// STARTUP TRACE - debug silent crash
console.log('[TRACE] index.js starting...');
process.on('uncaughtException', (err) => { console.error('[FATAL] Uncaught exception:', err.message, err.stack); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('[FATAL] Unhandled rejection:', err.message || err, err.stack || ''); process.exit(1); });

console.log('[TRACE] Loading dotenv...');
require('dotenv').config();

console.log('[TRACE] Loading dns...');
const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

console.log('[TRACE] Loading express...');
const express = require('express');
console.log('[TRACE] Loading cors...');
const cors = require('cors');
console.log('[TRACE] Loading helmet...');
const helmet = require('helmet');
console.log('[TRACE] Loading rate-limit...');
const rateLimit = require('express-rate-limit');
console.log('[TRACE] Loading logger...');
const { logger } = require('./services/logger');
console.log('[TRACE] Loading pool...');
const pool = require('./db/pool');
console.log('[TRACE] Loading notification service...');
const notificationService = require('./services/notificationService');

console.log('[TRACE] All requires done, setting up app...');

const app = express();
const PORT = process.env.PORT || 3000;

const VERSION = '4.34.0';
const BUILD = '2026-03-01-v4.34.0-production-stable';

// Store route loading results for diagnostics
const routeLoadResults = [];

async function runAutoMigrations() {
  try {
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ALTER COLUMN created_at SET DEFAULT NOW()`);
    
    // Basic columns only - no complex migration
    const basicColumns = [
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_avg_price_sqm INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_madlan_update TIMESTAMP'
    ];
    
    for (const sql of basicColumns) {
      try { await pool.query(sql); } catch (e) { /* column exists */ }
    }

    // Basic leads table - simple version
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id SERIAL PRIMARY KEY,
          source TEXT DEFAULT 'whatsapp_bot',
          phone TEXT,
          name TEXT,
          user_type TEXT,
          raw_data JSONB DEFAULT '{}',
          status TEXT DEFAULT 'new',
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC)`);
    } catch (e) { /* table exists */ }
    
    logger.info('Auto-migrations completed (v4.34.0 - production-stable)');
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

// Rate limiting - exempt public UI routes + bot + fireflies + whatsapp webhook
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, validate: { trustProxy: true } });
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/perplexity') || req.path.startsWith('/chat') || req.path.startsWith('/dashboard') || req.path.startsWith('/intelligence') || req.path.startsWith('/bot') || req.path.startsWith('/fireflies') || req.path.startsWith('/whatsapp/') || req.path.startsWith('/whatsapp-dashboard')) {
    return next();
  }
  apiLimiter(req, res, next);
});

// =============================================================
// ROBOTS.TXT + CRAWLER SUPPORT
// =============================================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# QUANTUM - Pinuy Binui Intelligence\nUser-agent: *\nAllow: /api/perplexity/\nAllow: /api/intelligence/\nAllow: /health\nDisallow: /api/admin/\nDisallow: /api/scan/\nDisallow: /diagnostics\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /api/perplexity/\nAllow: /api/intelligence/\n\nUser-agent: Claude-Web\nAllow: /api/perplexity/\nAllow: /api/intelligence/\n`);
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
    let botLeadCount = 0;
    try { const bl = await pool.query("SELECT COUNT(*) FROM leads WHERE source IN ('whatsapp_bot', 'whatsapp_webhook')"); botLeadCount = parseInt(bl.rows[0].count); } catch (e) { /* table might not exist yet */ }
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
      build: BUILD,
      db: 'connected',
      complexes: parseInt(result.rows[0].count),
      transactions: parseInt(txCount.rows[0].count),
      listings: parseInt(listingCount.rows[0].count),
      whatsapp_bot_leads: botLeadCount,
      unread_alerts: parseInt(alertCount.rows[0].count),
      notifications: notificationService.isConfigured() ? 'active' : 'disabled',
      routes_loaded: routeLoadResults.filter(r => r.status === 'ok').length,
      routes_failed: routeLoadResults.filter(r => r.status === 'failed').length
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message, version: VERSION });
  }
});

