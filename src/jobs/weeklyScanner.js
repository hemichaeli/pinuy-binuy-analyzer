const cron = require('node-cron');
const pool = require('../db/pool');
const { scanAll } = require('../services/perplexityService');
const { calculateAllIAI } = require('../services/iaiCalculator');
const { calculateAllSSI } = require('../services/ssiCalculator');
const nadlanScraper = require('../services/nadlanScraper');
const { calculateAllBenchmarks } = require('../services/benchmarkService');
const yad2Scraper = require('../services/yad2Scraper');
const mavatScraper = require('../services/mavatScraper');
const { sendPendingNotifications } = require('../services/notificationService');
const { logger } = require('../services/logger');

const WEEKLY_CRON = process.env.SCAN_CRON || '0 4 * * 0';

let isRunning = false;
let lastRunResult = null;
let scheduledTask = null;

async function snapshotStatuses() {
  const result = await pool.query('SELECT id, status, iai_score, actual_premium FROM complexes');
  const map = {};
  for (const row of result.rows) {
    map[row.id] = { status: row.status, iai_score: row.iai_score, actual_premium: row.actual_premium };
  }
  return map;
}

async function generateAlerts(beforeSnapshot) {
  const afterResult = await pool.query('SELECT id, name, city, status, iai_score, actual_premium FROM complexes');
  let alertCount = 0;

  for (const complex of afterResult.rows) {
    const before = beforeSnapshot[complex.id];
    if (!before) continue;

    if (before.status !== complex.status) {
      await createAlert({
        complexId: complex.id, type: 'status_change', severity: 'high',
        title: `שינוי סטטוס: ${complex.name} (${complex.city})`,
        message: `הסטטוס השתנה מ-${translateStatus(before.status)} ל-${translateStatus(complex.status)}`,
        data: { old_status: before.status, new_status: complex.status }
      });
      alertCount++;
    }

    if (complex.iai_score >= 70 && (before.iai_score || 0) < 70) {
      await createAlert({
        complexId: complex.id, type: 'opportunity', severity: 'high',
        title: `הזדמנות מצוינת: ${complex.name} (${complex.city})`,
        message: `ציון IAI עלה ל-${complex.iai_score} (רכישה מומלצת בחום)`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    } else if (complex.iai_score >= 50 && (before.iai_score || 0) < 50) {
      await createAlert({
        complexId: complex.id, type: 'opportunity', severity: 'medium',
        title: `שווה בדיקה: ${complex.name} (${complex.city})`,
        message: `ציון IAI עלה ל-${complex.iai_score}`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    }
  }

  // Stressed sellers
  const stressed = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city 
    FROM listings l JOIN complexes c ON l.complex_id = c.id
    WHERE l.ssi_score >= 50 AND l.created_at > NOW() - INTERVAL '8 days' AND l.is_active = true
  `);
  for (const listing of stressed.rows) {
    await createAlert({
      complexId: listing.complex_id, type: 'stressed_seller',
      severity: listing.ssi_score >= 70 ? 'high' : 'medium',
      title: `מוכר לחוץ: ${listing.complex_name} (${listing.city})`,
      message: `SSI=${listing.ssi_score} | ${listing.address} | ${formatPrice(listing.asking_price)} | ${listing.days_on_market} ימים`,
      data: { listing_id: listing.id, ssi_score: listing.ssi_score, asking_price: listing.asking_price }
    });
    alertCount++;
  }

  // Price drops
  const drops = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city
    FROM listings l JOIN complexes c ON l.complex_id = c.id
    WHERE l.total_price_drop_percent > 5 AND l.updated_at > NOW() - INTERVAL '8 days' AND l.is_active = true
  `);
  for (const listing of drops.rows) {
    await createAlert({
      complexId: listing.complex_id, type: 'price_drop',
      severity: parseFloat(listing.total_price_drop_percent) >= 10 ? 'high' : 'medium',
      title: `ירידת מחיר: ${listing.complex_name} (${listing.city})`,
      message: `ירידה של ${listing.total_price_drop_percent}% | ${listing.address} | ${formatPrice(listing.asking_price)}`,
      data: { listing_id: listing.id, drop_percent: listing.total_price_drop_percent }
    });
    alertCount++;
  }

  return alertCount;
}

async function createAlert({ complexId, type, severity, title, message, data }) {
  try {
    const existing = await pool.query(
      `SELECT id FROM alerts WHERE complex_id = $1 AND alert_type = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
      [complexId, type]
    );
    if (existing.rows.length > 0) return;
    await pool.query(
      `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)`,
      [complexId, type, severity, title, message, JSON.stringify(data || {})]
    );
  } catch (err) {
    logger.warn('Failed to create alert', { error: err.message, type, complexId });
  }
}

function translateStatus(s) {
  const map = { 'declared':'הוכרז','planning':'בתכנון','pre_deposit':'להפקדה','deposited':'הופקדה','approved':'אושרה','construction':'בביצוע','permit':'היתר בנייה' };
  return map[s] || s;
}

function formatPrice(p) {
  return p ? `${Number(p).toLocaleString('he-IL')} ש"ח` : 'N/A';
}

/**
 * Weekly scan: Nadlan -> Benchmarks -> mavat -> Perplexity -> yad2 -> SSI -> IAI -> Alerts -> Notifications
 */
async function runWeeklyScan() {
  if (isRunning) { logger.warn('Weekly scan already running'); return null; }

  isRunning = true;
  const startTime = Date.now();
  logger.info('=== Weekly scan started ===');

  try {
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, started_at, status) VALUES ('weekly_auto', NOW(), 'running') RETURNING id`
    );
    const scanId = scanLog.rows[0].id;
    const beforeSnapshot = await snapshotStatuses();

    // Step 1: Nadlan.gov.il
    let nadlanResults = { total: 0, succeeded: 0, totalNew: 0 };
    try {
      logger.info('Step 1/9: nadlan.gov.il transaction scan...');
      nadlanResults = await nadlanScraper.scanAll({ staleOnly: true, limit: 50 });
      logger.info(`Nadlan: ${nadlanResults.totalNew} new tx`);
    } catch (err) { logger.warn('Nadlan scan failed', { error: err.message }); }

    // Step 2: Benchmarks
    let bmResults = { calculated: 0, skipped: 0 };
    try {
      logger.info('Step 2/9: Benchmark calculation...');
      bmResults = await calculateAllBenchmarks({ limit: 50 });
      logger.info(`Benchmarks: ${bmResults.calculated} calculated`);
    } catch (err) { logger.warn('Benchmark failed', { error: err.message }); }

    // Step 3: mavat planning status
    let mavatResults = { total: 0, succeeded: 0, statusChanges: 0, committeeUpdates: 0 };
    try {
      logger.info('Step 3/9: mavat planning status scan...');
      mavatResults = await mavatScraper.scanAll({ staleOnly: true, limit: 30 });
      logger.info(`mavat: ${mavatResults.statusChanges} status changes, ${mavatResults.committeeUpdates} committee updates`);
    } catch (err) { logger.warn('mavat scan failed', { error: err.message }); }

    // Step 4: Perplexity
    logger.info('Step 4/9: Perplexity scan...');
    const pxResults = await scanAll({ staleOnly: true });

    // Step 5: yad2
    let yad2Results = { total: 0, succeeded: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0 };
    try {
      logger.info('Step 5/9: yad2 listing scan...');
      yad2Results = await yad2Scraper.scanAll({ staleOnly: true, limit: 40 });
      logger.info(`yad2: ${yad2Results.totalNew} new, ${yad2Results.totalUpdated} updated`);
    } catch (err) { logger.warn('yad2 scan failed', { error: err.message }); }

    // Step 6: SSI
    let ssiResults = { total: 0, highStress: 0 };
    try {
      logger.info('Step 6/9: SSI scores...');
      ssiResults = await calculateAllSSI();
    } catch (err) { logger.warn('SSI failed', { error: err.message }); }

    // Step 7: IAI
    try {
      logger.info('Step 7/9: IAI scores...');
      await calculateAllIAI();
    } catch (err) { logger.warn('IAI failed', { error: err.message }); }

    // Step 8: Alerts
    logger.info('Step 8/9: Generating alerts...');
    const alertCount = await generateAlerts(beforeSnapshot);

    // Step 9: Send notifications
    let notifResults = { sent: 0 };
    try {
      logger.info('Step 9/9: Sending notifications...');
      notifResults = await sendPendingNotifications();
    } catch (err) { logger.warn('Notifications failed', { error: err.message }); }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Weekly scan: ` +
      `Nadlan: ${nadlanResults.totalNew} tx. ` +
      `BM: ${bmResults.calculated}. ` +
      `mavat: ${mavatResults.statusChanges} status, ${mavatResults.committeeUpdates} committee. ` +
      `PX: ${pxResults.succeeded}/${pxResults.total}. ` +
      `yad2: ${yad2Results.totalNew} new, ${yad2Results.totalUpdated} upd. ` +
      `SSI: ${ssiResults.highStress || 0} stressed. ` +
      `${alertCount} alerts, ${notifResults.totalAlerts || 0} notified. ${duration}s`;

    await pool.query(
      `UPDATE scan_logs SET completed_at = NOW(), status = 'completed',
        complexes_scanned = $1, new_transactions = $2, new_listings = $3,
        updated_listings = $4, status_changes = $5, alerts_sent = $6, summary = $7
       WHERE id = $8`,
      [pxResults.scanned,
        (pxResults.totalNewTransactions || 0) + (nadlanResults.totalNew || 0),
        (pxResults.totalNewListings || 0) + (yad2Results.totalNew || 0),
        yad2Results.totalUpdated || 0,
        mavatResults.statusChanges || 0,
        alertCount, summary, scanId]
    );

    lastRunResult = {
      scanId, completedAt: new Date().toISOString(), duration: `${duration}s`,
      nadlan: { newTx: nadlanResults.totalNew },
      benchmarks: { calculated: bmResults.calculated },
      mavat: { statusChanges: mavatResults.statusChanges, committeeUpdates: mavatResults.committeeUpdates },
      perplexity: { succeeded: pxResults.succeeded, failed: pxResults.failed },
      yad2: { new: yad2Results.totalNew, updated: yad2Results.totalUpdated, priceChanges: yad2Results.totalPriceChanges },
      ssi: ssiResults,
      alertsGenerated: alertCount,
      notifications: notifResults,
      summary
    };

    logger.info(`=== Weekly scan completed in ${duration}s ===`);
    return lastRunResult;

  } catch (err) {
    logger.error('Weekly scan failed', { error: err.message, stack: err.stack });
    lastRunResult = { error: err.message, completedAt: new Date().toISOString() };
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('PERPLEXITY_API_KEY not set - weekly scanner disabled');
    return;
  }
  if (!cron.validate(WEEKLY_CRON)) {
    logger.error(`Invalid cron: ${WEEKLY_CRON}`);
    return;
  }
  scheduledTask = cron.schedule(WEEKLY_CRON, async () => {
    logger.info(`Cron triggered: ${WEEKLY_CRON}`);
    await runWeeklyScan();
  }, { timezone: 'Asia/Jerusalem' });
  logger.info(`Weekly scanner: ${WEEKLY_CRON} (Asia/Jerusalem)`);
}

function stopScheduler() {
  if (scheduledTask) { scheduledTask.stop(); }
}

function getSchedulerStatus() {
  return {
    enabled: !!scheduledTask, cron: WEEKLY_CRON, timezone: 'Asia/Jerusalem',
    isRunning, lastRun: lastRunResult, perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  };
}

module.exports = { startScheduler, stopScheduler, runWeeklyScan, getSchedulerStatus, createAlert };
