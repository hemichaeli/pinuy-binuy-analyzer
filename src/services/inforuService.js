const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * INFORU SMS + WhatsApp Service for QUANTUM
 * SMS: UAPI XML endpoint
 * WhatsApp: CAPI v2 REST endpoint
 */

const INFORU_XML_URL = 'https://uapi.inforu.co.il/SendMessageXml.ashx';
const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEFAULT_SENDER = 'QUANTUM';

// --- SMS Templates (free-text) ---
const SMS_TEMPLATES = {
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
אנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים פוטנציאליים מיידיים.
נשמח לשיתוף פעולה - {agent_phone}`,
    maxLength: 480
  }
};

// --- WhatsApp Templates (INFORU approved - real template IDs) ---
const WA_TEMPLATES = {
  // Template: קישור לתיקייה ציבורית של דירה מעודכן
  file_link_updated: {
    templateId: '214803',
    name: 'קישור לתיקייה ציבורית של דירה מעודכן',
    params: ['name'],  // היי [#1#]
    hasButtons: true,
    buttonType: 'URL'
  },
  // Template: קישור לתיקייה ציבורית של דירה
  file_link_basic: {
    templateId: '213960',
    name: 'קישור לתיקייה ציבורית של דירה',
    params: ['name'],  // היי [#1#]
    hasButtons: false
  },
  // Template: אישור השתתפות לפרויקט
  project_attendance: {
    templateId: '212543',
    name: 'אישור השתתפות לפרויקט',
    params: ['name', 'project_name'],  // שלום [#1#], פרויקט [#2#]
    hasButtons: true,
    buttonType: 'QUICK_REPLY'
  },
  // Template: אישור השתתפות (מפורט)
  meeting_attendance: {
    templateId: '211339',
    name: 'אישור השתתפות',
    params: ['name', 'meeting_type', 'date', 'address', 'time', 'attendees'],
    hasButtons: true,
    buttonType: 'QUICK_REPLY'
  },
  // Template: מוסד 2 (tested and working!)
  institutional_message: {
    templateId: '200763',
    name: 'מוסד 2',
    params: [],  // No parameters
    hasButtons: false
  },
  // Template: מוסד (original)
  institutional_original: {
    templateId: '200683',
    name: 'מוסד',
    params: [],
    hasButtons: false
  },
  // Template: היכרות לנציגות מתחם 1 עם דן קושניר
  representative_intro: {
    templateId: '180735',
    name: 'היכרות לנציגות מתחם 1 עם דן קושניר',
    params: [],
    hasButtons: true,
    buttonType: 'QUICK_REPLY'
  }
};

// QUANTUM-specific template mappings
const QUANTUM_WA_MAPPINGS = {
  seller_initial: 'file_link_basic',      // Use basic file link template
  seller_followup: 'institutional_message', // Use working tested template
  buyer_opportunity: 'project_attendance',   // Use project attendance template
  kones_inquiry: 'representative_intro',     // Use intro template
  test_message: 'institutional_message'      // For testing - working template
};

// ==================== AUTH ====================

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// ==================== SMS ====================

function buildXmlPayload(username, password, recipients, message, senderName = DEFAULT_SENDER) {
  const esc = (str) => String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const phones = Array.isArray(recipients) ? recipients : [recipients];
  return `<Inforu>
<User>
<Username>${esc(username)}</Username>
<Password>${esc(password)}</Password>
</User>
<Content Type="sms">
<Message>${esc(message)}</Message>
</Content>
<Recipients>
<PhoneNumber>${esc(phones.join(';'))}</PhoneNumber>
</Recipients>
<Settings>
<Sender>${esc(senderName)}</Sender>
</Settings>
</Inforu>`;
}

async function sendSms(recipients, message, options = {}) {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');

  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhone).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers');

  const isHebrew = /[\u0590-\u05FF]/.test(message);
  const segments = Math.ceil(message.length / (isHebrew ? 70 : 160));
  const xml = buildXmlPayload(username, password, phones, message, options.senderName || DEFAULT_SENDER);

  try {
    const response = await axios.post(INFORU_XML_URL, null, {
      params: { InforuXML: xml },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      timeout: 30000
    });

    const status = parseInt((response.data.match(/<Status>(.*?)<\/Status>/) || [])[1] || '-999');
    const description = (response.data.match(/<Description>(.*?)<\/Description>/) || [])[1] || 'Unknown';
    const recipientCount = parseInt((response.data.match(/<NumberOfRecipients>(.*?)<\/NumberOfRecipients>/) || [])[1] || '0');

    const result = {
      success: status === 1, status, description,
      recipientsCount: recipientCount, messageSegments: segments,
      phones, channel: 'sms', timestamp: new Date().toISOString()
    };

    await logMessage(result, message, phones, { ...options, channel: 'sms' });
    if (status === 1) logger.info(`SMS sent to ${recipientCount} recipients`, { phones });
    else logger.warn('SMS failed', { status, description, phones });

    return result;
  } catch (err) {
    logger.error('SMS API error', { error: err.message });
    throw err;
  }
}

// ==================== WHATSAPP ====================

/**
 * Send WhatsApp template message via CAPI
 * @param {string|string[]} recipients - Phone number(s)
 * @param {string} templateKey - Key from WA_TEMPLATES or QUANTUM_WA_MAPPINGS
 * @param {object} variables - Template parameter values
 * @param {object} options - Additional options
 */
async function sendWhatsApp(recipients, templateKey, variables = {}, options = {}) {
  // Map QUANTUM template keys to actual WA templates
  const actualTemplateKey = QUANTUM_WA_MAPPINGS[templateKey] || templateKey;
  const tmpl = WA_TEMPLATES[actualTemplateKey];
  
  if (!tmpl) throw new Error(`WhatsApp template "${templateKey}" -> "${actualTemplateKey}" not found`);

  const phones = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhoneLocal).filter(Boolean);
  if (phones.length === 0) throw new Error('No valid phone numbers');

  // Build template parameters (only if template has params)
  const templateParams = tmpl.params && tmpl.params.length > 0 
    ? tmpl.params.map((paramName, idx) => ({
        Name: `[#${idx + 1}#]`,
        Type: 'Text',
        Value: variables[paramName] || variables[`param${idx + 1}`] || ''
      }))
    : [];

  // Build recipients array
  const recipientsArray = phones.map(phone => ({ Phone: phone }));

  const payload = {
    Data: {
      TemplateId: tmpl.templateId,
      ...(templateParams.length > 0 ? { TemplateParameters: templateParams } : {}),
      Recipients: recipientsArray
    }
  };

  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsApp`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getBasicAuth()
      },
      timeout: 30000
    });

    const data = response.data;
    const result = {
      success: data.StatusId === 1,
      status: data.StatusId,
      description: data.StatusDescription,
      recipientsCount: data.Data?.Recipients || 0,
      errors: data.Data?.Errors || null,
      phones, channel: 'whatsapp',
      templateKey: actualTemplateKey, 
      originalTemplateKey: templateKey,
      templateId: tmpl.templateId,
      timestamp: new Date().toISOString()
    };

    // Build message text for logging
    const msgText = `[WA Template: ${tmpl.name}] ${JSON.stringify(variables)}`;
    await logMessage(result, msgText, phones, { ...options, channel: 'whatsapp', templateKey: actualTemplateKey });

    if (data.StatusId === 1) {
      logger.info(`WhatsApp sent to ${data.Data?.Recipients} recipients`, { 
        templateKey: actualTemplateKey, 
        originalKey: templateKey,
        templateId: tmpl.templateId,
        phones 
      });
    } else {
      logger.warn('WhatsApp send failed', { 
        status: data.StatusId, 
        description: data.StatusDescription, 
        errors: data.Data?.Errors,
        templateKey: actualTemplateKey
      });
    }

    return result;
  } catch (err) {
    logger.error('WhatsApp API error', { error: err.message, templateKey: actualTemplateKey });
    throw err;
  }
}

/**
 * Send WhatsApp chat message (only within 24h window)
 */
async function sendWhatsAppChat(phone, message, options = {}) {
  const normalizedPhone = normalizePhoneLocal(phone);
  if (!normalizedPhone) throw new Error('Invalid phone number');

  const payload = {
    Data: {
      Message: message,
      Phone: normalizedPhone,
      ...(options.mediaUrl ? { MessageMedia: options.mediaUrl } : {}),
      Settings: {
        ...(options.customerMessageId ? { CustomerMessageId: options.customerMessageId } : {}),
        ...(options.customerParameter ? { CustomerParameter: options.customerParameter } : {})
      }
    }
  };

  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getBasicAuth()
      },
      timeout: 30000
    });

    const data = response.data;
    const result = {
      success: data.StatusId === 1,
      status: data.StatusId,
      description: data.StatusDescription,
      phone: normalizedPhone, channel: 'whatsapp_chat',
      timestamp: new Date().toISOString()
    };

    await logMessage(result, message, [normalizedPhone], { ...options, channel: 'whatsapp_chat' });
    return result;
  } catch (err) {
    logger.error('WhatsApp Chat API error', { error: err.message });
    throw err;
  }
}

/**
 * Get list of WhatsApp templates from INFORU
 */
async function getWhatsAppTemplates() {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplateList`, 
      { Data: {} },
      {
        headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
        timeout: 15000
      }
    );
    return response.data;
  } catch (err) {
    logger.error('Failed to get WA templates', { error: err.message });
    throw err;
  }
}