// Route loading - SAFE VERSION
function loadRoute(routePath, mountPath) {
  try {
    console.log(`[TRACE] Loading route ${mountPath}...`);
    const route = require(routePath);
    app.use(mountPath, route);
    logger.info(`Route loaded: ${mountPath}`);
    routeLoadResults.push({ path: mountPath, file: routePath, status: 'ok' });
    return true;
  } catch (error) {
    const errorDetail = `${error.message} | Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`;
    logger.error(`Route FAILED ${mountPath}: ${errorDetail}`);
    console.error(`[TRACE] Route FAILED ${mountPath}: ${error.message}`);
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
    ['./routes/intelligenceRoutes', '/api/intelligence'],
    ['./routes/chatRoutes', '/api/chat'],
    ['./routes/dashboardRoutes', '/api/dashboard'],
    ['./routes/governmentDataRoutes', '/api/government'],
    ['./routes/newsRoutes', '/api/news'],
    ['./routes/pricingRoutes', '/api/pricing'],
    ['./routes/messagingRoutes', '/api/messaging'],
    ['./routes/facebookRoutes', '/api/facebook'],
    ['./routes/admin', '/api/admin'],
    ['./routes/enrichmentRoutes', '/api/enrichment'],
    ['./routes/inforuRoutes', '/api/inforu'],
    ['./routes/premiumRoutes', '/api/premium'],
    ['./routes/signatureRoutes', '/api/signatures'],
    ['./routes/schedulerRoutes', '/api/scheduler/v2'],
    ['./routes/leadRoutes', '/api/leads'],
    ['./routes/botRoutes', '/api/bot'],
    ['./routes/whatsappWebhookRoutes', '/api'],
    ['./routes/whatsappDashboardRoutes', '/api'], // Simple dashboard
    ['./routes/firefliesWebhookRoutes', '/api/fireflies'],
    ['./routes/mavatBuildingRoutes', '/api/mavat'],
  ];
  
  let loaded = 0, failed = 0;
  for (const [routePath, mountPath] of routes) {
    if (loadRoute(routePath, mountPath)) loaded++;
    else failed++;
  }
  logger.info(`Routes: ${loaded} loaded, ${failed} skipped`);
}

// Root - redirect to dashboard
app.get('/', (req, res) => {
  res.redirect(302, '/api/dashboard/');
});

// API info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    name: 'QUANTUM - Pinuy Binuy Investment Analyzer',
    version: VERSION, build: BUILD,
    endpoints: {
      health: '/health', 
      whatsapp_webhook: '/api/whatsapp/webhook', 
      whatsapp_trigger: '/api/whatsapp/trigger',
      whatsapp_dashboard: '/api/whatsapp-dashboard', 
      whatsapp_stats: '/api/whatsapp/stats',
      bot_health: '/api/bot/health'
    }
  });
});

async function start() {
  console.log('[TRACE] start() called');
  logger.info(`Starting QUANTUM Backend v${VERSION}`);
  logger.info(`Build: ${BUILD}`);
  
  console.log('[TRACE] Running auto-migrations...');
  await runAutoMigrations();
  console.log('[TRACE] Auto-migrations done, loading routes...');
  loadAllRoutes();
  
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info(`=== ROUTE LOADING SUMMARY ===`);
  loaded.forEach(r => logger.info(`  OK: ${r.path}`));
  failed.forEach(r => logger.error(`  FAILED: ${r.path} -> ${r.error}`));
  
  // 404 handler - AFTER all routes
  app.use((req, res) => { res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION }); });
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: 'Internal Server Error', message: err.message, version: VERSION }); });
  
  console.log('[TRACE] About to listen on port', PORT);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TRACE] Server listening on port ${PORT}`);
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Routes: ${loaded.length} loaded, ${failed.length} failed`);
    logger.info(`WhatsApp Bot: /api/bot/`);
    logger.info(`WhatsApp Webhook: /api/whatsapp/webhook`);
    logger.info(`WhatsApp Dashboard: /api/whatsapp-dashboard`);
  });
}

console.log('[TRACE] Calling start()...');
start().catch(err => {
  console.error('[FATAL] start() failed:', err.message, err.stack);
  process.exit(1);
});
module.exports = app;