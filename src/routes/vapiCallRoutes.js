/**
 * VAPI Call Routes
 *
 * VAPI tool servers always receive POST, regardless of declared method.
 * Tool responses must be plain JSON — VAPI uses the full body as the result.
 *
 * - POST /api/vapi-call/slots   — returns available calendar slots (VAPI tool)
 * - POST /api/vapi-call/book    — books a slot + sends WA summary (VAPI tool)
 * - POST /api/vapi-call/webhook — end-of-call webhook (logs, fallback WA)
 * - GET  /api/vapi-call/slots   — manual check
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';
const TZ = 'Asia/Jerusalem';

// ── Helper: Google Calendar ───────────────────────────────────────────────────
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

// ── Helper: format date in Hebrew ─────────────────────────────────────────────
function heDate(dt) {
  const d = new Date(dt);
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  // Convert to Israel time
  const ilStr = d.toLocaleString('en-US', { timeZone: TZ,
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'narrow', day: 'numeric', month: 'numeric' });
  // Parse manually
  const il = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const day = days[il.getDay()];
  const date = il.getDate();
  const month = months[il.getMonth()];
  const hh = String(il.getHours()).padStart(2, '0');
  const mm = String(il.getMinutes()).padStart(2, '0');
  return `יום ${day}, ${date} ב${month}, בשעה ${hh}:${mm}`;
}

// ── Get available slots (core logic) ─────────────────────────────────────────
async function getSlots() {
  const calendar = getCalendar();
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const busyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      timeZone: TZ,
      items: [{ id: HEMI_CALENDAR_ID }]
    }
  });

  const busy = (busyRes.data.calendars?.[HEMI_CALENDAR_ID]?.busy || []).map(b => ({
    start: new Date(b.start),
    end: new Date(b.end)
  }));

  // Build candidate slots in Israel time
  const slots = [];
  const cursor = new Date(now);
  // Round up to next 30-min mark
  const mins = cursor.getMinutes();
  if (mins < 30) { cursor.setMinutes(30, 0, 0); }
  else { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); }

  while (slots.length < 6 && cursor < end) {
    const ilDate = new Date(cursor.toLocaleString('en-US', { timeZone: TZ }));
    const hour = ilDate.getHours();
    const day = ilDate.getDay();

    if (day !== 5 && day !== 6 && hour >= 9 && hour < 18) {
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      const isBusy = busy.some(b => cursor < b.end && slotEnd > b.start);
      if (!isBusy) {
        slots.push({
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
          label: heDate(cursor)
        });
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  // Today's date for context
  const todayIL = new Date().toLocaleDateString('he-IL', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  return { slots, today: todayIL };
}

// ── POST /api/vapi-call/slots (VAPI tool call) ────────────────────────────────
router.post('/slots', async (req, res) => {
  try {
    const { slots, today } = await getSlots();
    const slotText = slots.map(s => s.label).join('\n');
    // VAPI uses the JSON body as the tool result
    res.json({
      today,
      available_slots: slots.slice(0, 4).map(s => ({ label: s.label, start: s.start, end: s.end })),
      message: `היום ${today}.\nהמועדים הפנויים הקרובים:\n${slotText}`
    });
  } catch (err) {
    logger.error('[VapiCall] Slots error:', err.message);
    res.json({ message: 'לא הצלחתי לבדוק את היומן. שאל את הלקוח מה נוח לו ואמור שנחזור לאשר.' });
  }
});

// ── GET /api/vapi-call/slots (manual check) ───────────────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const data = await getSlots();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/vapi-call/book (VAPI tool call) ─────────────────────────────────
router.post('/book', async (req, res) => {
  // VAPI sends tool args inside req.body directly
  const { start, end, phone, rooms, price } = req.body;
  try {
    const calendar = getCalendar();
    const startDt = new Date(start);
    const endDt = end ? new Date(end) : new Date(startDt.getTime() + 30 * 60 * 1000);
    const label = heDate(startDt);

    await calendar.events.insert({
      calendarId: HEMI_CALENDAR_ID,
      requestBody: {
        summary: `שיחת מנהל — ${phone || 'לא ידוע'}`,
        description: [
          'מקור: שיחת הילה VAPI',
          rooms ? `${rooms} חדרים` : '',
          price ? `מחיר: ₪${price}` : ''
        ].filter(Boolean).join('\n'),
        start: { dateTime: startDt.toISOString(), timeZone: TZ },
        end: { dateTime: endDt.toISOString(), timeZone: TZ }
      }
    });

    // Send WhatsApp summary to customer
    if (phone) {
      try {
        const normalizedPhone = phone.replace(/^\+972/, '0').replace(/\D/g, '');
        const waMessage =
          `שלום רב,\n` +
          `בהמשך לשיחתנו קבענו שיחת מנהל ב${label}.\n\n` +
          `המשך יום נעים,\n` +
          `הילה | קוונטום נדל"ן`;

        const { sendWhatsAppChat } = require('../services/inforuService');
        await sendWhatsAppChat(normalizedPhone, waMessage, {
          customerMessageId: `vapi_book_${Date.now()}`,
          customerParameter: 'QUANTUM_PILOT'
        });
        logger.info(`[VapiCall] WA summary sent to ${normalizedPhone}`);
      } catch (e) {
        logger.warn(`[VapiCall] WA send failed: ${e.message}`);
      }
    }

    logger.info(`[VapiCall] Booked: ${label} for ${phone}`);
    res.json({
      success: true,
      label,
      message: `הפגישה נקבעה ל${label}. נשלחה הודעת אישור בוואטסאפ.`
    });
  } catch (err) {
    logger.error('[VapiCall] Book error:', err.message);
    res.json({
      success: false,
      message: 'לא הצלחתי לקבוע ביומן. אמרי ללקוח שהמנהל יתקשר לאשר.'
    });
  }
});

// ── POST /api/vapi-call/webhook (end-of-call fallback) ───────────────────────
router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  try {
    const body = req.body;
    const type = body?.message?.type || body?.type;
    logger.info(`[VapiCall] Webhook received: ${type}`);
  } catch (err) {
    logger.error('[VapiCall] Webhook error:', err.message);
  }
});

module.exports = router;
