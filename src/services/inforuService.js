const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * INFORU SMS & WhatsApp Service for QUANTUM
 * Uses InforUMobile API (https://apidoc.inforu.co.il)
 * Token: Set via INFORU_API_TOKEN env variable
 */

const INFORU_XML_URL = 'https://api.inforu.co.il/SendMessageXml.ashx';
const INFORU_REST_URL = 'https://capi.inforu.co.il/api/v2/SMS/SendSms';
const DEFAULT_SENDER = 'QUANTUM';

const TEMPLATES = {
  seller_initial: {
    name: 'פנייה ראשונית למוכר',
    template: `שלום {name},
ראיתי שיש לך נכס למכירה ב{address}, {city}.
אני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים רציניים לאזור שלך.
אשמח לשוחח - {agent_phone}
QUANTUM Real Estate`,
    maxLength: 480
  },
  seller_followup: {
    name: 'מעקב למוכר',
    template: `שלום {name},
פניתי אליך לפני מספר ימים בנוגע לנכס ב{address}.
עדיין יש לנו עניין רב מצד קונים.
נשמח לעזור - {agent_phone}
QUANTUM`,
    maxLength: 320
  },
  buyer_opportunity: {
    name: 'הזדמנות לקונה',
    template: `שלום {name},
יש לנו הזדמנות חדשה שמתאימה לך:
{complex_name}, {city}
מכפיל: x{multiplier} | סטטוס: {status}
לפרטים: {agent_phone}
QUANTUM`,
    maxLength: 320
  },
  kones_inquiry: {
    name: 'פנייה לכונס',
    template: `לכבוד עו"ד {name},
בנוגע לנכס בכינוס ב{address}, {city}.
אנו מ-QUANTUM, משרד תיווך מתמחה בפינוי-בינוי.
יש לנו קונים פוטנציאליים מיידיים.
נשמח לשיתוף פעולה - {agent_phone}`,
    maxLength: 480
  }
};

function buildXmlPayload(token, recipients, message, senderName = DEFAULT_SENDER) {
  const escapeXml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const phoneNumbers = Array.isArray(recipients) ? recipients : [recipients];
  const recipientXml = phoneNumbers.map(p => `<PhoneNumber>${escapeXml(p)}</PhoneNumber>`).join('\n    ');

  return `<Inforu>
  <User>
    <Token>${escapeXml(token)}</Token>
  </User>
  <Content Type="sms">
    <Message>${escapeXml(message)}</Message>
  </Content>
  <Recipients>
    ${recipientXml}
  </Recipients>
  <Settings>
    <SenderName>${escapeXml(senderName)}</SenderName>
  </Settings>
</Inforu>`;
}

async function sendSms(recipients, message, options = {}) {
  const token = process.env.INFORU_API_TOKEN;
  if (!token) throw new Error('INFORU_API_TOKEN not configured');

  const senderName = options.senderName || DEFAULT_SENDER;
  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhone).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers provided');

  const isHebrew = /[\u0590-\u05FF]/.test(message);
  const maxSingleSms = isHebrew ? 70 : 160;
  const segments = Math.ceil(message.length / maxSingleSms);

  const xml = buildXmlPayload(token, phones, message, senderName);

  try {
    const response = await axios.post(INFORU_XML_URL, xml, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: 30000
    });

    const statusMatch = response.data.match(/<Status>(.*?)<\/Status>/);
    const descMatch = response.data.match(/<Description>(.*?)<\/Description>/);
    const countMatch = response.data.match(/<NumberOfRecipients>(.*?)<\/NumberOfRecipients>/);

    const status = statusMatch ? parseInt(statusMatch[1]) : -999;
    const description = descMatch ? descMatch[1] : 'Unknown';
    const recipientCount = countMatch ? parseInt(countMatch[1]) : 0;

    const result = {
      success: status === 1,
      status,
      description,
      recipientsCount: recipientCount,
      messageSegments: segments,
      phones,
      timestamp: new Date().toISOString()
    };

    await logMessage(result, message, phones, options);

    if (status !== 1) {
      logger.warn('INFORU SMS failed', { status, description, phones });
    } else {
      logger.info(`INFORU SMS sent to ${recipientCount} recipients`, { phones });
    }

    return result;
  } catch (err) {
    logger.error('INFORU API error', { error: err.message });
    throw err;
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  if (cleaned.startsWith('05')) cleaned = '972' + cleaned.substring(1);
  if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
  if (cleaned.startsWith('972') && cleaned.length >= 11 && cleaned.length <= 13) return cleaned;
  if (cleaned.length >= 10 && cleaned.length <= 13) return cleaned;
  return null;
}

