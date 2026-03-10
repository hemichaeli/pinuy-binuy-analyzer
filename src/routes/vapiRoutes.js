/**
 * QUANTUM Voice AI - Vapi Integration Routes
 * v1.7.0 - Pre-fetched calendar slots, fixed INFORU token, native endCall
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');
const { JWT } = require('google-auth-library');

const VAPI_API_KEY = process.env.VAPI_API_KEY || '';

let _optService = null;
function getOptService() {
  if (!_optService) {
    try { _optService = require('../services/optimizationService'); } catch (e) {
      logger.warn('[VAPI] optimizationService not available:', e.message);
    }
  }
  return _optService;
}

// ─── Google Service Account Auth ─────────────────────────────────────────────

let _googleAuthClient = null;

function getGoogleAuthClient() {
  if (_googleAuthClient) return _googleAuthClient;
  const email = process.env.GOOGLE_SA_EMAIL;
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) { logger.warn('[VAPI] Google SA credentials not set'); return null; }
  const key = rawKey.replace(/\\n/g, '\n');
  _googleAuthClient = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  return _googleAuthClient;
}

async function getGoogleAccessToken() {
  const client = getGoogleAuthClient();
  if (!client) return null;
  try {
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
  } catch (err) {
    logger.error('[VAPI] Failed to get Google access token:', err.message);
    return null;
  }
}

const HEMI_CALENDAR_ID    = process.env.HEMI_CALENDAR_ID    || 'hemi.michaeli@gmail.com';
const QUANTUM_CALENDAR_ID = process.env.QUANTUM_CALENDAR_ID ||
  'cf4cd8ef53ef4cbdca7f172bdef3f6862509b4026a5e04b648ce09144ab5aa21@group.calendar.google.com';

// Hebrew hour labels (spoken)
const HOUR_LABELS = {
  9:  'תשע בבוקר',
  10: 'עשר בבוקר',
  11: 'אחת עשרה',
  12: 'שתיים עשרה',
  13: 'אחת אחרי הצהריים',
  14: 'שתיים אחרי הצהריים',
  15: 'שלוש אחרי הצהריים',
  16: 'ארבע אחרי הצהריים',
  17: 'חמש אחרי הצהריים',
  18: 'שש בערב',
};

// Hebrew day labels relative to today
function hebrewDayLabel(date, todayDate) {
  const d = new Date(date);
  const t = new Date(todayDate);
  d.setHours(0,0,0,0); t.setHours(0,0,0,0);
  const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return 'מחר';
  if (diff === 2) return 'מחרתיים';
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  return 'ב' + days[d.getDay()];
}

// ─── Fetch pre-call available slots ──────────────────────────────────────────
// Returns up to 4 free 1-hour slots in the next 3 business days, 09:00-18:00 Israel time
// as { slots: [{ iso, label, date, time }] }

async function fetchFreeSlots() {
  const TZ = 'Asia/Jerusalem';
  const now = new Date();
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

  // Build candidate slots: next 3 weekdays × hours 9-17
  const candidates = [];
  let d = new Date(now);
  d.setHours(d.getHours() + 2); // at least 2h from now
  let daysAdded = 0;

  while (daysAdded < 3) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
    if (dow === 'Sat' || dow === 'Sun') continue; // skip weekend (Israel: Fri/Sat)
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: TZ });
    for (const h of [9, 10, 11, 13, 14, 15, 16]) {
      candidates.push({ dateStr, hour: h });
    }
    daysAdded++;
  }

  if (!candidates.length) {
    return { slots: getFallbackSlots(todayStr) };
  }

  // Check freeBusy
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) {
    return { slots: getFallbackSlots(todayStr) };
  }

  const timeMin = new Date(`${candidates[0].dateStr}T09:00:00+03:00`).toISOString();
  const timeMax = new Date(`${candidates[candidates.length-1].dateStr}T19:00:00+03:00`).toISOString();

  let busyIntervals = [];
  try {
    const fbRes = await axios.post(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      { timeMin, timeMax, timeZone: TZ, items: [{ id: HEMI_CALENDAR_ID }, { id: QUANTUM_CALENDAR_ID }] },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    const cals = fbRes.data.calendars || {};
    for (const calId of Object.keys(cals)) {
      busyIntervals = busyIntervals.concat(cals[calId]?.busy || []);
    }
  } catch (err) {
    logger.warn('[VAPI] freeBusy pre-fetch error:', err.response?.data?.error?.message || err.message);
    return { slots: getFallbackSlots(todayStr) };
  }

  const free = [];
  for (const { dateStr, hour } of candidates) {
    if (free.length >= 4) break;
    const slotStart = new Date(`${dateStr}T${String(hour).padStart(2,'0')}:00:00+03:00`);
    const slotEnd   = new Date(slotStart.getTime() + 3600000);
    const isBusy = busyIntervals.some(b => {
      const bs = new Date(b.start), be = new Date(b.end);
      return slotStart < be && slotEnd > bs;
    });
    if (!isBusy) {
      const label = `${hebrewDayLabel(dateStr, todayStr)} ב${HOUR_LABELS[hour] || `${hour}:00`}`;
      free.push({ iso: slotStart.toISOString(), label, date: dateStr, time: `${String(hour).padStart(2,'0')}:00` });
    }
  }

  return { slots: free.length >= 2 ? free : getFallbackSlots(todayStr) };
}

function getFallbackSlots(todayStr) {
  // Deterministic fallback - next 2 weekdays at 10:00 and 14:00
  const slots = [];
  let d = new Date(todayStr + 'T12:00:00+03:00');
  let added = 0;
  while (added < 2) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' });
    if (dow === 'Sat' || dow === 'Sun') continue;
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
    const dayLabel = hebrewDayLabel(dateStr, todayStr);
    slots.push({ iso: new Date(`${dateStr}T10:00:00+03:00`).toISOString(), label: `${dayLabel} בעשר בבוקר`, date: dateStr, time: '10:00' });
    slots.push({ iso: new Date(`${dateStr}T14:00:00+03:00`).toISOString(), label: `${dayLabel} בשתיים אחרי הצהריים`, date: dateStr, time: '14:00' });
    added++;
  }
  return slots.slice(0, 4);
}

// ─── Vapi tool call parser ────────────────────────────────────────────────────

function parseVapiToolCall(body, toolName) {
  const list = body?.message?.toolCallList || body?.message?.toolCalls || [];
  const tc = list.find(t => t.function?.name === toolName);
  if (!tc) return { toolCallId: null, args: null };
  const args = typeof tc.function.arguments === 'string'
    ? JSON.parse(tc.function.arguments)
    : (tc.function.arguments || {});
  return { toolCallId: tc.id || tc.toolCallId || null, args };
}

function vapiToolResponse(res, toolCallId, resultText) {
  return res.json({ results: [{ toolCallId: toolCallId || 'unknown', result: resultText }] });
}

// ─── Helper: build caller context ────────────────────────────────────────────

async function buildCallerContext(phone) {
  const normalized = phone.replace(/\D/g, '').replace(/^972/, '0').replace(/^00972/, '0');
  const variants = [normalized, `972${normalized.slice(1)}`, `+972${normalized.slice(1)}`, phone];
  let lead = null;
  try {
    const placeholders = variants.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(`SELECT * FROM leads WHERE phone IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`, variants);
    if (result.rows.length > 0) lead = result.rows[0];
  } catch (err) { logger.warn('[VAPI] Lead lookup error:', err.message); }

  let complexInfo = null;
  if (lead?.form_data?.addresses?.length > 0) {
    const addr = lead.form_data.addresses[0];
    try {
      const res = await pool.query(
        `SELECT id, name, city, status, developer, iai_score, theoretical_premium_min, theoretical_premium_max, actual_premium, news_summary, signature_percent FROM complexes WHERE city ILIKE $1 ORDER BY iai_score DESC NULLS LAST LIMIT 3`,
        [`%${addr.city || ''}%`]
      );
      if (res.rows.length > 0) complexInfo = res.rows;
    } catch (err) { logger.warn('[VAPI] Complex lookup error:', err.message); }
  }

  return {
    known: !!lead,
    lead_name: lead?.name || 'אורח',
    lead_type: lead?.user_type || 'unknown',
    lead_phone: normalized,
    lead_topic: extractTopic(lead),
    lead_urgency: lead?.is_urgent || false,
    lead_status: lead?.status || 'new',
    lead_id: lead?.id || null,
    last_contact: lead?.updated_at || null,
    complex_context: complexInfo
      ? complexInfo.map(c => `${c.name} ב-${c.city}: ציון IAI ${c.iai_score || 'N/A'}, פרמיה ${c.theoretical_premium_min}-${c.theoretical_premium_max}%`).join(' | ')
      : null,
    lead_context: lead ? `שם: ${lead.name}, סוג: ${lead.user_type}, סטטוס: ${lead.status}` : null,
  };
}

function extractTopic(lead) {
  if (!lead) return 'פינוי-בינוי';
  if (lead.form_data?.addresses?.length > 0) { const a = lead.form_data.addresses[0]; return `המתחם ב${a.city || ''} ${a.street || ''}`; }
  if (lead.form_data?.subject) return lead.form_data.subject;
  return 'פינוי-בינוי';
}

// ─── Calendar Links ───────────────────────────────────────────────────────────

function generateCalendarLinks({ title, description, location, startISO, durationMinutes = 30 }) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const enc = encodeURIComponent;
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${fmt(start)}/${fmt(end)}&details=${enc(description)}&location=${enc(location || '')}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?subject=${enc(title)}&startdt=${start.toISOString()}&enddt=${end.toISOString()}&body=${enc(description)}&location=${enc(location || '')}&path=%2Fcalendar%2Faction%2Fcompose&rru=addevent`;
  return { google, outlook };
}

// ─── Send Meeting SMS via INFORU ──────────────────────────────────────────────

async function sendMeetingSMS({ phone, leadName, meetingDatetime, address }) {
  const username = process.env.INFORU_USERNAME || 'hemichaeli';
  // Try all possible env var names
  const token = process.env.INFORU_API_TOKEN || process.env.INFORU_PASSWORD ||
                process.env.INFORU_TOKEN || process.env.QUANTUM_TOKEN;

  if (!token) {
    logger.warn('[VAPI] No INFORU token found (tried INFORU_API_TOKEN, INFORU_PASSWORD, INFORU_TOKEN)');
    return { success: false, error: 'no token' };
  }

  const start = new Date(meetingDatetime);
  const dateStr = start.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = start.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

  const links = generateCalendarLinks({
    title: 'פגישה עם קוונטום נדלן',
    description: `פגישת ייעוץ נדלן${address ? ' - ' + address : ''}`,
    location: address || '',
    startISO: meetingDatetime,
  });

  const msg = [
    `שלום${leadName ? ' ' + leadName : ''}!`,
    `פגישתך עם קוונטום נדלן אושרה:`,
    `${dateStr} בשעה ${timeStr}`,
    address ? `כתובת: ${address}` : null,
    ``,
    `הוסף ליומן:`,
    `Google: ${links.google}`,
    `Outlook: ${links.outlook}`,
    ``,
    `קוונטום נדלן | 03-757-2229`,
  ].filter(l => l !== null).join('\n');

  // Normalize to 972XXXXXXXXX
  const normPhone = phone.replace(/\D/g, '').replace(/^0/, '972').replace(/^972972/, '972');

  try {
    const resp = await axios.post(
      'https://capi.inforu.co.il/api/v2/SMS/SendSms',
      { Data: { Message: msg, SMSMaxParts: 4 }, Recipients: { PhoneNumber: normPhone }, Settings: { SenderName: 'QUANTUM' } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Buffer.from(`${username}:${token}`).toString('base64')}` } }
    );
    logger.info(`[VAPI] SMS sent to ${normPhone}: ${resp.data?.Status || JSON.stringify(resp.data)}`);
    return { success: true };
  } catch (err) {
    logger.error('[VAPI] SMS error:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// ─── INFORU WhatsApp helper (also used for SMS fallback) ─────────────────────

async function sendMeetingWhatsApp({ phone, leadName, meetingDatetime, address }) {
  const token = process.env.INFORU_API_TOKEN || process.env.INFORU_PASSWORD || process.env.INFORU_TOKEN;
  if (!token) return { success: false };

  const start = new Date(meetingDatetime);
  const dateStr = start.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = start.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const normPhone = phone.replace(/\D/g, '').replace(/^0/, '972').replace(/^972972/, '972');
  const links = generateCalendarLinks({ title: 'פגישה עם קוונטום נדלן', description: `פגישת ייעוץ${address ? ' - ' + address : ''}`, location: address || '', startISO: meetingDatetime });
  const msg = `שלום${leadName ? ' ' + leadName : ''}!\nפגישתך אושרה: ${dateStr} בשעה ${timeStr}${address ? '\nכתובת: ' + address : ''}\n\nGoogle: ${links.google}\nOutlook: ${links.outlook}\n\nקוונטום נדלן | 03-757-2229`;

  try {
    await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat',
      { Data: { Message: msg }, Recipients: { PhoneNumber: normPhone } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Buffer.from(`hemichaeli:${token}`).toString('base64')}` } }
    );
    return { success: true };
  } catch (e) {
    logger.warn('[VAPI] WhatsApp fallback error:', e.message);
    return { success: false };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/caller-context/:phone', async (req, res) => {
  try {
    const context = await buildCallerContext(req.params.phone);
    res.json({ success: true, context });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/agents', (req, res) => {
  const safe = Object.values({
    cold_prospecting: { id: 'cold_prospecting', name: 'Cold Prospecting', description: 'שיחה קרה', assistantId: process.env.VAPI_ASSISTANT_COLD }
  }).map(a => ({ id: a.id, name: a.name, description: a.description, hasAssistantId: !!a.assistantId }));
  res.json({ success: true, agents: safe });
});

// ─── Calendar check (for user-proposed times during call) ────────────────────

function formatDateHebrew(date) {
  return date.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
}

router.post('/calendar-check', async (req, res) => {
  try {
    const body = req.body;
    logger.info('[VAPI] calendar-check:', JSON.stringify(body).substring(0, 400));

    const { toolCallId, args } = parseVapiToolCall(body, 'checkCalendarAvailability');
    const date = args?.date || body.date;
    const time = args?.time || body.time;

    if (!date || !time) {
      return vapiToolResponse(res, toolCallId, 'לא צוין תאריך או שעה.');
    }

    const cleaned = time.toString().replace(/[^\d:]/g, '');
    const parts = cleaned.split(':');
    const hh = (parts[0] || '0').padStart(2, '0');
    const mm = (parts[1] || '00').padStart(2, '0');
    const normalizedTime = `${hh}:${mm}`;

    const startTime = new Date(`${date}T${normalizedTime}:00+03:00`);
    if (isNaN(startTime.getTime())) {
      return vapiToolResponse(res, toolCallId, `FREE:${normalizedTime}:${date}`);
    }
    const endTime = new Date(startTime.getTime() + 3600000);

    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return vapiToolResponse(res, toolCallId, `FREE:${normalizedTime}:${date}`);
    }

    let busy = false;
    try {
      const fbRes = await axios.post(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        { timeMin: startTime.toISOString(), timeMax: endTime.toISOString(), timeZone: 'Asia/Jerusalem', items: [{ id: HEMI_CALENDAR_ID }, { id: QUANTUM_CALENDAR_ID }] },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      const cals = fbRes.data.calendars || {};
      for (const calId of Object.keys(cals)) {
        if ((cals[calId]?.busy || []).length > 0) { busy = true; break; }
      }
    } catch (fbErr) {
      logger.warn('[VAPI] freeBusy check error:', fbErr.message);
    }

    const dateHebrew = formatDateHebrew(startTime);

    if (busy) {
      const alt = new Date(startTime.getTime() + 3600000);
      const altHour = alt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      return vapiToolResponse(res, toolCallId, `BUSY:${normalizedTime}:${altHour}:${date}:${dateHebrew}`);
    }

    return vapiToolResponse(res, toolCallId, `FREE:${normalizedTime}:${date}:${dateHebrew}`);

  } catch (err) {
    logger.error('[VAPI] calendar-check error:', err.message);
    return vapiToolResponse(res, null, 'FREE:confirmed');
  }
});

// ─── Send Meeting SMS/WhatsApp ────────────────────────────────────────────────

router.post('/send-meeting-sms', async (req, res) => {
  try {
    const body = req.body;
    logger.info('[VAPI] send-meeting-sms:', JSON.stringify(body).substring(0, 400));

    const { toolCallId, args } = parseVapiToolCall(body, 'sendMeetingSMS');

    const phone = args?.phone || body?.message?.call?.customer?.number || body.phone;
    const leadName        = args?.lead_name || body.lead_name;
    const meetingDatetime = args?.meeting_datetime || body.meeting_datetime;
    const address         = args?.address || body.address;

    logger.info(`[VAPI] SMS params: phone=${phone} dt=${meetingDatetime} name=${leadName}`);

    if (!phone || !meetingDatetime) {
      return vapiToolResponse(res, toolCallId, 'CONFIRM:no_phone');
    }

    // Try SMS first, then WhatsApp fallback
    let result = await sendMeetingSMS({ phone, leadName, meetingDatetime, address });
    if (!result.success) {
      result = await sendMeetingWhatsApp({ phone, leadName, meetingDatetime, address });
    }

    logger.info(`[VAPI] Message result: ${JSON.stringify(result)}`);
    return vapiToolResponse(res, toolCallId, result.success ? 'SMS_SENT' : 'SMS_FAILED');

  } catch (err) {
    logger.error('[VAPI] send-meeting-sms error:', err.message);
    return vapiToolResponse(res, null, 'SMS_FAILED');
  }
});

// ─── Outbound Call ────────────────────────────────────────────────────────────

const AGENTS_CONFIG = {
  seller_followup:    process.env.VAPI_ASSISTANT_SELLER   || null,
  buyer_qualification:process.env.VAPI_ASSISTANT_BUYER    || null,
  meeting_reminder:   process.env.VAPI_ASSISTANT_REMINDER || null,
  cold_prospecting:   process.env.VAPI_ASSISTANT_COLD     || null,
  inbound_handler:    process.env.VAPI_ASSISTANT_INBOUND  || null,
};

router.post('/outbound', async (req, res) => {
  try {
    const { phone, agent_type = 'cold_prospecting', lead_id, complex_id, metadata = {} } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const assistantId = AGENTS_CONFIG[agent_type];
    if (!assistantId) return res.status(503).json({ success: false, error: `No assistantId for ${agent_type}` });
    if (!VAPI_API_KEY) return res.status(503).json({ success: false, error: 'VAPI_API_KEY not configured' });

    const [context, { slots }] = await Promise.all([
      buildCallerContext(phone),
      fetchFreeSlots(),
    ]);

    // Format slots as Hebrew sentence for the prompt
    const slotsText = slots.length >= 2
      ? slots.slice(0, 4).map(s => s.label).join(', ')
      : 'מחר בעשר בבוקר, מחרתיים בשתיים אחרי הצהריים';

    // Also store slot ISO times for SMS use
    const slotsJson = JSON.stringify(slots.slice(0, 4).map(s => ({ label: s.label, iso: s.iso, date: s.date, time: s.time })));

    logger.info(`[VAPI] Pre-call slots for ${phone}: ${slotsText}`);

    const payload = {
      assistantId,
      customer: { number: phone, name: context.lead_name !== 'אורח' ? context.lead_name : undefined },
      assistantOverrides: {
        variableValues: {
          lead_name: context.lead_name,
          lead_context: context.lead_context || 'לקוח חדש',
          complex_context: context.complex_context || '',
          complex_city: metadata.city || '',
          available_slots: slotsText,
          slots_json: slotsJson,
        },
        metadata: { agent_type, lead_id: lead_id || context.lead_id, complex_id, quantum_source: 'outbound', ...metadata },
      },
    };
    if (process.env.VAPI_PHONE_NUMBER_ID) payload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

    const vapiRes = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const vapiData = await vapiRes.json();
    if (!vapiRes.ok) return res.status(vapiRes.status).json({ success: false, error: vapiData.message || 'Vapi error' });

    try {
      await pool.query(
        `INSERT INTO vapi_calls (call_id, phone, agent_type, lead_id, complex_id, status, metadata, created_at) VALUES ($1,$2,$3,$4,$5,'initiated',$6,NOW()) ON CONFLICT (call_id) DO NOTHING`,
        [vapiData.id, phone, agent_type, lead_id || context.lead_id, complex_id, JSON.stringify({ ...metadata, available_slots: slotsText })]
      );
    } catch (dbErr) { logger.warn('[VAPI] DB log error:', dbErr.message); }

    logger.info(`[VAPI] Outbound call: ${vapiData.id} to ${phone}`);
    res.json({ success: true, call_id: vapiData.id, phone, agent_type, available_slots: slotsText });
  } catch (err) {
    logger.error('[VAPI] outbound error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/outbound/batch', async (req, res) => {
  try {
    const { calls = [] } = req.body;
    if (!Array.isArray(calls) || calls.length === 0) return res.status(400).json({ success: false, error: 'calls array required' });
    if (calls.length > 50) return res.status(400).json({ success: false, error: 'Max 50 calls per batch' });
    const results = [];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const { slots } = await fetchFreeSlots();
    const slotsText = slots.length >= 2 ? slots.slice(0, 4).map(s => s.label).join(', ') : 'מחר בעשר בבוקר, מחרתיים בשתיים אחרי הצהריים';
    for (const call of calls) {
      try {
        const { phone, agent_type = 'cold_prospecting', lead_id, complex_id, metadata = {} } = call;
        const assistantId = AGENTS_CONFIG[agent_type];
        if (!phone || !assistantId || !VAPI_API_KEY) { results.push({ phone, success: false, error: 'missing config' }); continue; }
        const context = await buildCallerContext(phone);
        const payload = { assistantId, customer: { number: phone, name: context.lead_name !== 'אורח' ? context.lead_name : undefined }, assistantOverrides: { variableValues: { lead_name: context.lead_name, lead_context: context.lead_context || 'לקוח חדש', complex_context: context.complex_context || '', complex_city: metadata.city || '', available_slots: slotsText }, metadata: { agent_type, lead_id: lead_id || context.lead_id, complex_id } } };
        if (process.env.VAPI_PHONE_NUMBER_ID) payload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
        const vapiRes = await fetch('https://api.vapi.ai/call/phone', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` }, body: JSON.stringify(payload) });
        const vapiData = await vapiRes.json();
        if (vapiRes.ok) {
          try { await pool.query(`INSERT INTO vapi_calls (call_id, phone, agent_type, lead_id, complex_id, status, metadata, created_at) VALUES ($1,$2,$3,$4,$5,'initiated',$6,NOW()) ON CONFLICT (call_id) DO NOTHING`, [vapiData.id, phone, agent_type, lead_id || context.lead_id, complex_id, JSON.stringify(metadata)]); } catch (_) {}
          results.push({ phone, success: true, call_id: vapiData.id });
        } else { results.push({ phone, success: false, error: vapiData.message }); }
        await delay(500);
      } catch (err) { results.push({ phone: call.phone, success: false, error: err.message }); }
    }
    const succeeded = results.filter(r => r.success).length;
    res.json({ success: true, total: calls.length, succeeded, failed: calls.length - succeeded, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  const { type, call } = req.body;
  try {
    if (type === 'call-started') {
      await pool.query(`INSERT INTO vapi_calls (call_id, phone, agent_type, status, created_at) VALUES ($1,$2,$3,'active',NOW()) ON CONFLICT (call_id) DO UPDATE SET status='active', updated_at=NOW()`,
        [call.id, call.customer?.number || 'unknown', call.metadata?.agent_type || 'inbound']).catch(() => {});
    }
    if (type === 'call-ended') {
      const duration = call.endedAt && call.startedAt ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null;
      const intent = extractCallIntent(call);
      await pool.query(
        `INSERT INTO vapi_calls (call_id, phone, agent_type, status, duration_seconds, summary, intent, transcript, metadata, created_at, updated_at) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (call_id) DO UPDATE SET status='completed',duration_seconds=$4,summary=$5,intent=$6,transcript=$7,metadata=COALESCE(vapi_calls.metadata,'{}')||$8::jsonb,updated_at=NOW()`,
        [call.id, call.customer?.number || 'unknown', call.metadata?.agent_type || 'unknown', duration, call.summary || '', intent, JSON.stringify(call.transcript || []), JSON.stringify({ endedReason: call.endedReason, lead_id: call.metadata?.lead_id })]
      ).catch(() => {});
      logger.info(`[VAPI] Call ended: ${call.id} | ${duration}s | ${call.endedReason} | intent: ${intent}`);
    }
  } catch (err) { logger.error('[VAPI] Webhook error:', err.message); }
});

function extractCallIntent(call) {
  const text = [call.summary || '', ...(call.transcript || []).map(t => t.text || '')].join(' ').toLowerCase();
  if (text.includes('פגישה') && (text.includes('נקבע') || text.includes('מסכים') || text.includes('SMS_SENT'))) return 'meeting_set';
  if (text.includes('מעוניין') || text.includes('רוצה')) return 'interested';
  if (text.includes('לא מעוניין') || text.includes('לא רוצה')) return 'not_interested';
  return 'unknown';
}

router.get('/calls', async (req, res) => {
  try {
    const { agent_type, status, limit = 50, offset = 0, lead_id } = req.query;
    let where = [], params = [], p = 1;
    if (agent_type) { where.push(`agent_type = $${p++}`); params.push(agent_type); }
    if (status) { where.push(`status = $${p++}`); params.push(status); }
    if (lead_id) { where.push(`lead_id = $${p++}`); params.push(lead_id); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM vapi_calls ${whereClause} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`, [...params, parseInt(limit), parseInt(offset)]);
    const countResult = await pool.query(`SELECT COUNT(*) FROM vapi_calls ${whereClause}`, params);
    res.json({ success: true, total: parseInt(countResult.rows[0].count), calls: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/calls/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vapi_calls WHERE call_id = $1 OR id::text = $1 LIMIT 1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, call: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`SELECT agent_type, COUNT(*) as total, COUNT(*) FILTER (WHERE status='completed') as completed, COUNT(*) FILTER (WHERE intent='meeting_set') as meetings_set, COUNT(*) FILTER (WHERE intent='interested') as interested, ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)) as avg_duration_seconds FROM vapi_calls WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY agent_type ORDER BY total DESC`);
    res.json({ success: true, stats: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/google-auth-status', async (req, res) => {
  try {
    const email = process.env.GOOGLE_SA_EMAIL;
    if (!email || !process.env.GOOGLE_SA_PRIVATE_KEY) return res.json({ success: false, configured: false });
    const token = await getGoogleAccessToken();
    res.json({ success: !!token, configured: true, serviceAccountEmail: email, tokenObtained: !!token });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Debug: test SMS ──────────────────────────────────────────────────────────
router.post('/test-sms', async (req, res) => {
  try {
    const { phone = req.body.phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const result = await sendMeetingSMS({ phone, leadName: 'בדיקה', meetingDatetime: new Date(Date.now() + 86400000).toISOString(), address: 'רחוב הבדיקה 1' });
    res.json({ result, token_used: !!(process.env.INFORU_API_TOKEN || process.env.INFORU_PASSWORD) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
