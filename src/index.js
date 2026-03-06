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
const VERSION = '4.58.0';
const BUILD = '2026-03-06-v4.58.0-dashboard-v5-complete-facebook-integration';

// What's in this version:
// - NEW: Dashboard V5 - Complete 6 tabs with full functionality
// - NEW: Facebook Marketing API integration with real-time sync
// - NEW: WhatsApp to Leads conversion pipeline
// - NEW: Complete CRM functionality in dashboard
// - All previous: scheduling system, WhatsApp webhook, dashboard redesign, Vapi, PostgreSQL

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

async function runSchedulingMigrations() {
  try {
    const schemaFile = path.join(__dirname, 'models', 'schedulingSchema.sql');
    if (fs.existsSync(schemaFile)) {
      const sql = fs.readFileSync(schemaFile, 'utf8');
      await pool.query(sql);
      logger.info('[MIGRATIONS] Scheduling schema applied');
    }
  } catch (err) {
    logger.error('[MIGRATIONS] Scheduling schema failed:', err.message);
  }
}

// Helmet with custom CSP - allows dashboard inline scripts + external resources
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    }
  }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path.startsWith('/api/intelligence') || req.path === '/health' || req.path === '/api/debug' || req.path.startsWith('/api/whatsapp/') || req.path.startsWith('/api/vapi/webhook') || req.path.startsWith('/api/scheduling/') || req.path.startsWith('/api/backup/'), message: { error: 'Too many requests, please try again later' } });
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
    { path: '/api/facebook', file: 'routes/facebookRoute.js' },  // FIXED: Corrected filename
    { path: '/api/messaging', file: 'routes/messagingRoutes.js' },
    { path: '/api/morning', file: 'routes/morningReportRoutes.js' },
    { path: '/api/vapi', file: 'routes/vapiRoutes.js' },
    { path: '/api/inforu', file: 'routes/inforuRoutes.js' },
    { path: '/api', file: 'routes/whatsappWebhookRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappAlertRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappRoutes.js' },
    { path: '/api/scheduling', file: 'routes/schedulingRoutes.js' },
  ];

  for (const { path: routePath, file } of routeFiles) {
    try {
      const fullPath = require.resolve(`./${file}`);
      delete require.cache[fullPath];
      const router = require(`./${file}`);
      app.use(routePath, router);
      routeLoadResults.push({ path: routePath, status: 'ok', file });
    } catch (err) {
      routeLoadResults.push({ path: routePath, status: 'failed', error: err.message, file });
    }
  }
}

