/**
 * QUANTUM Event Scheduler Routes — v1.0
 *
 * Admin API:
 *   GET  /api/events                    — list events
 *   POST /api/events                    — create event
 *   GET  /api/events/:id                — event details
 *   POST /api/events/:id/stations       — add station (pro)
 *   POST /api/events/:id/slots          — generate slots for a station
 *   POST /api/events/:id/import-zoho   — import residents from Zoho
 *   POST /api/events/:id/assign         — auto-assign attendees to slots
 *   POST /api/events/:id/notify         — send WA + email to all
 *   GET  /api/events/:id/report         — full report JSON
 *   GET  /api/events/:id/compounds      — Zoho compounds list
 *   GET  /api/events/zoho/compounds     — list compounds from Zoho
 *
 * Professional HTML (token-protected):
 *   GET  /pro/:token                    — professional's attendance page
 *   POST /pro/:token/attendee/:aid      — update attendee status (arrived/no_show/notes)
 *   GET  /pro/:token/pdf                — printable PDF list
 *
 * Attendee HTML (token-protected):
 *   GET  /attend/:token                 — attendee confirmation page
 *   POST /attend/:token/confirm         — confirm/cancel/reschedule
 */

const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const { logger } = require('../services/logger');

let zohoSvc;
try { zohoSvc = require('../services/zohoResidentsService'); } catch (e) {}

// ── helpers ─────────────────────────────────────────────────────────────────

function ok(res, data)    { res.json({ success: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ success: false, error: msg }); }

async function sendWA(phone, message) {
  const axios = require('axios');
  const { INFORU_USERNAME, INFORU_PASSWORD, INFORU_WA_TOKEN } = process.env;
  if (!INFORU_USERNAME) return { sent: false, reason: 'no credentials' };
  try {
    const auth = Buffer.from(`${INFORU_USERNAME}:${INFORU_PASSWORD}`).toString('base64');
    const payload = INFORU_WA_TOKEN
      ? { Data: { Message: message, Phone: phone.replace(/\D/g,''), Settings: { CustomerMessageId: `ev_${Date.now()}` } } }
      : { Data: { Message: message, Phone: phone.replace(/\D/g,'') } };
    await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat',
      payload, { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// ── Zoho compounds list ──────────────────────────────────────────────────────

router.get('/zoho/compounds', async (req, res) => {
  try {
    if (!zohoSvc) return err(res, 'Zoho service not available');
    const compounds = await zohoSvc.getCompounds();
    ok(res, { compounds });
  } catch (e) { err(res, e.message); }
});

router.get('/zoho/buildings/:compoundId', async (req, res) => {
  try {
    if (!zohoSvc) return err(res, 'Zoho service not available');
    const buildings = await zohoSvc.getBuildingsByCompound(req.params.compoundId);
    ok(res, { buildings });
  } catch (e) { err(res, e.message); }
});

// ── Events CRUD ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        COUNT(DISTINCT s.id)::int AS station_count,
        COUNT(DISTINCT a.id)::int AS attendee_count,
        COUNT(DISTINCT CASE WHEN a.status='confirmed' THEN a.id END)::int AS confirmed_count,
        COUNT(DISTINCT CASE WHEN a.status='cancelled' THEN a.id END)::int AS cancelled_count
      FROM quantum_events e
      LEFT JOIN event_stations s ON s.event_id = e.id
      LEFT JOIN event_attendees a ON a.station_id = s.id
      GROUP BY e.id
      ORDER BY e.event_date DESC
    `);
    ok(res, { events: rows });
  } catch (e) { err(res, e.message); }
});

router.post('/', async (req, res) => {
  try {
    const { title, event_type = 'signing', event_date, location, zoho_compound_id, compound_name, notes } = req.body;
    if (!title || !event_date) return err(res, 'title and event_date required', 400);
    const { rows } = await pool.query(
      `INSERT INTO quantum_events (title, event_type, event_date, location, zoho_compound_id, compound_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, event_type, event_date, location, zoho_compound_id, compound_name, notes]
    );
    ok(res, { event: rows[0] });
  } catch (e) { err(res, e.message); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quantum_events WHERE id=$1', [req.params.id]);
    if (!rows.length) return err(res, 'Event not found', 404);
    const event = rows[0];

    const { rows: stations } = await pool.query(
      'SELECT * FROM event_stations WHERE event_id=$1 ORDER BY station_number', [event.id]);

    for (const st of stations) {
      const { rows: slots } = await pool.query(
        'SELECT * FROM event_slots WHERE station_id=$1 ORDER BY start_time', [st.id]);
      const { rows: attendees } = await pool.query(
        `SELECT a.*, s.start_time, s.end_time FROM event_attendees a
         LEFT JOIN event_slots s ON s.id = a.slot_id
         WHERE a.station_id=$1 ORDER BY s.start_time NULLS LAST, a.name`, [st.id]);
      st.slots = slots;
      st.attendees = attendees;
    }
    event.stations = stations;
    ok(res, { event });
  } catch (e) { err(res, e.message); }
});

