const cron = require('node-cron');
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const notificationService = require('../services/notificationService');

// Check every 30 minutes for stuck scans
const WATCHER_CRON = '*/30 * * * *';

let watcherTask = null;
let lastAlertSent = null;

/**
 * Send alert about stuck scans
 */
async function sendStuckScanAlert(stuckScans) {
  if (!notificationService.isConfigured()) {
    logger.info('Stuck scan alert not sent - no email provider configured');
    return;
  }

  // Don't spam - only send if last alert was >2 hours ago
  if (lastAlertSent && (Date.now() - lastAlertSent) < 2 * 60 * 60 * 1000) {
    logger.info('Stuck scan detected but alert throttled (< 2 hours since last alert)');
    return;
  }

  const now = new Date();
  const israelTime = now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  const subject = `[QUANTUM] Stuck Scans Detected - ${stuckScans.length} scans`;

  const scansRows = stuckScans.map((scan) => {
    const duration = Math.round((Date.now() - new Date(scan.started_at).getTime()) / (1000 * 60));
    return `<tr><td>#${scan.id}</td><td>${scan.scan_type}</td><td>${duration} min</td><td>${scan.complexes_scanned || 0}</td></tr>`;
  }).join('');

  const html = `<div><h2>Stuck Scans Detected</h2><p>${stuckScans.length} scans running over 3 hours. Time: ${israelTime}</p><table><thead><tr><th>ID</th><th>Type</th><th>Duration</th><th>Scanned</th></tr></thead><tbody>${scansRows}</tbody></table><p>Use POST /api/scan/fix-stuck to resolve.</p></div>`;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    lastAlertSent = Date.now();
    logger.info(`Stuck scan alert sent: ${stuckScans.length} stuck scans`);
  } catch (err) {
    logger.warn('Failed to send stuck scan alert', { error: err.message });
  }
}

/**
 * Check for stuck scans and auto-fix them
 */
async function checkStuckScans() {
  try {
    const stuckResult = await pool.query(`
      SELECT id, scan_type, started_at, complexes_scanned
      FROM scan_logs
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '3 hours'
      ORDER BY started_at ASC
    `);

    if (stuckResult.rows.length === 0) {
      return;
    }

    logger.warn(`[STUCK-WATCHER] Found ${stuckResult.rows.length} stuck scans - auto-fixing`);

    await sendStuckScanAlert(stuckResult.rows);

    const fixResult = await pool.query(`
      UPDATE scan_logs
      SET status = 'failed',
          completed_at = NOW(),
          errors = 'Auto-failed by stuck scan watcher after 3+ hours'
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '3 hours'
      RETURNING id
    `);

    logger.info(`[STUCK-WATCHER] Auto-fixed ${fixResult.rows.length} stuck scans`);
  } catch (err) {
    logger.error('[STUCK-WATCHER] Check failed', { error: err.message });
  }
}

/**
 * Start the stuck scan watcher
 */
function startWatcher() {
  if (watcherTask) {
    logger.warn('[STUCK-WATCHER] Already running');
    return;
  }

  watcherTask = cron.schedule(WATCHER_CRON, async () => {
    await checkStuckScans();
  });

  logger.info('[STUCK-WATCHER] Started - checking every 30 minutes (3h threshold)');

  setTimeout(async () => {
    await checkStuckScans();
  }, 5 * 60 * 1000);
}

function stopWatcher() {
  if (watcherTask) {
    watcherTask.stop();
    watcherTask = null;
    logger.info('[STUCK-WATCHER] Stopped');
  }
}

module.exports = { startWatcher, stopWatcher, checkStuckScans };
