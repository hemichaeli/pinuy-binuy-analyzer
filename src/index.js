require('dotenv').config();

// Railway private networking uses IPv6 - ensure Node.js resolves it
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
const notificationService = require('./services/notificationService');

const app = express();
const PORT = process.env.PORT || 3000;

// Auto-migrate and seed on startup
async function initDatabase() {
  const maxRetries = 15;
  const retryDelay = 3000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      break;
    } catch (err) {
      logger.warn(`DB connection attempt ${i + 1}/${maxRetries} failed: ${err.message}`);
      if (i === maxRetries - 1) {
        logger.error('Could not connect to database after all retries');
        return false;
      }
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'complexes'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      logger.info('Tables not found - running migration...');
      const schemaPath = path.join(__dirname, 'db', 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      logger.info('Migration completed: all tables created');
    } else {
      logger.info('Tables already exist - skipping base migration');
    }

    // Run incremental migrations (idempotent ALTER TABLE IF NOT EXISTS)
    try {
      const migrationsDir = path.join(__dirname, 'db', 'migrations');
      if (fs.existsSync(migrationsDir)) {
        const migrationFiles = fs.readdirSync(migrationsDir)
          .filter(f => f.endsWith('.sql'))
          .sort();
        for (const file of migrationFiles) {
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          await pool.query(sql);
          logger.info(`Migration applied: ${file}`);
        }
      }
    } catch (migErr) {
      logger.warn(`Migration warning (non-critical): ${migErr.message}`);
    }

    const countCheck = await pool.query('SELECT COUNT(*) FROM complexes');
    if (parseInt(countCheck.rows[0].count) === 0) {
      logger.info('No data found - running seed...');
      const { seedWithPool } = require('./db/seed');
      await seedWithPool(pool);
      logger.info('Seed completed');
    } else {
      logger.info(`Database has ${countCheck.rows[0].count} complexes - skipping seed`);
    }
    
    return true;
  } catch (err) {
    logger.error(`Database init error: ${err.message}`);
    return false;
  }
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

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

// Routes
const projectRoutes = require('./routes/projects');
const opportunityRoutes = require('./routes/opportunities');
const scanRoutes = require('./routes/scan');
const alertRoutes = require('./routes/alerts');

