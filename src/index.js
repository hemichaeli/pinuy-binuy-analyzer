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
const VERSION = '5.2.0';
const BUILD = '2026-03-28-multilingual-newsletter';

// ── START_MODE: 'quantum' | 'minhelet' | 'both' (default: 'both') ─────────────
const START_MODE = (process.env.START_MODE || 'both').toLowerCase();
const isQuantum  = START_MODE === 'quantum' || START_MODE === 'both';
const isMinhelet = START_MODE === 'minhelet' || START_MODE === 'both';

logger.info(`=== START_MODE: ${START_MODE.toUpperCase()} | quantum=${isQuantum} minhelet=${isMinhelet} ===`);

// ── Migrations ─────────────────────────────────────────────────────────────────

async function runAutoMigrations() {
  try {
    const migFile = path.join(__dirname, 'db', 'auto_migrations.sql');
    if (!fs.existsSync(migFile)) return;
    await pool.query(fs.readFileSync(migFile, 'utf8'));
    logger.info('[MIGRATIONS] Auto-migrations completed');
  } catch (err) { logger.error('[MIGRATIONS] Failed:', err.message); }
}

async function runMigrationFile(label, filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    await pool.query(fs.readFileSync(filePath, 'utf8'));
    logger.info(`[MIGRATIONS] ${label} applied`);
  } catch (err) { logger.error(`[MIGRATIONS] ${label} failed:`, err.message); }
}

async function runOutreachMigration() {
  try {
    await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS call_scheduled_at TIMESTAMPTZ;`);
    logger.info('[MIGRATIONS] Outreach columns applied');
  } catch (err) { logger.error('[MIGRATIONS] Outreach migration failed:', err.message); }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
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
    req.path.startsWith('/api/vapi/book-slot') ||
    req.path.startsWith('/api/scheduling/') || req.path.startsWith('/api/backup/') ||
    req.path.startsWith('/api/notifications/') || req.path.startsWith('/api/search/') ||
    req.path.startsWith('/api/docs') || req.path.startsWith('/api/auto-contact') ||
    req.path.startsWith('/booking/') || req.path.startsWith('/cal/') || req.path.startsWith('/api/kones/') ||
    req.path.startsWith('/api/appointments/') || req.path.startsWith('/api/test/') ||
    req.path.startsWith('/api/visits/') || req.path.startsWith('/api/campaigns/') ||
    req.path.startsWith('/events/') || req.path.startsWith('/api/events/') ||
    req.path.startsWith('/pro/') || req.path.startsWith('/attend/') ||
    req.path.startsWith('/api/outreach/') ||
    req.path.startsWith('/api/comms/') ||
    req.path.startsWith('/api/morning/') ||
    req.path.startsWith('/api/newsletter/'),
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const d = Date.now() - start;
    if (req.path !== '/health' && !req.path.startsWith('/api/debug')) {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${d}ms`);
    }
  });
  next();
});

const routeLoadResults = [];

// ── Route loader ───────────────────────────────────────────────────────────────

function loadRoute(routePath, file) {
  try {
    const fullPath = require.resolve(`./${file}`);
    delete require.cache[fullPath];
    app.use(routePath, require(`./${file}`));
    routeLoadResults.push({ path: routePath, status: 'ok', file });
  } catch (err) {
    routeLoadResults.push({ path: routePath, status: 'failed', error: err.message, file });
  }
}