// ── Stations ─────────────────────────────────────────────────────────────────

router.post('/:id/stations', async (req, res) => {
  try {
    const { pro_name, pro_role = 'lawyer', pro_phone, pro_email, station_number, notes } = req.body;
    if (!pro_name) return err(res, 'pro_name required', 400);
    const { rows } = await pool.query(
      `INSERT INTO event_stations (event_id, pro_name, pro_role, pro_phone, pro_email, station_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, pro_name, pro_role, pro_phone, pro_email, station_number, notes]
    );
    ok(res, { station: rows[0] });
  } catch (e) { err(res, e.message); }
});

// ── Slots: auto-generate for a station ───────────────────────────────────────

router.post('/:id/stations/:sid/slots', async (req, res) => {
  try {
    const { start_time, end_time, slot_duration_minutes = 15 } = req.body;
    if (!start_time || !end_time) return err(res, 'start_time and end_time required', 400);

    let current = new Date(start_time);
    const end   = new Date(end_time);
    const dur   = parseInt(slot_duration_minutes);
    const created = [];

    while (current < end) {
      const slotEnd = new Date(current.getTime() + dur * 60000);
      if (slotEnd > end) break;
      const { rows } = await pool.query(
        'INSERT INTO event_slots (station_id, start_time, end_time) VALUES ($1,$2,$3) RETURNING *',
        [req.params.sid, current.toISOString(), slotEnd.toISOString()]
      );
      created.push(rows[0]);
      current = slotEnd;
    }
    ok(res, { slots: created, count: created.length });
  } catch (e) { err(res, e.message); }
});

// ── Import residents from Zoho ────────────────────────────────────────────────

router.post('/:id/import-zoho', async (req, res) => {
  try {
    if (!zohoSvc) return err(res, 'Zoho service not available');
    const { building_ids, compound_id, compound_name, station_id } = req.body;
    if (!station_id) return err(res, 'station_id required', 400);

    let residents;
    if (compound_id) {
      residents = await zohoSvc.getResidentsForCompound(compound_id, compound_name || '');
    } else if (building_ids && building_ids.length) {
      residents = await zohoSvc.getResidentsForEvent(building_ids, compound_name || '');
    } else {
      return err(res, 'compound_id or building_ids required', 400);
    }

    let inserted = 0;
    for (const r of residents) {
      const existing = await pool.query(
        'SELECT id FROM event_attendees WHERE station_id=$1 AND zoho_contact_id=$2',
        [station_id, r.zoho_contact_id]
      );
      if (existing.rows.length) continue;
      await pool.query(
        `INSERT INTO event_attendees
           (station_id, zoho_contact_id, zoho_asset_id, name, phone, unit_number, floor, building_name, compound_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [station_id, r.zoho_contact_id, r.zoho_asset_id, r.name, r.phone,
         r.unit_number, r.floor, r.building_name, r.compound_name]
      );
      inserted++;
    }
    ok(res, { imported: residents.length, inserted, duplicates: residents.length - inserted });
  } catch (e) { err(res, e.message); }
});

// ── Auto-assign attendees to slots (round-robin) ──────────────────────────────

