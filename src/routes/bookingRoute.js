/**
 * QUANTUM Visual Booking Route v6
 *
 * Regular meetings:  meeting_slots table, one slot = one person
 * Signing ceremony:  ceremony_slots table, parallel stations per building
 *                    Each contact sees ONLY their building's slots
 *                    capacity = number of active stations in that building
 *
 * v6: Smart slot clustering
 *   - Pulls contact_street from bot_sessions (sourced from Zoho Mailing_Street)
 *   - Scores each open slot by geographic density:
 *       +5  same street already has confirmed/reserved appointments in ±90 min window
 *       +2  adjacent slots on same street (within ±3 slots)
 *       +1  any other confirmed slot within ±60 min
 *       -3  slot creates an isolated "island" (gap > 90 min on both sides)
 *   - Surfaces 3 smart picks: recommended, earliest, latest
 *   - Full list still accessible via "show all times"
 *
 * GET  /booking/:token          - Visual calendar HTML
 * GET  /booking/:token/slots    - JSON slot data
 * POST /booking/:token/confirm  - Confirm booking + create Google + Zoho Calendar events
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const inforuService = require('../services/inforuService');
const { logger } = require('../services/logger');
const crypto = require('crypto');

// Google Calendar (service account)
let gcal;
try { gcal = require('../services/googleCalendarService'); } catch (e) { /* optional */ }

// Zoho Calendar (OAuth, same credentials as CRM)
let zcal;
try { zcal = require('../services/zohoCalendarService'); } catch (e) { /* optional */ }

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://pinuy-binuy-analyzer-production.up.railway.app';

const DAY_NAMES_HE = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const DAY_NAMES_RU = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];

function generateToken() { return crypto.randomBytes(16).toString('hex'); }

async function ensureBookingToken(phone, campaignId) {
  const res = await pool.query(
    `SELECT booking_token FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id IS NOT DISTINCT FROM $2`,
    [phone, campaignId]
  );
  if (res.rows[0]?.booking_token) return res.rows[0].booking_token;
  const token = generateToken();
  await pool.query(
    `UPDATE bot_sessions SET booking_token=$1 WHERE phone=$2 AND zoho_campaign_id IS NOT DISTINCT FROM $3`,
    [token, phone, campaignId]
  );
  return token;
}
module.exports.ensureBookingToken = ensureBookingToken;
module.exports.BASE_URL = BASE_URL;

// ══════════════════════════════════════════════════════════════
// SMART SLOT CLUSTERING
// ══════════════════════════════════════════════════════════════

async function scoreSlotsByProximity(slots, campaignId, contactStreet) {
  if (!slots.length) return slots;

  const confirmedRes = await pool.query(
    `SELECT slot_datetime, contact_street
     FROM meeting_slots
     WHERE campaign_id=$1
       AND status IN ('confirmed','reserved')
       AND slot_datetime > NOW() - INTERVAL '1 hour'
     ORDER BY slot_datetime`,
    [campaignId]
  );
  const confirmed = confirmedRes.rows;

  const WINDOW_SAME_STREET = 90 * 60 * 1000;
  const WINDOW_ANY          = 60 * 60 * 1000;
  const ISOLATION_GAP       = 90 * 60 * 1000;

  for (const slot of slots) {
    let score = 0;
    const slotMs = new Date(slot.slot_datetime).getTime();

    for (const c of confirmed) {
      const cMs = new Date(c.slot_datetime).getTime();
      const diff = Math.abs(slotMs - cMs);
      if (diff <= WINDOW_SAME_STREET && contactStreet && c.contact_street === contactStreet) {
        score += 5;
      } else if (diff <= WINDOW_ANY) {
        score += 1;
      }
    }

    const before = confirmed.filter(c => new Date(c.slot_datetime).getTime() < slotMs);
    const after  = confirmed.filter(c => new Date(c.slot_datetime).getTime() > slotMs);
    const nearestBefore = before.length ? slotMs - new Date(before[before.length - 1].slot_datetime).getTime() : Infinity;
    const nearestAfter  = after.length  ? new Date(after[0].slot_datetime).getTime() - slotMs : Infinity;
    if (nearestBefore > ISOLATION_GAP && nearestAfter > ISOLATION_GAP) {
      score -= 3;
    }

    slot.cluster_score = score;
  }

  slots.sort((a, b) => {
    if (b.cluster_score !== a.cluster_score) return b.cluster_score - a.cluster_score;
    return new Date(a.slot_datetime) - new Date(b.slot_datetime);
  });

  if (slots.length > 0) {
    slots[0].is_recommended = true;
  }

  return slots;
}

