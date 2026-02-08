const nodemailer = require('nodemailer');
const pool = require('../db/pool');
const { logger } = require('./logger');

// Email targets
const TRELLO_EMAIL = process.env.TRELLO_BOARD_EMAIL || 'uth_limited+c9otswetpgdfphdpoehc@boards.trello.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';

// SMTP configuration via environment variables
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    logger.warn('SMTP not configured - email notifications disabled');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
}

/**
 * Format alert for Trello card (subject = card title, body = description)
 */
function formatTrelloCard(alert) {
  const severityEmoji = {
    'high': '🔴',
    'medium': '🟡',
    'info': '🔵'
  };
  const emoji = severityEmoji[alert.severity] || '';

  // Trello subject = card title (keep short and informative)
  const subject = `${emoji} ${alert.title}`;

  // Trello body = card description (detailed info)
  const data = typeof alert.data === 'string' ? JSON.parse(alert.data) : (alert.data || {});

  let body = `${alert.message}\n\n`;
  body += `סוג התראה: ${translateAlertType(alert.alert_type)}\n`;
  body += `חומרה: ${alert.severity}\n`;
  body += `תאריך: ${new Date(alert.created_at).toLocaleDateString('he-IL')}\n`;

  if (data.old_status && data.new_status) {
    body += `\nשינוי סטטוס: ${data.old_status} -> ${data.new_status}\n`;
  }
  if (data.old_iai !== undefined && data.new_iai !== undefined) {
    body += `\nשינוי IAI: ${data.old_iai} -> ${data.new_iai}\n`;
  }
  if (data.ssi_score) {
    body += `\nציון SSI: ${data.ssi_score}\n`;
  }
  if (data.drop_percent) {
    body += `\nירידת מחיר: ${data.drop_percent}%\n`;
  }

  return { subject, body };
}

/**
 * Format alert for office email (more detailed, professional)
 */
function formatOfficeEmail(alerts) {
  const subject = `QUANTUM Alert: ${alerts.length} התראות חדשות - ${new Date().toLocaleDateString('he-IL')}`;

  let html = `<div dir="rtl" style="font-family: Arial, sans-serif;">`;
  html += `<h2 style="color: #333;">QUANTUM - התראות חדשות</h2>`;
  html += `<p>${alerts.length} התראות חדשות נמצאו ב-${new Date().toLocaleDateString('he-IL')}</p>`;
  html += `<hr/>`;

  // Group by severity
  const highAlerts = alerts.filter(a => a.severity === 'high');
  const mediumAlerts = alerts.filter(a => a.severity === 'medium');
  const infoAlerts = alerts.filter(a => a.severity === 'info');

  if (highAlerts.length > 0) {
    html += `<h3 style="color: #d32f2f;">🔴 התראות דחופות (${highAlerts.length})</h3>`;
    for (const alert of highAlerts) {
      html += formatAlertHtml(alert);
    }
  }

  if (mediumAlerts.length > 0) {
    html += `<h3 style="color: #f57c00;">🟡 התראות בינוניות (${mediumAlerts.length})</h3>`;
    for (const alert of mediumAlerts) {
      html += formatAlertHtml(alert);
    }
  }

  if (infoAlerts.length > 0) {
    html += `<h3 style="color: #1976d2;">🔵 מידע (${infoAlerts.length})</h3>`;
    for (const alert of infoAlerts) {
      html += formatAlertHtml(alert);
    }
  }

  html += `<hr/><p style="color: #666; font-size: 12px;">QUANTUM Pinuy Binuy Investment Analyzer</p>`;
  html += `</div>`;

  return { subject, html };
}

function formatAlertHtml(alert) {
  return `<div style="background: #f5f5f5; padding: 12px; margin: 8px 0; border-radius: 4px; border-right: 4px solid ${
    alert.severity === 'high' ? '#d32f2f' : alert.severity === 'medium' ? '#f57c00' : '#1976d2'
  };">
    <strong>${alert.title}</strong><br/>
    <span style="color: #555;">${alert.message}</span><br/>
    <span style="color: #999; font-size: 11px;">${translateAlertType(alert.alert_type)} | ${new Date(alert.created_at).toLocaleString('he-IL')}</span>
  </div>`;
}

