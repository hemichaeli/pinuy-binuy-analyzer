require('dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { logger } = require('./services/logger');
const pool = require('./db/pool');
const notificationService = require('./services/notificationService');

const app = express();
const PORT = process.env.PORT || 3000;

const VERSION = '4.19.0';
const BUILD = '2026-02-15-v4.19.0-facebook-marketplace';

// Store route loading results for diagnostics
const routeLoadResults = [];

async function runAutoMigrations() {
  try {
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ALTER COLUMN created_at SET DEFAULT NOW()`);
    
    const phase45Columns = [
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_avg_price_sqm INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_price_trend DECIMAL(5,2)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_madlan_update TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_officially_declared BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_track VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_declaration_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_plan_number VARCHAR(100)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_certainty_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_last_verified TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS committee_last_checked TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_detected BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_decision TEXT',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_impact VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_company_number VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_status VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_level VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_last_verified TIMESTAMP'
    ];
    
    for (const sql of phase45Columns) {
      try { await pool.query(sql); } catch (e) { /* column exists */ }
    }

    // v4.15.0: Messaging system
    const msgColumns = [
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS deal_status VARCHAR(50) DEFAULT 'חדש'",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS message_status VARCHAR(50) DEFAULT 'לא נשלחה'",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_message_sent_at TIMESTAMP",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMP",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_reply_text TEXT",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS notes TEXT"
    ];
    for (const sql of msgColumns) {
      try { await pool.query(sql); } catch (e) { /* column exists */ }
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS listing_messages (
          id SERIAL PRIMARY KEY,
          listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
          direction VARCHAR(10) NOT NULL DEFAULT 'sent',
          message_text TEXT NOT NULL,
          sent_at TIMESTAMP DEFAULT NOW(),
          status VARCHAR(30) DEFAULT 'pending',
          yad2_conversation_id VARCHAR(100),
          error_message TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_messages_listing ON listing_messages(listing_id)`);
    } catch (e) { /* table exists */ }

    // v4.19.0: Facebook Marketplace support
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_facebook_scan TIMESTAMP`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_source_city ON listings(source, city)`);
    } catch (e) { /* columns/indexes exist */ }
    
    logger.info('Auto-migrations completed');
  } catch (error) {
    logger.error('Auto-migration error:', error.message);
  }
}

// CRITICAL: Trust proxy for Railway reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'] }));
app.use(express.json({ limit: '50mb' }));

// Rate limiting - exempt public UI routes
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, validate: { trustProxy: true } });
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/perplexity') || req.path.startsWith('/chat') || req.path.startsWith('/dashboard')) {
    return next();
  }
  apiLimiter(req, res, next);
});

// ============================================================
// ROBOTS.TXT + CRAWLER SUPPORT
// ============================================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# QUANTUM - Pinuy Binuy Intelligence
User-agent: *
Allow: /api/perplexity/
Allow: /health
Disallow: /api/admin/
Disallow: /api/scan/
Disallow: /diagnostics

User-agent: PerplexityBot
Allow: /

User-agent: ChatGPT-User
Allow: /api/perplexity/

User-agent: Claude-Web
Allow: /api/perplexity/

