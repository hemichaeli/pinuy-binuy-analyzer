/**
 * VAPI Call Routes v7
 *
 * Single unified tool endpoint: POST /api/vapi-call/tool
 * All 3 tools point to the same URL — routes by function name.
 * This eliminates the "No result returned" mystery for /book and /schedule-callback.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';
const TZ = 'Asia/Jerusalem';

const DAYS   = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

const HOUR_HE = {
  6:'שש',7:'שבע',8:'שמונה',9:'תשע',10:'עשר',11:'אחת עשרה',
  12:'שתים עשרה',13:'אחת',14:'שתיים',15:'שלוש',16:'ארבע',17:'חמש'
};

// ── Extract args from VAPI body (any format) ──────────────────────────────────
function extractArgs(body) {
  try {
    const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
    if (toolCalls.length > 0) {
      const raw = toolCalls[0]?.function?.arguments;
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    const raw2 = body?.function?.arguments;
    if (raw2) return typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
  } catch (e) {}
  const { message, service, ...rest } = body || {};
  return Object.keys(rest).length ? rest : {};
}

function extractFunctionName(body) {
  try {
    const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
    if (toolCalls.length > 0) return toolCalls[0]?.function?.name;
    if (body?.function?.name) return body.function.name;
  } catch (e) {}
  return null;
}

function extractCallPhone(body) {
  try {
    const num = body?.message?.call?.customer?.number || body?.call?.customer?.number;
    if (num) return num.replace(/^\+972/, '0').replace(/\D/g, '');
  } catch (e) {}
  return null;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function heTime(il) {
  const h = il.getHours(), m = il.getMinutes();
  const base   = HOUR_HE[h] || `${h}`;
  const period = h < 12 ? 'בבוקר' : h < 17 ? 'אחר הצהריים' : 'בערב';
  if (m === 0)  return `${base} ${period}`;
  if (m === 30) return `${base} וחצי ${period}`;
  return `${base} ו-${m} ${period}`;
}

function getCalendar() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SA_EMAIL,
      private_key: (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

function toIsrael(dt) {
  const d = new Date(dt);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value || '0';
  return new Date(
    parseInt(get('year')), parseInt(get('month'))-1, parseInt(get('day')),
    parseInt(get('hour')), parseInt(get('minute')), parseInt(get('second'))
  );
}

function heDate(dt) {
  const il = toIsrael(dt);
  return `יום ${DAYS[il.getDay()]}, ${il.getDate()} ב${MONTHS[il.getMonth()]}, ב${heTime(il)}`;
}

function heToday() {
  const il = toIsrael(new Date());
  return `יום ${DAYS[il.getDay()]}, ${il.getDate()} ב${MONTHS[il.getMonth()]} ${il.getFullYear()}`;
}

// ── DB busy periods ───────────────────────────────────────────────────────────
async function getQuantumBusy(from, to) {
  const busy = [];
  try {
    const { rows } = await pool.query(
      `SELECT event_date as start, event_date + INTERVAL '30 minutes' as end
       FROM quantum_events WHERE event_date >= $1 AND event_date < $2
         AND (status IS NULL OR status NOT IN ('cancelled','ביטול'))`,
      [from.toISOString(), to.toISOString()]
    );
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) {}
  try {
    const { rows } = await pool.query(
      `SELECT slot_datetime as start,
              slot_datetime + (COALESCE(duration_minutes,30) * INTERVAL '1 minute') as end
       FROM meeting_slots WHERE slot_datetime >= $1 AND slot_datetime < $2
         AND status IN ('confirmed','reserved')`,
      [from.toISOString(), to.toISOString()]
    );
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) {}
  return busy;
}

async function computeSlots() {
  const now = new Date();
  const end = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  let gcalBusy = [];
  try {
    const cal = getCalendar();
    const res = await cal.freebusy.query({
      requestBody: { timeMin: now.toISOString(), timeMax: end.toISOString(), timeZone: TZ, items: [{ id: HEMI_CALENDAR_ID }] }
    });
    gcalBusy = (res.data.calendars?.[HEMI_CALENDAR_ID]?.busy || [])
      .map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) { logger.warn('[VapiCall] GCal freebusy:', e.message); }

  const dbBusy = await getQuantumBusy(now, end);
  const allBusy = [...gcalBusy, ...dbBusy];

  const slots = [];
  const cursor = new Date(now);
  const mins = cursor.getMinutes();
  if (mins < 30) { cursor.setMinutes(30, 0, 0); }
  else { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); }

  while (slots.length < 6 && cursor < end) {
    const il = toIsrael(cursor);
    const hour = il.getHours(), day = il.getDay();
    if (day !== 5 && day !== 6 && hour >= 9 && hour < 18) {
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      if (!allBusy.some(b => cursor < b.end && slotEnd > b.start)) {
        slots.push({ label: heDate(cursor), start: cursor.toISOString(), end: slotEnd.toISOString() });
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }
  return { today: heToday(), slots };
}

async function sendWA(phone, message) {
  const normalized = String(phone || '').replace(/^\+972/, '0').replace(/\D/g, '');
  if (!normalized || normalized.length < 9) return;
  const { sendWhatsAppChat } = require('../services/inforuService');
  await sendWhatsAppChat(normalized, message, {
    customerMessageId: `vapi_${Date.now()}`,
    customerParameter: 'QUANTUM_PILOT'
  });
  logger.info(`[VapiCall] WA → ${normalized}`);
}

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function handleGetAvailableSlots(args, callPhone) {
  const { slots, today } = await computeSlots();
  const top4 = slots.slice(0, 4);
  if (top4.length === 0) {
    return { today, slots: [], message: `אין מועד פנוי בקרוב. עברי לתיאום חזרה.` };
  }
  return {
    today,
    slots: top4.map((s, i) => ({ index: i + 1, label: s.label, start: s.start, end: s.end })),
    message: `היום ${today}. מועדים פנויים:\n${top4.map((s, i) => `${i+1}. ${s.label}`).join('\n')}`
  };
}

async function handleBookSlot(args, callPhone) {
  const slot_index = parseInt(args.slot_index || args.slotIndex || 1);
  const phone      = args.phone || callPhone || '';
  const rooms      = args.rooms || '';
  const price      = args.price || '';

  const { slots } = await computeSlots();
  const slot = slots[slot_index - 1];

  if (!slot) {
    return { success: false, message: `לא מצאתי את המועד. הצגי שוב את הרשימה ובקשי בחירה.` };
  }

  const startDt = new Date(slot.start);
  const endDt   = new Date(slot.end);
  const label   = slot.label;

  // Calendar
  try {
    const cal = getCalendar();
    await cal.events.insert({
      calendarId: HEMI_CALENDAR_ID,
      requestBody: {
        summary: `שיחת מנהל — ${phone || 'לא ידוע'}`,
        description: ['מקור: VAPI הילה', rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : ''].filter(Boolean).join('\n'),
        start: { dateTime: startDt.toISOString(), timeZone: TZ },
        end:   { dateTime: endDt.toISOString(),   timeZone: TZ }
      }
    });
  } catch (e) { logger.warn('[VapiCall] GCal insert:', e.message); }

  // DB
  try {
    await pool.query(
      `INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
       VALUES ($1, 'שיחת_מנהל', $2, $3, 'confirmed', NOW())`,
      [`שיחת מנהל — ${phone}`, startDt.toISOString(),
       [rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : '', 'מקור: VAPI הילה'].filter(Boolean).join(' | ')]
    );
  } catch (e) {}

  // WA
  if (phone) {
    try {
      await sendWA(phone,
        `שלום רב,\n` +
        `בהמשך לשיחתנו קבענו שיחת מנהל ב${label}.\n\n` +
        `המשך יום נעים,\n` +
        `הילה | קוונטום נדל"ן`
      );
    } catch (e) {}
  }

  logger.info(`[VapiCall] Booked: ${label} | ${phone}`);
  return { success: true, label, message: `הפגישה נקבעה ל${label}. נשלחה הודעת אישור בוואטסאפ.` };
}

async function handleScheduleCallback(args, callPhone) {
  const phone         = args.phone || callPhone || '';
  const callback_time = args.callback_time || args.callbackTime || '';
  const callback_day  = args.callback_day  || args.callbackDay  || '';
  const timeDesc      = [callback_day, callback_time].filter(Boolean).join(' ') || 'בהקדם';

  try {
    await pool.query(
      `INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
       VALUES ($1, 'חזרה_ללקוח', NOW(), $2, 'confirmed', NOW())`,
      [`חזרה ללקוח ${phone}`, `מועד: ${timeDesc} | מקור: VAPI הילה`]
    );
  } catch (e) {}

  if (phone) {
    try {
      await sendWA(phone,
        `שלום רב,\n` +
        `בהמשך לשיחתנו נרשמנו לחזור אליך ${timeDesc}.\n` +
        `אם תרצה לדבר לפני כן — אנחנו זמינים.\n\n` +
        `המשך יום נעים,\n` +
        `הילה | קוונטום נדל"ן`
      );
    } catch (e) {}
  }

  logger.info(`[VapiCall] Callback: ${timeDesc} | ${phone}`);
  return { success: true, message: `נרשמנו לחזור אליך ${timeDesc}. נשלחה הודעה בוואטסאפ.` };
}

// ── Unified tool endpoint ─────────────────────────────────────────────────────
router.post('/tool', async (req, res) => {
  const body      = req.body;
  const fnName    = extractFunctionName(body);
  const args      = extractArgs(body);
  const callPhone = extractCallPhone(body);

  logger.info(`[VapiCall] tool called: ${fnName} | args: ${JSON.stringify(args)}`);

  try {
    let result;
    if (!fnName || fnName === 'getAvailableSlots') {
      result = await handleGetAvailableSlots(args, callPhone);
    } else if (fnName === 'bookSlot') {
      result = await handleBookSlot(args, callPhone);
    } else if (fnName === 'scheduleCallback') {
      result = await handleScheduleCallback(args, callPhone);
    } else {
      result = { error: `Unknown function: ${fnName}` };
    }
    res.json(result);
  } catch (err) {
    logger.error(`[VapiCall] tool error (${fnName}):`, err.message);
    res.json({ error: err.message, message: 'שגיאה פנימית. נסי שוב.' });
  }
});

// ── Keep individual routes for backwards compat + manual testing ──────────────
router.get('/slots', async (req, res) => {
  try { res.json({ success: true, ...(await computeSlots()) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/slots', async (req, res) => {
  try { res.json(await handleGetAvailableSlots({}, null)); }
  catch (err) { res.json({ error: err.message }); }
});

router.post('/book', async (req, res) => {
  try { res.json(await handleBookSlot(req.body, null)); }
  catch (err) { res.json({ error: err.message }); }
});

router.post('/schedule-callback', async (req, res) => {
  try { res.json(await handleScheduleCallback(req.body, null)); }
  catch (err) { res.json({ error: err.message }); }
});

router.post('/webhook', (req, res) => {
  res.json({ received: true });
  try { logger.info(`[VapiCall] Webhook: ${req.body?.message?.type}`); } catch (e) {}
});

module.exports = router;