/**
 * Get WhatsApp template details
 */
async function getWhatsAppTemplate(templateId) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplate`,
      { Data: { TemplateId: String(templateId) } },
      {
        headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
        timeout: 15000
      }
    );
    return response.data;
  } catch (err) {
    logger.error('Failed to get WA template', { error: err.message, templateId });
    throw err;
  }
}

/**
 * Pull incoming WhatsApp messages
 */
async function pullIncomingWhatsApp(batchSize = 100) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/PullData`,
      { Data: { Type: 'IncomingMessagesWhatsapp', BatchSize: batchSize } },
      {
        headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
        timeout: 15000
      }
    );
    return response.data;
  } catch (err) {
    logger.error('Failed to pull WA messages', { error: err.message });
    throw err;
  }
}

/**
 * Pull WhatsApp delivery reports
 */
async function pullWhatsAppDLR(batchSize = 100) {
  try {
    const response = await axios.post(`${INFORU_CAPI_BASE}/PullData`,
      { Data: { Type: 'DeliveryNotificationWhatsapp', BatchSize: batchSize } },
      {
        headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() },
        timeout: 15000
      }
    );
    return response.data;
  } catch (err) {
    logger.error('Failed to pull WA DLR', { error: err.message });
    throw err;
  }
}

// ==================== DUAL CHANNEL ====================