function loadAllRoutes() {
  // ── SHARED: loaded for both QUANTUM and MINHELET ────────────────────────────
  const shared = [
    { path: '/api/vapi',               file: 'routes/vapiRoutes.js' },
    { path: '/api/inforu',             file: 'routes/inforuRoutes.js' },
    { path: '/api',                    file: 'routes/whatsappWebhookRoutes.js' },
    { path: '/api/whatsapp',           file: 'routes/whatsappAlertRoutes.js' },
    { path: '/api/whatsapp',           file: 'routes/whatsappRoutes.js' },
    { path: '/api',                    file: 'routes/whatsappAnalyticsRoutes.js' },
    { path: '/api',                    file: 'routes/whatsappDashboardRoutes.js' },
    { path: '/api',                    file: 'routes/quantumWhatsAppRoutes.js' },
    { path: '/api/users',              file: 'routes/userRoutes.js' },
    { path: '/api/docs',               file: 'routes/docsRoute.js' },
    { path: '/api/search',             file: 'routes/searchRoutes.js' },
    { path: '/api/comms',              file: 'routes/unifiedCommsRoutes.js' },
  ];

  // ── QUANTUM only: listings, IAI/SSI, scrapers, outreach, morning report ─────
  const quantumRoutes = [
    { path: '/dashboard',              file: 'routes/dashboardRoute.js' },
    { path: '/sandbox',                file: 'routes/sandboxRoute.js' },
    { path: '/api/projects',           file: 'routes/projects.js' },
    { path: '/api',                    file: 'routes/opportunities.js' },
    { path: '/api/scan',               file: 'routes/scan.js' },
    { path: '/api/alerts',             file: 'routes/alerts.js' },
    { path: '/api/leads',              file: 'routes/leadRoutes.js' },
    { path: '/api/dashboard',          file: 'routes/dashboardRoutes.js' },
    { path: '/api/chat',               file: 'routes/chatRoutes.js' },
    { path: '/api/intelligence',       file: 'routes/intelligenceRoutes.js' },
    { path: '/api/facebook',           file: 'routes/facebookRoute.js' },
    { path: '/api/facebook',           file: 'routes/facebookRoutes.js' },
    { path: '/api/messaging',          file: 'routes/messagingRoutes.js' },
    { path: '/api/morning',            file: 'routes/morningReportRoutes.js' },
    { path: '/api/kones',              file: 'routes/konesRoutes.js' },
    { path: '/api/ssi',                file: 'routes/ssiRoutes.js' },
    { path: '/api/export',             file: 'routes/exportRoutes.js' },
    { path: '/api/crm',                file: 'routes/crmRoutes.js' },
    { path: '/api/enrichment',         file: 'routes/enrichmentRoutes.js' },
    { path: '/api/analytics',          file: 'routes/analyticsRoutes.js' },
    { path: '/api/outreach',           file: 'routes/outreachRoutes.js' },
    { path: '/api/newsletter',         file: 'routes/newsletterRoutes.js' },
    { path: '/api/signatures',         file: 'routes/signatureRoutes.js' },
  ];

  // ── MINHELET only: resident coordination, scheduling, events, campaigns ──────
  const minheletRoutes = [
    { path: '/campaigns',              file: 'routes/campaignDashboardRoute.js' },
    { path: '/booking',                file: 'routes/bookingRoute.js' },
    { path: '/cal',                    file: 'routes/calRoute.js' },
    { path: '/api/appointments',       file: 'routes/appointmentRoutes.js' },
    { path: '/api/scheduling',         file: 'routes/schedulingRoutes.js' },
    { path: '/api/scheduling',         file: 'routes/professionalVisitRoutes.js' },
    { path: '/api/scheduling/calendar', file: 'routes/calendarRoutes.js' },
    { path: '/api/test/optimization',  file: 'routes/optimizationTestRoute.js' },
    { path: '/api/notifications',      file: 'routes/notificationRoutes.js' },
    { path: '/api/campaigns',          file: 'routes/campaignRoutes.js' },
    // Event Scheduler: Admin UI MUST come before scheduler (avoids :id conflict)
    { path: '/events',                 file: 'routes/eventAdminRoute.js' },
    { path: '/events',                 file: 'routes/eventSchedulerRoutes.js' },
  ];

  shared.forEach(r => loadRoute(r.path, r.file));
  if (isQuantum)  quantumRoutes.forEach(r => loadRoute(r.path, r.file));
  if (isMinhelet) minheletRoutes.forEach(r => loadRoute(r.path, r.file));

  logger.info(`[Routes] shared=${shared.length} quantum=${isQuantum ? quantumRoutes.length : 0} minhelet=${isMinhelet ? minheletRoutes.length : 0}`);
}

