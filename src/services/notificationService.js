/**
 * Notification Service (Task 7) - v2 with Resend API
 * 
 * Sends alerts via email to:
 * 1. Trello board (creates cards automatically via email-to-board)
 * 2. Office email for human review
 * 
 * Uses Resend HTTP API (works on Railway, no SMTP port needed)
 * Fallback to SMTP if RESEND_API_KEY not set but SMTP vars are
 * 
 * Email subject -> Trello card title
 * Email body -> Trello card description
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Notification targets
const TRELLO_EMAIL = process.env.TRELLO_BOARD_EMAIL || 'uth_limited+c9otswetpgdfphdpoehc@boards.trello.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const NOTIFICATION_EMAILS = [TRELLO_EMAIL, OFFICE_EMAIL].filter(Boolean);

// Severity -> emoji mapping for email subjects
const SEVERITY_EMOJI = {
  critical: '🚨',
  high: '🔴',
  medium: '🟡',
  info: 'ℹ️'
};

const ALERT_TYPE_LABEL = {
  status_change: 'שינוי סטטוס',
  committee_approval: 'אישור ועדה',
  opportunity: 'הזדמנות השקעה',
  stressed_seller: 'מוכר לחוץ',
  price_drop: 'ירידת מחיר'
};

/**
 * Send email via Resend HTTP API
 */
async function sendViaResend(to, subject, htmlBody, textBody) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set' };

  const fromAddress = process.env.EMAIL_FROM || 'QUANTUM <onboarding@resend.dev>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject: subject,
        html: htmlBody,
        text: textBody || htmlBody.replace(/<[^>]*>/g, '')
      })
    });

    const data = await response.json();

    if (response.ok) {
      logger.info(`Resend email sent to ${to}: ${subject}`, { id: data.id });
      return { sent: true, messageId: data.id, provider: 'resend' };
    } else {
      logger.error(`Resend API error for ${to}`, { status: response.status, error: data });
      return { sent: false, error: data.message || JSON.stringify(data), statusCode: response.status, provider: 'resend' };
    }
  } catch (err) {
    logger.error(`Resend request failed for ${to}`, { error: err.message });
    return { sent: false, error: err.message, provider: 'resend' };
  }
}

/**
 * Send email via SMTP (nodemailer) - fallback
 */
async function sendViaSMTP(to, subject, htmlBody, textBody) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return { sent: false, error: 'SMTP not configured' };
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || smtpUser,
      to,
      subject,
      html: htmlBody,
      text: textBody || htmlBody.replace(/<[^>]*>/g, '')
    });

    logger.info(`SMTP email sent to ${to}: ${subject}`, { messageId: info.messageId });
    return { sent: true, messageId: info.messageId, provider: 'smtp' };
  } catch (err) {
    logger.error(`SMTP failed for ${to}`, { error: err.message, code: err.code });
    return { sent: false, error: err.message, code: err.code, provider: 'smtp' };
  }
}

/**
 * Send a single email - tries Resend first, falls back to SMTP
 */
async function sendEmail(to, subject, htmlBody, textBody) {
  // Prefer Resend (works on Railway)
  if (process.env.RESEND_API_KEY) {
    return sendViaResend(to, subject, htmlBody, textBody);
  }
  // Fallback to SMTP
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return sendViaSMTP(to, subject, htmlBody, textBody);
  }
  return { sent: false, error: 'No email provider configured. Set RESEND_API_KEY or SMTP_HOST/USER/PASS' };
}

/**
 * Format a single alert for Trello card (email body -> card description)
 */
function formatAlertForTrello(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || '';
  const typeLabel = ALERT_TYPE_LABEL[alert.alert_type] || alert.alert_type;
  
  let body = `## ${alert.title}\n\n`;
  body += `${alert.message}\n\n`;
  body += `---\n`;
  body += `**סוג:** ${typeLabel}\n`;
  body += `**חומרה:** ${alert.severity}\n`;
  body += `**תאריך:** ${new Date(alert.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}\n`;

  if (alert.data) {
    const data = typeof alert.data === 'string' ? JSON.parse(alert.data) : alert.data;
    if (data.old_status && data.new_status) {
      body += `**סטטוס ישן:** ${data.old_status} -> **חדש:** ${data.new_status}\n`;
    }
    if (data.committee) {
      body += `**ועדה:** ${data.committee === 'local' ? 'מקומית' : 'מחוזית'}\n`;
    }
    if (data.old_iai !== undefined) {
      body += `**IAI:** ${data.old_iai} -> ${data.new_iai}\n`;
    }
    if (data.ssi_score) {
      body += `**SSI:** ${data.ssi_score}\n`;
    }
    if (data.drop_percent) {
      body += `**ירידה:** ${data.drop_percent}%\n`;
    }
  }

  const subject = `${emoji} [QUANTUM] ${typeLabel}: ${alert.title}`;
  return { subject, body };
}

