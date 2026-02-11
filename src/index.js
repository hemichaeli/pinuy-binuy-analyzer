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
const notificationService = require('./services/notificationService');

const app = express();
const PORT = process.env.PORT || 3000;

async function runAutoMigrations() {
  try {
    // Add discovery_source column for tracking where complexes were discovered
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
    
    // Add declaration_date column for official declaration date
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
    
    // Ensure created_at has default
    await pool.query(`ALTER TABLE complexes ALTER COLUMN created_at SET DEFAULT NOW()`);
    
    logger.info('Auto migrations completed');
  } catch (e) {
    // Ignore errors - columns may already exist or other benign issues
    logger.debug(`Migration note: ${e.message}`);
  }
}

async function initDatabase() {
  const maxRetries = 15;
  const retryDelay = 3000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      break;
    } catch (err) {
      logger.warn(`DB connection attempt ${i + 1}/${maxRetries} failed`);
      if (i === maxRetries - 1) return false;
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'complexes')
    `);
    
    if (!tableCheck.rows[0].exists) {
      logger.info('Running initial schema migration...');
      const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
      await pool.query(schema);
      logger.info('Initial migration completed');
    }

    // Run auto migrations (new columns, etc.)
    await runAutoMigrations();

    // Run SQL file migrations
    try {
      const migrationsDir = path.join(__dirname, 'db', 'migrations');
      if (fs.existsSync(migrationsDir)) {
        const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
          await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
          logger.info(`Migration: ${file}`);
        }
      }
    } catch (e) { logger.warn(`Migration warning: ${e.message}`); }

    const count = await pool.query('SELECT COUNT(*) FROM complexes');
    if (parseInt(count.rows[0].count) === 0) {
      const { seedWithPool } = require('./db/seed');
      await seedWithPool(pool);
      logger.info('Seed completed');
    }
    
    return true;
  } catch (err) {
    logger.error(`Database init error: ${err.message}`);
    return false;
  }
}

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path !== '/health' && req.path !== '/debug') {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// Routes
app.use('/api/projects', require('./routes/projects'));
app.use('/api', require('./routes/opportunities'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/alerts', require('./routes/alerts'));

// Admin routes (optional - may not exist in older versions)
try {
  app.use('/api/admin', require('./routes/admin'));
} catch (e) {
  logger.debug('Admin routes not available');
}

const { getSchedulerStatus, runWeeklyScan } = require('./jobs/weeklyScanner');

app.get('/api/scheduler', (req, res) => res.json(getSchedulerStatus()));

app.post('/api/scheduler/run', async (req, res) => {
  if (getSchedulerStatus().isRunning) {
    return res.status(409).json({ error: 'Scan already running' });
  }
  res.json({ message: 'Weekly scan triggered' });
  runWeeklyScan().catch(e => logger.error('Weekly scan failed', { error: e.message }));
});

app.get('/api/notifications/status', (req, res) => {
  res.json({
    configured: notificationService.isConfigured(),
    provider: notificationService.getProvider(),
    targets: notificationService.NOTIFICATION_EMAILS
  });
});

app.post('/api/notifications/test', async (req, res) => {
  if (!notificationService.isConfigured()) {
    return res.status(400).json({ error: 'Email not configured' });
  }
  try {
    const results = [];
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      const r = await notificationService.sendEmail(email, '[QUANTUM] Test', '<h2>Test OK</h2>');
      results.push({ email, ...r });
    }
    res.json({ test: 'success', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  if (!notificationService.isConfigured()) return res.status(400).json({ error: 'Not configured' });
  try {
    const result = await notificationService.sendPendingAlerts();
    res.json({ message: 'Sent', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Claude orchestrator
function isClaudeConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
}

// Get discovery service info
function getDiscoveryInfo() {
  try {
    const discovery = require('./services/discoveryService');
    return {
      available: true,
      cities: discovery.ALL_TARGET_CITIES?.length || 0,
      regions: Object.keys(discovery.TARGET_REGIONS || {}),
      minUnits: discovery.MIN_HOUSING_UNITS || 12
    };
  } catch (e) {
    return { available: false };
  }
}

app.get('/debug', (req, res) => {
  const scheduler = getSchedulerStatus();
  const discovery = getDiscoveryInfo();
  
  res.json({
    timestamp: new Date().toISOString(),
    build: '2026-02-11-v9-discovery-fix',
    version: '4.4.1',
    node_version: process.version,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? '(set)' : '(not set)',
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ? '(set)' : '(not set)',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '(set)' : '(not set)',
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ? '(set)' : '(not set)',
      RESEND_API_KEY: process.env.RESEND_API_KEY ? '(set)' : '(not set)'
    },
    features: {
      unified_ai_scan: isClaudeConfigured() ? 'active (Perplexity + Claude)' : 'partial (Perplexity only)',
      discovery: discovery.available ? `active (${discovery.cities} cities)` : 'loading',
      committee_tracking: 'active',
      yad2_direct_api: 'active',
      ssi_calculator: 'active',
      iai_calculator: 'active',
      notifications: notificationService.isConfigured() ? 'active' : 'disabled',
      weekly_scanner: scheduler.enabled ? 'active' : 'disabled'
    },
    discovery: discovery,
    scan_pipeline: [
      '1. Unified AI scan (Perplexity + Claude)',
      '2. Committee approval tracking',
      '3. yad2 direct API + fallback',
      '4. SSI/IAI recalculation',
      '5. Discovery scan (NEW complexes) ⭐',
      '6. Alert generation',
      '7. Email notifications'
    ]
  });
});

app.get('/health', async (req, res) => {
  try {
    const [complexes, tx, listings, alerts] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM complexes'),
      pool.query('SELECT COUNT(*) FROM transactions'),
      pool.query('SELECT COUNT(*) FROM listings WHERE is_active = TRUE'),
      pool.query('SELECT COUNT(*) FROM alerts WHERE is_read = FALSE')
    ]);

    let committeeStats = { local: 0, district: 0 };
    try {
      const c = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL) as local,
          COUNT(*) FILTER (WHERE district_committee_date IS NOT NULL) as district
        FROM complexes
      `);
      committeeStats = { local: parseInt(c.rows[0].local), district: parseInt(c.rows[0].district) };
    } catch (e) {}

    const discovery = getDiscoveryInfo();

    res.json({
      status: 'ok',
      version: '4.4.1',
      db: 'connected',
      complexes: parseInt(complexes.rows[0].count),
      transactions: parseInt(tx.rows[0].count),
      active_listings: parseInt(listings.rows[0].count),
      committee_tracked: committeeStats,
      unread_alerts: parseInt(alerts.rows[0].count),
      discovery_cities: discovery.cities || 0,
      ai_sources: {
        perplexity: !!process.env.PERPLEXITY_API_KEY,
        claude: isClaudeConfigured()
      },
      notifications: notificationService.isConfigured() ? 'configured' : 'not_configured'
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'QUANTUM - Pinuy Binuy Investment Analyzer',
    version: '4.4.1',
    phase: 'Phase 4.4 - Discovery + Unified AI',
    endpoints: {
      health: 'GET /health',
      debug: 'GET /debug',
      projects: 'GET /api/projects',
      project: 'GET /api/projects/:id',
      opportunities: 'GET /api/opportunities',
      stressedSellers: 'GET /api/stressed-sellers',
      dashboard: 'GET /api/dashboard',
      scanUnified: 'POST /api/scan/unified',
      scanDiscovery: 'POST /api/scan/discovery ⭐',
      scanDiscoveryStatus: 'GET /api/scan/discovery/status',
      scanDiscoveryRecent: 'GET /api/scan/discovery/recent',
      scanCommittee: 'POST /api/scan/committee',
      scanYad2: 'POST /api/scan/yad2',
      scanMavat: 'POST /api/scan/mavat',
      scanNadlan: 'POST /api/scan/nadlan',
      scanBenchmark: 'POST /api/scan/benchmark',
      scanWeekly: 'POST /api/scan/weekly',
      alerts: 'GET /api/alerts',
      scheduler: 'GET /api/scheduler'
    }
  });
});

app.use((err, req, res, _next) => {
  logger.error(`Error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  const dbReady = await initDatabase();
  if (dbReady) {
    const { startScheduler } = require('./jobs/weeklyScanner');
    startScheduler();
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`QUANTUM API v4.4.1 running on port ${PORT}`);
    logger.info(`AI Sources: Perplexity=${!!process.env.PERPLEXITY_API_KEY}, Claude=${isClaudeConfigured()}`);
    const discovery = getDiscoveryInfo();
    if (discovery.available) {
      logger.info(`Discovery: ${discovery.cities} target cities, min ${discovery.minUnits} units`);
    }
    logger.info(`Notifications: ${notificationService.isConfigured() ? notificationService.getProvider() : 'disabled'}`);
  });
}

start();

module.exports = app;
