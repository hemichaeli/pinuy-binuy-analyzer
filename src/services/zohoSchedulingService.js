/**
 * QUANTUM Zoho Scheduling Service
 * Writes bot conversation results back to Zoho CRM in real-time:
 *  - Creates incoming message records (הודעות נכנסות) in the campaign
 *  - Updates contact status in campaign (confirmed / declined / pending / no_answer)
 *  - Updates custom fields on the Contact record
 */

const axios = require('axios');
const { logger } = require('./logger');

const ZOHO_BASE = 'https://www.zohoapis.com/crm/v3';
const ZOHO_ACCOUNTS = 'https://accounts.zoho.com/oauth/v2/token';

// Token cache
let _token = null;
let _tokenExpiry = 0;

// ── OAUTH ─────────────────────────────────────────────────────
async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN');
  }

  const res = await axios.post(ZOHO_ACCOUNTS, null, {
    params: {
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    }
  });

  _token = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

async function zohoRequest(method, path, data = null) {
  const token = await getAccessToken();
  const config = {
    method,
    url: `${ZOHO_BASE}${path}`,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (data) config.data = data;

  const res = await axios(config);
  return res.data;
}

// ── CONTACT LOOKUP ────────────────────────────────────────────
/**
 * Find a Zoho Contact by phone number
 * Returns { id, name, email } or null
 */
async function findContactByPhone(phone) {
  try {
    // Normalize phone - strip leading 0, add country code
    const normalized = normalizePhone(phone);
    const variants = [phone, normalized, phone.replace(/\D/g, '')];

    for (const variant of variants) {
      const res = await zohoRequest('GET',
        `/Contacts/search?phone=${encodeURIComponent(variant)}&fields=id,Full_Name,Email,Phone,Mobile`
      );
      if (res.data && res.data.length > 0) {
        return res.data[0];
      }
    }
    return null;
  } catch (err) {
    logger.warn(`[ZohoScheduling] Contact lookup failed for ${phone}:`, err.message);
    return null;
  }
}

// ── CAMPAIGN CONTACT STATUS ───────────────────────────────────
/**
 * STATUS VALUES (maps to Zoho campaign member status):
 *  - 'pending'          → ממתין
 *  - 'bot_sent'         → WA נשלח
 *  - 'answered'         → ענה
 *  - 'confirmed'        → אישר פגישה
 *  - 'declined'         → סירב
 *  - 'maybe'            → אולי
 *  - 'no_answer_24h'    → לא ענה 24ש
 *  - 'no_answer_48h'    → לא ענה 48ש
 */
async function updateCampaignContactStatus(campaignId, contactId, status, notes = '') {
  if (!campaignId || !contactId) return;

  const STATUS_LABELS = {
    pending: 'ממתין',
    bot_sent: 'WA נשלח',
    answered: 'ענה',
    confirmed: 'אישר פגישה ✅',
    declined: 'סירב ❌',
    maybe: 'אולי 🤷',
    no_answer_24h: 'לא ענה 24ש',
    no_answer_48h: 'לא ענה 48ש'
  };

  try {
    // Update campaign member status via Campaigns API
    await zohoRequest('PUT', `/Campaigns/${campaignId}/Contacts/${contactId}`, {
      data: [{
        Status: STATUS_LABELS[status] || status,
        ...(notes ? { Description: notes } : {})
      }]
    });

    // Also update a custom field on the Contact record itself
    await zohoRequest('PUT', `/Contacts/${contactId}`, {
      data: [{
        Scheduling_Status: STATUS_LABELS[status] || status,
        Scheduling_Last_Update: new Date().toISOString()
      }]
    });

    logger.info(`[ZohoScheduling] Updated contact ${contactId} in campaign ${campaignId}: ${status}`);
  } catch (err) {
    logger.warn(`[ZohoScheduling] Status update failed:`, err.message);
  }
}

// ── INCOMING MESSAGE LOG ──────────────────────────────────────
/**
 * Creates a record in the campaign's incoming messages
 * (הודעות נכנסות - the SMS-XXXXXXX entries visible in the campaign view)
 */
async function logIncomingMessage({ campaignId, contactId, contactName, phone, messageContent, direction = 'נכנסת', subject = '' }) {
  if (!campaignId) return null;

  try {
    // Log as a Campaign Message record
    const res = await zohoRequest('POST', `/Campaigns/${campaignId}/Campaign_Messages`, {
      data: [{
        Direction: direction,
        Message_Content: messageContent,
        Contact: contactId ? { id: contactId } : null,
        Phone: phone,
        Subject: subject || 'BOT תשובה',
        Channel: 'WhatsApp',
        Status: 'Delivered',
        Sent_Time: new Date().toISOString()
      }]
    });

    logger.info(`[ZohoScheduling] Logged incoming message for campaign ${campaignId}`);
    return res?.data?.[0]?.details?.id || null;
  } catch (err) {
    // Fallback: log as a note on the contact
    if (contactId) {
      await logAsContactNote(contactId, campaignId, messageContent);
    }
    logger.warn(`[ZohoScheduling] Message log failed, used note fallback:`, err.message);
    return null;
  }
}

/**
 * Fallback: log bot interaction as a Note on the Contact
 */
async function logAsContactNote(contactId, campaignId, content) {
  try {
    await zohoRequest('POST', `/Notes`, {
      data: [{
        Note_Title: `QUANTUM BOT - קמפיין ${campaignId}`,
        Note_Content: content,
        Parent_Id: { id: contactId },
        se_module: 'Contacts'
      }]
    });
  } catch (err) {
    logger.warn(`[ZohoScheduling] Note fallback also failed:`, err.message);
  }
}

// ── BOOKING CONFIRMATION ──────────────────────────────────────
/**
 * Creates a Zoho CRM Activity (Event) for the confirmed meeting
 */
async function createMeetingActivity({ contactId, campaignId, meetingType, meetingDatetime, representativeName, location }) {
  if (!contactId) return null;

  const TYPE_LABELS = {
    consultation: 'פגישת ייעוץ - QUANTUM',
    physical: 'פגישה פיזית - QUANTUM',
    appraiser: 'ביקור שמאי - QUANTUM',
    surveyor: 'ביקור מודד - QUANTUM',
    signing_ceremony: 'כנס חתימות - QUANTUM'
  };

  try {
    const startDt = new Date(meetingDatetime);
    const endDt = new Date(startDt.getTime() + 45 * 60000);

    const res = await zohoRequest('POST', `/Events`, {
      data: [{
        Event_Title: TYPE_LABELS[meetingType] || meetingType,
        Start_DateTime: startDt.toISOString(),
        End_DateTime: endDt.toISOString(),
        Who_Id: { id: contactId },
        Description: `קמפיין: ${campaignId}\nנציג: ${representativeName || ''}\nמיקום: ${location || ''}`,
        Location: location || '',
        $se_module: 'Events'
      }]
    });

    const eventId = res?.data?.[0]?.details?.id;
    logger.info(`[ZohoScheduling] Created event ${eventId} for contact ${contactId}`);
    return eventId;
  } catch (err) {
    logger.warn(`[ZohoScheduling] Event creation failed:`, err.message);
    return null;
  }
}

// ── BULK STATUS UPDATE ────────────────────────────────────────
/**
 * Called by reminder job when no answer after 24h / 48h
 */
async function markNoAnswer(campaignId, contactId, hours) {
  const status = hours >= 48 ? 'no_answer_48h' : 'no_answer_24h';
  await updateCampaignContactStatus(campaignId, contactId, status,
    `לא ענה לאחר ${hours} שעות`);
}

// ── HELPERS ───────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return '+' + digits;
  if (digits.startsWith('0')) return '+972' + digits.slice(1);
  return '+972' + digits;
}

module.exports = {
  findContactByPhone,
  updateCampaignContactStatus,
  logIncomingMessage,
  createMeetingActivity,
  markNoAnswer
};
