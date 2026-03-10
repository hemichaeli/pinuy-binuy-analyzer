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
const VERSION = '4.90.0';
const BUILD = '2026-03-10-v4.90.0-professional-visits';

async function runAutoMigrations() {
  try {
    logger.info('[MIGRATIONS] Running auto-migrations...');
    const migFile = path.join(__dirname, 'db', 'auto_migrations.sql');
    if (!fs.existsSync(migFile)) { logger.warn('[MIGRATIONS] No auto_migrations.sql found'); return; }
    const sql = fs.readFileSync(migFile, 'utf8');
    await pool.query(sql);
    logger.info('[MIGRATIONS] Auto-migrations completed');
  } catch (err) { logger.error('[MIGRATIONS] Failed:', err.message); }
}

async function runSchedulingMigrations() {
  try {
    const schemaFile = path.join(__dirname, 'models', 'schedulingSchema.sql');
    if (fs.existsSync(schemaFile)) {
      const sql = fs.readFileSync(schemaFile, 'utf8');
      await pool.query(sql);
      logger.info('[MIGRATIONS] Scheduling schema applied');
    }
  } catch (err) { logger.error('[MIGRATIONS] Scheduling schema failed:', err.message); }
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
      scriptSrcAttr: ["'unsafe-inline'"],
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
    req.path.startsWith('/booking/') || req.path.startsWith('/cal/') || req.path.startsWith('/api/kones/') ||
    req.path.startsWith('/api/appointments/') || req.path.startsWith('/api/test/') ||
    req.path.startsWith('/api/visits/'),
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
    { path: '/cal', file: 'routes/calRoute.js' },
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
    { path: '/api/kones', file: 'routes/konesRoutes.js' },
    { path: '/api/appointments', file: 'routes/appointmentRoutes.js' },
    { path: '/api', file: 'routes/whatsappWebhookRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappAlertRoutes.js' },
    { path: '/api/whatsapp', file: 'routes/whatsappRoutes.js' },
    { path: '/api/scheduling', file: 'routes/schedulingRoutes.js' },
    { path: '/api/scheduling', file: 'routes/professionalVisitRoutes.js' },   // ← NEW v4.90
    { path: '/api/scheduling/calendar', file: 'routes/calendarRoutes.js' },
    { path: '/api/test/optimization', file: 'routes/optimizationTestRoute.js' },
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
      routeLoadResults.push({ path: routePath, status: 'ok', file });
    } catch (err) {
      routeLoadResults.push({ path: routePath, status: 'failed', error: err.message, file });
    }
  }
}