app.use('/api/projects', projectRoutes);
app.use('/api', opportunityRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/alerts', alertRoutes);

// Weekly scheduler routes
const { getSchedulerStatus, runWeeklyScan } = require('./jobs/weeklyScanner');

app.get('/api/scheduler', (req, res) => {
  res.json(getSchedulerStatus());
});

app.post('/api/scheduler/run', async (req, res) => {
  const status = getSchedulerStatus();
  if (status.isRunning) {
    return res.status(409).json({ error: 'Scan already running' });
  }
  res.json({ message: 'Weekly scan triggered manually', note: 'Running in background' });
  try { await runWeeklyScan(); } catch (err) {
    logger.error('Manual weekly scan failed', { error: err.message });
  }
});

// Notification routes
app.get('/api/notifications/status', (req, res) => {
  res.json({
    configured: notificationService.isConfigured(),
    provider: notificationService.getProvider(),
    resend_key: process.env.RESEND_API_KEY ? `${process.env.RESEND_API_KEY.substring(0, 8)}...(set)` : '(not set)',
    smtp_host: process.env.SMTP_HOST ? `${process.env.SMTP_HOST} (set)` : '(not set)',
    email_from: process.env.EMAIL_FROM || 'QUANTUM <onboarding@resend.dev>',
    targets: notificationService.NOTIFICATION_EMAILS
  });
});

app.post('/api/notifications/test', async (req, res) => {
  if (!notificationService.isConfigured()) {
    return res.status(400).json({ 
      error: 'Email not configured. Set RESEND_API_KEY (preferred) or SMTP_HOST/USER/PASS',
      provider: notificationService.getProvider()
    });
  }
  try {
    const testSubject = `[QUANTUM] Test notification - ${new Date().toISOString()}`;
    const testBody = '<div dir="rtl"><h2>QUANTUM - בדיקת התראות</h2><p>אם אתה רואה הודעה זו, מערכת ההתראות פעילה!</p></div>';
    const results = [];
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      const result = await notificationService.sendEmail(email, testSubject, testBody);
      results.push({ email, ...result });
    }
    const allSent = results.every(r => r.sent);
    res.json({ test: allSent ? 'success' : 'partial_failure', provider: notificationService.getProvider(), results });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  if (!notificationService.isConfigured()) {
    return res.status(400).json({ error: 'Email not configured' });
  }
  try {
    const result = await notificationService.sendPendingAlerts();
    res.json({ message: 'Pending alerts processed', provider: notificationService.getProvider(), ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint
app.get('/debug', (req, res) => {
  const scheduler = getSchedulerStatus();
  const emailProvider = notificationService.getProvider();
  res.json({
    timestamp: new Date().toISOString(),
    build: '2026-02-09-v5-benchmark-fix',
    node_version: process.version,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? `${process.env.DATABASE_URL.substring(0, 20)}...(set)` : '(not set)',
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? `${process.env.PERPLEXITY_API_KEY.substring(0, 8)}...(set)` : '(not set)',
      RESEND_API_KEY: process.env.RESEND_API_KEY ? `${process.env.RESEND_API_KEY.substring(0, 8)}...(set)` : '(not set)',
      EMAIL_FROM: process.env.EMAIL_FROM || 'QUANTUM <onboarding@resend.dev> (default)',
      SMTP_HOST: process.env.SMTP_HOST || '(not set)',
      SCAN_CRON: process.env.SCAN_CRON || '0 4 * * 0 (default)',
      PORT: process.env.PORT || '(not set)',
      NODE_ENV: process.env.NODE_ENV || '(not set)',
    },
    scheduler: {
      enabled: scheduler.enabled,
      cron: scheduler.cron,
      isRunning: scheduler.isRunning,
      lastRun: scheduler.lastRun,
      notificationsConfigured: scheduler.notificationsConfigured
    },
    features: {
      ssi_calculator: 'active',
      iai_calculator: 'active',
      benchmark_service: 'active',
      nadlan_scraper: 'active',
      yad2_scraper: 'active',
      mavat_scraper: 'active',
      committee_tracking: 'active',
      perplexity_scanner: process.env.PERPLEXITY_API_KEY ? 'active' : 'disabled',
      notification_service: notificationService.isConfigured() 
        ? `active (${emailProvider})` 
        : 'disabled (set RESEND_API_KEY or SMTP vars)',
      weekly_scanner: scheduler.enabled ? 'active' : 'disabled'
    },
    weekly_scan_steps: [
      '1. nadlan.gov.il transaction scan',
      '2. Benchmark calculation (actual_premium)',
      '3. Perplexity AI scan (status + listings)',
      '4. yad2 listing scan (dedicated price tracking)',
      '5. mavat planning scan (committee approvals + status)',
      '6. SSI score calculation',
      '7. IAI score recalculation',
      '8. Alert generation (incl. committee alerts)',
      '9. Email notifications (Trello cards + office digest)'
    ],
    alert_types: [
      'status_change - plan status progression',
      'committee_approval - local/district committee (critical price trigger)',
      'opportunity - IAI threshold crossed (50/70)',
      'stressed_seller - high SSI listing found',
      'price_drop - significant price reduction'
    ],
    notification_targets: notificationService.NOTIFICATION_EMAILS,
    cwd: process.cwd(),
  });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM complexes');
    const txCount = await pool.query('SELECT COUNT(*) FROM transactions');
    const listingCount = await pool.query('SELECT COUNT(*) FROM listings');
    const activeListings = await pool.query('SELECT COUNT(*) FROM listings WHERE is_active = TRUE');
    const yad2Listings = await pool.query("SELECT COUNT(*) FROM listings WHERE source = 'yad2' AND is_active = TRUE");
    const stressedCount = await pool.query('SELECT COUNT(*) FROM listings WHERE ssi_score >= 50 AND is_active = TRUE');
    const alertCount = await pool.query('SELECT COUNT(*) FROM alerts WHERE is_read = FALSE');
    const benchmarkedCount = await pool.query('SELECT COUNT(*) FROM complexes WHERE actual_premium IS NOT NULL');
    
    // Committee tracking stats
    let committeeStats = { local: 0, district: 0 };
    try {
      const localCommittee = await pool.query('SELECT COUNT(*) FROM complexes WHERE local_committee_date IS NOT NULL');
      const districtCommittee = await pool.query('SELECT COUNT(*) FROM complexes WHERE district_committee_date IS NOT NULL');
      committeeStats.local = parseInt(localCommittee.rows[0].count);
      committeeStats.district = parseInt(districtCommittee.rows[0].count);
    } catch (e) { /* columns may not exist yet */ }
    
    const scheduler = getSchedulerStatus();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '3.0.0',
      db: 'connected',
      complexes: parseInt(result.rows[0].count),
      transactions: parseInt(txCount.rows[0].count),
      listings: {
        total: parseInt(listingCount.rows[0].count),
        active: parseInt(activeListings.rows[0].count),
        yad2_active: parseInt(yad2Listings.rows[0].count),
        stressed: parseInt(stressedCount.rows[0].count)
      },
      benchmarked_complexes: parseInt(benchmarkedCount.rows[0].count),
      committee_tracked: committeeStats,
      unread_alerts: parseInt(alertCount.rows[0].count),
      perplexity: process.env.PERPLEXITY_API_KEY ? 'configured' : 'not_configured',
      notifications: notificationService.isConfigured() ? `configured (${notificationService.getProvider()})` : 'not_configured',
      scheduler: scheduler.enabled ? 'active' : 'disabled'
    });
  } catch (err) {
    res.status(503).json({
      status: 'error', timestamp: new Date().toISOString(),
      db: 'disconnected', error: err.message
    });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Pinuy Binuy Investment Analyzer API',
    version: '3.0.0',
    phase: 'v3.0 - Full Pipeline (9-step scan + notifications)',
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
      scanRun: 'POST /api/scan/run',
      scanNadlan: 'POST /api/scan/nadlan',
      scanYad2: 'POST /api/scan/yad2',
      scanMavat: 'POST /api/scan/mavat',
      scanBenchmark: 'POST /api/scan/benchmark',
      scanWeekly: 'POST /api/scan/weekly',
      scanComplex: 'POST /api/scan/complex/:id',
      scanSSI: 'POST /api/scan/ssi',
      scanResults: 'GET /api/scan/results',
      alerts: 'GET /api/alerts',
      alertMarkRead: 'PUT /api/alerts/:id/read',
      notificationsStatus: 'GET /api/notifications/status',
      notificationsTest: 'POST /api/notifications/test',
      notificationsSend: 'POST /api/notifications/send',
      scheduler: 'GET /api/scheduler',
      schedulerRun: 'POST /api/scheduler/run'
    }
  });
});

app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function start() {
  const dbReady = await initDatabase();
  if (!dbReady) {
    logger.warn('Starting without database - some features may be unavailable');
  }
  
  if (dbReady) {
    const { startScheduler } = require('./jobs/weeklyScanner');
    startScheduler();
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Pinuy Binuy API v3.0 running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Database: ${dbReady ? 'ready' : 'unavailable'}`);
    logger.info(`Perplexity: ${process.env.PERPLEXITY_API_KEY ? 'configured' : 'not configured'}`);
    logger.info(`Notifications: ${notificationService.isConfigured() ? `configured (${notificationService.getProvider()})` : 'not configured'}`);
    logger.info('Features: SSI, IAI, Benchmark, Nadlan, yad2, mavat, Committee, Notifications, Weekly Scanner');
  });
}

start();

module.exports = app;