function loadBackupRoutes() {
  try {
    const { createFullBackup, getBackupStats, restoreFromBackup } = require('./services/backupService');
    app.post('/api/backup/create', async (req, res) => {
      try { res.json({ success: true, backup: await createFullBackup() }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.get('/api/backup/list', async (req, res) => {
      try { res.json({ success: true, stats: await getBackupStats() }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.post('/api/backup/restore/:timestamp', async (req, res) => {
      try {
        if (!req.body.confirmed) return res.status(400).json({ success: false, error: 'Confirmation required' });
        res.json({ success: true, result: await restoreFromBackup(`quantum_backup_${req.params.timestamp}.sql.gz`, { confirmed: true }) });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    routeLoadResults.push({ path: '/api/backup', status: 'ok', file: 'services/backupService.js' });
  } catch (err) {
    routeLoadResults.push({ path: '/api/backup', status: 'failed', error: err.message, file: 'services/backupService.js' });
  }
  try {
    const { createBackup, listBackups } = require('./services/githubBackupService');
    app.post('/api/backup/github/create', async (req, res) => {
      try { res.json(await createBackup()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    app.get('/api/backup/github/list', async (req, res) => {
      try { const b = await listBackups(); res.json({ success: true, count: b.length, backups: b }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
  } catch (err) { logger.warn('[BACKUP] GitHub routes failed:', err.message); }
}

function loadAutoContactRoutes() {
  if (!isQuantum) return;
  try {
    const { runAutoFirstContact, runKonesAutoContact, getContactStats, getKonesContactStats } = require('./services/autoFirstContactService');
    app.get('/api/auto-contact/stats', async (req, res) => { try { res.json({ success: true, ...await getContactStats() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
    app.get('/api/auto-contact/kones-stats', async (req, res) => { try { res.json({ success: true, kones: await getKonesContactStats() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
    app.post('/api/auto-contact/run', async (req, res) => { try { res.json({ success: true, result: await runAutoFirstContact() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
    app.post('/api/auto-contact/run-kones', async (req, res) => { try { res.json({ success: true, result: await runKonesAutoContact() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
    routeLoadResults.push({ path: '/api/auto-contact', status: 'ok', file: 'services/autoFirstContactService.js' });
  } catch (err) {
    routeLoadResults.push({ path: '/api/auto-contact', status: 'failed', error: err.message, file: 'services/autoFirstContactService.js' });
  }
}

// ── Vapi keyterms ──────────────────────────────────────────────────────────────

const VAPI_QUANTUM_KEYTERMS = [
  'פינוי-בינוי', 'ועדה מקומית', 'כינוס נכסים', 'פרמיה', 'דייר סרבן', 'יזם',
  'נסח טאבו', 'QUANTUM', 'קוונטום', 'תשואה', 'השקעה', 'תמורה', 'חוזה פינוי',
  'בעל נכס', 'שמאי', 'דירת תמורה', 'רישום בטאבו', 'פרויקט', 'מתחם', 'הסכם פינוי',
];

async function checkVapiKeytermsSupport() {
  const apiKey = process.env.VAPI_API_KEY;
  const testId = process.env.VAPI_ASSISTANT_COLD;
  if (!apiKey || !testId) return;
  try {
    const axios = require('axios');
    const resp = await axios.patch(`https://api.vapi.ai/assistant/${testId}`,
      { transcriber: { provider: 'deepgram', model: 'nova-3', language: 'he', keyterms: ['פינוי-בינוי', 'QUANTUM'] } },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    if (Array.isArray(resp.data?.transcriber?.keyterms) && resp.data.transcriber.keyterms.length > 0) {
      const agents = [process.env.VAPI_ASSISTANT_SELLER, process.env.VAPI_ASSISTANT_BUYER, process.env.VAPI_ASSISTANT_REMINDER, process.env.VAPI_ASSISTANT_COLD, process.env.VAPI_ASSISTANT_INBOUND, process.env.VAPI_ASSISTANT_SCHEDULING].filter(Boolean);
      const body = { transcriber: { provider: 'deepgram', model: 'nova-3', language: 'he', keyterms: VAPI_QUANTUM_KEYTERMS } };
      for (const id of agents) {
        try { await axios.patch(`https://api.vapi.ai/assistant/${id}`, body, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }); } catch (e) {}
      }
      logger.info('[VapiKeyterms] Applied to all agents');
    }
  } catch (err) { logger.warn('[VapiKeyterms]', err.response?.data?.message || err.message); }
}

// ── Health / version / complexes / debug ───────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) FROM complexes');
    res.json({ status: 'ok', mode: START_MODE, complexes: parseInt(r.rows[0].count), version: VERSION, build: BUILD });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message, version: VERSION });
  }
});

app.get('/api/version', (req, res) => res.json({ version: VERSION, build: BUILD, mode: START_MODE }));

app.get('/api/complexes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const { rows } = await pool.query(
      `SELECT id, name, addresses as address, city, neighborhood, iai_score, enhanced_ssi_score as ssi_score, status, existing_units as units_count, developer
       FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT $1`, [limit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug', async (req, res) => {
  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  let gcalStatus = 'not configured';
  try { const gcal = require('./services/googleCalendarService'); gcalStatus = gcal.isConfigured() ? `configured (${process.env.GOOGLE_SA_EMAIL || ''})` : 'credentials missing'; } catch (e) {}
  let escalationStatus = 'n/a';
  try { const { getEscalationMinutes } = require('./services/waBotEscalationService'); const m = await getEscalationMinutes(); escalationStatus = m === 0 ? 'disabled' : `active (${m} min)`; } catch (e) {}
  let eventStats = {};
  try { const { rows } = await pool.query('SELECT COUNT(*) AS total FROM quantum_events'); eventStats = { total_events: parseInt(rows[0].total) }; } catch (e) {}
  let outreachStats = {};
  try { const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE message_status='sent') as wa_sent, COUNT(*) FILTER (WHERE message_status='replied') as replied FROM listings WHERE is_active=TRUE`); outreachStats = rows[0]; } catch (e) {}
  let newsletterStats = {};
  try { const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE confirmed AND is_active) AS active, COUNT(DISTINCT lang) AS langs FROM newsletter_subscribers`); newsletterStats = rows[0]; } catch (e) {}
  res.json({
    version: VERSION, build: BUILD, mode: START_MODE, timestamp: new Date().toISOString(),
    quantum: isQuantum, minhelet: isMinhelet,
    google_calendar: gcalStatus,
    wa_bot_escalation: escalationStatus,
    event_scheduler: JSON.stringify(eventStats),
    outreach: JSON.stringify(outreachStats),
    newsletter: JSON.stringify(newsletterStats),
    routes: { loaded: loaded.map(r => `${r.path} (${r.file})`), failed: failed.map(r => ({ path: r.path, error: r.error })) }
  });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ── Main start ─────────────────────────────────────────────────────────────────

async function start() {
  logger.info(`=== QUANTUM ANALYZER ${VERSION} | mode=${START_MODE} ===`);

  await runAutoMigrations();
  await runMigrationFile('Scheduling schema', path.join(__dirname, 'models', 'schedulingSchema.sql'));
  await runMigrationFile('Campaigns schema', path.join(__dirname, 'db', 'migrations', 'campaigns_schema.sql'));
  await runMigrationFile('Events schema', path.join(__dirname, 'db', 'migrations', 'events_schema.sql'));
  await runMigrationFile('Enrichment (009)', path.join(__dirname, 'db', 'migrations', '009_listing_enrichment_columns.sql'));
  await runMigrationFile('Dedup (010)', path.join(__dirname, 'db', 'migrations', '010_deduplicate_listings.sql'));
  await runMigrationFile('Re-dedup (011)', path.join(__dirname, 'db', 'migrations', '011_rededuplicate_listings.sql'));
  await runMigrationFile('CRM deals (013)', path.join(__dirname, 'db', 'migrations', '013_crm_deals.sql'));
  await runMigrationFile('Perf indexes (014)', path.join(__dirname, 'db', 'migrations', '014_add_performance_indexes.sql'));
  await runMigrationFile('Newsletter (015)', path.join(__dirname, 'db', 'migrations', '015_newsletter_subscribers.sql'));
  await runMigrationFile('Newsletter lang (016)', path.join(__dirname, 'db', 'migrations', '016_newsletter_lang.sql'));
  await runMigrationFile('Multi-channel (019)', path.join(__dirname, 'db', 'migrations', '019_available_channels.sql'));
  if (isQuantum) await runOutreachMigration();

  loadAllRoutes();
  loadBackupRoutes();
  loadAutoContactRoutes();

  const loaded = routeLoadResults.filter(r => r.status === 'ok');
  const failed = routeLoadResults.filter(r => r.status === 'failed');
  logger.info(`=== ROUTES: ${loaded.length} ok / ${failed.length} failed ===`);
  failed.forEach(r => logger.error(`  FAILED: ${r.path} (${r.file}) -> ${r.error}`));

  // ── QUANTUM crons ────────────────────────────────────────────────────────────
  if (isQuantum) {
    try { const gcal = require('./services/googleCalendarService'); if (gcal.isConfigured()) logger.info('[GCal] Configured'); } catch (e) {}

    try {
      const { initialize: initAutoContact, runAutoFirstContact, runKonesAutoContact } = require('./services/autoFirstContactService');
      await initAutoContact();
      const cron = require('node-cron');
      cron.schedule('*/30 * * * *', async () => { try { await runAutoFirstContact(); } catch (e) {} });
      cron.schedule('45 7 * * *',   async () => { try { await runKonesAutoContact(); } catch (e) {} });
      logger.info('[AutoContact] ACTIVE');
    } catch (e) { logger.warn('[AutoContact] Failed:', e.message); }

    try {
      const cron = require('node-cron');
      const axios = require('axios');
      cron.schedule('*/30 * * * *', async () => {
        try { await axios.post(`http://localhost:${PORT}/api/outreach/wa-then-call-cron`, {}, { timeout: 30000 }); }
        catch (e) { if (e.code !== 'ECONNREFUSED') logger.warn('[OutreachCron]', e.message); }
      });
      logger.info('[OutreachCron] ACTIVE');
    } catch (e) {}

    try {
      const { pollIncomingWhatsApp } = require('./cron/incomingWhatsAppCron');
      const cron = require('node-cron');
      cron.schedule('* * * * *', async () => { try { await pollIncomingWhatsApp(); } catch (e) {} });
      logger.info('[IncomingWA] ACTIVE - polling INFORU every 60s');
    } catch (e) { logger.warn('[IncomingWA] Failed:', e.message); }

    try {
      const cron = require('node-cron');
      const { runEscalation } = require('./services/waBotEscalationService');
      cron.schedule('*/5 * * * *', async () => { try { await runEscalation(); } catch (e) {} });
      logger.info('[WaBotEscalation] ACTIVE');
    } catch (e) {}

    try {
      const cron = require('node-cron');
      cron.schedule('0 9 */3 * *', async () => { try { await checkVapiKeytermsSupport(); } catch (e) {} });
    } catch (e) {}

    try { require('./jobs/weeklyScanner').startScheduler(); } catch (e) {}
    try { require('./jobs/stuckScanWatcher').startWatcher(); } catch (e) {}
    try { require('./jobs/discoveryScheduler').startDiscoveryScheduler(); } catch (e) {}
    try { require('./jobs/appointmentFallbackJob').initialize(); } catch (e) {}

    try {
      const masterPipeline = require('./jobs/masterPipeline');
      masterPipeline.startScheduler();
      app.post('/api/pipeline/run', async (req, res) => {
        const st = masterPipeline.getStatus();
        if (st.isRunning) return res.json({ ok: false, message: 'Pipeline already running' });
        res.json({ ok: true, message: 'Master pipeline started' });
        masterPipeline.runMasterPipeline().catch(e => logger.error('Pipeline error', e));
      });
      app.get('/api/pipeline/status', (req, res) => res.json(masterPipeline.getStatus()));
      logger.info('[MasterPipeline] ACTIVE');
    } catch (e) { logger.warn('[MasterPipeline] Failed:', e.message); }

    const scraperDefs = [
      { name: 'Komo',           module: './services/komoScraper',           cron: '0 8 * * *',   fn: 'scanAll' },
      { name: 'BankNadlan',     module: './services/bankNadlanScraper',     cron: '15 8 * * *',  fn: 'scanAll' },
      { name: 'Yad1',           module: './services/yad1Scraper',           cron: '30 8 * * *',  fn: 'scanAll' },
      { name: 'Dira',           module: './services/diraScraper',           cron: '45 8 * * *',  fn: 'scanAll' },
      { name: 'Kones2',         module: './services/kones2Scraper',         cron: '0 9 * * *',   fn: 'scanAll' },
      { name: 'BidSpirit',      module: './services/bidspiritScraper',      cron: '15 9 * * *',  fn: 'scanAll' },
      { name: 'Govmap',         module: './services/govmapScraper',         cron: '0 7 * * 1',   fn: 'scanAll' },
      { name: 'ComplexAddress', module: './services/complexAddressScraper', cron: '30 9 * * *',  fn: 'scanAll' },
      { name: 'KonesIsrael',    module: './services/konesIsraelService',    cron: '15 7 * * *',  fn: 'runKonesonlineScrape' },
    ];
    for (const def of scraperDefs) {
      try {
        const scraper = require(def.module);
        const cron = require('node-cron');
        cron.schedule(def.cron, async () => { try { await scraper[def.fn](); } catch (e) {} });
        logger.info(`[${def.name}] ACTIVE`);
      } catch (e) {}
    }
  }

  // ── MINHELET crons ───────────────────────────────────────────────────────────
  if (isMinhelet) {
    try { const zcal = require('./services/zohoCalendarService'); if (zcal.isConfigured()) logger.info('[ZohoCal] Configured'); } catch (e) {}

    try { const { startOptimizationCron } = require('./cron/optimizationCron'); startOptimizationCron(); logger.info('[ScheduleOptimization] ACTIVE'); } catch (e) {}

    try {
      const cron = require('node-cron');
      const axios = require('axios');
      cron.schedule('*/2 * * * *', async () => {
        try { await axios.post(`http://localhost:${PORT}/api/campaigns/followup/run`, {}, { timeout: 30000 }); }
        catch (e) { if (e.code !== 'ECONNREFUSED') logger.warn('[CampaignFollowup]', e.message); }
      });
      logger.info('[CampaignFollowup] ACTIVE - every 2 min');
    } catch (e) {}

    try {
      const cron = require('node-cron');
      const { runCampaignFlowEngine } = require('./cron/campaignFlowEngine');
      cron.schedule('*/5 * * * *', async () => { try { await runCampaignFlowEngine(); } catch (e) {} });
      logger.info('[CampaignFlowEngine] ACTIVE - every 5 min');
    } catch (e) {}

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
            const p = appt.phone.replace(/\D/g,'');
            const ip = p.startsWith('0') ? '+972'+p.slice(1) : '+'+p;
            const r = await axios.post('https://api.vapi.ai/call/phone', { phoneNumberId, assistantId, customer: { number: ip, name: appt.lead_name||'לקוח' }, assistantOverrides: { variableValues: { appointment_id: appt.id.toString() } } }, { headers: { Authorization: `Bearer ${apiKey}` } });
            await pool.query(`UPDATE appointments SET status='vapi_called', vapi_call_id=$1 WHERE id=$2`, [r.data?.id, appt.id]);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ── Shared crons (both modes) ────────────────────────────────────────────────
  try { const { initializeBackupService } = require('./services/backupService'); await initializeBackupService(); } catch (e) {}
  try { const { initializeGithubBackup } = require('./services/githubBackupService'); await initializeGithubBackup(); } catch (e) {}

  try {
    const { processReminderQueue } = require('./jobs/reminderJob');
    const cron = require('node-cron');
    cron.schedule('* * * * *', async () => { try { await processReminderQueue(); } catch (e) {} });
    logger.info('[ReminderQueue] ACTIVE');
  } catch (e) {}

  app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path, version: VERSION, mode: START_MODE }));
  app.use((err, req, res, next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: err.message, version: VERSION }); });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`=== QUANTUM ${VERSION} | mode=${START_MODE} | port=${PORT} | routes=${loaded.length} ===`);
  });
}

start();
module.exports = app;