User-agent: GPTBot
Allow: /api/perplexity/
`);
});

app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'QUANTUM - Pinuy Binuy Intelligence',
    name_for_model: 'quantum_pinuy_binuy',
    description_for_human: 'Israeli urban renewal (Pinuy-Binuy) real estate investment data.',
    description_for_model: 'Access Israeli Pinuy-Binui real estate data. Use /api/perplexity/brain.html for summary or /api/perplexity/brain.json for structured data.',
    api: { type: 'openapi', url: 'https://pinuy-binuy-analyzer-production.up.railway.app/api/perplexity/brain.json' },
    logo_url: 'https://pinuy-binuy-analyzer-production.up.railway.app/favicon.ico',
    contact_email: 'Office@u-r-quantum.com',
    legal_info_url: 'https://pinuy-binuy-analyzer-production.up.railway.app/'
  });
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health' && req.path !== '/debug' && req.path !== '/robots.txt') {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM complexes');
    const txCount = await pool.query('SELECT COUNT(*) FROM transactions');
    const listingCount = await pool.query('SELECT COUNT(*) FROM listings');
    const alertCount = await pool.query('SELECT COUNT(*) FROM alerts WHERE is_read = FALSE');
    const fbCount = await pool.query("SELECT COUNT(*) FROM listings WHERE source = 'facebook' AND is_active = TRUE");
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
      build: BUILD,
      db: 'connected',
      complexes: parseInt(result.rows[0].count),
      transactions: parseInt(txCount.rows[0].count),
      listings: parseInt(listingCount.rows[0].count),
      facebook_listings: parseInt(fbCount.rows[0].count),
      unread_alerts: parseInt(alertCount.rows[0].count),
      notifications: notificationService.isConfigured() ? 'active' : 'disabled',
      routes_loaded: routeLoadResults.filter(r => r.status === 'ok').length,
      routes_failed: routeLoadResults.filter(r => r.status === 'failed').length
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message, version: VERSION });
  }
});

// Route loading
function loadRoute(routePath, mountPath) {
  try {
    const route = require(routePath);
    app.use(mountPath, route);
    logger.info(`Route loaded: ${mountPath}`);
    routeLoadResults.push({ path: mountPath, file: routePath, status: 'ok' });
    return true;
  } catch (error) {
    const errorDetail = `${error.message} | Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`;
    logger.error(`Route FAILED ${mountPath}: ${errorDetail}`);
    routeLoadResults.push({ path: mountPath, file: routePath, status: 'failed', error: error.message, stack: error.stack?.split('\n').slice(0, 5) });
    return false;
  }
}

function loadAllRoutes() {
  const routes = [
    ['./routes/projects', '/api/projects'],
    ['./routes/opportunities', '/api'],
    ['./routes/scan', '/api/scan'],
    ['./routes/alerts', '/api/alerts'],
    ['./routes/ssiRoutes', '/api/ssi'],
    ['./routes/enhancedData', '/api/enhanced'],
    ['./routes/konesRoutes', '/api/kones'],
    ['./routes/perplexityRoutes', '/api/perplexity'],
    ['./routes/chatRoutes', '/api/chat'],
    ['./routes/dashboardRoutes', '/api/dashboard'],
    ['./routes/governmentDataRoutes', '/api/government'],
    ['./routes/newsRoutes', '/api/news'],
    ['./routes/pricingRoutes', '/api/pricing'],
    ['./routes/messagingRoutes', '/api/messaging'],
    ['./routes/facebookRoutes', '/api/facebook'],
    ['./routes/admin', '/api/admin'],
  ];
  
  let loaded = 0, failed = 0;
  for (const [routePath, mountPath] of routes) {
    if (loadRoute(routePath, mountPath)) loaded++;
    else failed++;
  }
  logger.info(`Routes: ${loaded} loaded, ${failed} skipped`);
}

// Lazy load services
function getDiscoveryInfo() {
  try { const ds = require('./services/discoveryService'); return { available: true, cities: ds.ALL_TARGET_CITIES?.length || 0 }; } catch { return { available: false }; }
}
function getKonesInfo() {
  try { const ks = require('./services/konesIsraelService'); return { available: true, configured: ks.isConfigured?.() || false }; } catch { return { available: false }; }
}

// Diagnostics endpoint
app.get('/diagnostics', async (req, res) => {
  let dbTables = [];
  try {
    const tableResult = await pool.query(`SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name AND table_schema = 'public') as columns FROM information_schema.tables t WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    dbTables = tableResult.rows;
  } catch (e) { dbTables = [{ error: e.message }]; }

  let rowCounts = {};
  for (const table of dbTables) {
    if (table.table_name) {
      try { const r = await pool.query(`SELECT COUNT(*) FROM "${table.table_name}"`); rowCounts[table.table_name] = parseInt(r.rows[0].count); }
      catch (e) { rowCounts[table.table_name] = `ERROR: ${e.message}`; }
    }
  }

  let duplicates = [];
  try { const dupResult = await pool.query(`SELECT name, city, COUNT(*) as cnt FROM complexes GROUP BY name, city HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 30`); duplicates = dupResult.rows; }
  catch (e) { duplicates = [{ error: e.message }]; }

  let uniqueCounts = {};
  try { const uc = await pool.query(`SELECT COUNT(*) as total, COUNT(DISTINCT name) as unique_names, COUNT(DISTINCT CONCAT(name, '|', city)) as unique_name_city, COUNT(DISTINCT city) as cities FROM complexes`); uniqueCounts = uc.rows[0]; }
  catch (e) { uniqueCounts = { error: e.message }; }

  res.json({ version: VERSION, build: BUILD, timestamp: new Date().toISOString(), routes: routeLoadResults, db_tables: dbTables, row_counts: rowCounts, complex_duplicates: duplicates, complex_unique_counts: uniqueCounts,
    env_check: { DATABASE_URL: process.env.DATABASE_URL ? 'set' : 'missing', PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? 'set' : 'missing', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'missing', RESEND_API_KEY: process.env.RESEND_API_KEY ? 'set' : 'missing', KONES_EMAIL: process.env.KONES_EMAIL ? 'set' : 'missing', KONES_PASSWORD: process.env.KONES_PASSWORD ? 'set' : 'missing', YAD2_EMAIL: process.env.YAD2_EMAIL ? 'set' : 'missing', YAD2_PASSWORD: process.env.YAD2_PASSWORD ? 'set' : 'missing' }
  });
});

