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
const VERSION = '4.64.0';
const BUILD = '2026-03-07-v4.64.0-visual-booking-calendar-sequential-fill';

// What's in this version:
// - NEW: Visual booking calendar at /booking/:token (mobile-first, RTL/LTR)
// - NEW: Sequential fill algorithm - prevents scheduling gaps in time blocks
// - NEW: show_rep_name / show_station_number configurable per campaign
// - NEW: Google Calendar link in WhatsApp confirmation
// - FIX: NULL campaignId SQL bug (IS NOT DISTINCT FROM)
// - FIX: Combined date+time slot selection (1 step)
// - NEW: Campaign report endpoint /api/scheduling/campaign/:id/report
// All previous: Search, CRM, Analytics, Users, Docs, Export, Notifications, Dashboard V5

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

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    }
  }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token'] }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  skip: (req) =>
    req.path.startsWith('/api/intelligence') || req.path === '/health' || req.path === '/api/debug' ||
    req.path.startsWith('/api/whatsapp/') || req.path.startsWith('/api/vapi/webhook') ||
    req.path.startsWith('/api/scheduling/') || req.path.startsWith('/api/backup/') ||
    req.path.startsWith('/api/notifications/') || req.path.startsWith('/api/search/') ||
    req.path.startsWith('/api/docs') || req.path.startsWith('/api/auto-contact') ||
    req.path.startsWith('/booking/'),
  message: { error: 'Too many requests, please try again later' }
});
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
    { path: '/sandbox', file: 'routes/sandboxRoute.js' },
    { path: '/booking', file: 'routes/bookingRoute.js' },
    { path: '/api/projects', file: 'routes/projects.js' },
    { path: '/api', file: 'routes/opportunities.js' },
    { path: '/api/scan', file: 'routes/scan.js' },
    { path: '/api/alerts', file: 'routes/alerts.js' },
    { path: '/api/leads', file: 'routes/leadRoutes.js' },
    { path: '/api/dashboard', file: 'routes/dashboardRoutes.js' },
    { path: '/api/chat', file: 'routes/chatRoutes.js' },
    { path: '/api/intelligence', file: 'routes/intelligenceRoutes.js' },
    { path: '/api/facebook', file: 'routes/facebookRoute.js' },
    { path: '/api/messaging', file: 'routes/messagingRoutes.js' },
    { path: '/api/morning', file: 'routes/morningReportRoutes.js' },
    { path: '/api/vapi', file: 'routes/vapiRoutes.js' },
    { path: '/api/inforu', file: 'routes/inforuRoutes.js' },
    { path: '/api', file: 'routes/whatsappWebhookRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappAlertRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappRoutes.js' },
    { path: '/api/scheduling', file: 'routes/schedulingRoutes.js' },
    { path: '/api/notifications', file: 'routes/notificationRoutes.js' },
    { path: '/api/export', file: 'routes/exportRoutes.js' },
    { path: '/api/search', file: 'routes/searchRoutes.js' },
    { path: '/api/crm', file: 'routes/crmRoutes.js' },
    { path: '/api/analytics', file: 'routes/analyticsRoutes.js' },
    { path: '/api/users', file: 'routes/userRoutes.js' },
    { path: '/api/docs', file: 'routes/docsRoute.js' },
  ];

  for (const { path: routePath, file } of routeFiles) {
    try {
      const fullPath = require.resolve(`./${file}`);
      delete require.cache[fullPath];
      const router = require(`./${file}`);
      app.use(routePath, router);
      routeLoadResults.push({ path: routePath, status: 'ok' , file });
    } catch (err) {
      routeLoadResults.push({ path: routePath, status: 'failed', error: err.message, file });
    }
  }
}