function loadBackupRoutes() {
  try {
    const { createFullBackup, getBackupStats, restoreFromBackup } = require('./services/backupService');
    app.post('/api/backup/create', async (req, res) => {
      try { const result = await createFullBackup(); res.json({ success: true, backup: result }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.get('/api/backup/list', async (req, res) => {
      try { const stats = await getBackupStats(); res.json({ success: true, stats }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.post('/api/backup/restore/:timestamp', async (req, res) => {
      try {
        if (!req.body.confirmed) return res.status(400).json({ success: false, error: 'Confirmation required' });
        const result = await restoreFromBackup(`quantum_backup_${req.params.timestamp}.sql.gz`, { confirmed: true });
        res.json({ success: true, result });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
    const { runAutoFirstContact, runKonesAutoContact, getContactStats, getKonesContactStats } = require('./services/autoFirstContactService');
    app.get('/api/auto-contact/stats', async (req, res) => {
      try { res.json({ success: true, ...await getContactStats() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.get('/api/auto-contact/kones-stats', async (req, res) => {
      try { res.json({ success: true, kones: await getKonesContactStats() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.post('/api/auto-contact/run', async (req, res) => {
      try { res.json({ success: true, result: await runAutoFirstContact() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.post('/api/auto-contact/run-kones', async (req, res) => {
      try { res.json({ success: true, result: await runKonesAutoContact() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    routeLoadResults.push({ path: '/api/auto-contact', status: 'ok', file: 'services/autoFirstContactService.js' });
    logger.info('[AutoContact] API routes loaded');
  } catch (err) {
    routeLoadResults.push({ path: '/api/auto-contact', status: 'failed', error: err.message, file: 'services/autoFirstContactService.js' });
    logger.error('[AutoContact] Failed to load routes:', err.message);
  }
}

const VAPI_QUANTUM_KEYTERMS = [
  'פינוי-בינוי', 'ועדה מקומית', 'כינוס נכסים', 'פרמיה',
  'דייר סרבן', 'יזם', 'נסח טאבו', 'QUANTUM', 'קוונטום',
  'תשואה', 'השקעה', 'תמורה', 'חוזה פינוי', 'בעל נכס', 'שמאי',
  'דירת תמורה', 'רישום בטאבו', 'פרויקט', 'מתחם', 'הסכם פינוי',
];

const VAPI_AGENT_IDS = [
  process.env.VAPI_ASSISTANT_SELLER,
  process.env.VAPI_ASSISTANT_BUYER,
  process.env.VAPI_ASSISTANT_REMINDER,
  process.env.VAPI_ASSISTANT_COLD,
  process.env.VAPI_ASSISTANT_INBOUND,
];

async function checkVapiKeytermsSupport() {
  const apiKey = process.env.VAPI_API_KEY;
  const testId = process.env.VAPI_ASSISTANT_COLD;
  if (!apiKey || !testId) return;
  logger.info('[VapiKeyterms] Checking if Vapi supports keyterms...');
  try {
    const axios = require('axios');
    const testBody = { transcriber: { provider: 'deepgram', model: 'nova-3', language: 'he', keyterms: ['פינוי-בינוי', 'QUANTUM'] } };
    const resp = await axios.patch(`https://api.vapi.ai/assistant/${testId}`, testBody, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    const returned = resp.data?.transcriber?.keyterms;
    if (Array.isArray(returned) && returned.length > 0) {
      logger.info('[VapiKeyterms] SUPPORTED! Applying keyterms to all 5 agents...');
      const fullBody = { transcriber: { provider: 'deepgram', model: 'nova-3', language: 'he', keyterms: VAPI_QUANTUM_KEYTERMS } };
      let success = 0;
      for (const agentId of VAPI_AGENT_IDS) {
        if (!agentId) continue;
        try { await axios.patch(`https://api.vapi.ai/assistant/${agentId}`, fullBody, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }); success++; } catch (e) { logger.warn(`[VapiKeyterms] Failed to update agent ${agentId}:`, e.message); }
      }
    } else {
      logger.info('[VapiKeyterms] Not yet supported - will check again in 3 days');
    }
  } catch (err) {
    logger.warn('[VapiKeyterms] Check error:', err.response?.data?.message || err.message);
  }
}

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM complexes');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected', complexes: parseInt(result.rows[0].count), version: VERSION });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message, version: VERSION });
  }
});

app.get('/api/complexes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const { rows } = await pool.query(
      `SELECT id, name, address, city, iai_score, ssi_score, status, units_count, property_type, enrichment_status, developer
       FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT $1`, [limit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug', async (req, res) => {
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  let backupStatus = 'unknown';
  try { const { getBackupStats } = require('./services/backupService'); const s = await getBackupStats(); backupStatus = `active (${s.totalBackups} backups, ${s.totalSizeMB}MB)`; } catch (e) { backupStatus = 'failed'; }
  let notificationStats = {};
  try { notificationStats = require('./services/notificationService').getStats(); } catch (e) {}
  let optimizationStats = {};
  try { const { rows } = await pool.query(`SELECT status, COUNT(*) AS total FROM reschedule_requests GROUP BY status`); optimizationStats = Object.fromEntries(rows.map(r => [r.status, parseInt(r.total)])); } catch (e) {}
  let gcalStatus = 'not configured';
  try { const gcal = require('./services/googleCalendarService'); gcalStatus = gcal.isConfigured() ? `configured (${process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL})` : 'credentials missing'; } catch (e) { gcalStatus = 'service error'; }
  let zcalStatus = 'not configured';
  try { const zcal = require('./services/zohoCalendarService'); zcalStatus = zcal.isConfigured() ? 'configured (Zoho OAuth)' : 'credentials missing'; } catch (e) { zcalStatus = 'service error'; }
  res.json({
    version: VERSION, build: BUILD, timestamp: new Date().toISOString(),
    campaign_admin_panel: 'active at GET /api/scheduling/admin',
    professional_visits: 'active at POST /api/scheduling/visits | POST /api/scheduling/pre-register',
    schedule_optimization: `active - cron 20:00 Sun-Thu + 22:30 expire | ${JSON.stringify(optimizationStats)}`,
    google_calendar: gcalStatus,
    zoho_calendar: zcalStatus,
    incoming_whatsapp_poll: 'active - every 60s via INFORU PullData',
    routes: { loaded: loaded.map(r => r.path + ' (' + r.file + ')'), failed: failed.map(r => ({ path: r.path, error: r.error })) }
  });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

async function start() {
  logger.info(`=== QUANTUM ANALYZER ${VERSION} ===`);
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

  try { const gcal = require('./services/googleCalendarService'); if (gcal.isConfigured()) { logger.info(`[GCal] Configured`); } } catch (e) {}
  try { const zcal = require('./services/zohoCalendarService'); if (zcal.isConfigured()) { logger.info('[ZohoCal] Configured'); } } catch (e) {}

  try {
    const { initialize: initAutoContact, runAutoFirstContact, runKonesAutoContact } = require('./services/autoFirstContactService');
    await initAutoContact();
    const cron = require('node-cron');
    cron.schedule('*/30 * * * *', async () => { try { await runAutoFirstContact(); } catch (e) { logger.warn('[AutoContact] Cron error:', e.message); } });
    cron.schedule('45 7 * * *', async () => { try { await runKonesAutoContact(); } catch (e) { logger.warn('[KonesContact] Cron error:', e.message); } });
    logger.info('[AutoContact] ACTIVE - every 30 min');
  } catch (e) { logger.warn('[AutoContact] Failed to start:', e.message); }

  try { const { startOptimizationCron } = require('./cron/optimizationCron'); startOptimizationCron(); logger.info('[ScheduleOptimization] ACTIVE'); } catch (e) { logger.warn('[ScheduleOptimization] Failed:', e.message); }

  try {
    const { pollIncomingWhatsApp } = require('./cron/incomingWhatsAppCron');
    const cron = require('node-cron');
    cron.schedule('* * * * *', async () => { try { await pollIncomingWhatsApp(); } catch (e) { logger.warn('[IncomingWA] Cron error:', e.message); } });
    logger.info('[IncomingWA] ACTIVE - polling INFORU every 60s');
  } catch (e) { logger.warn('[IncomingWA] Failed to start:', e.message); }

  try {
    const cron = require('node-cron');
    cron.schedule('0 9 */3 * *', async () => { try { await checkVapiKeytermsSupport(); } catch (e) { logger.warn('[VapiKeyterms] Cron error:', e.message); } });
    logger.info('[VapiKeyterms] Checker ACTIVE - every 3 days at 09:00');
  } catch (e) { logger.warn('[VapiKeyterms] Failed to start checker:', e.message); }

  try { const konesIsraelService = require('./services/konesIsraelService'); const cron = require('node-cron'); cron.schedule('15 7 * * *', async () => { try { await konesIsraelService.runKonesonlineScrape(); } catch (e) {} }); } catch (e) {}

  try {
    const cron = require('node-cron');
    cron.schedule('*/15 * * * *', async () => {
      try {
        const { rows: stale } = await pool.query(`SELECT a.* FROM appointments a WHERE a.status='whatsapp_sent' AND a.created_at < NOW() - INTERVAL '1 hour' AND a.vapi_call_id IS NULL LIMIT 5`);
        if (!stale.length) return;
        const axios = require('axios');
        const apiKey = process.env.VAPI_API_KEY, phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
        const assistantId = process.env.VAPI_ASSISTANT_COLD || process.env.VAPI_ASSISTANT_SELLER;
        if (!apiKey || !phoneNumberId) return;
        for (const appt of stale) {
          const p = appt.phone.replace(/\D/g,''); const ip = p.startsWith('0') ? '+972'+p.slice(1) : '+'+p;
          const r = await axios.post('https://api.vapi.ai/call/phone', { phoneNumberId, assistantId, customer: { number: ip, name: appt.lead_name||'לקוח' }, assistantOverrides: { variableValues: { appointment_id: appt.id.toString() } } }, { headers: { Authorization: `Bearer ${apiKey}` } });
          await pool.query(`UPDATE appointments SET status='vapi_called', vapi_call_id=$1 WHERE id=$2`, [r.data?.id, appt.id]);
        }
      } catch (e) {}
    });
  } catch (e) {}

  try { const { initializeBackupService } = require('./services/backupService'); await initializeBackupService(); } catch (e) {}

  try { const { processReminderQueue } = require('./jobs/reminderJob'); const cron = require('node-cron');
    cron.schedule('* * * * *', async () => { try { await processReminderQueue(); } catch (e) {} });
    logger.info('Reminder queue: ACTIVE');
  } catch (e) {}

  try { require('./jobs/weeklyScanner').startScheduler(); } catch (e) {}
  try { require('./jobs/stuckScanWatcher').startWatcher(); } catch (e) {}
  try { require('./jobs/discoveryScheduler').startDiscoveryScheduler(); } catch (e) {}
  try { require('./jobs/appointmentFallbackJob').initialize(); } catch (e) {}

  const scraperDefs = [
    { name: 'Komo', module: './services/komoScraper', cron: '0 8 * * *', fn: 'scanAll' },
    { name: 'BankNadlan', module: './services/bankNadlanScraper', cron: '15 8 * * *', fn: 'scanAll' },
    { name: 'Yad1', module: './services/yad1Scraper', cron: '30 8 * * *', fn: 'scanAll' },
    { name: 'Dira', module: './services/diraScraper', cron: '45 8 * * *', fn: 'scanAll' },
    { name: 'Kones2', module: './services/kones2Scraper', cron: '0 9 * * *', fn: 'scanAll' },
    { name: 'BidSpirit', module: './services/bidspiritScraper', cron: '15 9 * * *', fn: 'scanAll' },
    { name: 'Govmap', module: './services/govmapScraper', cron: '0 7 * * 1', fn: 'scanAll' },
  ];
  for (const def of scraperDefs) {
    try { const scraper = require(def.module); const cron = require('node-cron'); cron.schedule(def.cron, async () => { try { await scraper[def.fn](); } catch (e) {} }); logger.info(`[${def.name}Scraper] ACTIVE`); } catch (e) {}
  }

  app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION }));
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: err.message, version: VERSION }); });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT} | ${loaded.length} routes loaded`);
  });
}

start();
module.exports = app;