router.post('/:id/stations/:sid/assign', async (req, res) => {
  try {
    const { rows: slots } = await pool.query(
      "SELECT * FROM event_slots WHERE station_id=$1 AND status='free' ORDER BY start_time",
      [req.params.sid]
    );
    const { rows: attendees } = await pool.query(
      "SELECT * FROM event_attendees WHERE station_id=$1 AND slot_id IS NULL ORDER BY building_name, unit_number",
      [req.params.sid]
    );

    let assigned = 0;
    for (let i = 0; i < Math.min(slots.length, attendees.length); i++) {
      await pool.query(
        "UPDATE event_attendees SET slot_id=$1 WHERE id=$2",
        [slots[i].id, attendees[i].id]
      );
      await pool.query(
        "UPDATE event_slots SET status='booked' WHERE id=$1",
        [slots[i].id]
      );
      assigned++;
    }
    ok(res, { assigned, unassigned: attendees.length - assigned });
  } catch (e) { err(res, e.message); }
});

// ── Send notifications ────────────────────────────────────────────────────────

router.post('/:id/notify', async (req, res) => {
  try {
    const { target = 'attendees', base_url } = req.body; // target: attendees | pros | all
    const base = base_url || `https://pinuy-binuy-analyzer-production.up.railway.app`;

    const { rows: event } = await pool.query('SELECT * FROM quantum_events WHERE id=$1', [req.params.id]);
    if (!event.length) return err(res, 'Event not found', 404);
    const ev = event[0];

    let waSent = 0, waFailed = 0;

    if (target === 'attendees' || target === 'all') {
      const { rows: attendees } = await pool.query(`
        SELECT a.*, s.start_time, s.end_time, st.pro_name
        FROM event_attendees a
        LEFT JOIN event_slots s ON s.id = a.slot_id
        LEFT JOIN event_stations st ON st.id = a.station_id
        WHERE st.event_id = $1 AND a.status = 'pending' AND a.wa_sent_at IS NULL AND a.phone IS NOT NULL
      `, [req.params.id]);

      for (const a of attendees) {
        const link = `${base}/attend/${a.token}`;
        const timeStr = a.start_time ? `בשעה ${fmtDate(a.start_time).split(' ')[1]}` : 'בשעה שתיקבע בקרוב';
        const msg = `שלום ${a.name} 👋\n\n` +
          `נקבעה לך פגישה ב*${ev.title}*\n` +
          `📅 ${fmtDate(ev.event_date).split(' ')[0]} ${timeStr}\n` +
          `📍 ${ev.location || ''}\n` +
          (a.unit_number ? `🏠 דירה ${a.unit_number}${a.floor ? `, קומה ${a.floor}` : ''}\n` : '') +
          `\nאנא אשר/י הגעה:\n${link}`;

        const result = await sendWA(a.phone, msg);
        if (result.sent) {
          await pool.query("UPDATE event_attendees SET wa_sent_at=NOW(), status='pending' WHERE id=$1", [a.id]);
          waSent++;
        } else {
          waFailed++;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (target === 'pros' || target === 'all') {
      const { rows: stations } = await pool.query(
        'SELECT * FROM event_stations WHERE event_id=$1 AND pro_phone IS NOT NULL', [req.params.id]);
      for (const st of stations) {
        const link = `${base}/pro/${st.token}`;
        const msg = `שלום ${st.pro_name} 👋\n\n` +
          `קישור לרשימת הנוכחות שלך לאירוע:\n*${ev.title}*\n` +
          `📅 ${fmtDate(ev.event_date)}\n\n` +
          `לרשימה וסימון נוכחות:\n${link}`;
        const result = await sendWA(st.pro_phone, msg);
        if (result.sent) waSent++;
        else waFailed++;
        await new Promise(r => setTimeout(r, 300));
      }
    }

    ok(res, { wa_sent: waSent, wa_failed: waFailed });
  } catch (e) { err(res, e.message); }
});

// ── Report JSON ───────────────────────────────────────────────────────────────

router.get('/:id/report', async (req, res) => {
  try {
    const { rows: event } = await pool.query('SELECT * FROM quantum_events WHERE id=$1', [req.params.id]);
    if (!event.length) return err(res, 'Event not found', 404);
    const ev = event[0];

    const { rows: stations } = await pool.query(
      'SELECT * FROM event_stations WHERE event_id=$1 ORDER BY station_number', [ev.id]);

    for (const st of stations) {
      const { rows } = await pool.query(`
        SELECT a.*, s.start_time, s.end_time
        FROM event_attendees a
        LEFT JOIN event_slots s ON s.id = a.slot_id
        WHERE a.station_id = $1
        ORDER BY s.start_time NULLS LAST, a.building_name, a.unit_number
      `, [st.id]);
      st.attendees = rows;
      st.total       = rows.length;
      st.confirmed   = rows.filter(r => r.status === 'confirmed').length;
      st.arrived     = rows.filter(r => r.status === 'arrived').length;
      st.no_show     = rows.filter(r => r.status === 'no_show').length;
      st.cancelled   = rows.filter(r => r.status === 'cancelled').length;
    }

    ev.stations = stations;
    ok(res, { report: ev });
  } catch (e) { err(res, e.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFESSIONAL HTML PAGE  /pro/:token
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/pro/:token', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.*, e.title, e.event_date, e.location, e.compound_name FROM event_stations s JOIN quantum_events e ON e.id=s.event_id WHERE s.token=$1',
      [req.params.token]
    );
    if (!st.length) return res.status(404).send('<h2>קישור לא תקין</h2>');
    const station = st[0];

    const { rows: attendees } = await pool.query(`
      SELECT a.*, sl.start_time, sl.end_time
      FROM event_attendees a
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.station_id = $1
      ORDER BY sl.start_time NULLS LAST, a.building_name, a.unit_number
    `, [station.id]);

    const roleLabel = { lawyer: 'עורך דין', surveyor: 'מודד', appraiser: 'שמאי', other: 'מקצוען' }[station.pro_role] || station.pro_role;
    const stats = {
      total: attendees.length,
      confirmed: attendees.filter(a => a.status === 'confirmed').length,
      cancelled: attendees.filter(a => a.status === 'cancelled').length,
      arrived:   attendees.filter(a => a.status === 'arrived').length,
      no_show:   attendees.filter(a => a.status === 'no_show').length,
    };

    const rows = attendees.map(a => {
      const time = a.start_time ? fmtDate(a.start_time).split(' ')[1] : '-';
      const statusColors = { confirmed:'#1b5e20', cancelled:'#3c1414', arrived:'#0d47a1', no_show:'#4a1942', pending:'#1a3a5c', rescheduled:'#3e2723' };
      const statusLabels = { confirmed:'אישר', cancelled:'ביטל', arrived:'הגיע', no_show:'לא הגיע', pending:'ממתין', rescheduled:'תיאם מחדש' };
      return `<tr data-id="${a.id}">
        <td style="text-align:center;font-size:13px;color:#90a4ae">${time}</td>
        <td><strong>${esc(a.name)}</strong>${a.unit_number?`<br><span style="font-size:11px;color:#78909c">דירה ${esc(a.unit_number)}${a.floor?', קומה '+esc(a.floor):''}</span>`:''}</td>
        <td style="font-size:12px;color:#b0bec5">${esc(a.building_name||'-')}</td>
        <td style="direction:ltr;font-size:12px">${esc(a.phone||'-')}</td>
        <td>
          <span class="badge" style="background:${statusColors[a.status]||'#263238'}">${statusLabels[a.status]||a.status}</span>
        </td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="act-btn" style="background:#0d47a1" onclick="setStatus(${a.id},'arrived',this)">✅ הגיע</button>
            <button class="act-btn" style="background:#3c1414" onclick="setStatus(${a.id},'no_show',this)">❌ לא הגיע</button>
            <button class="act-btn" style="background:#263238" onclick="openNotes(${a.id},'${esc(a.name)}')">📝</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | ${esc(station.pro_name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;direction:rtl}
.topbar{background:linear-gradient(135deg,#0d1117,#161b27);border-bottom:1px solid #1e3a5f;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#4fc3f7;font-size:18px;font-weight:700}
.event-header{padding:16px 20px;background:#0d1a2a;border-bottom:1px solid #1e3a5f}
.event-title{font-size:16px;font-weight:700;color:#fff}
.event-meta{font-size:12px;color:#78909c;margin-top:4px}
.stats-bar{display:flex;gap:10px;padding:12px 20px;background:#0a0f1a;border-bottom:1px solid #1e3a5f;flex-wrap:wrap}
.stat{background:#0d1117;border:1px solid #1e3a5f;border-radius:6px;padding:8px 14px;text-align:center;min-width:70px}
.stat .n{font-size:20px;font-weight:700;color:#4fc3f7}
.stat .l{font-size:10px;color:#78909c}
.container{padding:16px;max-width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:650px}
th{background:#0d1a2a;color:#90a4ae;padding:10px 12px;text-align:right;border-bottom:1px solid #1e3a5f;font-weight:600;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid #11202f;vertical-align:middle}
tr:hover td{background:#0d2035}
.badge{display:inline-block;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff}
.act-btn{padding:5px 9px;border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap}
.act-btn:hover{opacity:.85}
.pdf-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32;padding:9px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none}
.toast.show{opacity:1}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:998;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#0d1a2a;border:1px solid #1e3a5f;border-radius:10px;padding:20px;width:90%;max-width:380px}
.modal h3{color:#4fc3f7;margin-bottom:12px}
.modal textarea{width:100%;background:#161b27;border:1px solid #2a4a6b;border-radius:6px;padding:9px;color:#e0e0e0;font-size:13px;direction:rtl;resize:vertical;min-height:80px}
.modal-actions{display:flex;gap:8px;margin-top:12px}
.btn{padding:8px 16px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer}
.btn-primary{background:#1565c0;color:#fff}.btn-outline{background:transparent;border:1px solid #2a4a6b;color:#90a4ae}
@media print{.topbar,.stats-bar,.act-btn,.pdf-btn,.toast,.modal-overlay{display:none!important}body{background:#fff;color:#000}table{font-size:11px}th,td{border:1px solid #ccc;padding:6px 8px}tr:hover td{background:none}}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">QUANTUM</div>
  <a href="/events/pro/${req.params.token}/pdf" target="_blank" class="pdf-btn">🖨️ הדפס רשימה</a>
</div>
<div class="event-header">
  <div class="event-title">${esc(station.title)} — ${esc(roleLabel)}: ${esc(station.pro_name)}</div>
  <div class="event-meta">📅 ${fmtDate(station.event_date)} | 📍 ${esc(station.location||'')} | ${esc(station.compound_name||'')}</div>
</div>
<div class="stats-bar">
  <div class="stat"><div class="n">${stats.total}</div><div class="l">סה"כ</div></div>
  <div class="stat"><div class="n" style="color:#a5d6a7">${stats.confirmed}</div><div class="l">אישרו</div></div>
  <div class="stat"><div class="n" style="color:#4db6ac">${stats.arrived}</div><div class="l">הגיעו</div></div>
  <div class="stat"><div class="n" style="color:#ef9a9a">${stats.no_show}</div><div class="l">לא הגיעו</div></div>
  <div class="stat"><div class="n" style="color:#ffab91">${stats.cancelled}</div><div class="l">ביטלו</div></div>
</div>
<div class="container">
  <table id="mainTable">
    <thead><tr><th>שעה</th><th>שם</th><th>בניין</th><th>טלפון</th><th>סטטוס</th><th>פעולות</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<div class="toast" id="toast"></div>
<div class="modal-overlay" id="notesModal">
  <div class="modal">
    <h3>📝 הערות — <span id="notesName"></span></h3>
    <textarea id="notesText" placeholder="הערות..."></textarea>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveNotes()">💾 שמור</button>
      <button class="btn btn-outline" onclick="closeModal()">ביטול</button>
    </div>
  </div>
</div>

<script>
let currentAid = null;
function toast(msg,type){const t=document.getElementById('toast');t.textContent=msg;t.style.background=type==='error'?'#3c1414':'#1b5e20';t.style.borderColor=type==='error'?'#7f1616':'#2e7d32';t.style.color=type==='error'?'#ef9a9a':'#a5d6a7';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}

async function setStatus(aid, status, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/events/pro/${req.params.token}/attendee/'+aid, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({status})
    });
    const d = await r.json();
    if (d.success) { toast('עודכן!'); setTimeout(()=>location.reload(),1000); }
    else toast(d.error||'שגיאה','error');
  } catch(e) { toast('שגיאת רשת','error'); }
  btn.disabled = false;
}

function openNotes(aid, name) {
  currentAid = aid;
  document.getElementById('notesName').textContent = name;
  document.getElementById('notesText').value = '';
  document.getElementById('notesModal').classList.add('open');
}
function closeModal() { document.getElementById('notesModal').classList.remove('open'); }

async function saveNotes() {
  const notes = document.getElementById('notesText').value.trim();
  if (!notes) return closeModal();
  try {
    const r = await fetch('/events/pro/${req.params.token}/attendee/'+currentAid, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({pro_notes: notes})
    });
    const d = await r.json();
    if (d.success) { toast('הערה נשמרה'); closeModal(); }
    else toast(d.error||'שגיאה','error');
  } catch(e) { toast('שגיאה','error'); }
}
</script>
</body></html>`);
  } catch (e) { res.status(500).send('<h2>שגיאה</h2>'); }
});

router.post('/pro/:token/attendee/:aid', async (req, res) => {
  try {
    const { rows: st } = await pool.query('SELECT id FROM event_stations WHERE token=$1', [req.params.token]);
    if (!st.length) return err(res, 'Invalid token', 403);
    const { status, pro_notes } = req.body;
    const updates = [];
    const vals    = [];
    if (status)    { updates.push(`status=$${updates.length+1}`);    vals.push(status); }
    if (pro_notes !== undefined) { updates.push(`pro_notes=$${updates.length+1}`); vals.push(pro_notes); }
    if (!updates.length) return err(res, 'Nothing to update', 400);
    updates.push(`updated_at=NOW()`);
    vals.push(st[0].id, req.params.aid);
    await pool.query(
      `UPDATE event_attendees SET ${updates.join(',')} WHERE station_id=$${vals.length-1} AND id=$${vals.length}`,
      vals
    );
    ok(res, { updated: true });
  } catch (e) { err(res, e.message); }
});

// ── PDF / Print page ──────────────────────────────────────────────────────────

router.get('/pro/:token/pdf', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.*, e.title, e.event_date, e.location FROM event_stations s JOIN quantum_events e ON e.id=s.event_id WHERE s.token=$1',
      [req.params.token]
    );
    if (!st.length) return res.status(404).send('<h2>לא נמצא</h2>');
    const station = st[0];
    const { rows: attendees } = await pool.query(`
      SELECT a.*, sl.start_time FROM event_attendees a
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.station_id=$1 ORDER BY sl.start_time NULLS LAST, a.building_name, a.unit_number
    `, [station.id]);

    const tableRows = attendees.map((a, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${a.start_time ? fmtDate(a.start_time).split(' ')[1] : '-'}</td>
        <td><strong>${esc(a.name)}</strong></td>
        <td>${esc(a.unit_number||'-')}${a.floor?` / קומה ${esc(a.floor)}`:''}</td>
        <td>${esc(a.building_name||'-')}</td>
        <td style="direction:ltr">${esc(a.phone||'-')}</td>
        <td style="text-align:center;font-size:16px">${a.status==='arrived'?'✅':a.status==='no_show'?'❌':''}</td>
        <td style="font-size:11px;color:#555">${esc(a.pro_notes||'')}</td>
      </tr>`).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<title>רשימת נוכחות — ${esc(station.pro_name)}</title>
<style>
body{font-family:Arial,sans-serif;direction:rtl;padding:20px;color:#000;background:#fff;font-size:12px}
h1{font-size:16px;margin-bottom:4px}.meta{font-size:11px;color:#555;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{background:#1a3a5c;color:#fff;padding:7px 10px;text-align:right;font-size:11px}
td{padding:7px 10px;border-bottom:1px solid #ddd}
tr:nth-child(even) td{background:#f5f8fc}
.footer{margin-top:14px;font-size:10px;color:#888;text-align:center}
@media print{@page{size:A4;margin:15mm}}
</style>
</head>
<body>
<h1>QUANTUM | רשימת נוכחות</h1>
<div class="meta">
  <strong>${esc(station.title)}</strong> | ${fmtDate(station.event_date)} | ${esc(station.location||'')}
  <br>${esc(station.pro_role)}: <strong>${esc(station.pro_name)}</strong> | סה"כ: ${attendees.length}
</div>
<table>
  <thead><tr><th>#</th><th>שעה</th><th>שם</th><th>דירה/קומה</th><th>בניין</th><th>טלפון</th><th>הגיע?</th><th>הערות</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>
<div class="footer">הופק על ידי QUANTUM | ${new Date().toLocaleDateString('he-IL')}</div>
<script>window.onload=()=>window.print()</script>
</body></html>`);
  } catch (e) { res.status(500).send('<h2>שגיאה</h2>'); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDEE HTML PAGE  /attend/:token
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/attend/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, sl.start_time, sl.end_time, st.pro_name, st.pro_role, st.station_number,
             e.title, e.event_date, e.location, e.id AS event_id
      FROM event_attendees a
      JOIN event_stations st ON st.id = a.station_id
      JOIN quantum_events e ON e.id = st.event_id
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.token = $1
    `, [req.params.token]);
    if (!rows.length) return res.status(404).send('<h2>קישור לא תקין או פג תוקף</h2>');
    const a = rows[0];

    // Get available slots for rescheduling
    const { rows: freeSlots } = await pool.query(
      "SELECT * FROM event_slots WHERE station_id=$1 AND status='free' ORDER BY start_time",
      [a.station_id]
    );

    const statusMsg = {
      confirmed:   '✅ אישרת הגעה',
      cancelled:   '❌ ביטלת השתתפות',
      rescheduled: '🔄 תיאמת מחדש',
      arrived:     '✅ הגעתך אושרה',
      no_show:     '❓ לא רשום/ה כמגיע/ה',
      pending:     null,
    }[a.status];

    const roleLabel = { lawyer:'עו"ד', surveyor:'מודד', appraiser:'שמאי', other:'נציג' }[a.pro_role] || a.pro_role;
    const slotOptions = freeSlots.map(s =>
      `<option value="${s.id}">${fmtDate(s.start_time).split(' ')[1]}</option>`
    ).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | אישור הגעה</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0a0a0f 0%,#0d1a2a 100%);min-height:100vh;color:#e0e0e0;direction:rtl;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#0d1117;border:1px solid #1e3a5f;border-radius:14px;padding:28px 24px;width:100%;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.logo{color:#4fc3f7;font-size:16px;font-weight:700;margin-bottom:16px;letter-spacing:1px}
.event-title{font-size:18px;font-weight:700;color:#fff;margin-bottom:6px}
.event-meta{font-size:13px;color:#78909c;margin-bottom:20px;line-height:1.6}
.info-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:14px}
.info-row .icon{font-size:18px;line-height:1}
.info-row .text{color:#cdd5de}
.info-row .label{font-size:11px;color:#78909c}
.divider{border:none;border-top:1px solid #1e3a5f;margin:18px 0}
.status-banner{padding:10px 14px;border-radius:8px;font-size:14px;font-weight:600;margin-bottom:16px;text-align:center}
.status-confirmed{background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32}
.status-cancelled{background:#3c1414;color:#ef9a9a;border:1px solid #7f1616}
.status-rescheduled{background:#3e2723;color:#ffccbc;border:1px solid #6d4c41}
.btn-group{display:flex;gap:10px;flex-direction:column}
.btn{width:100%;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s}
.btn-confirm{background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32}
.btn-confirm:hover{background:#2e7d32}
.btn-cancel{background:#3c1414;color:#ef9a9a;border:1px solid #7f1616}
.btn-cancel:hover{background:#7f1616}
.btn-reschedule{background:#1a3a5c;color:#4fc3f7;border:1px solid #2a5a8f}
.btn-reschedule:hover{background:#2a5a8f}
.reschedule-panel{display:none;margin-top:14px;background:#0a0f1a;border:1px solid #2a4a6b;border-radius:8px;padding:14px}
.reschedule-panel label{font-size:12px;color:#90a4ae;display:block;margin-bottom:6px}
.reschedule-panel select{width:100%;background:#161b27;border:1px solid #2a4a6b;border-radius:6px;padding:9px;color:#e0e0e0;font-size:13px}
.reschedule-panel .btn-sm{width:100%;margin-top:10px;padding:9px;background:#1565c0;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32;padding:9px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none;text-align:center;min-width:200px}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="card">
  <div class="logo">QUANTUM</div>
  <div class="event-title">${esc(a.title)}</div>

  <div class="info-row"><div class="icon">📅</div><div><div class="label">תאריך ושעה</div><div class="text">${fmtDate(a.event_date)}${a.start_time?` | שעתך: ${fmtDate(a.start_time).split(' ')[1]}`:''}</div></div></div>
  ${a.location?`<div class="info-row"><div class="icon">📍</div><div><div class="label">מיקום</div><div class="text">${esc(a.location)}</div></div></div>`:''}
  <div class="info-row"><div class="icon">🏠</div><div><div class="label">דירה</div><div class="text">דירה ${esc(a.unit_number||'-')}${a.floor?`, קומה ${esc(a.floor)}`:''} — ${esc(a.building_name||'')}</div></div></div>
  <div class="info-row"><div class="icon">👤</div><div><div class="label">${roleLabel}</div><div class="text">${esc(a.pro_name)} ${a.station_number?'(עמדה '+a.station_number+')':''}</div></div></div>

  <hr class="divider">

  ${statusMsg ? `<div class="status-banner status-${a.status}">${statusMsg}</div>` : ''}

  <div class="btn-group">
    <button class="btn btn-confirm" onclick="respond('confirmed')">✅ מאשר/ת הגעה</button>
    <button class="btn btn-cancel"  onclick="respond('cancelled')">❌ אינני יכול/ה להגיע</button>
    ${freeSlots.length ? `
    <button class="btn btn-reschedule" onclick="document.getElementById('rsPanel').style.display='block'">🔄 בקש/י שעה אחרת</button>
    <div class="reschedule-panel" id="rsPanel">
      <label>בחר/י שעה חלופית:</label>
      <select id="slotSelect">${slotOptions}</select>
      <button class="btn-sm" onclick="reschedule()">אשר תיאום מחדש</button>
    </div>` : ''}
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
function toast(msg,type){const t=document.getElementById('toast');t.textContent=msg;t.style.background=type==='error'?'#3c1414':'#1b5e20';t.style.borderColor=type==='error'?'#7f1616':'#2e7d32';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),4000);}

async function respond(status) {
  try {
    const r = await fetch('/events/attend/${req.params.token}/confirm', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status})
    });
    const d = await r.json();
    if (d.success) { toast(status==='confirmed'?'✅ אושרת הגעה! תודה':'❌ הביטול נרשם'); setTimeout(()=>location.reload(), 2000); }
    else toast(d.error||'שגיאה','error');
  } catch(e) { toast('שגיאת רשת','error'); }
}

async function reschedule() {
  const slotId = document.getElementById('slotSelect').value;
  try {
    const r = await fetch('/events/attend/${req.params.token}/confirm', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:'rescheduled', slot_id: slotId})
    });
    const d = await r.json();
    if (d.success) { toast('🔄 תיאום החדש נרשם!'); setTimeout(()=>location.reload(), 2000); }
    else toast(d.error||'שגיאה','error');
  } catch(e) { toast('שגיאת רשת','error'); }
}
</script>
</body></html>`);
  } catch (e) { res.status(500).send('<h2>שגיאה</h2>'); }
});

router.post('/attend/:token/confirm', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT a.*, st.event_id FROM event_attendees a JOIN event_stations st ON st.id=a.station_id WHERE a.token=$1',
      [req.params.token]
    );
    if (!rows.length) return err(res, 'Invalid token', 404);
    const a = rows[0];
    const { status, slot_id } = req.body;

    if (slot_id) {
      // Release old slot
      if (a.slot_id) {
        await pool.query("UPDATE event_slots SET status='free' WHERE id=$1", [a.slot_id]);
      }
      // Book new slot
      await pool.query("UPDATE event_slots SET status='booked' WHERE id=$1", [slot_id]);
      await pool.query(
        "UPDATE event_attendees SET status='rescheduled', slot_id=$1, responded_at=NOW(), updated_at=NOW() WHERE id=$2",
        [slot_id, a.id]
      );
    } else {
      await pool.query(
        "UPDATE event_attendees SET status=$1, responded_at=NOW(), updated_at=NOW() WHERE id=$2",
        [status, a.id]
      );
      // If cancelled, release slot
      if (status === 'cancelled' && a.slot_id) {
        await pool.query("UPDATE event_slots SET status='free' WHERE id=$1", [a.slot_id]);
      }
    }
    ok(res, { updated: true });
  } catch (e) { err(res, e.message); }
});

// ── HTML escape util ──────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
