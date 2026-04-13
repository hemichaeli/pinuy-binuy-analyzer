/**
 * VAPI Call Routes v3
 * - Times formatted as Hebrew words (no digits that TTS mispronounces)
 * - Slot availability: Google Calendar + QUANTUM DB
 * - WA summary sent from book endpoint (not webhook)
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

// Hour → Hebrew word
const HOUR_HE = {
  6:'שש',7:'שבע',8:'שמונה',9:'תשע',10:'עשר',11:'אחת עשרה',
  12:'שתים עשרה',13:'אחת',14:'שתיים',15:'שלוש',16:'ארבע',
  17:'חמש',18:'שש'
};
const PERIOD = (h) => h < 12 ? 'בבוקר' : h < 17 ? 'אחר הצהריים' : 'בערב';

function heTime(il) {
  const h = il.getHours();
  const m = il.getMinutes();
  const base = HOUR_HE[h] || String(h);
  const period = PERIOD(h);
  if (m === 0)  return `${base} ${period}`;
  if (m === 30) return `${base} וחצי ${period}`;
  return `${base} ו-${m} ${period}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

async function getQuantumBusy(from, to) {
  const busy = [];
  try {
    const { rows } = await pool.query(
      `SELECT event_date as start, event_date + INTERVAL '30 minutes' as end
       FROM quantum_events
       WHERE event_date >= $1 AND event_date < $2
         AND (status IS NULL OR status NOT IN ('cancelled','ביטול'))`,
      [from.toISOString(), to.toISOString()]
    );
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) {}
  try {
    const { rows } = await pool.query(
      `SELECT slot_datetime as start,
              slot_datetime + (COALESCE(duration_minutes,30) * INTERVAL '1 minute') as end
       FROM meeting_slots
       WHERE slot_datetime >= $1 AND slot_datetime < $2
         AND status IN ('confirmed','reserved')`,
      [from.toISOString(), to.toISOString()]
    );
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) {}
  return busy;
}

async function computeSlots() {
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  let gcalBusy = [];
  try {
    const cal = getCalendar();
    const res = await cal.freebusy.query({
      requestBody: { timeMin: now.toISOString(), timeMax: end.toISOString(), timeZone: TZ, items: [{ id: HEMI_CALENDAR_ID }] }
    });
    gcalBusy = (res.data.calendars?.[HEMI_CALENDAR_ID]?.busy || [])
      .map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) { logger.warn('[VapiCall] GCal:', e.message); }

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
        slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString(), label: heDate(cursor) });
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  return { today: heToday(), slots };
}

// ── POST /api/vapi-call/slots ─────────────────────────────────────────────────
router.post('/slots', async (req, res) => {
  try {
    const { slots, today } = await computeSlots();
    const top4 = slots.slice(0, 4);
    res.json({
      today,
      available_slots: top4.map(s => ({ label: s.label, start: s.start, end: s.end })),
      message: `היום ${today}. המועדים הפנויים:\n${top4.map(s => s.label).join('\n')}`
    });
  } catch (err) {
    logger.error('[VapiCall] Slots error:', err.message);
    res.json({ message: 'לא הצלחתי לבדוק את היומן. שאל מתי נוח לו ואמור שנחזור לאשר.' });
  }
});

router.get('/slots', async (req, res) => {
  try { res.json({ success: true, ...(await computeSlots()) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/vapi-call/book ──────────────────────────────────────────────────
router.post('/book', async (req, res) => {
  const { start, end, phone, rooms, price } = req.body;
  try {
    const startDt = new Date(start);
    const endDt   = end ? new Date(end) : new Date(startDt.getTime() + 30 * 60 * 1000);
    const label   = heDate(startDt);

    // 1. Google Calendar
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

    // 2. QUANTUM DB
    try {
      await pool.query(
        `INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
         VALUES ($1, 'שיחת_מנהל', $2, $3, 'confirmed', NOW())`,
        [`שיחת מנהל — ${phone || 'לא ידוע'}`, startDt.toISOString(),
         [rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : '', 'מקור: VAPI הילה'].filter(Boolean).join(' | ')]
      );
    } catch (e) { logger.warn('[VapiCall] DB insert:', e.message); }

    // 3. WhatsApp summary
    if (phone) {
      try {
        const normalized = phone.replace(/^\+972/, '0').replace(/\D/g, '');
        const wa =
          `שלום רב,\n` +
          `בהמשך לשיחתנו קבענו שיחת מנהל ב${label}.\n\n` +
          `המשך יום נעים,\n` +
          `הילה | קוונטום נדל"ן`;
        const { sendWhatsAppChat } = require('../services/inforuService');
        await sendWhatsAppChat(normalized, wa, {
          customerMessageId: `vapi_book_${Date.now()}`,
          customerParameter: 'QUANTUM_PILOT'
        });
        logger.info(`[VapiCall] WA → ${normalized} | ${label}`);
      } catch (e) { logger.warn('[VapiCall] WA:', e.message); }
    }

    logger.info(`[VapiCall] Booked: ${label} | ${phone}`);
    res.json({ success: true, label, message: `הפגישה נקבעה ל${label}. נשלחה הודעת אישור בוואטסאפ.` });
  } catch (err) {
    logger.error('[VapiCall] Book error:', err.message);
    res.json({ success: false, message: 'לא הצלחתי לקבוע. המנהל יחזור לאשר.' });
  }
});

router.post('/webhook', (req, res) => {
  res.json({ received: true });
  try { logger.info(`[VapiCall] Webhook: ${req.body?.message?.type}`); } catch (e) {}
});

module.exports = router;