/**
 * Send message on both SMS and WhatsApp
 */
async function sendDualChannel(recipients, templateKey, variables = {}, options = {}) {
  const results = { sms: null, whatsapp: null };

  // Send SMS
  try {
    const smsMessage = fillTemplate(templateKey, variables);
    results.sms = await sendSms(recipients, smsMessage, options);
  } catch (err) {
    results.sms = { success: false, error: err.message, channel: 'sms' };
  }

  // Send WhatsApp (if mapping exists)
  if (QUANTUM_WA_MAPPINGS[templateKey] || WA_TEMPLATES[templateKey]) {
    try {
      results.whatsapp = await sendWhatsApp(recipients, templateKey, variables, options);
    } catch (err) {
      results.whatsapp = { success: false, error: err.message, channel: 'whatsapp' };
    }
  }

  return results;
}

// ==================== HELPERS ====================

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

// For WhatsApp CAPI - keep local format (05x)
function normalizePhoneLocal(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+972')) cleaned = '0' + cleaned.substring(4);
  if (cleaned.startsWith('972')) cleaned = '0' + cleaned.substring(3);
  if (cleaned.startsWith('05') && cleaned.length === 10) return cleaned;
  return cleaned;
}

function fillTemplate(templateKey, variables) {
  const tmpl = SMS_TEMPLATES[templateKey];
  if (!tmpl) throw new Error(`SMS template "${templateKey}" not found`);
  let message = tmpl.template;
  for (const [key, value] of Object.entries(variables)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return message;
}

async function bulkSend(templateKey, recipientsList, options = {}) {
  const channel = options.channel || 'sms';
  const results = { total: recipientsList.length, sent: 0, failed: 0, errors: [], details: [] };
  const batchSize = options.batchSize || 10;
  const delayMs = options.delayMs || 2000;

  for (let i = 0; i < recipientsList.length; i += batchSize) {
    const batch = recipientsList.slice(i, i + batchSize);
    for (const recipient of batch) {
      try {
        let result;
        if (channel === 'whatsapp') {
          result = await sendWhatsApp(recipient.phone, templateKey, recipient.variables || {}, options);
        } else if (channel === 'dual') {
          result = await sendDualChannel(recipient.phone, templateKey, recipient.variables || {}, options);
        } else {
          const message = fillTemplate(templateKey, recipient.variables || {});
          result = await sendSms(recipient.phone, message, options);
        }

        const success = channel === 'dual' 
          ? (result.sms?.success || result.whatsapp?.success)
          : result.success;

        if (success) results.sent++; 
        else { results.failed++; results.errors.push({ phone: recipient.phone, error: result.description || 'Failed' }); }
        results.details.push(result);
      } catch (err) {
        results.failed++;
        results.errors.push({ phone: recipient.phone, error: err.message });
      }
    }
    if (i + batchSize < recipientsList.length) await new Promise(r => setTimeout(r, delayMs));
  }

  logger.info(`Bulk ${channel} complete: ${results.sent}/${results.total}`, { templateKey, channel });
  return results;
}

// ==================== LOGGING & STATUS ====================

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
        template_id VARCHAR(50),
        sender VARCHAR(50) DEFAULT 'QUANTUM',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    for (const phone of phones) {
      await pool.query(
        `INSERT INTO sent_messages (phone, message, template_key, status, status_code, status_description, listing_id, complex_id, channel, template_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [phone, message.substring(0, 500), options.templateKey || null,
         result.success ? 'sent' : 'failed', result.status, result.description,
         options.listingId || null, options.complexId || null, options.channel || 'sms',
         result.templateId || null]
      );
    }
  } catch (err) {
    logger.warn('Failed to log message', { error: err.message });
  }
}

async function getStats() {
  try {
    const stats = await pool.query(`
      SELECT 
        channel,
        COUNT(*) as total_sent, 
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(DISTINCT phone) as unique_recipients,
        MIN(created_at) as first_message, 
        MAX(created_at) as last_message
      FROM sent_messages
      GROUP BY channel
    `);
    return stats.rows;
  } catch (err) {
    return [];
  }
}

async function checkAccountStatus() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) {
    return { configured: false, error: 'INFORU credentials not set' };
  }

  const result = { configured: true, credentialsValid: true, sms: null, whatsapp: null };

  // Check SMS
  try {
    const xml = buildXmlPayload(username, password, '0000000000', 'QUANTUM test message', 'QUANTUM');
    const resp = await axios.post(INFORU_XML_URL, null, {
      params: { InforuXML: xml },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      timeout: 10000
    });
    const status = parseInt((resp.data.match(/<Status>(.*?)<\/Status>/) || [])[1] || '-999');
    const description = (resp.data.match(/<Description>(.*?)<\/Description>/) || [])[1] || 'Unknown';
    result.sms = { working: status === 1, status, description };
  } catch (err) {
    result.sms = { working: false, error: err.message };
  }

  // Check WhatsApp
  try {
    const resp = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/GetTemplateList`,
      { Data: {} },
      { headers: { 'Content-Type': 'application/json', 'Authorization': getBasicAuth() }, timeout: 10000 }
    );
    const templateCount = resp.data.Data?.Count || 0;
    result.whatsapp = { 
      working: resp.data.StatusId === 1, 
      templateCount,
      status: resp.data.StatusId,
      description: resp.data.StatusDescription || 'Success',
      templates: templateCount > 0 ? resp.data.Data.List.slice(0, 5).map(t => ({
        id: t.TemplateId,
        name: t.TemplateName,
        status: t.ApprovalStatusDescription
      })) : []
    };
  } catch (err) {
    result.whatsapp = { working: false, error: err.message };
  }

  return result;
}

module.exports = {
  // SMS
  sendSms, fillTemplate, 
  // WhatsApp
  sendWhatsApp, sendWhatsAppChat,
  getWhatsAppTemplates, getWhatsAppTemplate,
  pullIncomingWhatsApp, pullWhatsAppDLR,
  // Dual
  sendDualChannel,
  // Bulk
  bulkSend,
  // Utils
  normalizePhone, normalizePhoneLocal,
  getStats, checkAccountStatus,
  // Constants
  SMS_TEMPLATES, WA_TEMPLATES, QUANTUM_WA_MAPPINGS
};