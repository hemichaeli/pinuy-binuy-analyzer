/**
 * Notification Service v3 - Smart Email Delivery
 * 
 * Sends alerts and scan status via email to:
 * 1. Personal email (hemi.michaeli@gmail.com) - always works
 * 2. Office email (Office@u-r-quantum.com) 
 * 3. Trello board - DISABLED (system alerts now in QUANTUM dashboard)
 * 
 * Smart provider selection:
 * - Tries Resend first (no SMTP port needed on Railway)
 * - Falls back to SMTP if Resend fails (e.g., sandbox domain restrictions)
 * - Logs all delivery attempts for debugging
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Notification targets - personal email first (always works with Resend sandbox)
const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const TRELLO_EMAIL = process.env.TRELLO_BOARD_EMAIL || 'uth_limited+c9otswetpgdfphdpoehc@boards.trello.com';

// All notification targets
// Alert notifications - no longer sent to Trello (system alerts now in QUANTUM dashboard)
const NOTIFICATION_EMAILS = [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);

// Severity -> emoji mapping for email subjects
const SEVERITY_EMOJI = {
  critical: '\u{1F6A8}',
  high: '\u{1F534}',
  medium: '\u{1F7E1}',
  info: '\u2139\uFE0F'
};

const ALERT_TYPE_LABEL = {
  status_change: '\u05E9\u05D9\u05E0\u05D5\u05D9 \u05E1\u05D8\u05D8\u05D5\u05E1',
  committee_approval: '\u05D0\u05D9\u05E9\u05D5\u05E8 \u05D5\u05E2\u05D3\u05D4',
  opportunity: '\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05EA \u05D4\u05E9\u05E7\u05E2\u05D4',
  stressed_seller: '\u05DE\u05D5\u05DB\u05E8 \u05DC\u05D7\u05D5\u05E5',
  price_drop: '\u05D9\u05E8\u05D9\u05D3\u05EA \u05DE\u05D7\u05D9\u05E8',
  new_complex: '\u05DE\u05EA\u05D7\u05DD \u05D7\u05D3\u05E9'
};

/**
 * Send email via Resend HTTP API
 */
async function sendViaResend(to, subject, htmlBody, textBody) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set', provider: 'resend' };

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
      logger.info(`\u2709\uFE0F Resend: sent to ${to}`, { id: data.id });
      return { sent: true, messageId: data.id, provider: 'resend' };
    } else {
      logger.warn(`Resend failed for ${to}: ${data.message || response.status}`, { status: response.status });
      return { sent: false, error: data.message || `HTTP ${response.status}`, statusCode: response.status, provider: 'resend' };
    }
  } catch (err) {
    logger.error(`Resend error for ${to}`, { error: err.message });
    return { sent: false, error: err.message, provider: 'resend' };
  }
}

/**
 * Send email via SMTP (nodemailer)
 */
async function sendViaSMTP(to, subject, htmlBody, textBody) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return { sent: false, error: 'SMTP not configured', provider: 'smtp' };
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

    logger.info(`\u2709\uFE0F SMTP: sent to ${to}`, { messageId: info.messageId });
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
  if (process.env.RESEND_API_KEY) {
    const resendResult = await sendViaResend(to, subject, htmlBody, textBody);
    if (resendResult.sent) return resendResult;
    logger.info(`Resend failed for ${to}, trying SMTP fallback...`);
  }
  
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return sendViaSMTP(to, subject, htmlBody, textBody);
  }
  
  return { sent: false, error: 'No email provider available', provider: 'none' };
}

/**
 * Format a single alert for Trello card
 */