// ══════════════════════════════════════════════════════════════
// SLOT FETCHERS
// ══════════════════════════════════════════════════════════════

async function getMeetingSlots(campaignId, contactStreet) {
  const res = await pool.query(
    `SELECT id, slot_datetime,
            TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD') AS slot_date,
            TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time_str,
            EXTRACT(DOW FROM slot_datetime AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
            representative_name
     FROM meeting_slots
     WHERE campaign_id=$1 AND status='open' AND slot_datetime > NOW()
     ORDER BY slot_datetime LIMIT 60`,
    [campaignId]
  );
  if (!res.rows.length) return [];

  let slots = res.rows.map(s => ({ ...s, booking_type: 'meeting', capacity: 1, open_count: 1, cluster_score: 0, is_recommended: false }));
  slots = await scoreSlotsByProximity(slots, campaignId, contactStreet || null);
  return slots;
}

async function getCeremonySlots(ceremonyId, buildingId) {
  let query, params;

  if (buildingId) {
    query = `
      SELECT
        cs.slot_time AS time_str,
        cs.slot_date,
        COUNT(*) FILTER (WHERE cs.status = 'open') AS open_count,
        COUNT(*) AS total_count,
        EXTRACT(DOW FROM cs.slot_date)::int AS dow,
        cb.building_label,
        cst.building_id
      FROM ceremony_slots cs
      JOIN ceremony_stations cst ON cs.station_id = cst.id
      JOIN ceremony_buildings cb ON cst.building_id = cb.id
      WHERE cs.ceremony_id=$1
        AND cst.building_id=$2
        AND cst.is_active = true
        AND cs.status = 'open'
      GROUP BY cs.slot_time, cs.slot_date, cb.building_label, cst.building_id
      HAVING COUNT(*) FILTER (WHERE cs.status = 'open') > 0
      ORDER BY cs.slot_time`;
    params = [ceremonyId, buildingId];
  } else {
    query = `
      SELECT
        cs.slot_time AS time_str,
        cs.slot_date,
        COUNT(*) FILTER (WHERE cs.status = 'open') AS open_count,
        COUNT(*) AS total_count,
        EXTRACT(DOW FROM cs.slot_date)::int AS dow,
        null AS building_label,
        null AS building_id
      FROM ceremony_slots cs
      JOIN ceremony_stations cst ON cs.station_id = cst.id
      WHERE cs.ceremony_id=$1 AND cst.is_active=true AND cs.status='open'
      GROUP BY cs.slot_time, cs.slot_date
      HAVING COUNT(*) FILTER (WHERE cs.status = 'open') > 0
      ORDER BY cs.slot_time`;
    params = [ceremonyId];
  }

  const res = await pool.query(query, params);
  const bId = buildingId || 0;
  return res.rows.map(row => ({
    id: `ceremony:${ceremonyId}:${bId}:${row.time_str.substring(0,5)}`,
    booking_type: 'ceremony',
    ceremony_id: ceremonyId,
    building_id: buildingId || null,
    building_label: row.building_label,
    slot_date: row.slot_date,
    time_str: row.time_str.substring(0, 5),
    dow: parseInt(row.dow),
    open_count: parseInt(row.open_count),
    total_count: parseInt(row.total_count),
    capacity: parseInt(row.total_count),
    cluster_score: 0,
    is_recommended: false,
    representative_name: null
  }));
}

function groupByDate(slots, lang = 'he') {
  const groups = {};
  const dayNames = lang === 'ru' ? DAY_NAMES_RU : DAY_NAMES_HE;
  for (const slot of slots) {
    const key = slot.slot_date;
    if (!groups[key]) {
      const d = new Date(`${slot.slot_date}T${slot.time_str}`);
      const dayNum = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      groups[key] = { date: key, label: dayNames[slot.dow] || '', dayNum, slots: [] };
    }
    groups[key].slots.push(slot);
  }
  const sorted = Object.values(groups).sort((a, b) => a.date.localeCompare(b.date));
  for (const g of sorted) {
    g.slots.sort((a, b) => a.time_str.localeCompare(b.time_str));
  }
  return sorted;
}