function fillTemplate(templateKey, variables) {
  const tmpl = TEMPLATES[templateKey];
  if (!tmpl) throw new Error(`Template "${templateKey}" not found`);
  let message = tmpl.template;
  for (const [key, value] of Object.entries(variables)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return message;
}

async function bulkSend(templateKey, recipientsList, options = {}) {
  const results = { total: recipientsList.length, sent: 0, failed: 0, errors: [], details: [] };
  const batchSize = options.batchSize || 10;
  const delayBetweenBatches = options.delayMs || 2000;

  for (let i = 0; i < recipientsList.length; i += batchSize) {
    const batch = recipientsList.slice(i, i + batchSize);
    for (const recipient of batch) {
      try {
        const message = fillTemplate(templateKey, recipient.variables || {});
        const result = await sendSms(recipient.phone, message, {
          ...options, listingId: recipient.listingId, complexId: recipient.complexId
        });
        if (result.success) results.sent++; else { results.failed++; results.errors.push({ phone: recipient.phone, error: result.description }); }
        results.details.push(result);
      } catch (err) {
        results.failed++;
        results.errors.push({ phone: recipient.phone, error: err.message });
      }
    }
    if (i + batchSize < recipientsList.length) await new Promise(r => setTimeout(r, delayBetweenBatches));
  }

  logger.info(`Bulk SMS complete: ${results.sent}/${results.total} sent`, { templateKey, failed: results.failed });
  return results;
}

async function logMessage(result, message, phones, options = {}) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sent_messages (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20),
        message TEXT,
        template_key VARCHAR(50),
        status VARCHAR(20),
        status_code INTEGER,
        status_description TEXT,
        listing_id INTEGER,
        complex_id INTEGER,
        channel VARCHAR(20) DEFAULT 'sms',
        sender VARCHAR(50) DEFAULT 'QUANTUM',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    for (const phone of phones) {
      await pool.query(
        `INSERT INTO sent_messages (phone, message, template_key, status, status_code, status_description, listing_id, complex_id, channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [phone, message.substring(0, 500), options.templateKey || null,
         result.success ? 'sent' : 'failed', result.status, result.description,
         options.listingId || null, options.complexId || null, options.channel || 'sms']
      );
    }
  } catch (err) {
    logger.warn('Failed to log message', { error: err.message });
  }
}

async function getStats() {
  try {
    const stats = await pool.query(`
      SELECT COUNT(*) as total_sent, COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(DISTINCT phone) as unique_recipients, COUNT(DISTINCT complex_id) as complexes_contacted,
        MIN(created_at) as first_message, MAX(created_at) as last_message
      FROM sent_messages
    `);
    return stats.rows[0] || { total_sent: 0, successful: 0, failed: 0, unique_recipients: 0, complexes_contacted: 0 };
  } catch (err) {
    return { total_sent: 0, successful: 0, failed: 0, unique_recipients: 0, complexes_contacted: 0 };
  }
}

async function checkAccountStatus() {
  const token = process.env.INFORU_API_TOKEN;
  if (!token) return { configured: false, error: 'INFORU_API_TOKEN not set' };
  try {
    const xml = buildXmlPayload(token, '0000000000', 'test', 'TEST');
    const response = await axios.post(INFORU_XML_URL, xml, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 10000
    });
    const statusMatch = response.data.match(/<Status>(.*?)<\/Status>/);
    const status = statusMatch ? parseInt(statusMatch[1]) : -999;
    return { configured: true, tokenValid: status !== -2 && status !== -3, status, rawResponse: response.data };
  } catch (err) {
    return { configured: true, tokenValid: false, error: err.message };
  }
}

module.exports = { sendSms, bulkSend, fillTemplate, normalizePhone, getStats, checkAccountStatus, TEMPLATES };