function loadBackupRoutes() {
  try {
    const { createFullBackup, getBackupStats, restoreFromBackup } = require('./services/backupService');
    
    app.post('/api/backup/create', async (req, res) => {
      try {
        const result = await createFullBackup();
        res.json({ success: true, message: 'Backup created successfully', backup: result, timestamp: new Date().toISOString() });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Backup creation failed', message: error.message });
      }
    });

    app.get('/api/backup/list', async (req, res) => {
      try {
        const stats = await getBackupStats();
        res.json({ success: true, stats: stats, timestamp: new Date().toISOString() });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to list backups', message: error.message });
      }
    });

    app.post('/api/backup/restore/:timestamp', async (req, res) => {
      try {
        const { timestamp } = req.params;
        const { confirmed } = req.body;
        if (!confirmed) return res.status(400).json({ success: false, error: 'Confirmation required' });
        const result = await restoreFromBackup(`quantum_backup_${timestamp}.sql.gz`, { confirmed: true });
        res.json({ success: true, result: result, timestamp: new Date().toISOString() });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Restore operation failed', message: error.message });
      }
    });
    
    routeLoadResults.push({ path: '/api/backup', status: 'ok', file: 'services/backupService.js' });
    logger.info('[BACKUP API] Backup API routes loaded successfully');
  } catch (err) {
    routeLoadResults.push({ path: '/api/backup', status: 'failed', error: err.message, file: 'services/backupService.js' });
    logger.error('[BACKUP API] Failed to load backup API routes:', err.message);
  }
}

function loadAutoContactRoutes() {
  try {
    const { runAutoFirstContact, getContactStats } = require('./services/autoFirstContactService');

    app.get('/api/auto-contact/stats', async (req, res) => {
      try {
        const stats = await getContactStats();
        res.json({ success: true, ...stats });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    app.post('/api/auto-contact/run', async (req, res) => {
      try {
        logger.info('[AutoContact] Manual trigger via API');
        const result = await runAutoFirstContact();
        res.json({ success: true, result, timestamp: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    routeLoadResults.push({ path: '/api/auto-contact', status: 'ok', file: 'services/autoFirstContactService.js' });
    logger.info('[AutoContact] API routes loaded: /api/auto-contact/stats, /api/auto-contact/run');
  } catch (err) {
    routeLoadResults.push({ path: '/api/auto-contact', status: 'failed', error: err.message, file: 'services/autoFirstContactService.js' });
    logger.error('[AutoContact] Failed to load routes:', err.message);
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
  
  let backupStatus = 'unknown';
  try {
    const { getBackupStats } = require('./services/backupService');
    const stats = await getBackupStats();
    backupStatus = `active (${stats.totalBackups} backups, ${stats.totalSizeMB}MB)`;
  } catch (error) {
    backupStatus = 'failed to initialize';
  }

  let notificationStats = {};
  try {
    const ns = require('./services/notificationService');
    notificationStats = ns.getStats();
  } catch (e) { /* ignore */ }
  
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
    sandbox: 'active at /sandbox',
    visual_booking: 'active at /booking/:token',
    auto_first_contact: 'active (cron every 30min)',
    notifications_sse: `active (${notificationStats.connected_clients || 0} clients connected)`,
    export_api: 'active - leads/complexes/messages/ads/full-report',
    search_api: 'active - global/suggestions/saved/history',
    crm_api: 'active - calls/reminders/deals/pipeline/stats',
    analytics_api: 'active - overview/leads/market/performance/revenue',
    users_api: 'active - users/login/logout/roles/activity',
    api_docs: 'active at /api/docs (Swagger UI)',
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
  loadAutoContactRoutes();

  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info('=== ROUTE LOADING SUMMARY ===');
  loaded.forEach(r => logger.info(`  OK: ${r.path} (${r.file})`));
  failed.forEach(r => logger.error(`  FAILED: ${r.path} (${r.file}) -> ${r.error}`));

  try {
    const { initialize: initAutoContact, runAutoFirstContact } = require('./services/autoFirstContactService');
    await initAutoContact();
    const cron = require('node-cron');
    cron.schedule('*/30 * * * *', async () => {
      try { await runAutoFirstContact(); } catch (e) { logger.warn('[AutoContact] Cron error:', e.message); }
    });
    logger.info('[AutoContact] ACTIVE - cron every 30 minutes');
  } catch (e) {
    logger.warn('[AutoContact] Failed to start:', e.message);
  }

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

  logger.info('WhatsApp: WEBHOOK mode active');
  logger.info('Visual Booking: ACTIVE at /booking/:token');
  logger.info('Auto First Contact: ACTIVE (P0) - cron every 30min');

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Routes: ${loaded.length} loaded, ${failed.length} failed`);
  });
}

start();
module.exports = app;