// ══════════════════════════════════════════════════════════════
// GET /booking/:token
// ══════════════════════════════════════════════════════════════
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const sessionRes = await pool.query(
      `SELECT bs.*, csc.meeting_type, csc.show_rep_name, csc.booking_link_expires_hours
       FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [token]
    );
    if (!sessionRes.rows.length) {
      return res.status(404).type('html').send(errorPage('הקישור לא נמצא', 'The link is invalid or expired.'));
    }
    const session = sessionRes.rows[0];
    const lang = session.language || 'he';

    if (session.booking_completed_at || session.state === 'confirmed') {
      const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
      return res.type('html').send(alreadyBookedPage(lang, ctx.confirmedSlot || {}));
    }
    const expiresHours = session.booking_link_expires_hours || 48;
    if (Date.now() - new Date(session.created_at).getTime() > expiresHours * 3600000) {
      return res.type('html').send(errorPage('הקישור פג תוקף', 'This booking link has expired. Please contact QUANTUM.'));
    }

    const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
    const isCeremony = session.meeting_type === 'signing_ceremony';
    const config = { show_rep_name: session.show_rep_name !== false };

    let slots = [];
    let buildingLabel = null;
    if (isCeremony) {
      const ceremonyId = ctx.ceremony?.id;
      const buildingId = session.ceremony_building_id || null;
      if (ceremonyId) {
        slots = await getCeremonySlots(ceremonyId, buildingId);
        buildingLabel = slots[0]?.building_label || null;
      }
    } else {
      slots = await getMeetingSlots(session.zoho_campaign_id, session.contact_street || null);
    }

    let smartPicks = null;
    if (!isCeremony && slots.length >= 2) {
      const recommended = slots.find(s => s.is_recommended) || slots[0];
      const earliest    = [...slots].sort((a, b) => a.slot_datetime.localeCompare(b.slot_datetime))[0];
      const latest      = [...slots].sort((a, b) => b.slot_datetime.localeCompare(a.slot_datetime))[0];
      const seen = new Set();
      smartPicks = [recommended, earliest, latest].filter(s => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    }

    const grouped = groupByDate(slots, lang);
    res.type('html').send(calendarPage(token, ctx.contactName || '', lang, config, grouped, isCeremony, buildingLabel, smartPicks));
  } catch (err) {
    logger.error('[BookingRoute] GET error:', err);
    res.status(500).type('html').send(errorPage('שגיאה טכנית', 'Technical error. Please try again.'));
  }
});

// ══════════════════════════════════════════════════════════════
// GET /booking/:token/slots (JSON)
// ══════════════════════════════════════════════════════════════
router.get('/:token/slots', async (req, res) => {
  try {
    const sessionRes = await pool.query(
      `SELECT bs.zoho_campaign_id, bs.language, bs.context, bs.ceremony_building_id,
              bs.contact_street, csc.meeting_type
       FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [req.params.token]
    );
    if (!sessionRes.rows.length) return res.status(404).json({ error: 'Invalid token' });
    const { zoho_campaign_id, language, context, ceremony_building_id, contact_street, meeting_type } = sessionRes.rows[0];
    const ctx = typeof context === 'string' ? JSON.parse(context) : (context || {});
    const isCeremony = meeting_type === 'signing_ceremony';
    const slots = isCeremony
      ? await getCeremonySlots(ctx.ceremony?.id, ceremony_building_id)
      : await getMeetingSlots(zoho_campaign_id, contact_street || null);
    res.json({ slots, lang: language, isCeremony });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /booking/:token/confirm
