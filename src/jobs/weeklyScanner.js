const cron = require('node-cron');
const pool = require('../db/pool');
const { scanAll } = require('../services/perplexityService');
const { calculateAllIAI } = require('../services/iaiCalculator');
const { logger } = require('../services/logger');

// Israel is UTC+2 (winter) / UTC+3 (summer)
// Sunday 06:00 Israel time = ~03:00-04:00 UTC
// We use 04:00 UTC to cover both DST cases
const WEEKLY_CRON = process.env.SCAN_CRON || '0 4 * * 0'; // Every Sunday at 04:00 UTC

let isRunning = false;
let lastRunResult = null;
let scheduledTask = null;

/**
 * Snapshot current statuses before scan for change detection
 */
async function snapshotStatuses() {
  const result = await pool.query(
    'SELECT id, status, iai_score, actual_premium FROM complexes'
  );
  const map = {};
  for (const row of result.rows) {
    map[row.id] = {
      status: row.status,
      iai_score: row.iai_score,
      actual_premium: row.actual_premium
    };
  }
  return map;
}

/**
 * Detect changes and create alerts
 */
async function generateAlerts(beforeSnapshot) {
  const afterResult = await pool.query(
    'SELECT id, name, city, status, iai_score, actual_premium FROM complexes'
  );
  
  let alertCount = 0;

  for (const complex of afterResult.rows) {
    const before = beforeSnapshot[complex.id];
    if (!before) continue;

    // Status change alert
    if (before.status !== complex.status) {
      await createAlert({
        complexId: complex.id,
        type: 'status_change',
        severity: 'high',
        title: `שינוי סטטוס: ${complex.name} (${complex.city})`,
        message: `הסטטוס השתנה מ-${translateStatus(before.status)} ל-${translateStatus(complex.status)}`,
        data: { old_status: before.status, new_status: complex.status }
      });
      alertCount++;
    }

    // IAI score improvement alert (crossed threshold)
    if (complex.iai_score >= 70 && (before.iai_score || 0) < 70) {
      await createAlert({
        complexId: complex.id,
        type: 'opportunity',
        severity: 'high',
        title: `הזדמנות מצוינת: ${complex.name} (${complex.city})`,
        message: `ציון IAI עלה ל-${complex.iai_score} (רכישה מומלצת בחום)`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    } else if (complex.iai_score >= 50 && (before.iai_score || 0) < 50) {
      await createAlert({
        complexId: complex.id,
        type: 'opportunity',
        severity: 'medium',
        title: `שווה בדיקה: ${complex.name} (${complex.city})`,
        message: `ציון IAI עלה ל-${complex.iai_score} (שווה בדיקה מעמיקה)`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    }
  }

  // Check for new high-SSI listings (stressed sellers)
  const newStressedListings = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city 
    FROM listings l
    JOIN complexes c ON l.complex_id = c.id
    WHERE l.ssi_score >= 50 
    AND l.created_at > NOW() - INTERVAL '8 days'
    AND l.is_active = true
  `);

  for (const listing of newStressedListings.rows) {
    await createAlert({
      complexId: listing.complex_id,
      type: 'stressed_seller',
      severity: listing.ssi_score >= 70 ? 'high' : 'medium',
      title: `מוכר לחוץ: ${listing.complex_name} (${listing.city})`,
      message: `SSI=${listing.ssi_score} | ${listing.address} | ${formatPrice(listing.asking_price)} | ${listing.days_on_market} ימים`,
      data: { listing_id: listing.id, ssi_score: listing.ssi_score, asking_price: listing.asking_price }
    });
    alertCount++;
  }

  // Check for price drops in existing listings
  const priceDrops = await pool.query(`
    SELECT l.*, c.name as complex_name, c.city
    FROM listings l
    JOIN complexes c ON l.complex_id = c.id
    WHERE l.total_price_drop_percent > 5
    AND l.updated_at > NOW() - INTERVAL '8 days'
    AND l.is_active = true
  `);

  for (const listing of priceDrops.rows) {
    await createAlert({
      complexId: listing.complex_id,
      type: 'price_drop',
      severity: parseFloat(listing.total_price_drop_percent) >= 10 ? 'high' : 'medium',
      title: `ירידת מחיר: ${listing.complex_name} (${listing.city})`,
      message: `ירידה של ${listing.total_price_drop_percent}% | ${listing.address} | ${formatPrice(listing.asking_price)} (היה ${formatPrice(listing.original_price)})`,
      data: { listing_id: listing.id, drop_percent: listing.total_price_drop_percent }
    });
    alertCount++;
  }

  return alertCount;
}

/**
 * Create an alert in the database
 */
async function createAlert({ complexId, type, severity, title, message, data }) {
  try {
    // Avoid duplicate alerts (same type + complex within 24 hours)
    const existing = await pool.query(
      `SELECT id FROM alerts 
       WHERE complex_id = $1 AND alert_type = $2 
       AND created_at > NOW() - INTERVAL '24 hours'`,
      [complexId, type]
    );
    if (existing.rows.length > 0) return;

    await pool.query(
      `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [complexId, type, severity, title, message, JSON.stringify(data || {})]
    );
  } catch (err) {
    logger.warn('Failed to create alert', { error: err.message, type, complexId });
  }
}

/**
 * Translate status to Hebrew for alerts
 */
function translateStatus(status) {
  const map = {
    'declared': 'הוכרז',
    'planning': 'בתכנון',
    'pre_deposit': 'להפקדה',
    'deposited': 'הופקדה',
    'approved': 'אושרה',
    'construction': 'בביצוע',
    'permit': 'היתר בנייה'
  };
  return map[status] || status;
}

/**
 * Format price with commas
 */
function formatPrice(price) {
  if (!price) return 'N/A';
  return `${Number(price).toLocaleString('he-IL')} ש"ח`;
}

/**
 * Run the weekly scan
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
    // 1. Create scan log entry
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, started_at, status) 
       VALUES ('weekly_auto', NOW(), 'running') RETURNING id`
    );
    const scanId = scanLog.rows[0].id;

    // 2. Snapshot current statuses for change detection
    const beforeSnapshot = await snapshotStatuses();

    // 3. Run Perplexity scan on all complexes (stale = not scanned in 6+ days)
    const results = await scanAll({ staleOnly: true });

    // 4. Generate alerts from changes
    const alertCount = await generateAlerts(beforeSnapshot);

    // 5. Recalculate IAI scores for all complexes
    try {
      await calculateAllIAI();
      logger.info('IAI scores recalculated for all complexes');
    } catch (iaiErr) {
      logger.warn('IAI recalculation failed', { error: iaiErr.message });
    }

    // 6. Update scan log
    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Weekly scan: ${results.succeeded}/${results.total} succeeded, ` +
      `${results.totalNewTransactions} new tx, ${results.totalNewListings} new listings, ` +
      `${alertCount} alerts. ${results.failed} failed. Duration: ${duration}s`;

    await pool.query(
      `UPDATE scan_logs SET 
        completed_at = NOW(), 
        status = 'completed',
        complexes_scanned = $1,
        new_transactions = $2,
        new_listings = $3,
        alerts_sent = $4,
        summary = $5,
        errors = $6
       WHERE id = $7`,
      [
        results.scanned,
        results.totalNewTransactions,
        results.totalNewListings,
        alertCount,
        summary,
        results.failed > 0 ? JSON.stringify(results.details.filter(d => d.status === 'error')) : null,
        scanId
      ]
    );

    lastRunResult = {
      scanId,
      completedAt: new Date().toISOString(),
      duration: `${duration}s`,
      complexesScanned: results.scanned,
      succeeded: results.succeeded,
      failed: results.failed,
      newTransactions: results.totalNewTransactions,
      newListings: results.totalNewListings,
      alertsGenerated: alertCount,
      summary
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

/**
 * Start the cron scheduler
 */
function startScheduler() {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('PERPLEXITY_API_KEY not set - weekly scanner disabled');
    return;
  }

  // Validate cron expression
  if (!cron.validate(WEEKLY_CRON)) {
    logger.error(`Invalid cron expression: ${WEEKLY_CRON}`);
    return;
  }

  scheduledTask = cron.schedule(WEEKLY_CRON, async () => {
    logger.info(`Cron triggered: ${WEEKLY_CRON}`);
    await runWeeklyScan();
  }, {
    timezone: 'Asia/Jerusalem'
  });

  logger.info(`Weekly scanner scheduled: ${WEEKLY_CRON} (Asia/Jerusalem)`);
  logger.info('Next run: Sunday 06:00 Israel time');
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    logger.info('Weekly scanner stopped');
  }
}

/**
 * Get scheduler status
 */
function getSchedulerStatus() {
  return {
    enabled: !!scheduledTask,
    cron: WEEKLY_CRON,
    timezone: 'Asia/Jerusalem',
    isRunning,
    lastRun: lastRunResult,
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  runWeeklyScan,
  getSchedulerStatus
};
