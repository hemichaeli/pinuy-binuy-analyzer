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

const VERSION = '4.8.3';
const BUILD = '2026-02-12-v4.8.3-route-fix';

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
    
    logger.info('Auto-migrations completed');
  } catch (error) {
    logger.error('Auto-migration error:', error.message);
  }
}

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'] }));
app.use(express.json({ limit: '50mb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health' && req.path !== '/debug') {
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
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
      build: BUILD,
      db: 'connected',
      complexes: parseInt(result.rows[0].count),
      transactions: parseInt(txCount.rows[0].count),
      listings: parseInt(listingCount.rows[0].count),
      unread_alerts: parseInt(alertCount.rows[0].count),
      notifications: notificationService.isConfigured() ? 'active' : 'disabled'
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message, version: VERSION });
  }
});

// Route loading with error handling
function loadRoute(routePath, mountPath) {
  try {
    const route = require(routePath);
    app.use(mountPath, route);
    logger.info(`Route loaded: ${mountPath}`);
    return true;
  } catch (error) {
    logger.warn(`Route skipped ${mountPath}: ${error.message}`);
    return false;
  }
}

async function loadRoutes() {
  // Map to ACTUAL files in src/routes/
  const routes = [
    ['./routes/projects', '/api/projects'],
    ['./routes/opportunities', '/api'],
    ['./routes/scan', '/api/scan'],
    ['./routes/alerts', '/api/alerts'],
    ['./routes/ssiRoutes', '/api/ssi'],
    ['./routes/enhancedData', '/api/enhanced'],
    ['./routes/konesRoutes', '/api/kones'],
    ['./routes/perplexityRoutes', '/api/perplexity'],
    ['./routes/governmentDataRoutes', '/api/government'],
    ['./routes/newsRoutes', '/api/news'],
    ['./routes/pricingRoutes', '/api/pricing'],
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
  try {
    const ds = require('./services/discoveryService');
    return { available: true, cities: ds.ALL_TARGET_CITIES?.length || 0 };
  } catch { return { available: false }; }
}

function getKonesInfo() {
  try {
    const ks = require('./services/konesIsraelService');
    return { available: true, configured: ks.isConfigured?.() || false };
  } catch { return { available: false }; }
}

// Debug endpoint
app.get('/debug', (req, res) => {
  const discovery = getDiscoveryInfo();
  const kones = getKonesInfo();
  
  let schedulerStatus = null;
  try {
    const { getSchedulerStatus } = require('./jobs/weeklyScanner');
    schedulerStatus = getSchedulerStatus();
  } catch (e) {
    schedulerStatus = { error: e.message };
  }
  
  res.json({
    timestamp: new Date().toISOString(),
    build: BUILD,
    version: VERSION,
    node_version: process.version,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? '(set)' : '(not set)',
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? '(set)' : '(not set)',
      RESEND_API_KEY: process.env.RESEND_API_KEY ? '(set)' : '(not set)',
      KONES_EMAIL: process.env.KONES_EMAIL ? '(set)' : '(not set)',
      KONES_PASSWORD: process.env.KONES_PASSWORD ? '(set)' : '(not set)',
    },
    features: {
      discovery: discovery.available ? `active (${discovery.cities} cities)` : 'disabled',
      kones_israel: kones.available ? (kones.configured ? 'active' : 'not configured') : 'disabled',
      notifications: notificationService.isConfigured() ? 'active' : 'disabled',
    },
    scheduler: schedulerStatus
  });
});

// Scheduler routes
app.get('/api/scheduler', (req, res) => {
  try {
    const { getSchedulerStatus } = require('./jobs/weeklyScanner');
    res.json(getSchedulerStatus());
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/api/scheduler/run', async (req, res) => {
  try {
    const { runWeeklyScan, getSchedulerStatus } = require('./jobs/weeklyScanner');
    const status = getSchedulerStatus();
    if (status.isRunning) return res.status(409).json({ error: 'Scan already running' });
    res.json({ message: 'Scan triggered', note: 'Running in background' });
    await runWeeklyScan();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Notification routes
app.get('/api/notifications/status', (req, res) => {
  res.json(notificationService.getStatus ? notificationService.getStatus() : { configured: notificationService.isConfigured() });
});

app.post('/api/notifications/test', async (req, res) => {
  try {
    await notificationService.sendTestEmail?.();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'QUANTUM - Pinuy Binuy Investment Analyzer',
    version: VERSION,
    build: BUILD,
    endpoints: {
      health: '/health',
      debug: '/debug',
      scheduler: '/api/scheduler',
      projects: '/api/projects',
      opportunities: '/api/opportunities',
      scan: '/api/scan',
      kones: '/api/kones',
      notifications: '/api/notifications/status'
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message, version: VERSION });
});

async function start() {
  logger.info(`Starting QUANTUM Backend v${VERSION}`);
  logger.info(`Build: ${BUILD}`);
  
  await runAutoMigrations();
  await loadRoutes();
  
  // Start scheduler
  try {
    const { startScheduler } = require('./jobs/weeklyScanner');
    startScheduler();
  } catch (e) {
    logger.warn('Scheduler failed to start:', e.message);
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Notifications: ${notificationService.isConfigured() ? 'active' : 'disabled'}`);
  });
}

start();

module.exports = app;
