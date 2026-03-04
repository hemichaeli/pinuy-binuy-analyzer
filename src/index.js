require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { logger } = require('./services/logger');
const pool = require('./db/pool');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const VERSION = '4.48.0';
const BUILD = '2026-03-04-v4.48.0-morning-report-api';

// What's in this version:
// - Morning report routes: GET /api/morning/preview, POST /api/morning/send
// - All previous: Bloomberg Terminal dashboard, PostgreSQL, schedulers

async function runAutoMigrations() {
  try {
    logger.info('[MIGRATIONS] Running auto-migrations...');
    const migFile = path.join(__dirname, 'db', 'auto_migrations.sql');
    if (!fs.existsSync(migFile)) {
      logger.warn('[MIGRATIONS] No auto_migrations.sql found');
      return;
    }
    const sql = fs.readFileSync(migFile, 'utf8');
    await pool.query(sql);
    logger.info('[MIGRATIONS] Auto-migrations completed');
  } catch (err) {
    logger.error('[MIGRATIONS] Failed:', err.message);
  }
}

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path.startsWith('/api/intelligence') || req.path === '/health' || req.path === '/api/debug' || req.path.startsWith('/api/whatsapp/'), message: { error: 'Too many requests, please try again later' } });
app.use('/api/', limiter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health' && !req.path.startsWith('/api/debug')) {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

const routeLoadResults = [];

function loadAllRoutes() {
  const routeFiles = [
    { path: '/dashboard', file: 'routes/dashboardRoute.js' },
    { path: '/api/projects', file: 'routes/projects.js' },
    { path: '/api', file: 'routes/opportunities.js' },
    { path: '/api/scan', file: 'routes/scan.js' },
    { path: '/api/alerts', file: 'routes/alerts.js' },
    { path: '/api/leads', file: 'routes/leadRoutes.js' },
    { path: '/api/dashboard', file: 'routes/dashboardRoutes.js' },
    { path: '/api/chat', file: 'routes/chatRoutes.js' },
    { path: '/api/intelligence', file: 'routes/intelligenceRoutes.js' },
    { path: '/api/facebook', file: 'routes/facebookRoutes.js' },
    { path: '/api/messaging', file: 'routes/messagingRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappRoutes.js' },
    { path: '/api/morning', file: 'routes/morningReportRoutes.js' }
  ];

  for (const { path: routePath, file } of routeFiles) {
    try {
      const fullPath = require.resolve(`./${file}`);
      delete require.cache[fullPath];
      const router = require(`./${file}`);
      app.use(routePath, router);
      routeLoadResults.push({ path: routePath, status: 'ok' });
    } catch (err) {
      routeLoadResults.push({ path: routePath, status: 'failed', error: err.message });
    }
  }
}

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM complexes');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected', complexes: parseInt(result.rows[0].count), version: VERSION });
  } catch (err) {
    res.status(503).json({ status: 'error', timestamp: new Date().toISOString(), db: 'disconnected', error: err.message, version: VERSION });
  }
});

app.get('/api/debug', async (req, res) => {
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  res.json({ version: VERSION, build: BUILD, timestamp: new Date().toISOString(), routes: { loaded: loaded.map(r => r.path), failed: failed.map(r => ({ path: r.path, error: r.error })) } });
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

async function start() {
  logger.info(`=== QUANTUM ANALYZER ${VERSION} ===`);
  logger.info(`Build: ${BUILD}`);
  
  await runAutoMigrations();
  loadAllRoutes();
  
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info(`=== ROUTE LOADING SUMMARY ===`);
  loaded.forEach(r => logger.info(`  OK: ${r.path}`));
  failed.forEach(r => logger.error(`  FAILED: ${r.path} -> ${r.error}`));
  
  app.use((req, res) => { res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION }); });
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: 'Internal Server Error', message: err.message, version: VERSION }); });
  
  try { const { startScheduler } = require('./jobs/weeklyScanner'); startScheduler(); } catch (e) { logger.warn('Scheduler failed to start:', e.message); }
  try { const { startWatcher } = require('./jobs/stuckScanWatcher'); startWatcher(); } catch (e) { logger.warn('Stuck scan watcher failed to start:', e.message); }
  try { const { startDiscoveryScheduler } = require('./jobs/discoveryScheduler'); startDiscoveryScheduler(); } catch (e) { logger.warn('Discovery scheduler failed to start:', e.message); }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Routes: ${loaded.length} loaded, ${failed.length} failed`);
    logger.info(`Dashboard available at: /dashboard`);
  });
}

start();
module.exports = app;