// ══════════════════════════════════════════════════════════════
router.post('/:token/confirm', async (req, res) => {
  try {
    const { token } = req.params;
    const { slotId } = req.body;
    if (!slotId) return res.status(400).json({ error: 'slotId required' });

    const sessionRes = await pool.query(
      `SELECT bs.*, csc.meeting_type
       FROM bot_sessions bs
       LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
       WHERE bs.booking_token=$1`,
      [token]
    );
    if (!sessionRes.rows.length) return res.status(404).json({ error: 'Invalid token' });

    const session = sessionRes.rows[0];
    const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
    const lang = session.language || 'he';
    let dateStr, timeStr, repName, slotDatetime, confirmedSlotId, confirmedSlotType;

    if (slotId.startsWith('ceremony:')) {
      // Format: ceremony:CEREMONY_ID:BUILDING_ID:HH:MM
      const parts = slotId.split(':');
      const ceremonyId = parts[1];
      const buildingId  = parseInt(parts[2]) || null;
      const timeStr_    = parts.slice(3).join(':');

      const buildingFilter = buildingId ? `AND cst.building_id=${buildingId}` : '';
      const lockRes = await pool.query(
        `UPDATE ceremony_slots SET
           status='confirmed', confirmed_at=NOW(), reserved_at=NOW(),
           contact_phone=$1, zoho_contact_id=$2, contact_name=$3
         WHERE id = (
           SELECT cs.id FROM ceremony_slots cs
           JOIN ceremony_stations cst ON cs.station_id = cst.id
           WHERE cs.ceremony_id=$4
             AND cs.status='open'
             AND cst.is_active=true
             AND TO_CHAR(cs.slot_time,'HH24:MI') = $5
             ${buildingFilter}
           ORDER BY cs.id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *, TO_CHAR(slot_date,'DD/MM/YYYY') AS date_str_fmt`,
        [session.phone, session.zoho_contact_id, ctx.contactName || '', ceremonyId, timeStr_]
      );
      if (!lockRes.rows.length) return res.status(409).json({ error: 'slot_taken' });

      const slot = lockRes.rows[0];
      const d = new Date(`${slot.slot_date}T${timeStr_}`);
      dateStr = d.toLocaleDateString('he-IL', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem' });
      timeStr = timeStr_;
      repName = null;
      slotDatetime = `${slot.slot_date}T${timeStr_}:00`;
      confirmedSlotId = slot.id;
      confirmedSlotType = 'ceremony';

      // Google Calendar
      if (gcal?.createCeremonySlotEvent) {
        gcal.createCeremonySlotEvent(pool, slot, ctx.contactName || '', session.phone)
          .then(eventId => {
            if (eventId) {
              pool.query(`UPDATE ceremony_slots SET google_event_id=$1 WHERE id=$2`, [eventId, slot.id]).catch(() => {});
              logger.info(`[BookingRoute] GCal ceremony event created: ${eventId}`);
            }
          })
          .catch(e => logger.warn('[BookingRoute] GCal ceremony event failed:', e.message));
      }

      // Zoho Calendar
      if (zcal?.createCeremonySlotEvent) {
        zcal.createCeremonySlotEvent(pool, slot, ctx.contactName || '', session.phone)
          .then(uid => {
            if (uid) {
              pool.query(`UPDATE ceremony_slots SET zoho_event_id=$1 WHERE id=$2`, [uid, slot.id]).catch(() => {});
              logger.info(`[BookingRoute] ZohoCal ceremony event created: ${uid}`);
            }
          })
          .catch(e => logger.warn('[BookingRoute] ZohoCal ceremony event failed:', e.message));
      }

    } else {
      // Regular meeting slot
      const lockRes = await pool.query(
        `UPDATE meeting_slots SET
           status='confirmed', reserved_at=NOW(),
           contact_phone=$1, zoho_contact_id=$2, contact_name=$3,
           contact_address=$4, contact_street=$5
         WHERE id=$6 AND status='open'
         RETURNING *`,
        [
          session.phone, session.zoho_contact_id, ctx.contactName || '',
          session.contact_address || null, session.contact_street || null,
          slotId
        ]
      );
      if (!lockRes.rows.length) return res.status(409).json({ error: 'slot_taken' });

      const slot = lockRes.rows[0];
      const slotDt = new Date(slot.slot_datetime);
      dateStr = slotDt.toLocaleDateString('he-IL', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem' });
      timeStr = slotDt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      repName = slot.representative_name;
      slotDatetime = slot.slot_datetime;
      confirmedSlotId = slot.id;
      confirmedSlotType = 'meeting';

      // Google Calendar
      if (gcal?.createMeetingSlotEvent) {
        gcal.createMeetingSlotEvent(pool, slot, ctx.contactName || '', session.phone)
          .then(eventId => {
            if (eventId) {
              pool.query(`UPDATE meeting_slots SET google_event_id=$1 WHERE id=$2`, [eventId, slot.id]).catch(() => {});
              logger.info(`[BookingRoute] GCal meeting event created: ${eventId}`);
            }
          })
          .catch(e => logger.warn('[BookingRoute] GCal meeting event failed:', e.message));
      }

      // Zoho Calendar
      if (zcal?.createMeetingSlotEvent) {
        zcal.createMeetingSlotEvent(pool, slot, ctx.contactName || '', session.phone)
          .then(uid => {
            if (uid) {
              pool.query(`UPDATE meeting_slots SET zoho_event_id=$1 WHERE id=$2`, [uid, slot.id]).catch(() => {});
              logger.info(`[BookingRoute] ZohoCal meeting event created: ${uid}`);
            }
          })
          .catch(e => logger.warn('[BookingRoute] ZohoCal meeting event failed:', e.message));
      }
    }

    ctx.confirmedSlot = { dateStr, timeStr, time: timeStr, date_str: dateStr, rep_name: repName || '' };
    await pool.query(
      `UPDATE bot_sessions SET state='confirmed', context=$1, booking_completed_at=NOW() WHERE booking_token=$2`,
      [JSON.stringify(ctx), token]
    );

    const gcalEnd = new Date(new Date(slotDatetime).getTime() + 45 * 60000);
    const fmt = (d) => d.toISOString().replace(/[-:.]/g, '').substring(0, 15) + 'Z';
    const meetingLabel = { appraiser:'ביקור שמאי QUANTUM', consultation:'פגישת ייעוץ QUANTUM', physical:'פגישה פיזית QUANTUM', surveyor:'ביקור מודד QUANTUM', signing_ceremony:'כנס חתימות QUANTUM' }[session.meeting_type] || 'פגישת QUANTUM';
    const gcalLink = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meetingLabel)}&dates=${fmt(new Date(slotDatetime))}/${fmt(gcalEnd)}&sf=true`;

    const repLine = repName ? `\n👤 ${lang === 'ru' ? 'Представитель' : 'נציג'}: ${repName}` : '';
    const waMsg = lang === 'ru'
      ? `✅ *Встреча подтверждена!*\n\n📅 ${dateStr}\n⏰ ${timeStr}${repLine}\n\nНапомним за сутки. До встречи! 👋\n\n📆 Добавить в календарь: ${gcalLink}`
      : `✅ *הפגישה אושרה!*\n\n📅 ${dateStr}\n⏰ ${timeStr}${repLine}\n\nתקבל/י תזכורת יום לפני. להתראות! 👋\n\n📆 הוסף ליומן: ${gcalLink}`;

    inforuService.sendWhatsAppChat(session.phone, waMsg).catch(e => logger.warn('[BookingRoute] WA send failed:', e.message));
    res.json({ success: true, dateStr, timeStr, repName, gcalLink });
  } catch (err) {
    logger.error('[BookingRoute] confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ══════════════════════════════════════════════════════════════

function errorPage(titleHe, msgEn) {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QUANTUM</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;margin:0}
.box{background:#111827;border:1px solid #1e293b;border-radius:16px;padding:40px;max-width:320px}
.logo{color:#60a5fa;font-size:11px;letter-spacing:4px;margin-bottom:16px}
h2{color:#f87171;font-size:18px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}</style>
</head><body><div class="box"><div class="logo">⚡ QUANTUM</div><h2>${titleHe}</h2><p>${msgEn}</p></div></body></html>`;
}

function alreadyBookedPage(lang, slot) {
  const isRu = lang === 'ru';
  const title = isRu ? '✅ Встреча уже назначена' : '✅ הפגישה כבר נקבעה';
  const msg = isRu
    ? `Вы уже записаны на ${slot.dateStr || slot.date_str || ''} в ${slot.timeStr || slot.time || ''}`
    : `כבר נקבעתם ל-${slot.dateStr || slot.date_str || ''} בשעה ${slot.timeStr || slot.time || ''}`;
  return `<!DOCTYPE html><html dir="${isRu ? 'ltr' : 'rtl'}" lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QUANTUM</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;margin:0}
.box{background:#111827;border:1px solid #064e3b;border-radius:16px;padding:40px;max-width:320px}
.logo{color:#60a5fa;font-size:11px;letter-spacing:4px;margin-bottom:16px}
h2{color:#34d399;font-size:18px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}</style>
</head><body><div class="box"><div class="logo">⚡ QUANTUM</div><h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

function calendarPage(token, name, lang, config, grouped, isCeremony, buildingLabel, smartPicks) {
  const isRu = lang === 'ru';
  const dir = isRu ? 'ltr' : 'rtl';

  const T = {
    he: {
      heading: isCeremony ? 'בחר/י שעה לכנס החתימות' : 'בחר/י מועד נוח',
      building: buildingLabel ? `בניין: ${buildingLabel}` : '',
      subheading: name ? `שלום ${name} 👋` : 'שלום 👋',
      confirm: 'אישור',
      noSlots: 'אין מועדים פנויים כרגע. ניצור איתך קשר בהקדם.',
      success_title: '✅ הפגישה נקבעה!',
      success_sub: isCeremony ? 'תקבל/י אישור ב-WhatsApp.' : 'תקבל/י אישור ב-WhatsApp ותזכורת יום לפני.',
      slot_taken: 'המועד כבר נתפס - אנא בחר/י מועד אחר.',
      recommended: '⭐ מומלץ',
      earliest: '⏰ מוקדם',
      latest: '🌙 מאוחר',
      show_all: 'הצג את כל המועדים',
      hide_all: 'הסתר',
      cancel: 'בחר/י מועד אחר',
      rep_label: 'נציג',
      spots: (n) => n === 1 ? 'מקום אחד פנוי' : `${n} מקומות פנויים`,
      smart_heading: 'מועדים מומלצים',
      all_heading: 'כל המועדים הפנויים',
    },
    ru: {
      heading: isCeremony ? 'Выберите время для церемонии' : 'Выберите удобное время',
      building: buildingLabel ? `Здание: ${buildingLabel}` : '',
      subheading: name ? `Здравствуйте, ${name} 👋` : 'Здравствуйте 👋',
      confirm: 'Подтвердить',
      noSlots: 'Нет доступных слотов. Мы свяжемся с вами.',
      success_title: '✅ Встреча назначена!',
      success_sub: isCeremony ? 'Подтверждение придёт в WhatsApp.' : 'Подтверждение придёт в WhatsApp. Напомним за сутки.',
      slot_taken: 'Это время уже занято — выберите другое.',
      recommended: '⭐ Рекомендуем',
      earliest: '⏰ Раньше',
      latest: '🌙 Позже',
      show_all: 'Показать все слоты',
      hide_all: 'Скрыть',
      cancel: 'Выбрать другое время',
      rep_label: 'Представитель',
      spots: (n) => n === 1 ? '1 место' : `${n} места`,
      smart_heading: 'Рекомендуемые',
      all_heading: 'Все доступные слоты',
    },
  }[lang] || {};

  let smartHtml = '';
  if (!isCeremony && smartPicks && smartPicks.length > 0) {
    const LABELS = [T.recommended, T.earliest, T.latest];
    smartHtml = `<div class="smart-section">
      <div class="section-label">✨ ${T.smart_heading}</div>
      <div class="smart-row">`;
    smartPicks.forEach((slot, i) => {
      const repSafe = (slot.representative_name || '').replace(/'/g, "\\'");
      const slotIdSafe = String(slot.id).replace(/'/g, "\\'");
      const dateObj = new Date(`${slot.slot_date}T${slot.time_str}`);
      const dayLabel = (isRu ? DAY_NAMES_RU : DAY_NAMES_HE)[slot.dow] || '';
      const dayNum = `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}`;
      smartHtml += `<button class="smart-btn" data-id="${slotIdSafe}"
        onclick="selectSlot(this,'${slotIdSafe}','${dayLabel} ${dayNum}','${slot.time_str}','${repSafe}')">
        <span class="smart-label">${LABELS[i] || ''}</span>
        <span class="smart-time">${slot.time_str}</span>
        <span class="smart-date">${dayLabel} ${dayNum}</span>
        ${config.show_rep_name && slot.representative_name ? `<span class="smart-rep">${slot.representative_name}</span>` : ''}
      </button>`;
    });
    smartHtml += `</div></div>`;
  }

  let slotsHtml = '';
  if (!grouped.length) {
    slotsHtml = `<div class="no-slots">${T.noSlots}</div>`;
  } else {
    for (const group of grouped) {
      slotsHtml += `<div class="day-group">
        <div class="day-label">
          <span class="day-name">${group.label}</span>
          <span class="day-date">${group.dayNum}</span>
        </div>
        <div class="slots-row">`;
      for (const slot of group.slots) {
        const repSafe = (slot.representative_name || '').replace(/'/g, "\\'");
        const slotIdSafe = String(slot.id).replace(/'/g, "\\'");
        const capacityBadge = isCeremony && slot.open_count ? `<span class="cap-badge">${T.spots(slot.open_count)}</span>` : '';
        const recClass = slot.is_recommended ? ' recommended' : '';
        const disabledAttr = slot.open_count === 0 ? 'disabled' : '';
        slotsHtml += `<button class="slot-btn${recClass}" data-id="${slotIdSafe}" ${disabledAttr}
          onclick="selectSlot(this,'${slotIdSafe}','${group.label} ${group.dayNum}','${slot.time_str}','${repSafe}')">
          <span class="slot-time">${slot.time_str}</span>
          ${capacityBadge}
          ${!isCeremony && config.show_rep_name && slot.representative_name ? `<span class="rep-name">${slot.representative_name}</span>` : ''}
        </button>`;
      }
      slotsHtml += `</div></div>`;
    }
  }

  const buildingHtml = T.building ? `<div class="building-tag">📍 ${T.building}</div>` : '';
  const allSlotsToggle = (!isCeremony && smartPicks && smartPicks.length > 0 && grouped.length > 0)
    ? `<div class="all-toggle" onclick="toggleAllSlots()" id="allToggle">▼ ${T.show_all}</div>
       <div id="allSlots" style="display:none">${slotsHtml}</div>`
    : slotsHtml;

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>QUANTUM - ${T.heading}</title>
<style>
  :root{--blue:#3b82f6;--blue-dark:#2563eb;--green:#10b981;--amber:#f59e0b;--dark:#0a0a0f;--card:#111827;--border:#1e293b;--text:#e2e8f0;--muted:#64748b}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:var(--dark);color:var(--text);min-height:100vh;direction:${dir}}
  .header{background:linear-gradient(135deg,#1e3a5f,#0d1b2e);padding:20px 20px 16px;border-bottom:1px solid #1e40af44;position:sticky;top:0;z-index:10}
  .logo{font-size:10px;letter-spacing:4px;color:#60a5fa;text-transform:uppercase;margin-bottom:4px}
  .greeting{font-size:17px;font-weight:700;color:#f1f5f9}
  .subhead{font-size:13px;color:#94a3b8;margin-top:3px}
  .building-tag{display:inline-block;margin-top:6px;background:#1e3a5f;color:#93c5fd;border:1px solid #3b82f660;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:600}
  .container{padding:16px;max-width:500px;margin:0 auto;padding-bottom:110px}
  .smart-section{margin-bottom:24px}
  .section-label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
  .smart-row{display:flex;gap:10px;flex-wrap:wrap}
  .smart-btn{flex:1;min-width:100px;background:linear-gradient(135deg,#1e293b,#0f172a);border:1.5px solid var(--blue);border-radius:14px;padding:12px 10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;touch-action:manipulation;transition:all .15s}
  .smart-btn:hover{border-color:#60a5fa;background:#1e3a5f}
  .smart-btn.selected{background:#1e3a5f;box-shadow:0 0 0 3px #3b82f630}
  .smart-label{font-size:10px;font-weight:700;color:var(--blue);letter-spacing:.5px}
  .smart-time{font-size:20px;font-weight:800;color:var(--text)}
  .smart-date{font-size:11px;color:var(--muted)}
  .smart-rep{font-size:10px;color:var(--muted)}
  .all-toggle{text-align:center;padding:10px;color:var(--blue);font-size:14px;cursor:pointer;border:1px dashed var(--border);border-radius:10px;margin-bottom:16px}
  .all-toggle:hover{background:#1e293b}
  .day-group{margin-bottom:24px}
  .day-label{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .day-name{font-size:14px;font-weight:700;color:var(--blue)}
  .day-date{font-size:13px;color:var(--muted)}
  .slots-row{display:flex;flex-wrap:wrap;gap:8px}
  .slot-btn{position:relative;background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:10px 14px;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;display:flex;flex-direction:column;align-items:center;min-width:76px;gap:4px;touch-action:manipulation}
  .slot-btn:hover{border-color:var(--blue);background:#1e293b}
  .slot-btn.selected{border-color:var(--blue);background:#1e3a5f;box-shadow:0 0 0 3px #3b82f620}
  .slot-btn.recommended{border-color:var(--amber);background:#1c1608}
  .slot-btn:disabled{opacity:.35;cursor:not-allowed}
  .slot-time{font-size:16px;font-weight:700;color:var(--text)}
  .rep-name{font-size:10px;color:var(--muted);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cap-badge{font-size:9px;font-weight:600;color:#6ee7b7;letter-spacing:.2px}
  .no-slots{text-align:center;color:var(--muted);padding:40px 20px;font-size:14px}
  .confirm-panel{position:fixed;bottom:0;left:0;right:0;background:#0f172a;border-top:1px solid var(--blue);padding:16px 20px 28px;transform:translateY(100%);transition:transform .25s cubic-bezier(.4,0,.2,1);z-index:100}
  .confirm-panel.open{transform:translateY(0)}
  .selected-time{font-size:20px;font-weight:800;margin-bottom:4px}
  .selected-rep{font-size:13px;color:var(--muted);margin-bottom:14px}
  .confirm-btn{width:100%;background:var(--blue);color:#fff;border:none;border-radius:14px;padding:15px;font-size:17px;font-weight:700;cursor:pointer}
  .confirm-btn:hover{background:var(--blue-dark)}
  .confirm-btn:disabled{background:#374151;color:#6b7280;cursor:not-allowed}
  .cancel-link{display:block;text-align:center;margin-top:10px;color:var(--muted);font-size:13px;cursor:pointer}
  .success-screen{display:none;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:40px 24px}
  .success-screen.show{display:flex}
  .success-icon{font-size:64px;margin-bottom:20px}
  .success-title{font-size:22px;font-weight:800;color:var(--green);margin-bottom:10px}
  .success-detail{font-size:16px;font-weight:600;margin-bottom:6px}
  .success-sub{font-size:13px;color:var(--muted);margin-bottom:24px}
  .gcal-btn{display:inline-block;background:#1e3a5f;color:#93c5fd;border:1px solid #3b82f6;border-radius:12px;padding:12px 20px;font-size:14px;text-decoration:none;font-weight:600}
  .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-80px);background:#7f1d1d;color:#fca5a5;padding:10px 20px;border-radius:10px;font-size:14px;transition:transform .25s;z-index:200;max-width:300px;text-align:center}
  .toast.show{transform:translateX(-50%) translateY(0)}
  .loading-overlay{display:none;position:fixed;inset:0;background:#0a0a0fcc;z-index:150;align-items:center;justify-content:center}
  .loading-overlay.show{display:flex}
  .spinner{width:40px;height:40px;border:3px solid #1e293b;border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="mainView">
  <div class="header">
    <div class="logo">⚡ QUANTUM</div>
    <div class="greeting">${T.heading}</div>
    <div class="subhead">${T.subheading}</div>
    ${buildingHtml}
  </div>
  <div class="container">
    ${smartHtml}
    ${allSlotsToggle}
  </div>
</div>

<div class="confirm-panel" id="confirmPanel">
  <div class="selected-time" id="selectedLabel"></div>
  <div class="selected-rep" id="selectedRep"></div>
  <button class="confirm-btn" id="confirmBtn" onclick="confirmBooking()">${T.confirm}</button>
  <span class="cancel-link" onclick="cancelSelection()">↩ ${T.cancel}</span>
</div>

<div class="success-screen" id="successScreen">
  <div class="success-icon">🎉</div>
  <div class="success-title">${T.success_title}</div>
  <div class="success-detail" id="successDetail"></div>
  <div class="success-sub">${T.success_sub}</div>
  <a class="gcal-btn" id="gcalLink" href="#" target="_blank">📆 ${isRu ? 'Добавить в календарь' : 'הוסף ליומן Google'}</a>
</div>

<div class="toast" id="toast"></div>
<div class="loading-overlay" id="loader"><div class="spinner"></div></div>

<script>
const TOKEN = '${token}';
const SHOW_REP = ${config.show_rep_name};
const REP_LABEL = '${T.rep_label}';
const SLOT_TAKEN_MSG = '${T.slot_taken}';
const SHOW_ALL_TXT = '▼ ${T.show_all}';
const HIDE_ALL_TXT = '▲ ${T.hide_all}';
let selectedSlotId = null;
let allVisible = false;

function toggleAllSlots() {
  allVisible = !allVisible;
  document.getElementById('allSlots').style.display = allVisible ? 'block' : 'none';
  document.getElementById('allToggle').textContent = allVisible ? HIDE_ALL_TXT : SHOW_ALL_TXT;
}

function selectSlot(btn, id, dateLabel, time, rep) {
  document.querySelectorAll('.slot-btn,.smart-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedSlotId = id;
  document.getElementById('selectedLabel').textContent = dateLabel + '  ⏰ ' + time;
  document.getElementById('selectedRep').textContent = (SHOW_REP && rep) ? REP_LABEL + ': ' + rep : '';
  document.getElementById('confirmPanel').classList.add('open');
}
function cancelSelection() {
  document.querySelectorAll('.slot-btn,.smart-btn').forEach(b => b.classList.remove('selected'));
  selectedSlotId = null;
  document.getElementById('confirmPanel').classList.remove('open');
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}
async function confirmBooking() {
  if (!selectedSlotId) return;
  const btn = document.getElementById('confirmBtn');
  btn.disabled = true;
  document.getElementById('loader').classList.add('show');
  try {
    const res = await fetch('/booking/' + TOKEN + '/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: selectedSlotId })
    });
    const data = await res.json();
    document.getElementById('loader').classList.remove('show');
    if (res.status === 409 || data.error === 'slot_taken') {
      showToast(SLOT_TAKEN_MSG);
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (data.success) {
      document.getElementById('mainView').style.display = 'none';
      document.getElementById('confirmPanel').classList.remove('open');
      document.getElementById('successDetail').textContent = data.dateStr + '  ⏰ ' + data.timeStr;
      if (data.gcalLink) document.getElementById('gcalLink').href = data.gcalLink;
      document.getElementById('successScreen').classList.add('show');
    } else {
      showToast('שגיאה - אנא נסה/י שוב');
      btn.disabled = false;
    }
  } catch (e) {
    document.getElementById('loader').classList.remove('show');
    showToast('שגיאת חיבור - אנא נסה/י שוב');
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

module.exports = router;
