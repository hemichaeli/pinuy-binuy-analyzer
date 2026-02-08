const cron = require('node-cron');
const pool = require('../db/pool');
const { scanAll } = require('../services/perplexityService');
const { calculateAllIAI } = require('../services/iaiCalculator');
const { calculateAllSSI } = require('../services/ssiCalculator');
const nadlanScraper = require('../services/nadlanScraper');
const { calculateAllBenchmarks } = require('../services/benchmarkService');
const { logger } = require('../services/logger');

const WEEKLY_CRON = process.env.SCAN_CRON || '0 4 * * 0';

let isRunning = false;
let lastRunResult = null;
let scheduledTask = null;

async function snapshotStatuses() {
  const result = await pool.query(
    'SELECT id, status, iai_score, actual_premium FROM complexes'
  );
  const map = {};
  for (const row of result.rows) {
    map[row.id] = { status: row.status, iai_score: row.iai_score, actual_premium: row.actual_premium };
  }
  return map;
}

async function generateAlerts(beforeSnapshot) {
  const afterResult = await pool.query(
    'SELECT id, name, city, status, iai_score, actual_premium FROM complexes'
  );
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
        message: `ציון IAI עלה ל-${complex.iai_score} (שווה בדיקה מעמיקה)`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    }
  }

  const newStressedListings = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city 
    FROM listings l JOIN complexes c ON l.complex_id = c.id
    WHERE l.ssi_score >= 50 AND l.created_at > NOW() - INTERVAL '8 days' AND l.is_active = true
  `);
  for (const listing of newStressedListings.rows) {
    await createAlert({
      complexId: listing.complex_id, type: 'stressed_seller',
      severity: listing.ssi_score >= 70 ? 'high' : 'medium',
      title: `מוכר לחוץ: ${listing.complex_name} (${listing.city})`,
      message: `SSI=${listing.ssi_score} | ${listing.address} | ${formatPrice(listing.asking_price)} | ${listing.days_on_market} ימים`,
      data: { listing_id: listing.id, ssi_score: listing.ssi_score, asking_price: listing.asking_price }
    });
    alertCount++;
  }

  const priceDrops = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city
    FROM listings l JOIN complexes c ON l.complex_id = c.id
    WHERE l.total_price_drop_percent > 5 AND l.updated_at > NOW() - INTERVAL '8 days' AND l.is_active = true
  `);
  for (const listing of priceDrops.rows) {
    await createAlert({
      complexId: listing.complex_id, type: 'price_drop',
      severity: parseFloat(listing.total_price_drop_percent) >= 10 ? 'high' : 'medium',
      title: `ירידת מחיר: ${listing.complex_name} (${listing.city})`,
      message: `ירידה של ${listing.total_price_drop_percent}% | ${listing.address} | ${formatPrice(listing.asking_price)} (היה ${formatPrice(listing.original_price)})`,
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

function translateStatus(status) {
  const map = {
    'declared': 'הוכרז', 'planning': 'בתכנון', 'pre_deposit': 'להפקדה',
    'deposited': 'הופקדה', 'approved': 'אושרה', 'construction': 'בביצוע', 'permit': 'היתר בנייה'
  };
  return map[status] || status;
}

function formatPrice(price) {
  if (!price) return 'N/A';
  return `${Number(price).toLocaleString('he-IL')} ש"ח`;
}

/**
 * Run the weekly scan
 * Order: Nadlan -> Benchmarks -> Perplexity -> SSI -> IAI -> Alerts
 */
async function runWeeklyScan() {
  if (isRunning) {
    logger.warn('Weekly scan already running, skipping');
    return null;
  }

  isRunning = true;
  const startTime = Date.now();
  logger.info('=== Weekly scan started ===');

  try {
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, started_at, status) VALUES ('weekly_auto', NOW(), 'running') RETURNING id`
    );
    const scanId = scanLog.rows[0].id;
    const beforeSnapshot = await snapshotStatuses();

    // Step 1: Nadlan.gov.il transaction scan
    let nadlanResults = { total: 0, succeeded: 0, failed: 0, totalNew: 0 };
    try {
      logger.info('Step 1/6: Running nadlan.gov.il transaction scan...');
      nadlanResults = await nadlanScraper.scanAll({ staleOnly: true, limit: 50 });
      logger.info(`Nadlan scan: ${nadlanResults.totalNew} new transactions from ${nadlanResults.succeeded} complexes`);
    } catch (nadlanErr) {
      logger.warn('Nadlan scan failed (non-critical)', { error: nadlanErr.message });
    }

    // Step 2: Benchmark calculation (after new transaction data)
    let benchmarkResults = { calculated: 0, skipped: 0, errors: 0 };
    try {
      logger.info('Step 2/6: Calculating benchmarks...');
      benchmarkResults = await calculateAllBenchmarks({ limit: 50 });
      logger.info(`Benchmarks: ${benchmarkResults.calculated} calculated, ${benchmarkResults.skipped} skipped`);
    } catch (bmErr) {
      logger.warn('Benchmark calculation failed (non-critical)', { error: bmErr.message });
    }

    // Step 3: Perplexity scan
    logger.info('Step 3/6: Running Perplexity scan...');
    const results = await scanAll({ staleOnly: true });

    // Step 4: SSI scores
    let ssiResults = { total: 0, calculated: 0, errors: 0, stressed: 0, very_stressed: 0 };
    try {
      logger.info('Step 4/6: Calculating SSI scores...');
      ssiResults = await calculateAllSSI();
      logger.info('SSI scores calculated', ssiResults);
    } catch (ssiErr) {
      logger.warn('SSI calculation failed', { error: ssiErr.message });
    }

    // Step 5: IAI scores (after benchmarks + SSI so premium_gap is fresh)
    try {
      logger.info('Step 5/6: Recalculating IAI scores...');
      await calculateAllIAI();
      logger.info('IAI scores recalculated');
    } catch (iaiErr) {
      logger.warn('IAI recalculation failed', { error: iaiErr.message });
    }

    // Step 6: Generate alerts
    logger.info('Step 6/6: Generating alerts...');
    const alertCount = await generateAlerts(beforeSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Weekly scan: ` +
      `Nadlan: ${nadlanResults.totalNew} new tx. ` +
      `Benchmarks: ${benchmarkResults.calculated} calculated. ` +
      `Perplexity: ${results.succeeded}/${results.total} ok, ${results.totalNewTransactions} tx, ${results.totalNewListings} listings. ` +
      `SSI: ${ssiResults.very_stressed} very stressed + ${ssiResults.stressed} stressed. ` +
      `${alertCount} alerts. Duration: ${duration}s`;

    await pool.query(
      `UPDATE scan_logs SET 
        completed_at = NOW(), status = 'completed', complexes_scanned = $1,
        new_transactions = $2, new_listings = $3, alerts_sent = $4, summary = $5,
        errors = $6
       WHERE id = $7`,
      [results.scanned, (results.totalNewTransactions || 0) + (nadlanResults.totalNew || 0),
        results.totalNewListings, alertCount, summary,
        results.failed > 0 ? JSON.stringify(results.details.filter(d => d.status === 'error')) : null, scanId]
    );

    lastRunResult = {
      scanId, completedAt: new Date().toISOString(), duration: `${duration}s`,
      nadlan: { newTransactions: nadlanResults.totalNew },
      benchmarks: { calculated: benchmarkResults.calculated },
      perplexity: { succeeded: results.succeeded, failed: results.failed,
        newTransactions: results.totalNewTransactions, newListings: results.totalNewListings },
      ssi: ssiResults, alertsGenerated: alertCount, summary
    };

    logger.info(`=== Weekly scan completed in ${duration}s ===`, lastRunResult);
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
    logger.error(`Invalid cron expression: ${WEEKLY_CRON}`);
    return;
  }
  scheduledTask = cron.schedule(WEEKLY_CRON, async () => {
    logger.info(`Cron triggered: ${WEEKLY_CRON}`);
    await runWeeklyScan();
  }, { timezone: 'Asia/Jerusalem' });
  logger.info(`Weekly scanner scheduled: ${WEEKLY_CRON} (Asia/Jerusalem)`);
}

function stopScheduler() {
  if (scheduledTask) { scheduledTask.stop(); logger.info('Weekly scanner stopped'); }
}

function getSchedulerStatus() {
  return {
    enabled: !!scheduledTask, cron: WEEKLY_CRON, timezone: 'Asia/Jerusalem',
    isRunning, lastRun: lastRunResult, perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  };
}

module.exports = { startScheduler, stopScheduler, runWeeklyScan, getSchedulerStatus, createAlert };
