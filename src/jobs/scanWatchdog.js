/**
 * QUANTUM Scan Watchdog
 * Detects when daily scans fail to run (server down, crash, etc.)
 * 
 * Checks:
 *   1. On startup (20s delay) - did we miss scans while server was down?
 *   2. Daily at 10:00 Israel time - did today's scan run?
 * 
 * Sends email alert to all NOTIFICATION_EMAILS when scans are missed.
 */

const cron = require('node-cron');
const pool = require('../db/pool');
const notificationService = require('../services/notificationService');
const { logger } = require('../services/logger');
const { shouldSkipToday } = require('../config/israeliHolidays');

/**
 * Check if daily scan was missed and send alert
 */
async function checkMissedScans() {
  if (!notificationService.isConfigured()) {
    logger.info('[WATCHDOG] Notifications not configured, skipping');
    return;
  }

  try {
    const skipCheck = shouldSkipToday();
    
    // Get last scan from DB
    const lastScan = await pool.query(`
      SELECT id, scan_type, started_at, completed_at, status, summary
      FROM scan_logs 
      WHERE status IN ('completed', 'running')
      ORDER BY started_at DESC LIMIT 1
    `);

    const now = new Date();
    const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const israelHour = israelNow.getHours();
    
    // Calculate hours since last scan
    let hoursSinceLastScan = 999;
    let lastScanDate = '\u05D0\u05E3 \u05E4\u05E2\u05DD';
    if (lastScan.rows.length > 0) {
      const lastTime = new Date(lastScan.rows[0].started_at);
      hoursSinceLastScan = (now - lastTime) / (1000 * 60 * 60);
      lastScanDate = lastTime.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    }

    // Count approximate missed business days
    let missedDays = 0;
    if (hoursSinceLastScan > 30) {
      missedDays = Math.min(5, Math.floor(hoursSinceLastScan / 24));
    }

    // Should scan have run today?
    const shouldHaveRunToday = !skipCheck.shouldSkip && israelHour >= 10;
    
    let todayScanExists = false;
    if (shouldHaveRunToday) {
      const todayCheck = await pool.query(`
        SELECT id FROM scan_logs 
        WHERE started_at >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
        AND status IN ('completed', 'running')
        LIMIT 1
      `);
      todayScanExists = todayCheck.rows.length > 0;
    }

    // Alert if: today's scan missed OR no scan in 26+ hours on business day
    const needsAlert = (shouldHaveRunToday && !todayScanExists) || 
                        (!skipCheck.shouldSkip && hoursSinceLastScan > 26);

    if (!needsAlert) {
      logger.info(`[WATCHDOG] OK - last scan: ${lastScanDate} (${Math.round(hoursSinceLastScan)}h ago)`);
      return;
    }

    // Build alert
    const missedMsg = shouldHaveRunToday && !todayScanExists
      ? '\u05D4\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D4\u05D9\u05D5\u05DE\u05D9\u05EA \u05E9\u05DC \u05D4\u05D9\u05D5\u05DD \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4!'
      : `\u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4 \u05E1\u05E8\u05D9\u05E7\u05D4 \u05DB\u05D1\u05E8 ${Math.round(hoursSinceLastScan)} \u05E9\u05E2\u05D5\u05EA (~${missedDays} \u05D9\u05DE\u05D9 \u05E2\u05D1\u05D5\u05D3\u05D4)!`;

    const subject = `\u{1F6A8} [QUANTUM] \u05E1\u05E8\u05D9\u05E7\u05D4 \u05D9\u05D5\u05DE\u05D9\u05EA \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4!`;
    
    const html = `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #dc2626; margin-bottom: 8px;">\u{1F6A8} Watchdog - \u05E1\u05E8\u05D9\u05E7\u05D4 \u05DC\u05D0 \u05D4\u05EA\u05E7\u05D9\u05D9\u05DE\u05D4</h2>
        
        <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 12px 0;">
          <p style="margin: 0 0 8px; font-size: 16px; color: #991b1b;"><strong>${missedMsg}</strong></p>
          <p style="margin: 0; color: #7f1d1d;">
            <strong>\u05E1\u05E8\u05D9\u05E7\u05D4 \u05D0\u05D7\u05E8\u05D5\u05E0\u05D4:</strong> ${lastScanDate}<br>
            <strong>\u05E9\u05E2\u05D5\u05EA \u05DE\u05D0\u05D6:</strong> ${Math.round(hoursSinceLastScan)}<br>
            <strong>\u05D9\u05DE\u05D9 \u05E2\u05D1\u05D5\u05D3\u05D4 \u05E9\u05D4\u05D5\u05D7\u05DE\u05E6\u05D5:</strong> ~${missedDays}
          </p>
        </div>
        
        <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px; margin: 12px 0;">
          <strong style="color: #92400e;">\u05E1\u05D9\u05D1\u05D5\u05EA \u05D0\u05E4\u05E9\u05E8\u05D9\u05D5\u05EA:</strong>
          <ul style="margin: 4px 0 0; color: #78350f; padding-right: 20px;">
            <li>\u05D4\u05E9\u05E8\u05EA \u05D4\u05D9\u05D4 \u05E0\u05E4\u05D5\u05DC (deploy \u05DB\u05D5\u05E9\u05DC, crash)</li>
            <li>\u05E9\u05D2\u05D9\u05D0\u05EA \u05E7\u05D5\u05D3 \u05D1\u05D6\u05DE\u05DF \u05D4\u05E1\u05E8\u05D9\u05E7\u05D4</li>
            <li>\u05D1\u05E2\u05D9\u05D9\u05EA \u05D7\u05D9\u05D1\u05D5\u05E8 \u05DC\u05DE\u05E1\u05D3 \u05E0\u05EA\u05D5\u05E0\u05D9\u05DD</li>
          </ul>
        </div>
        
        <p style="margin: 16px 0 0;">
          <a href="https://pinuy-binuy-analyzer-production.up.railway.app/api/scan/daily-status" 
             style="background: #2563eb; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; display: inline-block;">
            \u05D1\u05D3\u05D5\u05E7 \u05E1\u05D8\u05D8\u05D5\u05E1
          </a>
          &nbsp;
          <a href="https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard/"
             style="background: #059669; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; display: inline-block;">
            Dashboard
          </a>
        </p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p style="font-size: 11px; color: #9ca3af;">
          QUANTUM Watchdog | Checks: startup + daily 10:00 (Sun-Thu)
        </p>
      </div>
    `;

    for (const email of notificationService.NOTIFICATION_EMAILS) {
      try {
        await notificationService.sendEmail(email, subject, html);
      } catch (e) {
        logger.warn(`[WATCHDOG] Failed to send to ${email}`, { error: e.message });
      }
    }
    
    logger.warn(`[WATCHDOG] ALERT SENT - scan missed! Last: ${lastScanDate}, ${Math.round(hoursSinceLastScan)}h ago`);

  } catch (err) {
    logger.error('[WATCHDOG] Check failed', { error: err.message });
  }
}

/**
 * Initialize watchdog cron + startup check
 */
function initWatchdog() {
  // Daily 10:00 check (Sun-Thu) - 2 hours after scheduled scan
  cron.schedule('0 10 * * 0-4', async () => {
    logger.info('[WATCHDOG] 10:00 daily check');
    await checkMissedScans();
  }, { timezone: 'Asia/Jerusalem' });

  // Startup check (20s delay to let DB connect)
  setTimeout(async () => {
    logger.info('[WATCHDOG] Startup check - looking for missed scans...');
    await checkMissedScans();
  }, 20000);

  logger.info('[WATCHDOG] Initialized: startup check + daily 10:00 (Sun-Thu)');
}

module.exports = { checkMissedScans, initWatchdog };
