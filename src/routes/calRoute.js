/**
 * QUANTUM Calendar Short-Link Route v1.0
 *
 * Provides short redirect URLs for calendar links sent via WhatsApp.
 * slotId is base64url-encoded to keep URLs short and safe.
 *
 * GET /cal/g/:slotId  → Google Calendar
 * GET /cal/o/:slotId  → Outlook Calendar
 * GET /cal/i/:slotId  → iOS / Apple Calendar (.ics download)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const DURATION_MS = 45 * 60 * 1000;

function fmtDt(d) {
  return new Date(d).toISOString().replace(/[-:.]/g, '').substring(0, 15) + 'Z';
}

function meetingTitle(meetingType) {
  return {
    appraiser: '\u05d1\u05d9\u05e7\u05d5\u05e8 \u05e9\u05de\u05d0\u05d9 QUANTUM',
    consultation: '\u05e4\u05d2\u05d9\u05e9\u05ea \u05d9\u05d9\u05e2\u05d5\u05e5 QUANTUM',
    physical: '\u05e4\u05d2\u05d9\u05e9\u05d4 \u05e4\u05d9\u05d6\u05d9\u05ea QUANTUM',
    surveyor: '\u05d1\u05d9\u05e7\u05d5\u05e8 \u05de\u05d5\u05d3\u05d3 QUANTUM',
    signing_ceremony: '\u05db\u05e0\u05e1 \u05d7\u05ea\u05d9\u05de\u05d5\u05ea QUANTUM'
  }[meetingType] || '\u05e4\u05d2\u05d9\u05e9\u05ea QUANTUM';
}

async function getSlotData(rawSlotId) {
  const slotId = String(rawSlotId);

  if (slotId.startsWith('ceremony:')) {
    const parts = slotId.split(':');
    const ceremonyId = parts[1];
    const buildingId = parseInt(parts[2]) || null;
    const timeStr = parts.slice(3).join(':');

    const q = buildingId
      ? `SELECT cs.slot_date, cb.building_label
         FROM ceremony_slots cs
         JOIN ceremony_stations cst ON cs.station_id = cst.id
         LEFT JOIN ceremony_buildings cb ON cst.building_id = cb.id
         WHERE cs.ceremony_id=$1 AND TO_CHAR(cs.slot_time,'HH24:MI')=$2 AND cst.building_id=$3
         LIMIT 1`
      : `SELECT cs.slot_date, null AS building_label
         FROM ceremony_slots cs
         JOIN ceremony_stations cst ON cs.station_id = cst.id
         WHERE cs.ceremony_id=$1 AND TO_CHAR(cs.slot_time,'HH24:MI')=$2
         LIMIT 1`;
    const params = buildingId ? [ceremonyId, timeStr, buildingId] : [ceremonyId, timeStr];
    const res = await pool.query(q, params);
    if (!res.rows.length) return null;

    const row = res.rows[0];
    const dateStr = typeof row.slot_date === 'string' ? row.slot_date : row.slot_date.toISOString().substring(0, 10);
    const start = new Date(`${dateStr}T${timeStr}:00`);
    const end = new Date(start.getTime() + DURATION_MS);
    const desc = row.building_label
      ? `\u05d1\u05e0\u05d9\u05d9\u05df: ${row.building_label} | QUANTUM Real Estate`
      : 'QUANTUM Real Estate';
    return { title: '\u05db\u05e0\u05e1 \u05d7\u05ea\u05d9\u05de\u05d5\u05ea QUANTUM', start, end, description: desc };
  }

  const res = await pool.query(
    `SELECT ms.slot_datetime, ms.representative_name, csc.meeting_type
     FROM meeting_slots ms
     LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = ms.campaign_id
     WHERE ms.id = $1`,
    [slotId]
  );
  if (!res.rows.length) return null;

  const row = res.rows[0];
  const start = new Date(row.slot_datetime);
  const end = new Date(start.getTime() + DURATION_MS);
  const title = meetingTitle(row.meeting_type);
  const desc = row.representative_name
    ? `\u05e0\u05e6\u05d9\u05d2: ${row.representative_name} | QUANTUM Real Estate`
    : 'QUANTUM Real Estate';
  return { title, start, end, description: desc };
}

function decodeSlotId(param) {
  try {
    return Buffer.from(param, 'base64url').toString('utf8');
  } catch {
    return param;
  }
}

// Google Calendar
router.get('/g/:slotId', async (req, res) => {
  try {
    const slotId = decodeSlotId(req.params.slotId);
    const data = await getSlotData(slotId);
    if (!data) return res.status(404).send('Not found');
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE` +
      `&text=${encodeURIComponent(data.title)}` +
      `&dates=${fmtDt(data.start)}/${fmtDt(data.end)}` +
      `&details=${encodeURIComponent(data.description)}&sf=true`;
    res.redirect(url);
  } catch (err) {
    logger.error('[CalRoute] Google error:', err.message);
    res.status(500).send('Error');
  }
});

// Outlook Calendar
router.get('/o/:slotId', async (req, res) => {
  try {
    const slotId = decodeSlotId(req.params.slotId);
    const data = await getSlotData(slotId);
    if (!data) return res.status(404).send('Not found');
    const url = `https://outlook.live.com/calendar/0/deeplink/compose` +
      `?subject=${encodeURIComponent(data.title)}` +
      `&startdt=${new Date(data.start).toISOString()}` +
      `&enddt=${new Date(data.end).toISOString()}` +
      `&body=${encodeURIComponent(data.description)}` +
      `&path=%2Fcalendar%2Faction%2Fcompose&rru=addevent`;
    res.redirect(url);
  } catch (err) {
    logger.error('[CalRoute] Outlook error:', err.message);
    res.status(500).send('Error');
  }
});

// iOS / Apple Calendar (.ics)
router.get('/i/:slotId', async (req, res) => {
  try {
    const slotId = decodeSlotId(req.params.slotId);
    const data = await getSlotData(slotId);
    if (!data) return res.status(404).send('Not found');
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//QUANTUM//Calendar//HE',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${Date.now()}@quantum-real-estate`,
      `DTSTAMP:${fmtDt(new Date())}`,
      `DTSTART:${fmtDt(data.start)}`,
      `DTEND:${fmtDt(data.end)}`,
      `SUMMARY:${data.title}`,
      `DESCRIPTION:${data.description.replace(/\n/g, '\\n')}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="quantum-meeting.ics"');
    res.send(ics);
  } catch (err) {
    logger.error('[CalRoute] iOS error:', err.message);
    res.status(500).send('Error');
  }
});

module.exports = router;
