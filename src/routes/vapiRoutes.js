/**
 * QUANTUM Voice AI - Vapi Integration Routes
 * v1.5.0 - SMS meeting confirmation with calendar links
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');
const { JWT } = require('google-auth-library');

const VAPI_API_KEY = process.env.VAPI_API_KEY || '';
const VAPI_BASE_URL = 'https://api.vapi.ai';

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

const NOVA3_TRANSCRIBER = {
  provider: 'deepgram', model: 'nova-3', language: 'he',
  keywords: ['פינוי-בינוי','ועדה מקומית','כינוס נכסים','פרמיה','יזם','דיירים','חתימות','הסכם פינוי','תמא 38','טאבו','קוונטום','נדלן','משכנתא','רוכש','מוכר','מתחם','קבלן'],
};

const AGENTS = {
  seller_followup:   { id: 'seller_followup',   name: 'מוכרים - Follow-up',          description: 'שיחת המשך עם מוכר פוטנציאלי', assistantId: process.env.VAPI_ASSISTANT_SELLER   || null },
  buyer_qualification:{ id: 'buyer_qualification', name: 'קונים - Lead Qualification', description: 'כישור ליד קונה/משקיע',         assistantId: process.env.VAPI_ASSISTANT_BUYER    || null },
  meeting_reminder:  { id: 'meeting_reminder',   name: 'תזכורת פגישה',                description: 'אישור ותזכורת לפגישה',         assistantId: process.env.VAPI_ASSISTANT_REMINDER || null },
  cold_prospecting:  { id: 'cold_prospecting',   name: 'Cold Prospecting',             description: 'שיחה קרה לדיירים',             assistantId: process.env.VAPI_ASSISTANT_COLD     || null },
  inbound_handler:   { id: 'inbound_handler',    name: 'מענה נכנס',                   description: 'מענה לשיחות נכנסות',           assistantId: process.env.VAPI_ASSISTANT_INBOUND  || null },
};

const ASSISTANT_IDS = [
  { id: process.env.VAPI_ASSISTANT_SELLER,   name: 'seller_followup' },
  { id: process.env.VAPI_ASSISTANT_BUYER,    name: 'buyer_qualification' },
  { id: process.env.VAPI_ASSISTANT_REMINDER, name: 'meeting_reminder' },
  { id: process.env.VAPI_ASSISTANT_COLD,     name: 'cold_prospecting' },
  { id: process.env.VAPI_ASSISTANT_INBOUND,  name: 'inbound_handler' },
];

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
      ? complexInfo.map(c => `${c.name} ב-${c.city}: ציון IAI ${c.iai_score || 'N/A'}, פרמיה תיאורטית ${c.theoretical_premium_min}-${c.theoretical_premium_max}%, ${c.news_summary || ''}`).join(' | ')
      : null,
    lead_context: lead ? `שם: ${lead.name}, סוג: ${lead.user_type}, סטטוס: ${lead.status}, ${JSON.stringify(lead.form_data || {})}` : null,
  };
}

function extractTopic(lead) {
  if (!lead) return 'פינוי-בינוי';
  if (lead.form_data?.addresses?.length > 0) { const a = lead.form_data.addresses[0]; return `המתחם ב${a.city || ''} ${a.street || ''}`; }
  if (lead.form_data?.subject) return lead.form_data.subject;
  if (lead.user_type === 'investor') return 'השקעה בפינוי-בינוי';
  return 'פינוי-בינוי';
}

// ─── Calendar Links Generator ─────────────────────────────────────────────────

function generateCalendarLinks({ title, description, location, startISO, durationMinutes = 30 }) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  // Format for Google: YYYYMMDDTHHMMSSZ
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const startFmt = fmt(start);
  const endFmt = fmt(end);

  const encTitle = encodeURIComponent(title);
  const encDesc = encodeURIComponent(description);
  const encLoc = encodeURIComponent(location || '');

  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encTitle}&dates=${startFmt}/${endFmt}&details=${encDesc}&location=${encLoc}`;

  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?subject=${encTitle}&startdt=${start.toISOString()}&enddt=${end.toISOString()}&body=${encDesc}&location=${encLoc}&path=%2Fcalendar%2Faction%2Fcompose&rru=addevent`;

  // ICS for Apple Calendar
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
    `DTSTART:${startFmt}`, `DTEND:${endFmt}`,
    `SUMMARY:${title}`, `DESCRIPTION:${description}`, `LOCATION:${location || ''}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\n');
  const apple = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;

  return { google, outlook, apple };
}

// ─── Send Meeting SMS via INFORU ──────────────────────────────────────────────

async function sendMeetingSMS({ phone, leadName, meetingDatetime, address, agentName = 'קוונטום נדלן' }) {
  const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
  const INFORU_TOKEN = process.env.INFORU_TOKEN || process.env.QUANTUM_TOKEN;

  if (!INFORU_TOKEN) { logger.warn('[VAPI] INFORU_TOKEN not set - skipping SMS'); return null; }

  const start = new Date(meetingDatetime);
  const dateStr = start.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = start.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

  const title = `פגישה עם ${agentName}`;
  const description = `פגישת ייעוץ נדלן - ${address}`;

  const links = generateCalendarLinks({
    title, description, location: address, startISO: meetingDatetime, durationMinutes: 30,
  });

  const smsText = [
    `שלום ${leadName || ''}!`,
    `פגישתך עם ${agentName} אושרה:`,
    `${dateStr} בשעה ${timeStr}`,
    address ? `כתובת: ${address}` : '',
    '',
    'הוסף ליומן:',
    `Google: ${links.google}`,
    `Outlook: ${links.outlook}`,
    '',
    'קוונטום נדלן | 03-757-2229',
  ].filter(l => l !== undefined).join('\n');

  // Normalize phone for INFORU (972XXXXXXXXX format)
  const normalizedPhone = phone.replace(/\D/g, '').replace(/^0/, '972').replace(/^972972/, '972');

  try {
    const payload = {
      Data: {
        Message: smsText,
        SMSMaxParts: 4,
      },
      Recipients: {
        PhoneNumber: normalizedPhone,
      },
      Settings: {
        SenderName: 'QUANTUM',
      },
    };

    const resp = await axios.post(
      'https://capi.inforu.co.il/api/v2/SMS/SendSms',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Buffer.from(`${INFORU_USERNAME}:${INFORU_TOKEN}`).toString('base64')}`,
        },
      }
    );
    logger.info(`[VAPI] Meeting SMS sent to ${phone}: ${resp.data?.Status || 'unknown'}`);
    return { success: true, links, smsText };
  } catch (err) {
    logger.error('[VAPI] SMS send error:', err.response?.data || err.message);
    return { success: false, error: err.message, links };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/caller-context/:phone', async (req, res) => {
  try {
    const context = await buildCallerContext(req.params.phone);
    res.json({ success: true, context });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/agents', (req, res) => {
  const safe = Object.values(AGENTS).map(a => ({ id: a.id, name: a.name, description: a.description, hasAssistantId: !!a.assistantId }));
  res.json({ success: true, agents: safe });
});

// ─── Calendar Availability Check ─────────────────────────────────────────────

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'hemi.michaeli@gmail.com';
const QUANTUM_CALENDAR_ID = process.env.QUANTUM_CALENDAR_ID || 'cf4cd8ef53ef4cbdca7f172bdef3f6862509b4026a5e04b648ce09144ab5aa21@group.calendar.google.com';

function formatDateHebrew(date) {
  return date.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
}

router.post('/calendar-check', async (req, res) => {
  try {
    const body = req.body;
    logger.info('[VAPI] calendar-check called:', JSON.stringify(body).substring(0, 300));

    let date, time;
    if (body.message?.toolCalls) {
      const tc = body.message.toolCalls.find(t => t.function?.name === 'checkCalendarAvailability');
      if (tc) {
        const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        date = args.date; time = args.time;
      }
    } else {
      date = body.date || body.parameters?.date;
      time = body.time || body.parameters?.time;
    }

    if (!date || !time) return res.json({ result: 'לא צוין תאריך או שעה.', available: false });

    // Normalize time to HH:MM
    const timeParts = time.toString().replace(/[^\d:]/g, '').split(':');
    const hh = (timeParts[0] || '0').padStart(2, '0');
    const mm = (timeParts[1] || '00').padStart(2, '0');
    const normalizedTime = `${hh}:${mm}`;

    const startTime = new Date(`${date}T${normalizedTime}:00+03:00`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    if (isNaN(startTime.getTime())) {
      logger.warn('[VAPI] calendar-check: invalid datetime', { date, time });
      return res.json({ result: `אני מקבל את השעה ${time}. נאשר את הפגישה.`, available: true, date, time: normalizedTime });
    }

    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return res.json({ result: `השעה ${normalizedTime} נראית פנויה. מאשר את הפגישה.`, available: true, date, time: normalizedTime });
    }

    let busy = false;
    try {
      const fbRes = await axios.post(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        {
          timeMin: startTime.toISOString(), timeMax: endTime.toISOString(),
          timeZone: 'Asia/Jerusalem',
          items: [{ id: HEMI_CALENDAR_ID }, { id: QUANTUM_CALENDAR_ID }],
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      const calendars = fbRes.data.calendars || {};
      for (const calId of Object.keys(calendars)) {
        if ((calendars[calId]?.busy || []).length > 0) { busy = true; break; }
      }
    } catch (fbErr) {
      logger.warn('[VAPI] freeBusy error:', fbErr.response?.data?.error?.message || fbErr.message);
    }

    const dateHebrew = formatDateHebrew(startTime);

    if (busy) {
      const altTime = new Date(startTime.getTime() + 60 * 60 * 1000);
      const altHour = altTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      return res.json({ result: `השעה ${normalizedTime} ב${dateHebrew} תפוסה. מה דעתך על ${altHour}?`, available: false, suggested_time: altHour, date, time: normalizedTime });
    }

    return res.json({ result: `מצוין, השעה ${normalizedTime} ב${dateHebrew} פנויה.`, available: true, date, time: normalizedTime });

  } catch (err) {
    logger.error('[VAPI] calendar-check error:', err.message);
    return res.json({ result: 'אני מקבל את הזמן. נאשר את הפגישה.', available: true });
  }
});

// ─── Send Meeting SMS ─────────────────────────────────────────────────────────

router.post('/send-meeting-sms', async (req, res) => {
  try {
    const body = req.body;
    logger.info('[VAPI] send-meeting-sms called:', JSON.stringify(body).substring(0, 300));

    let phone, leadName, meetingDatetime, address;

    if (body.message?.toolCalls) {
      const tc = body.message.toolCalls.find(t => t.function?.name === 'sendMeetingSMS');
      if (tc) {
        const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        phone = args.phone; leadName = args.lead_name; meetingDatetime = args.meeting_datetime; address = args.address;
      }
    } else {
      phone = body.phone || body.parameters?.phone;
      leadName = body.lead_name || body.parameters?.lead_name;
      meetingDatetime = body.meeting_datetime || body.parameters?.meeting_datetime;
      address = body.address || body.parameters?.address;
    }

    // Fallback: get phone from Vapi call if not in args
    phone = phone || body.message?.call?.customer?.number;

    if (!phone || !meetingDatetime) {
      return res.json({ result: 'אאשר שהפרטים נרשמו. נציג יצור קשר.', success: false });
    }

    const result = await sendMeetingSMS({ phone, leadName, meetingDatetime, address });

    if (result?.success) {
      logger.info(`[VAPI] Meeting SMS sent successfully to ${phone}`);
      return res.json({ result: 'שלחתי לך SMS עם כל הפרטים וקישורים להוספה ליומן.', success: true });
    } else {
      return res.json({ result: 'הפגישה נרשמה. תקבל אישור בקרוב.', success: false });
    }
  } catch (err) {
    logger.error('[VAPI] send-meeting-sms error:', err.message);
    return res.json({ result: 'הפגישה נרשמה בהצלחה.', success: false, error: err.message });
  }
});

// ─── Admin: Upgrade to Nova-3 ─────────────────────────────────────────────────

router.post('/admin/upgrade-nova3', async (req, res) => {
  if (!VAPI_API_KEY) return res.status(503).json({ success: false, error: 'VAPI_API_KEY not set' });
  const results = [];
  for (const a of ASSISTANT_IDS) {
    if (!a.id) { results.push({ name: a.name, success: false, error: 'no assistantId' }); continue; }
    try {
      const response = await axios.patch(`${VAPI_BASE_URL}/assistant/${a.id}`, { transcriber: NOVA3_TRANSCRIBER }, { headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' } });
      const t = response.data.transcriber;
      results.push({ name: a.name, success: true, model: t?.model, language: t?.language });
    } catch (err) {
      results.push({ name: a.name, success: false, error: err.response?.data?.message || err.message });
    }
  }
  const ok = results.filter(r => r.success).length;
  res.json({ success: ok === results.length, upgraded: ok, total: results.length, results });
});

// ─── Outbound Call ────────────────────────────────────────────────────────────

router.post('/outbound', async (req, res) => {
  try {
    const { phone, agent_type = 'seller_followup', lead_id, complex_id, metadata = {} } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    if (!AGENTS[agent_type]) return res.status(400).json({ success: false, error: `Unknown agent_type: ${agent_type}` });
    if (!VAPI_API_KEY) return res.status(503).json({ success: false, error: 'VAPI_API_KEY not configured' });

    const agent = AGENTS[agent_type];
    if (!agent.assistantId) return res.status(503).json({ success: false, error: `Assistant ID not configured for ${agent_type}` });

    const context = await buildCallerContext(phone);
    const payload = {
      assistantId: agent.assistantId,
      customer: { number: phone, name: context.lead_name !== 'אורח' ? context.lead_name : undefined },
      assistantOverrides: {
        variableValues: {
          lead_name: context.lead_name,
          lead_context: context.lead_context || 'לקוח חדש',
          complex_context: context.complex_context || 'מידע על מתחמים בסביבה זמין',
          complex_city: metadata.city || '',
          meeting_context: metadata.meeting_context || '',
          meeting_time: metadata.meeting_time || '',
        },
        metadata: { agent_type, lead_id: lead_id || context.lead_id, complex_id, quantum_source: 'outbound_trigger', ...metadata },
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
        `INSERT INTO vapi_calls (call_id, phone, agent_type, lead_id, complex_id, status, metadata, created_at) VALUES ($1, $2, $3, $4, $5, 'initiated', $6, NOW()) ON CONFLICT (call_id) DO NOTHING`,
        [vapiData.id, phone, agent_type, lead_id || context.lead_id, complex_id, JSON.stringify(metadata)]
      );
    } catch (dbErr) { logger.warn('[VAPI] Failed to log call to DB:', dbErr.message); }

    logger.info(`[VAPI] Outbound call initiated: ${vapiData.id} to ${phone} (${agent_type})`);
    res.json({ success: true, call_id: vapiData.id, phone, agent_type, status: 'initiated' });
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
    for (const call of calls) {
      try {
        const { phone, agent_type = 'seller_followup', lead_id, complex_id, metadata = {} } = call;
        const agent = AGENTS[agent_type];
        if (!phone || !agent?.assistantId || !VAPI_API_KEY) { results.push({ phone, success: false, error: 'missing config' }); continue; }
        const context = await buildCallerContext(phone);
        const payload = {
          assistantId: agent.assistantId,
          customer: { number: phone, name: context.lead_name !== 'אורח' ? context.lead_name : undefined },
          assistantOverrides: {
            variableValues: { lead_name: context.lead_name, lead_context: context.lead_context || 'לקוח חדש', complex_context: context.complex_context || '', complex_city: metadata.city || '', meeting_context: metadata.meeting_context || '', meeting_time: metadata.meeting_time || '' },
            metadata: { agent_type, lead_id: lead_id || context.lead_id, complex_id },
          },
        };
        if (process.env.VAPI_PHONE_NUMBER_ID) payload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
        const vapiRes = await fetch('https://api.vapi.ai/call/phone', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` }, body: JSON.stringify(payload) });
        const vapiData = await vapiRes.json();
        if (vapiRes.ok) {
          try { await pool.query(`INSERT INTO vapi_calls (call_id, phone, agent_type, lead_id, complex_id, status, metadata, created_at) VALUES ($1, $2, $3, $4, $5, 'initiated', $6, NOW()) ON CONFLICT (call_id) DO NOTHING`, [vapiData.id, phone, agent_type, lead_id || context.lead_id, complex_id, JSON.stringify(metadata)]); } catch (_) {}
          results.push({ phone, success: true, call_id: vapiData.id });
        } else { results.push({ phone, success: false, error: vapiData.message }); }
        await delay(500);
      } catch (err) { results.push({ phone: call.phone, success: false, error: err.message }); }
    }
    const succeeded = results.filter((r) => r.success).length;
    res.json({ success: true, total: calls.length, succeeded, failed: calls.length - succeeded, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  const { type, call } = req.body;
  try {
    logger.info(`[VAPI] Webhook: ${type} | call: ${call?.id}`);
    if (type === 'call-started') {
      await pool.query(`INSERT INTO vapi_calls (call_id, phone, agent_type, status, created_at) VALUES ($1, $2, $3, 'active', NOW()) ON CONFLICT (call_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
        [call.id, call.customer?.number || 'unknown', call.metadata?.agent_type || 'inbound']).catch(e => logger.warn('[VAPI] DB error:', e.message));
    }
    if (type === 'call-ended') {
      const duration = call.endedAt && call.startedAt ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null;
      const intent = extractCallIntent(call);
      await pool.query(
        `INSERT INTO vapi_calls (call_id, phone, agent_type, status, duration_seconds, summary, intent, transcript, metadata, created_at, updated_at) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (call_id) DO UPDATE SET status='completed',duration_seconds=$4,summary=$5,intent=$6,transcript=$7,metadata=COALESCE(vapi_calls.metadata,'{}')||$8::jsonb,updated_at=NOW()`,
        [call.id, call.customer?.number || 'unknown', call.metadata?.agent_type || 'unknown', duration, call.summary || '', intent, JSON.stringify(call.transcript || []), JSON.stringify({ cost: call.cost, endedReason: call.endedReason, lead_id: call.metadata?.lead_id, complex_id: call.metadata?.complex_id })]
      ).catch(e => logger.warn('[VAPI] DB error:', e.message));

      if (call.metadata?.reschedule_request_id) handleRescheduleCallOutcome(call).catch(e => logger.error('[VAPI] Reschedule error:', e.message));
      if (intent === 'meeting_set' && call.metadata?.lead_id) {
        await pool.query(`UPDATE leads SET status='meeting_scheduled', notes=COALESCE(notes||' | ','')||$2, updated_at=NOW() WHERE id=$1`,
          [call.metadata.lead_id, `פגישה נקבעה בשיחת קוונטום Voice - ${new Date().toLocaleDateString('he-IL')}`]).catch(() => {});
      }
      logger.info(`[VAPI] Call ended: ${call.id} | ${duration}s | intent: ${intent}`);
    }
  } catch (err) { logger.error('[VAPI] Webhook error:', err.message); }
});

function extractCallIntent(call) {
  const text = [call.summary || '', ...(call.transcript || []).map(t => t.text || '')].join(' ').toLowerCase();
  if (text.includes('פגישה') && (text.includes('נקבע') || text.includes('מסכים'))) return 'meeting_set';
  if (text.includes('מעוניין') || text.includes('רוצה')) return 'interested';
  if (text.includes('לא מעוניין') || text.includes('לא רוצה')) return 'not_interested';
  return 'unknown';
}

function extractRescheduleOutcome(call) {
  const transcript = call.transcript || [];
  const customerTexts = transcript.filter(t => t.role === 'user' || t.role === 'customer').map(t => (t.text || t.content || '').trim().toLowerCase()).join(' ');
  const allText = `${customerTexts} ${(call.summary || '').toLowerCase()}`;
  const declined = ['לא', 'לא רוצה', 'לא מעוניין', 'לא מתאים', 'להישאר', 'לא צריך'];
  for (const p of declined) { if (allText.includes(p)) return 'declined'; }
  const accepted = ['כן', 'בסדר', 'מסכים', 'מסכימה', 'מקבל', 'אחלה', 'נהדר', 'מתאים'];
  for (const p of accepted) { if (allText.includes(p)) return 'accepted'; }
  if (['no-answer', 'voicemail', 'failed', 'busy'].includes(call.endedReason || '')) return 'no_answer';
  return 'no_answer';
}

async function handleRescheduleCallOutcome(call) {
  const rescheduleRequestId = call.metadata?.reschedule_request_id;
  if (!rescheduleRequestId) return;
  const opt = getOptService();
  if (!opt) return;
  const reqRes = await pool.query(`SELECT * FROM reschedule_requests WHERE id=$1`, [rescheduleRequestId]);
  if (!reqRes.rows.length) return;
  const req = reqRes.rows[0];
  if (req.status !== 'pending') return;
  await pool.query(`UPDATE reschedule_requests SET call_completed_at=NOW(), updated_at=NOW() WHERE id=$1`, [rescheduleRequestId]);
  const outcome = extractRescheduleOutcome(call);
  const inforuService = require('../services/inforuService');
  const lang = req.language || 'he';
  if (outcome === 'accepted') {
    const swapped = await opt.performSwap(req);
    const msg = swapped
      ? (lang === 'ru' ? `Отлично! Встреча перенесена. До встречи!` : `מעולה! הפגישה הועברה. נתראה!`)
      : (lang === 'ru' ? 'Слот недоступен. Встреча в исходное время.' : 'לצערנו השעה כבר תפוסה. הפגישה נשארת במועד המקורי.');
    await inforuService.sendWhatsAppChat(req.phone, msg).catch(() => {});
  } else if (outcome === 'declined') {
    await opt.declineRequest(req);
    const msg = lang === 'ru' ? `Хорошо! Встреча остается в исходное время. До встречи!` : `בסדר גמור! הפגישה נשארת במועד המקורי. נתראה!`;
    await inforuService.sendWhatsAppChat(req.phone, msg).catch(() => {});
  }
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
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, call: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`SELECT agent_type, COUNT(*) as total, COUNT(*) FILTER (WHERE status='completed') as completed, COUNT(*) FILTER (WHERE intent='meeting_set') as meetings_set, COUNT(*) FILTER (WHERE intent='interested') as interested, COUNT(*) FILTER (WHERE intent='not_interested') as not_interested, ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)) as avg_duration_seconds FROM vapi_calls WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY agent_type ORDER BY total DESC`);
    res.json({ success: true, stats: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Schedule Lead + Google Calendar ─────────────────────────────────────────

async function createGoogleCalendarEvent({ leadName, leadAddress, scheduledTime, phoneNumber, leadSource }) {
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) { logger.warn('[VAPI] No Google access token'); return null; }
  const startTime = new Date(scheduledTime);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
  const event = {
    summary: `\u{1F3E0} \u05e9\u05d9\u05d7\u05d4 \u05e2\u05dd ${leadName}`,
    description: [`\u05dc\u05d9\u05d3: ${leadName}`, leadSource ? `\u05de\u05e7\u05d5\u05e8: ${leadSource}` : '', `\u05db\u05ea\u05d5\u05d1\u05ea: ${leadAddress}`, phoneNumber ? `\u05d8\u05dc: ${phoneNumber}` : ''].filter(Boolean).join('\n'),
    location: leadAddress,
    start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Jerusalem' },
    end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Jerusalem' },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }] },
    colorId: '11',
  };
  try {
    const response = await axios.post(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(QUANTUM_CALENDAR_ID)}/events`, event, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
    logger.info(`[VAPI] Calendar event created: ${response.data.id} for ${leadName}`);
    return response.data;
  } catch (calErr) {
    logger.error('[VAPI] Google Calendar API error:', calErr.response?.data || calErr.message);
    return null;
  }
}

router.post('/schedule-lead', async (req, res) => {
  try {
    const body = req.body;
    let leadName, leadAddress, scheduledTime, phoneNumber, leadSource;
    if (body.message?.toolCalls) {
      const tc = body.message.toolCalls.find(t => t.function?.name === 'schedule_lead_call');
      if (tc) { const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; leadName = args.lead_name; leadAddress = args.lead_address; scheduledTime = args.scheduled_time; phoneNumber = args.phone_number || body.message?.call?.customer?.number; leadSource = args.lead_source; }
    } else if (body.lead_name || body.leadName) {
      leadName = body.lead_name || body.leadName; leadAddress = body.lead_address || body.leadAddress; scheduledTime = body.scheduled_time || body.scheduledTime; phoneNumber = body.phone_number || body.phoneNumber; leadSource = body.lead_source || body.leadSource;
    }
    if (!leadName || !leadAddress || !scheduledTime) return res.json({ result: 'השיחה נרשמה. נציג יחזור אליך בקרוב.', success: false });
    const calendarEvent = await createGoogleCalendarEvent({ leadName, leadAddress, scheduledTime, phoneNumber, leadSource });
    try { await pool.query(`INSERT INTO vapi_leads (name, address, phone, scheduled_time, lead_source, calendar_event_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`, [leadName, leadAddress, phoneNumber || null, scheduledTime, leadSource || null, calendarEvent?.id || null]); } catch (_) {}
    const successMsg = calendarEvent ? `מעולה! קבעתי שיחה עם ${leadName} ב-${new Date(scheduledTime).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} ונוצר אירוע ביומן.` : `נרשמה שיחה עם ${leadName}. נציג יצור קשר בזמן שנקבע.`;
    res.json({ result: successMsg, success: true, calendarEventId: calendarEvent?.id || null });
  } catch (err) {
    res.json({ result: 'השיחה נרשמה. נציג יחזור אליך בקרוב.', success: false, error: err.message });
  }
});

router.get('/google-auth-status', async (req, res) => {
  try {
    const email = process.env.GOOGLE_SA_EMAIL;
    const hasKey = !!process.env.GOOGLE_SA_PRIVATE_KEY;
    if (!email || !hasKey) return res.json({ success: false, configured: false });
    const token = await getGoogleAccessToken();
    res.json({ success: !!token, configured: true, serviceAccountEmail: email, tokenObtained: !!token, message: token ? 'Service Account auth working' : 'Token request failed' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