function translateAlertType(type) {
  const map = {
    'status_change': 'שינוי סטטוס',
    'opportunity': 'הזדמנות השקעה',
    'stressed_seller': 'מוכר לחוץ',
    'price_drop': 'ירידת מחיר',
    'new_opportunity': 'הזדמנות חדשה',
    'high_iai': 'IAI גבוה',
    'high_ssi': 'SSI גבוה',
    'committee_approval': 'אישור ועדה'
  };
  return map[type] || type;
}

/**
 * Send a single alert as a Trello card via email
 */
async function sendTrelloCard(alert) {
  const smtp = getTransporter();
  if (!smtp) return { sent: false, reason: 'SMTP not configured' };

  const { subject, body } = formatTrelloCard(alert);

  try {
    await smtp.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: TRELLO_EMAIL,
      subject,
      text: body
    });

    logger.info(`Trello card sent: ${subject}`);
    return { sent: true, target: 'trello', subject };
  } catch (err) {
    logger.error(`Failed to send Trello card: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/**
 * Send batch alerts as office email digest
 */
async function sendOfficeDigest(alerts) {
  const smtp = getTransporter();
  if (!smtp) return { sent: false, reason: 'SMTP not configured' };
  if (alerts.length === 0) return { sent: false, reason: 'No alerts to send' };

  const { subject, html } = formatOfficeEmail(alerts);

  try {
    await smtp.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: OFFICE_EMAIL,
      subject,
      html
    });

    logger.info(`Office digest sent: ${alerts.length} alerts`);
    return { sent: true, target: 'office', alertCount: alerts.length };
  } catch (err) {
    logger.error(`Failed to send office digest: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/**
 * Process and send all unsent alerts
 * - High severity: individual Trello cards + included in digest
 * - Medium/Info: included in digest only
 */
async function sendPendingNotifications() {
  const smtp = getTransporter();
  if (!smtp) {
    logger.info('SMTP not configured - skipping notifications');
    return { sent: 0, skipped: 'SMTP not configured' };
  }

  // Get unsent alerts (created in the last 24 hours, not yet sent)
  const result = await pool.query(
    `SELECT a.*, c.name as complex_name, c.city
     FROM alerts a
     LEFT JOIN complexes c ON a.complex_id = c.id
     WHERE a.sent_at IS NULL AND a.created_at > NOW() - INTERVAL '24 hours'
     ORDER BY a.severity DESC, a.created_at ASC`
  );

  const alerts = result.rows;
  if (alerts.length === 0) {
    logger.info('No pending alerts to send');
    return { sent: 0, reason: 'No pending alerts' };
  }

  let trelloSent = 0;
  let trelloFailed = 0;

  // Send high-severity alerts as individual Trello cards
  const highAlerts = alerts.filter(a => a.severity === 'high');
  for (const alert of highAlerts) {
    const result = await sendTrelloCard(alert);
    if (result.sent) {
      trelloSent++;
      await pool.query('UPDATE alerts SET sent_at = NOW() WHERE id = $1', [alert.id]);
    } else {
      trelloFailed++;
    }
    // Brief delay between emails
    await new Promise(r => setTimeout(r, 1000));
  }

  // Send digest email to office with all alerts
  const digestResult = await sendOfficeDigest(alerts);

  // Mark all alerts as sent
  if (digestResult.sent) {
    const alertIds = alerts.map(a => a.id);
    await pool.query(
      `UPDATE alerts SET sent_at = NOW() WHERE id = ANY($1)`,
      [alertIds]
    );
  }

  const summary = {
    totalAlerts: alerts.length,
    highSeverity: highAlerts.length,
    trelloCards: { sent: trelloSent, failed: trelloFailed },
    officeDigest: digestResult,
    smtpConfigured: true
  };

  logger.info('Notifications sent', summary);
  return summary;
}

/**
 * Check if SMTP is configured and working
 */
async function testSmtp() {
  const smtp = getTransporter();
  if (!smtp) return { configured: false };

  try {
    await smtp.verify();
    return { configured: true, verified: true };
  } catch (err) {
    return { configured: true, verified: false, error: err.message };
  }
}

/**
 * Get notification configuration status
 */
function getNotificationStatus() {
  return {
    smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    trelloEmail: TRELLO_EMAIL,
    officeEmail: OFFICE_EMAIL,
    smtpHost: process.env.SMTP_HOST || '(not set)',
    smtpPort: process.env.SMTP_PORT || '587'
  };
}

module.exports = {
  sendPendingNotifications,
  sendTrelloCard,
  sendOfficeDigest,
  testSmtp,
  getNotificationStatus,
  formatTrelloCard,
  formatOfficeEmail
};