/**
 * Format alert as HTML for office email
 */
function formatAlertHTML(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || '';
  const typeLabel = ALERT_TYPE_LABEL[alert.alert_type] || alert.alert_type;
  const severityColor = {
    critical: '#dc2626', high: '#ef4444', medium: '#f59e0b', info: '#3b82f6'
  }[alert.severity] || '#6b7280';

  return `
    <div style="border-left: 4px solid ${severityColor}; padding: 12px 16px; margin: 8px 0; background: #f9fafb;">
      <h3 style="margin: 0 0 8px; color: ${severityColor};">${emoji} ${alert.title}</h3>
      <p style="margin: 0 0 8px; color: #374151;">${alert.message}</p>
      <p style="margin: 0; font-size: 12px; color: #9ca3af;">
        ${typeLabel} | ${alert.severity} | ${new Date(alert.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}
      </p>
    </div>
  `;
}

/**
 * Send real-time notification for a high-severity alert
 */
async function sendAlertNotification(alert) {
  if (!alert || !['critical', 'high'].includes(alert.severity)) return 0;

  const trelloFormat = formatAlertForTrello(alert);
  const htmlBody = formatAlertHTML(alert);
  const subject = trelloFormat.subject;

  let sentCount = 0;

  if (TRELLO_EMAIL) {
    const result = await sendEmail(TRELLO_EMAIL, subject, trelloFormat.body, trelloFormat.body);
    if (result.sent) sentCount++;
  }

  if (OFFICE_EMAIL) {
    const fullHTML = `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #1f2937;">QUANTUM - התראה חדשה</h2>
        ${htmlBody}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p style="font-size: 11px; color: #9ca3af;">
          Pinuy Binuy Investment Analyzer | <a href="https://ravishing-spirit-production-27e1.up.railway.app/api/dashboard">Dashboard</a>
        </p>
      </div>
    `;
    const result = await sendEmail(OFFICE_EMAIL, subject, fullHTML);
    if (result.sent) sentCount++;
  }

  if (sentCount > 0) {
    try {
      await pool.query('UPDATE alerts SET sent_at = NOW() WHERE id = $1', [alert.id]);
    } catch (err) {
      logger.warn('Failed to mark alert as sent', { alertId: alert.id, error: err.message });
    }
  }

  return sentCount;
}

/**
 * Send all unsent high-severity alerts
 */