function formatAlertForTrello(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || '';
  const typeLabel = ALERT_TYPE_LABEL[alert.alert_type] || alert.alert_type;
  
  let body = `## ${alert.title}\n\n`;
  body += `${alert.message}\n\n`;
  body += `---\n`;
  body += `**\u05E1\u05D5\u05D2:** ${typeLabel}\n`;
  body += `**\u05D7\u05D5\u05DE\u05E8\u05D4:** ${alert.severity}\n`;
  body += `**\u05EA\u05D0\u05E8\u05D9\u05DA:** ${new Date(alert.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}\n`;

  if (alert.data) {
    const data = typeof alert.data === 'string' ? JSON.parse(alert.data) : alert.data;
    if (data.old_status && data.new_status) {
      body += `**\u05E1\u05D8\u05D8\u05D5\u05E1 \u05D9\u05E9\u05DF:** ${data.old_status} -> **\u05D7\u05D3\u05E9:** ${data.new_status}\n`;
    }
    if (data.committee) {
      body += `**\u05D5\u05E2\u05D3\u05D4:** ${data.committee === 'local' ? '\u05DE\u05E7\u05D5\u05DE\u05D9\u05EA' : '\u05DE\u05D7\u05D5\u05D6\u05D9\u05EA'}\n`;
    }
    if (data.old_iai !== undefined) {
      body += `**IAI:** ${data.old_iai} -> ${data.new_iai}\n`;
    }
    if (data.ssi_score) {
      body += `**SSI:** ${data.ssi_score}\n`;
    }
    if (data.drop_percent) {
      body += `**\u05D9\u05E8\u05D9\u05D3\u05D4:** ${data.drop_percent}%\n`;
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

  for (const email of NOTIFICATION_EMAILS) {
    try {
      const isPersonalOrOffice = email !== TRELLO_EMAIL;
      const body = isPersonalOrOffice ? `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #1f2937;">QUANTUM - \u05D4\u05EA\u05E8\u05D0\u05D4 \u05D7\u05D3\u05E9\u05D4</h2>
          ${htmlBody}
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
          <p style="font-size: 11px; color: #9ca3af;">
            QUANTUM v4.20 | <a href="https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard">Dashboard</a>
          </p>
        </div>
      ` : trelloFormat.body;

      const result = await sendEmail(email, subject, body, email === TRELLO_EMAIL ? trelloFormat.body : undefined);
      if (result.sent) sentCount++;
    } catch (err) {
      logger.warn(`Failed to send alert to ${email}`, { error: err.message });
    }
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

  const subject = `\u{1F4CA} [QUANTUM] \u05E1\u05D9\u05DB\u05D5\u05DD \u05E9\u05D1\u05D5\u05E2\u05D9 - Pinuy Binuy Analyzer`;

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
        \u{1F4CA} QUANTUM - \u05E1\u05D9\u05DB\u05D5\u05DD \u05E9\u05D1\u05D5\u05E2\u05D9
      </h1>
      
      <div style="background: #f0f9ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <h3 style="margin: 0 0 8px; color: #1e40af;">\u05EA\u05D5\u05E6\u05D0\u05D5\u05EA \u05E1\u05E8\u05D9\u05E7\u05D4</h3>
        <table style="width: 100%; border-collapse: collapse;">
  `;

  if (scanResult.nadlan) html += `<tr><td style="padding: 4px 8px;">nadlan.gov.il</td><td>${scanResult.nadlan.newTransactions || scanResult.nadlan.newTx || 0} \u05E2\u05E1\u05E7\u05D0\u05D5\u05EA \u05D7\u05D3\u05E9\u05D5\u05EA</td></tr>`;
  if (scanResult.yad2) html += `<tr><td style="padding: 4px 8px;">yad2</td><td>${scanResult.yad2.new || scanResult.yad2.newListings || 0} \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05D7\u05D3\u05E9\u05D5\u05EA, ${scanResult.yad2.priceChanges || 0} \u05E9\u05D9\u05E0\u05D5\u05D9\u05D9 \u05DE\u05D7\u05D9\u05E8</td></tr>`;
  if (scanResult.mavat) html += `<tr><td style="padding: 4px 8px;">mavat</td><td>${scanResult.mavat.statusChanges || 0} \u05E9\u05D9\u05E0\u05D5\u05D9\u05D9 \u05E1\u05D8\u05D8\u05D5\u05E1, ${scanResult.mavat.committeeUpdates || 0} \u05D0\u05D9\u05E9\u05D5\u05E8\u05D9 \u05D5\u05E2\u05D3\u05D4</td></tr>`;
  if (scanResult.benchmarks) html += `<tr><td style="padding: 4px 8px;">Benchmarks</td><td>${scanResult.benchmarks.calculated || 0} \u05D7\u05D5\u05E9\u05D1\u05D5</td></tr>`;

  html += `
        </table>
        <p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">\u05DE\u05E9\u05DA: ${scanResult.duration || 'N/A'} | ${scanResult.alertsGenerated || 0} \u05D4\u05EA\u05E8\u05D0\u05D5\u05EA</p>
      </div>
  `;

  if (alertsResult.rows.length > 0) {
    html += `<h3 style="color: #1f2937; margin-top: 24px;">\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05D4\u05E9\u05D1\u05D5\u05E2 (${alertsResult.rows.length})</h3>`;
    for (const alert of alertsResult.rows) {
      html += formatAlertHTML(alert);
    }
  }

  if (topOpps.rows.length > 0) {
    html += `
      <h3 style="color: #1f2937; margin-top: 24px;">Top 10 \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 8px; text-align: right;">\u05E9\u05DD</th>
            <th style="padding: 8px; text-align: right;">\u05E2\u05D9\u05E8</th>
            <th style="padding: 8px; text-align: center;">\u05E1\u05D8\u05D8\u05D5\u05E1</th>
            <th style="padding: 8px; text-align: center;">IAI</th>
            <th style="padding: 8px; text-align: center;">\u05E4\u05E8\u05DE\u05D9\u05D4</th>
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
        QUANTUM v4.20 - Direct API Mode |
        <a href="https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard">Dashboard</a>
      </p>
    </div>
  `;

  const trelloText = `\u05E1\u05D9\u05DB\u05D5\u05DD \u05E9\u05D1\u05D5\u05E2\u05D9 QUANTUM\n\n` +
    `\u05E1\u05E8\u05D9\u05E7\u05D4: ${scanResult.summary || 'N/A'}\n\n` +
    `\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA: ${alertsResult.rows.length}\n` +
    alertsResult.rows.slice(0, 10).map(a => `- ${a.title}: ${a.message}`).join('\n') +
    `\n\nTop \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA:\n` +
    topOpps.rows.map(o => `- ${o.name} (${o.city}) IAI=${o.iai_score}`).join('\n');

  let sent = 0;
  for (const email of [PERSONAL_EMAIL, OFFICE_EMAIL]) {
    if (email) {
      const result = await sendEmail(email, subject, html);
      if (result.sent) sent++;
    }
  }
  if (TRELLO_EMAIL) {
    const result = await sendEmail(TRELLO_EMAIL, subject, trelloText, trelloText);
    if (result.sent) sent++;
  }

  logger.info(`Weekly digest sent to ${sent}/${NOTIFICATION_EMAILS.length} recipients`);
  return { sent, recipients: NOTIFICATION_EMAILS };
}

/**
 * Check if notifications are configured
 */
function isConfigured() {
  if (process.env.RESEND_API_KEY) return true;
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Get active provider info
 */
function getProvider() {
  const providers = [];
  if (process.env.RESEND_API_KEY) providers.push('resend');
  if (process.env.SMTP_HOST) providers.push('smtp');
  return providers.length ? providers.join('+') : 'none';
}

module.exports = {
  sendAlertNotification,
  sendPendingAlerts,
  sendPendingNotifications,
  sendWeeklyDigest,
  sendEmail,
  isConfigured,
  getProvider,
  NOTIFICATION_EMAILS,
  PERSONAL_EMAIL,
  OFFICE_EMAIL,
  TRELLO_EMAIL
};