// Initialize backup service API routes
function loadBackupRoutes() {
  try {
    const { 
      createFullBackup, 
      getBackupStats, 
      restoreFromBackup 
    } = require('./services/backupService');
    
    // Manual backup endpoint
    app.post('/api/backup/create', async (req, res) => {
      try {
        logger.info('[BACKUP API] Manual backup requested');
        const result = await createFullBackup();
        res.json({
          success: true,
          message: 'Backup created successfully',
          backup: result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('[BACKUP API] Manual backup failed:', error);
        res.status(500).json({
          success: false,
          error: 'Backup creation failed',
          message: error.message
        });
      }
    });

    // List backups endpoint
    app.get('/api/backup/list', async (req, res) => {
      try {
        const stats = await getBackupStats();
        res.json({
          success: true,
          stats: stats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('[BACKUP API] Failed to list backups:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to list backups',
          message: error.message
        });
      }
    });

    // Restore from backup endpoint (DANGEROUS)
    app.post('/api/backup/restore/:timestamp', async (req, res) => {
      try {
        const { timestamp } = req.params;
        const { confirmed } = req.body;
        
        if (!confirmed) {
          return res.status(400).json({
            success: false,
            error: 'Confirmation required',
            message: 'Database restore is a dangerous operation that requires explicit confirmation'
          });
        }
        
        const result = await restoreFromBackup(`quantum_backup_${timestamp}.sql.gz`, { confirmed: true });
        res.json({
          success: true,
          result: result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('[BACKUP API] Restore failed:', error);
        res.status(500).json({
          success: false,
          error: 'Restore operation failed',
          message: error.message
        });
      }
    });
    
    routeLoadResults.push({ path: '/api/backup', status: 'ok', file: 'services/backupService.js' });
    logger.info('[BACKUP API] Backup API routes loaded successfully');
  } catch (err) {
    routeLoadResults.push({ path: '/api/backup', status: 'failed', error: err.message, file: 'services/backupService.js' });
    logger.error('[BACKUP API] Failed to load backup API routes:', err.message);
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

// /api/complexes alias for dashboard (was 404 - dashboard called this directly)
app.get('/api/complexes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const { rows } = await pool.query(
      `SELECT id, name, address, city, iai_score, ssi_score, status, units_count, property_type, enrichment_status, developer
       FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug', async (req, res) => {
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  
  // Get backup service status
  let backupStatus = 'unknown';
  try {
    const { getBackupStats } = require('./services/backupService');
    const stats = await getBackupStats();
    backupStatus = `active (${stats.totalBackups} backups, ${stats.totalSizeMB}MB)`;
  } catch (error) {
    backupStatus = 'failed to initialize';
  }
  
  res.json({
    version: VERSION,
    build: BUILD,
    timestamp: new Date().toISOString(),
    whatsapp_mode: 'webhook_push',
    webhook_url: 'https://pinuy-binuy-analyzer-production.up.railway.app/api/whatsapp/webhook',
    backup_service: backupStatus,
    email_notifications: 'disabled',
    facebook_integration: 'active',
    dashboard_v5: 'complete_6_tabs',
    routes: {
      loaded: loaded.map(r => r.path + ' (' + r.file + ')'),
      failed: failed.map(r => ({ path: r.path, file: r.file, error: r.error }))
    }
  });
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

async function start() {
  logger.info(`=== QUANTUM ANALYZER ${VERSION} ===`);
  logger.info(`Build: ${BUILD}`);

  await runAutoMigrations();
  await runSchedulingMigrations();
  loadAllRoutes();
  loadBackupRoutes();

  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info(`=== ROUTE LOADING SUMMARY ===`);
  loaded.forEach(r => logger.info(`  OK: ${r.path} (${r.file})`));
  failed.forEach(r => logger.error(`  FAILED: ${r.path} (${r.file}) -> ${r.error}`));

  // Initialize backup service
  try {
    const { initializeBackupService } = require('./services/backupService');
    const backupResult = await initializeBackupService();
    logger.info(`[BACKUP] Service initialized: ${backupResult.stats.totalBackups} backups, ${backupResult.stats.totalSizeMB}MB`);
  } catch (error) {
    logger.error('[BACKUP] Failed to initialize backup service:', error.message);
  }

  app.use((req, res) => { res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION }); });
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: 'Internal Server Error', message: err.message, version: VERSION }); });

  try { const { startScheduler } = require('./jobs/weeklyScanner'); startScheduler(); } catch (e) { logger.warn('Scheduler failed to start:', e.message); }
  try { const { startWatcher } = require('./jobs/stuckScanWatcher'); startWatcher(); } catch (e) { logger.warn('Stuck scan watcher failed to start:', e.message); }
  try { const { startDiscoveryScheduler } = require('./jobs/discoveryScheduler'); startDiscoveryScheduler(); } catch (e) { logger.warn('Discovery scheduler failed to start:', e.message); }

  try {
    const { processReminderQueue } = require('./jobs/reminderJob');
    const cron = require('node-cron');
    cron.schedule('* * * * *', async () => {
      try { await processReminderQueue(); } catch (e) { logger.warn('[ReminderJob] Error:', e.message); }
    });
    logger.info('Reminder queue job: ACTIVE (every minute)');
  } catch (e) { logger.warn('Reminder job failed to start:', e.message); }

  logger.info('WhatsApp: WEBHOOK mode active at /api/whatsapp/webhook');
  logger.info('Facebook: Marketing API integration active');
  logger.info('Email notifications: DISABLED as requested');
  logger.info('Backup service: ACTIVE (hourly backups, 6-month retention)');

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Routes: ${loaded.length} loaded, ${failed.length} failed`);
    logger.info(`Dashboard V5: /dashboard (complete 6 tabs)`);
    logger.info(`Facebook API: /api/facebook/{sync,ads,campaigns,webhook}`);
    logger.info(`Backup API: /api/backup/{create,list,restore}`);
  });
}

start();
module.exports = app;