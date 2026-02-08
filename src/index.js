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
const PORT = process.env.PORT || 3000;

async function initDatabase() {
  const maxRetries = 15;
  const retryDelay = 3000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      break;
    } catch (err) {
      logger.warn(`DB attempt ${i + 1}/${maxRetries} failed: ${err.message}`);
      if (i === maxRetries - 1) { logger.error('DB connection failed'); return false; }
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'complexes')
    `);
    
    if (!tableCheck.rows[0].exists) {
      logger.info('Running migration...');
      const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
      await pool.query(schema);
      logger.info('Migration complete');
    }

    const countCheck = await pool.query('SELECT COUNT(*) FROM complexes');
    if (parseInt(countCheck.rows[0].count) === 0) {
      logger.info('Running seed...');
      const { seedWithPool } = require('./db/seed');
      await seedWithPool(pool);
      logger.info('Seed complete');
    } else {
      logger.info(`${countCheck.rows[0].count} complexes in DB`);
    }
    
    return true;
  } catch (err) {
    logger.error(`DB init error: ${err.message}`);
    return false;
  }
}

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const d = Date.now() - start;
    if (req.path !== '/health' && req.path !== '/debug') {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${d}ms`);
    }
  });
  next();
});

// Routes
app.use('/api/projects', require('./routes/projects'));
app.use('/api', require('./routes/opportunities'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/alerts', require('./routes/alerts'));

// Scheduler routes
const { getSchedulerStatus, runWeeklyScan } = require('./jobs/weeklyScanner');
const { sendPendingNotifications, testSmtp, getNotificationStatus } = require('./services/notificationService');

app.get('/api/scheduler', (req, res) => res.json(getSchedulerStatus()));

app.post('/api/scheduler/run', async (req, res) => {
  if (getSchedulerStatus().isRunning) return res.status(409).json({ error: 'Scan already running' });
  res.json({ message: 'Weekly scan triggered manually', note: 'Running in background' });
  try { await runWeeklyScan(); } catch (err) { logger.error('Manual scan failed', { error: err.message }); }
});

// Notification routes
app.get('/api/notifications/status', (req, res) => res.json(getNotificationStatus()));

app.post('/api/notifications/test', async (req, res) => {
  try {
    const result = await testSmtp();
    res.json({ message: 'SMTP test', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  try {
    const result = await sendPendingNotifications();
    res.json({ message: 'Notifications processed', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint
app.get('/debug', (req, res) => {
  const scheduler = getSchedulerStatus();
  const notif = getNotificationStatus();
  res.json({
    timestamp: new Date().toISOString(),
    build: '2026-02-09-v3-full-pipeline',
    node_version: process.version,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? `${process.env.DATABASE_URL.substring(0, 20)}...(set)` : '(not set)',
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? `${process.env.PERPLEXITY_API_KEY.substring(0, 8)}...(set)` : '(not set)',
      SMTP_HOST: process.env.SMTP_HOST || '(not set)',
      SCAN_CRON: process.env.SCAN_CRON || '0 4 * * 0 (default)',
      PORT: process.env.PORT || '(not set)',
      NODE_ENV: process.env.NODE_ENV || '(not set)',
    },
    scheduler: { enabled: scheduler.enabled, cron: scheduler.cron, isRunning: scheduler.isRunning, lastRun: scheduler.lastRun },
    notifications: notif,
    features: {
      ssi_calculator: 'active',
      iai_calculator: 'active',
      benchmark_service: 'active',
      nadlan_scraper: 'active',
      yad2_scraper: 'active',
      mavat_scraper: 'active',
      perplexity_scanner: process.env.PERPLEXITY_API_KEY ? 'active' : 'disabled',
      weekly_scanner: scheduler.enabled ? 'active' : 'disabled',
      email_notifications: notif.smtpConfigured ? 'active' : 'disabled (set SMTP_HOST/USER/PASS)'
    },
    weekly_scan_steps: [
      '1. nadlan.gov.il transaction scan',
      '2. Benchmark calculation (actual_premium)',
      '3. mavat planning status + committee tracking',
      '4. Perplexity AI scan (status + listings)',
      '5. yad2 listing scan (dedicated price tracking)',
      '6. SSI score calculation',
      '7. IAI score recalculation',
      '8. Alert generation',
      '9. Email notifications (Trello + Office)'
    ],
    cwd: process.cwd(),
  });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const [complexes, tx, listings, active, yad2, stressed, alerts, bm] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM complexes'),
      pool.query('SELECT COUNT(*) FROM transactions'),
      pool.query('SELECT COUNT(*) FROM listings'),
      pool.query('SELECT COUNT(*) FROM listings WHERE is_active = TRUE'),
      pool.query("SELECT COUNT(*) FROM listings WHERE source = 'yad2' AND is_active = TRUE"),
      pool.query('SELECT COUNT(*) FROM listings WHERE ssi_score >= 50 AND is_active = TRUE'),
      pool.query('SELECT COUNT(*) FROM alerts WHERE is_read = FALSE'),
      pool.query('SELECT COUNT(*) FROM complexes WHERE actual_premium IS NOT NULL')
    ]);
    const scheduler = getSchedulerStatus();
    res.json({
      status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0', db: 'connected',
      complexes: parseInt(complexes.rows[0].count),
      transactions: parseInt(tx.rows[0].count),
      listings: {
        total: parseInt(listings.rows[0].count),
        active: parseInt(active.rows[0].count),
        yad2_active: parseInt(yad2.rows[0].count),
        stressed: parseInt(stressed.rows[0].count)
      },
      benchmarked: parseInt(bm.rows[0].count),
      unread_alerts: parseInt(alerts.rows[0].count),
      perplexity: process.env.PERPLEXITY_API_KEY ? 'configured' : 'not_configured',
      smtp: process.env.SMTP_HOST ? 'configured' : 'not_configured',
      scheduler: scheduler.enabled ? 'active' : 'disabled'
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'QUANTUM - Pinuy Binuy Investment Analyzer API',
    version: '3.0.0',
    phase: 'Full Pipeline - All Components Connected',
    endpoints: {
      health: 'GET /health',
      debug: 'GET /debug',
      projects: 'GET /api/projects',
      project: 'GET /api/projects/:id',
      transactions: 'GET /api/projects/:id/transactions',
      listings: 'GET /api/projects/:id/listings',
      benchmark: 'GET /api/projects/:id/benchmark',
      opportunities: 'GET /api/opportunities',
      stressedSellers: 'GET /api/stressed-sellers',
      dashboard: 'GET /api/dashboard',
      scanPerplexity: 'POST /api/scan/run',
      scanNadlan: 'POST /api/scan/nadlan',
      scanYad2: 'POST /api/scan/yad2',
      scanMavat: 'POST /api/scan/mavat',
      scanBenchmark: 'POST /api/scan/benchmark',
      scanComplex: 'POST /api/scan/complex/:id',
      scanSSI: 'POST /api/scan/ssi',
      scanResults: 'GET /api/scan/results',
      alerts: 'GET /api/alerts',
      alertMarkRead: 'PUT /api/alerts/:id/read',
      scheduler: 'GET /api/scheduler',
      schedulerRun: 'POST /api/scheduler/run',
      notifStatus: 'GET /api/notifications/status',
      notifTest: 'POST /api/notifications/test',
      notifSend: 'POST /api/notifications/send'
    }
  });
});

app.use((err, req, res, _next) => {
  logger.error(`Unhandled: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  const dbReady = await initDatabase();
  if (!dbReady) logger.warn('Starting without database');
  
  if (dbReady) {
    const { startScheduler } = require('./jobs/weeklyScanner');
    startScheduler();
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`QUANTUM API v3.0 on port ${PORT}`);
    logger.info(`Env: ${process.env.NODE_ENV || 'dev'} | DB: ${dbReady ? 'ready' : 'unavailable'}`);
    logger.info(`Perplexity: ${process.env.PERPLEXITY_API_KEY ? 'yes' : 'no'} | SMTP: ${process.env.SMTP_HOST ? 'yes' : 'no'}`);
    logger.info('Features: SSI, IAI, Benchmark, Nadlan, yad2, mavat, Notifications, Weekly Scanner');
  });
}

start();
module.exports = app;
