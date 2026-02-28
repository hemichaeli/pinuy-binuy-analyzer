const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * INFORU SMS Service for QUANTUM (Fixed v2)
 * Uses InforUMobile API - Correct XML format with Username/Password auth
 * 
 * Required env vars:
 *   INFORU_USERNAME - Account username from InforUMobile
 *   INFORU_PASSWORD - Account password from InforUMobile
 * 
 * API docs: https://uapi.inforu.co.il/SendMessageXml.ashx?InforuXML={xml}
 */

const INFORU_XML_URL = 'https://uapi.inforu.co.il/SendMessageXml.ashx';
const DEFAULT_SENDER = 'QUANTUM';

const TEMPLATES = {
  seller_initial: {
    name: '\u05E4\u05E0\u05D9\u05D9\u05D4 \u05E8\u05D0\u05E9\u05D5\u05E0\u05D9\u05EA \u05DC\u05DE\u05D5\u05DB\u05E8',
    template: `\u05E9\u05DC\u05D5\u05DD {name},
\u05E8\u05D0\u05D9\u05EA\u05D9 \u05E9\u05D9\u05E9 \u05DC\u05DA \u05E0\u05DB\u05E1 \u05DC\u05DE\u05DB\u05D9\u05E8\u05D4 \u05D1{address}, {city}.
\u05D0\u05E0\u05D9 \u05DE-QUANTUM, \u05DE\u05E9\u05E8\u05D3 \u05EA\u05D9\u05D5\u05D5\u05DA \u05D4\u05DE\u05EA\u05DE\u05D7\u05D4 \u05D1\u05E4\u05D9\u05E0\u05D5\u05D9-\u05D1\u05D9\u05E0\u05D5\u05D9.
\u05D9\u05E9 \u05DC\u05E0\u05D5 \u05E7\u05D5\u05E0\u05D9\u05DD \u05E8\u05E6\u05D9\u05E0\u05D9\u05D9\u05DD \u05DC\u05D0\u05D6\u05D5\u05E8 \u05E9\u05DC\u05DA.
\u05D0\u05E9\u05DE\u05D7 \u05DC\u05E9\u05D5\u05D7\u05D7 - {agent_phone}
QUANTUM Real Estate`,
    maxLength: 480
  },
  seller_followup: {
    name: '\u05DE\u05E2\u05E7\u05D1 \u05DC\u05DE\u05D5\u05DB\u05E8',
    template: `\u05E9\u05DC\u05D5\u05DD {name},
\u05E4\u05E0\u05D9\u05EA\u05D9 \u05D0\u05DC\u05D9\u05DA \u05DC\u05E4\u05E0\u05D9 \u05DE\u05E1\u05E4\u05E8 \u05D9\u05DE\u05D9\u05DD \u05D1\u05E0\u05D5\u05D2\u05E2 \u05DC\u05E0\u05DB\u05E1 \u05D1{address}.
\u05E2\u05D3\u05D9\u05D9\u05DF \u05D9\u05E9 \u05DC\u05E0\u05D5 \u05E2\u05E0\u05D9\u05D9\u05DF \u05E8\u05D1 \u05DE\u05E6\u05D3 \u05E7\u05D5\u05E0\u05D9\u05DD.
\u05E0\u05E9\u05DE\u05D7 \u05DC\u05E2\u05D6\u05D5\u05E8 - {agent_phone}
QUANTUM`,
    maxLength: 320
  },
  buyer_opportunity: {
    name: '\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05EA \u05DC\u05E7\u05D5\u05E0\u05D4',
    template: `\u05E9\u05DC\u05D5\u05DD {name},
\u05D9\u05E9 \u05DC\u05E0\u05D5 \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05EA \u05D7\u05D3\u05E9\u05D4 \u05E9\u05DE\u05EA\u05D0\u05D9\u05DE\u05D4 \u05DC\u05DA:
{complex_name}, {city}
\u05DE\u05DB\u05E4\u05D9\u05DC: x{multiplier} | \u05E1\u05D8\u05D8\u05D5\u05E1: {status}
\u05DC\u05E4\u05E8\u05D8\u05D9\u05DD: {agent_phone}
QUANTUM`,
    maxLength: 320
  },
  kones_inquiry: {
    name: '\u05E4\u05E0\u05D9\u05D9\u05D4 \u05DC\u05DB\u05D5\u05E0\u05E1',
    template: `\u05DC\u05DB\u05D1\u05D5\u05D3 \u05E2\u05D5"\u05D3 {name},
\u05D1\u05E0\u05D5\u05D2\u05E2 \u05DC\u05E0\u05DB\u05E1 \u05D1\u05DB\u05D9\u05E0\u05D5\u05E1 \u05D1{address}, {city}.
\u05D0\u05E0\u05D5 \u05DE-QUANTUM, \u05DE\u05E9\u05E8\u05D3 \u05EA\u05D9\u05D5\u05D5\u05DA \u05DE\u05EA\u05DE\u05D7\u05D4 \u05D1\u05E4\u05D9\u05E0\u05D5\u05D9-\u05D1\u05D9\u05E0\u05D5\u05D9.
\u05D9\u05E9 \u05DC\u05E0\u05D5 \u05E7\u05D5\u05E0\u05D9\u05DD \u05E4\u05D5\u05D8\u05E0\u05E6\u05D9\u05D0\u05DC\u05D9\u05D9\u05DD \u05DE\u05D9\u05D9\u05D3\u05D9\u05D9\u05DD.
\u05E0\u05E9\u05DE\u05D7 \u05DC\u05E9\u05D9\u05EA\u05D5\u05E3 \u05E4\u05E2\u05D5\u05DC\u05D4 - {agent_phone}`,
    maxLength: 480
  }
};