async function sendPendingAlerts() {
  try {
    const result = await pool.query(`
      SELECT a.*, c.name as complex_name, c.city
      FROM alerts a
      LEFT JOIN complexes c ON a.complex_id = c.id
      WHERE a.sent_at IS NULL AND a.severity IN ('critical', 'high')
      ORDER BY a.created_at ASC
      LIMIT 20
    `);

    if (result.rows.length === 0) {
      logger.info('No pending alerts to send');
      return { totalAlerts: 0, sent: 0 };
    }

    let sent = 0;
    for (const alert of result.rows) {
      const count = await sendAlertNotification(alert);
      if (count > 0) sent++;
      await new Promise(r => setTimeout(r, 1000));
    }

    logger.info(`Sent ${sent}/${result.rows.length} pending alerts`);
    return { totalAlerts: result.rows.length, sent };
  } catch (err) {
    logger.error('Failed to send pending alerts', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Alias for weekly scanner compatibility
 */
async function sendPendingNotifications() {
  return sendPendingAlerts();
}

/**
 * Send weekly digest email
 */
async function sendWeeklyDigest(scanResult) {
  if (!scanResult) return;

  const subject = `📊 [QUANTUM] סיכום שבועי - Pinuy Binuy Analyzer`;

  const alertsResult = await pool.query(`
    SELECT a.*, c.name as complex_name, c.city
    FROM alerts a
    LEFT JOIN complexes c ON a.complex_id = c.id
    WHERE a.created_at > NOW() - INTERVAL '7 days'
    ORDER BY 
      CASE a.severity 
        WHEN 'critical' THEN 1 WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 ELSE 4 
      END,
      a.created_at DESC
    LIMIT 30
  `);

  const topOpps = await pool.query(`
    SELECT name, city, status, iai_score, actual_premium
    FROM complexes WHERE iai_score >= 50
    ORDER BY iai_score DESC LIMIT 10
  `);

  let html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h1 style="color: #1f2937; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">
        📊 QUANTUM - סיכום שבועי
      </h1>
      
      <div style="background: #f0f9ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <h3 style="margin: 0 0 8px; color: #1e40af;">תוצאות סריקה</h3>
        <table style="width: 100%; border-collapse: collapse;">
  `;

  if (scanResult.nadlan) html += `<tr><td style="padding: 4px 8px;">nadlan.gov.il</td><td>${scanResult.nadlan.newTransactions || scanResult.nadlan.newTx || 0} עסקאות חדשות</td></tr>`;
  if (scanResult.yad2) html += `<tr><td style="padding: 4px 8px;">yad2</td><td>${scanResult.yad2.new || scanResult.yad2.newListings || 0} מודעות חדשות, ${scanResult.yad2.priceChanges || 0} שינויי מחיר</td></tr>`;
  if (scanResult.mavat) html += `<tr><td style="padding: 4px 8px;">mavat</td><td>${scanResult.mavat.statusChanges || 0} שינויי סטטוס, ${scanResult.mavat.committeeUpdates || 0} אישורי ועדה</td></tr>`;
  if (scanResult.benchmarks) html += `<tr><td style="padding: 4px 8px;">Benchmarks</td><td>${scanResult.benchmarks.calculated || 0} חושבו</td></tr>`;

  html += `
        </table>
        <p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">משך: ${scanResult.duration || 'N/A'} | ${scanResult.alertsGenerated || 0} התראות</p>
      </div>
  `;

  if (alertsResult.rows.length > 0) {
    html += `<h3 style="color: #1f2937; margin-top: 24px;">התראות השבוע (${alertsResult.rows.length})</h3>`;
    for (const alert of alertsResult.rows) {
      html += formatAlertHTML(alert);
    }
  }

  if (topOpps.rows.length > 0) {
    html += `
      <h3 style="color: #1f2937; margin-top: 24px;">Top 10 הזדמנויות</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 8px; text-align: right;">שם</th>
            <th style="padding: 8px; text-align: right;">עיר</th>
            <th style="padding: 8px; text-align: center;">סטטוס</th>
            <th style="padding: 8px; text-align: center;">IAI</th>
            <th style="padding: 8px; text-align: center;">פרמיה</th>
          </tr>
        </thead>
        <tbody>
    `;
    for (const opp of topOpps.rows) {
      const iaiColor = opp.iai_score >= 70 ? '#16a34a' : opp.iai_score >= 50 ? '#ca8a04' : '#6b7280';
      html += `
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 6px 8px;">${opp.name}</td>
          <td style="padding: 6px 8px;">${opp.city}</td>
          <td style="padding: 6px 8px; text-align: center;">${opp.status}</td>
          <td style="padding: 6px 8px; text-align: center; color: ${iaiColor}; font-weight: bold;">${opp.iai_score}</td>
          <td style="padding: 6px 8px; text-align: center;">${opp.actual_premium ? opp.actual_premium + '%' : 'N/A'}</td>
        </tr>
      `;
    }
    html += `</tbody></table>`;
  }

  html += `
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 8px;">
      <p style="font-size: 11px; color: #9ca3af; text-align: center;">
        QUANTUM - Pinuy Binuy Investment Analyzer v3.0 |
        <a href="https://ravishing-spirit-production-27e1.up.railway.app/api/dashboard">Dashboard</a>
      </p>
    </div>
  `;

  const trelloText = `סיכום שבועי QUANTUM\n\n` +
    `סריקה: ${scanResult.summary || 'N/A'}\n\n` +
    `התראות: ${alertsResult.rows.length}\n` +
    alertsResult.rows.slice(0, 10).map(a => `- ${a.title}: ${a.message}`).join('\n') +
    `\n\nTop הזדמנויות:\n` +
    topOpps.rows.map(o => `- ${o.name} (${o.city}) IAI=${o.iai_score}`).join('\n');

  let sent = 0;
  if (TRELLO_EMAIL) {
    const result = await sendEmail(TRELLO_EMAIL, subject, trelloText, trelloText);
    if (result.sent) sent++;
  }
  if (OFFICE_EMAIL) {
    const result = await sendEmail(OFFICE_EMAIL, subject, html);
    if (result.sent) sent++;
  }

  logger.info(`Weekly digest sent to ${sent} recipients`);
  return { sent, recipients: NOTIFICATION_EMAILS };
}

/**
 * Check if notifications are configured
 */
function isConfigured() {
  // Resend takes priority
  if (process.env.RESEND_API_KEY) return true;
  // Fallback to SMTP
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Get active provider info
 */
function getProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

module.exports = {
  sendAlertNotification,
  sendPendingAlerts,
  sendPendingNotifications,
  sendWeeklyDigest,
  sendEmail,
  isConfigured,
  getProvider,
  NOTIFICATION_EMAILS
};
