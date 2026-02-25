/**
 * QUANTUM Missed Scan Detection v1.0
 * Detects when daily scans didn't run (server was down)
 * and sends alert notifications on startup.
 */
const pool = require('../db/pool');
const notificationService = require('../services/notificationService');
const { logger } = require('../services/logger');

async function checkMissedScans() {
  try {
    const result = await pool.query(`
      SELECT id, scan_type, started_at, completed_at, status
      FROM scan_logs
      ORDER BY started_at DESC
      LIMIT 1
    `);

    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const hour = israelTime.getHours();
    const day = israelTime.getDay();

    // Only alert on business days after 09:00 (scan runs at 08:00)
    if (day === 5 || day === 6 || hour < 9) {
      logger.info('[MISSED-SCAN] Not a business day/hour, skipping check');
      return;
    }

    if (result.rows.length === 0) {
      logger.warn('[MISSED-SCAN] No scan logs found at all!');
      await sendMissedScanNotification(null, 'No scan logs found in database');
      return;
    }

    const lastScan = result.rows[0];
    const lastScanTime = new Date(lastScan.started_at);
    const hoursSinceLastScan = (now - lastScanTime) / (1000 * 60 * 60);

    logger.info(`[MISSED-SCAN] Last scan: ${lastScanTime.toISOString()} (${hoursSinceLastScan.toFixed(1)}h ago, status: ${lastScan.status})`);

    if (hoursSinceLastScan > 30) {
      logger.warn(`[MISSED-SCAN] Last scan was ${hoursSinceLastScan.toFixed(1)} hours ago!`);
      await sendMissedScanNotification(lastScan, `Last scan was ${hoursSinceLastScan.toFixed(0)} hours ago`);
    } else {
      logger.info('[MISSED-SCAN] Scans are up to date');
    }
  } catch (err) {
    logger.error('[MISSED-SCAN] Check failed', { error: err.message });
  }
}

async function sendMissedScanNotification(lastScan, reason) {
  if (!notificationService.isConfigured()) {
    logger.warn('[MISSED-SCAN] Cannot send notification - no email provider configured');
    return;
  }

  const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const lastScanTime = lastScan
    ? new Date(lastScan.started_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
    : 'N/A';
  const lastScanStatus = lastScan ? lastScan.status : 'N/A';

  const subject = `\u{1F6A8} [QUANTUM] \u05E1\u05E8\u05D9\u05E7\u05D4 \u05D9\u05D5\u05DE\u05D9\u05EA \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4!`;

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto;">
      <h2 style="color: #dc2626; margin-bottom: 4px;">\u{1F6A8} \u05E1\u05E8\u05D9\u05E7\u05D4 \u05D9\u05D5\u05DE\u05D9\u05EA \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4!</h2>
      <p style="color: #6b7280; margin: 0 0 16px; font-size: 13px;">
        \u05D6\u05D5\u05D4\u05D4 \u05E2\u05DB\u05E9\u05D9\u05D5: ${israelTime}
      </p>
      
      <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
        <p style="margin: 0 0 8px; font-size: 15px;"><strong>\u05E1\u05D9\u05D1\u05D4:</strong> ${reason}</p>
        <p style="margin: 0 0 8px; font-size: 14px;">\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D0\u05D7\u05E8\u05D5\u05E0\u05D4: ${lastScanTime} (\u05E1\u05D8\u05D8\u05D5\u05E1: ${lastScanStatus})</p>
        <p style="margin: 0; font-size: 14px;">\u05D4\u05E9\u05E8\u05EA \u05D7\u05D6\u05E8 \u05DC\u05E4\u05E2\u05D5\u05DC\u05D4 \u05D5\u05D4\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D4\u05D1\u05D0\u05D4 \u05EA\u05E8\u05D5\u05E5 \u05D1-08:00</p>
      </div>
      
      <div style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; padding: 12px; font-size: 13px;">
        <strong>\u05DE\u05D4 \u05DC\u05E2\u05E9\u05D5\u05EA:</strong><br>
        \u2022 \u05DC\u05D1\u05D3\u05D5\u05E7 \u05D0\u05EA \u05DC\u05D5\u05D2\u05D9 \u05D4-Railway \u05DC\u05E9\u05D2\u05D9\u05D0\u05D5\u05EA<br>
        \u2022 \u05DC\u05D4\u05E8\u05D9\u05E5 \u05E1\u05E8\u05D9\u05E7\u05D4 \u05D9\u05D3\u05E0\u05D9\u05EA: <code>POST /api/scheduler/run</code>
      </div>
      
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
      <p style="font-size: 11px; color: #9ca3af; text-align: center;">
        QUANTUM - Missed Scan Detection | Server restarted at ${israelTime}
      </p>
    </div>
  `;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    logger.info('[MISSED-SCAN] Alert sent to all recipients');

    // Also create a system alert in the dashboard
    try {
      await pool.query(
        `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data)
         VALUES (NULL, 'status_change', 'critical', $1, $2, $3)`,
        [
          '\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D9\u05D5\u05DE\u05D9\u05EA \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4',
          reason + '. \u05D4\u05E9\u05E8\u05EA \u05D7\u05D6\u05E8 \u05DC\u05E4\u05E2\u05D5\u05DC\u05D4 \u05D5\u05D4\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D4\u05D1\u05D0\u05D4 \u05EA\u05E8\u05D5\u05E5 \u05D1-08:00.',
          JSON.stringify({ lastScanTime: lastScan?.started_at, lastScanStatus: lastScan?.status, detectedAt: new Date().toISOString() })
        ]
      );
    } catch (e) {
      logger.warn('[MISSED-SCAN] Failed to create dashboard alert', { error: e.message });
    }
  } catch (err) {
    logger.error('[MISSED-SCAN] Failed to send notification', { error: err.message });
  }
}

module.exports = { checkMissedScans };