// Debug endpoint
app.get('/debug', (req, res) => {
  const discovery = getDiscoveryInfo();
  const kones = getKonesInfo();
  let schedulerStatus = null;
  try { const { getSchedulerStatus } = require('./jobs/weeklyScanner'); schedulerStatus = getSchedulerStatus(); } catch (e) { schedulerStatus = { error: e.message }; }
  
  res.json({
    timestamp: new Date().toISOString(), build: BUILD, version: VERSION, node_version: process.version,
    env: { DATABASE_URL: process.env.DATABASE_URL ? '(set)' : '(not set)', PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? '(set)' : '(not set)', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '(set)' : '(not set)', RESEND_API_KEY: process.env.RESEND_API_KEY ? '(set)' : '(not set)', KONES_EMAIL: process.env.KONES_EMAIL ? '(set)' : '(not set)', KONES_PASSWORD: process.env.KONES_PASSWORD ? '(set)' : '(not set)', YAD2_EMAIL: process.env.YAD2_EMAIL ? '(set)' : '(not set)', YAD2_PASSWORD: process.env.YAD2_PASSWORD ? '(set)' : '(not set)' },
    features: { discovery: discovery.available ? `active (${discovery.cities} cities)` : 'disabled', kones_israel: kones.available ? (kones.configured ? 'active' : 'not configured') : 'disabled', notifications: notificationService.isConfigured() ? 'active' : 'disabled' },
    routes: routeLoadResults, scheduler: schedulerStatus
  });
});

// Scheduler routes
app.get('/api/scheduler', (req, res) => { try { const { getSchedulerStatus } = require('./jobs/weeklyScanner'); res.json(getSchedulerStatus()); } catch (e) { res.json({ error: e.message }); } });
app.post('/api/scheduler/run', async (req, res) => { try { const { runWeeklyScan, getSchedulerStatus } = require('./jobs/weeklyScanner'); const status = getSchedulerStatus(); if (status.isRunning) return res.status(409).json({ error: 'Scan already running' }); res.json({ message: 'Scan triggered', note: 'Running in background' }); await runWeeklyScan(); } catch (e) { res.status(500).json({ error: e.message }); } });

// Notification routes
app.get('/api/notifications/status', (req, res) => { res.json(notificationService.getStatus ? notificationService.getStatus() : { configured: notificationService.isConfigured() }); });
app.post('/api/notifications/test', async (req, res) => { try { await notificationService.sendTestEmail?.(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Root - redirect to dashboard
app.get('/', (req, res) => {
  res.redirect(302, '/api/dashboard/');
});

// API info endpoint (moved from root)
app.get('/api/info', (req, res) => {
  res.json({
    name: 'QUANTUM - Pinuy Binuy Investment Analyzer',
    version: VERSION, build: BUILD,
    ui: {
      dashboard: '/api/dashboard/',
      chat: '/api/chat/',
    },
    endpoints: {
      health: '/health', debug: '/debug', diagnostics: '/diagnostics',
      projects: '/api/projects', opportunities: '/api/opportunities',
      stressed_sellers: '/api/ssi/stressed-sellers', scan: '/api/scan',
      scan_ai: '/api/scan/ai', messaging: '/api/messaging',
      kones: '/api/kones', perplexity: '/api/perplexity',
      facebook: '/api/facebook',
      notifications: '/api/notifications/status'
    }
  });
});

async function start() {
  logger.info(`Starting QUANTUM Backend v${VERSION}`);
  logger.info(`Build: ${BUILD}`);
  
  await runAutoMigrations();
  loadAllRoutes();
  
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info(`=== ROUTE LOADING SUMMARY ===`);
  loaded.forEach(r => logger.info(`  OK: ${r.path}`));
  failed.forEach(r => logger.error(`  FAILED: ${r.path} -> ${r.error}`));
  
  // 404 handler - AFTER all routes
  app.use((req, res) => { res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION }); });
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: 'Internal Server Error', message: err.message, version: VERSION }); });
  
  try { const { startScheduler } = require('./jobs/weeklyScanner'); startScheduler(); } catch (e) { logger.warn('Scheduler failed to start:', e.message); }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Routes: ${loaded.length} loaded, ${failed.length} failed`);
    logger.info(`Dashboard: /api/dashboard/`);
    logger.info(`Chat: /api/chat/`);
    logger.info(`Facebook API: /api/facebook/`);
    logger.info(`Messaging API: /api/messaging/`);
  });
}

start();
module.exports = app;