/**
 * Build INFORU XML payload (correct format per official API docs)
 * Uses Username + Password auth, semicolon-separated phones, <Sender> tag
 */
function buildXmlPayload(username, password, recipients, message, senderName = DEFAULT_SENDER) {
  const escapeXml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // INFORU expects semicolon-separated phone numbers in single PhoneNumber element
  const phoneNumbers = Array.isArray(recipients) ? recipients : [recipients];
  const phoneString = phoneNumbers.join(';');

  return `<Inforu>
<User>
<Username>${escapeXml(username)}</Username>
<Password>${escapeXml(password)}</Password>
</User>
<Content Type="sms">
<Message>${escapeXml(message)}</Message>
</Content>
<Recipients>
<PhoneNumber>${escapeXml(phoneString)}</PhoneNumber>
</Recipients>
<Settings>
<Sender>${escapeXml(senderName)}</Sender>
</Settings>
</Inforu>`;
}

async function sendSms(recipients, message, options = {}) {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  
  if (!username || !password) {
    throw new Error('INFORU_USERNAME and INFORU_PASSWORD must be configured in environment variables');
  }

  const senderName = options.senderName || DEFAULT_SENDER;
  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhone).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers provided');

  const isHebrew = /[\u0590-\u05FF]/.test(message);
  const maxSingleSms = isHebrew ? 70 : 160;
  const segments = Math.ceil(message.length / maxSingleSms);

  const xml = buildXmlPayload(username, password, phones, message, senderName);

  try {
    // INFORU API requires form-urlencoded with InforuXML parameter
    const response = await axios.post(INFORU_XML_URL, null, {
      params: { InforuXML: xml },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
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
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  
  if (!username || !password) {
    return { 
      configured: false, 
      error: 'INFORU_USERNAME and INFORU_PASSWORD not set. Set these in Railway environment variables.',
      hint: 'Login to inforu.co.il to find your API credentials'
    };
  }
  
  try {
    // Send to invalid number just to verify credentials work
    const xml = buildXmlPayload(username, password, '0000000000', 'credential_check', 'TEST');
    const response = await axios.post(INFORU_XML_URL, null, {
      params: { InforuXML: xml },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      timeout: 10000
    });
    const statusMatch = response.data.match(/<Status>(.*?)<\/Status>/);
    const descMatch = response.data.match(/<Description>(.*?)<\/Description>/);
    const status = statusMatch ? parseInt(statusMatch[1]) : -999;
    const description = descMatch ? descMatch[1] : 'Unknown';
    
    // Status -2 = bad credentials, -18 = wrong number (means credentials work!)
    const credentialsValid = status !== -2 && status !== -3 && status !== -4;
    
    return { 
      configured: true, 
      credentialsValid,
      status, 
      description,
      rawResponse: response.data 
    };
  } catch (err) {
    return { configured: true, credentialsValid: false, error: err.message };
  }
}

module.exports = { sendSms, bulkSend, fillTemplate, normalizePhone, getStats, checkAccountStatus, TEMPLATES };
