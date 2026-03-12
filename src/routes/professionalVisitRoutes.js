/**
 * QUANTUM Professional Visits Routes v1.2
 *
 * POST /api/scheduling/pre-register
 *   Called by Zoho Workflow when WA is sent to a contact.
 *   v1.1: Auto-fetches buildings from Zoho relatedlist5.
 *   v1.2: Generates booking token + schedules no-reply follow-up reminders.
 *         Returns booking_url so Zoho can embed it in the WA template.
 *
 * POST /api/scheduling/visits
 *   Admin creates a professional visit (appraiser/surveyor).
 *
 * GET  /api/scheduling/visits?campaign_id=xxx
 *   List visits for a campaign.
 *
 * GET  /api/scheduling/visits/:id/report
 *   Export booked slots for a visit.
 *
 * GET  /api/scheduling/campaigns/:campaignId/buildings
 *   Returns buildings linked to a Zoho campaign (via relatedlist5).
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { logger } = require('../services/logger');
const axios   = require('axios');
const crypto  = require('crypto');

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── Lazy migration: vapi_call_after_hours column ────────────
pool.query(
  `ALTER TABLE campaign_schedule_config
   ADD COLUMN IF NOT EXISTS vapi_call_after_hours INTEGER DEFAULT 72`
).catch(() => {});

// ── In-memory buildings cache ────────────────────────────────
// Key: campaign_id  Value: { buildings: [...], expiresAt: timestamp }
const buildingsCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedBuildings(campaignId) {
  const entry = buildingsCache.get(campaignId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { buildingsCache.delete(campaignId); return null; }
  return entry.buildings;
}

function setCachedBuildings(campaignId, buildings) {
  buildingsCache.set(campaignId, { buildings, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Parse property_addresses textarea into structured object.
 * Input:  "סמילצ'נסקי 3 דירה 9, ראשון לציון"
 * Output: { street, building, apartment, city, normalized }
 */
function parsePropertyAddress(raw) {
  if (!raw || !raw.trim()) return null;
  const line = raw.split('\n')[0].trim();
  const aptMatch = line.match(/דירה\s+(\d+)/i);
  const apartment = aptMatch ? aptMatch[1] : null;
  const commaIdx = line.indexOf(',');
  const city = commaIdx > -1 ? line.substring(commaIdx + 1).trim() : null;
  const beforeComma = commaIdx > -1 ? line.substring(0, commaIdx) : line;
  const stripped = beforeComma.replace(/דירה\s+\d+/i, '').trim();
  const tokens = stripped.split(/\s+/).filter(Boolean);
  let building = null;
  let streetTokens = tokens;
  if (tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])) {
    building = tokens[tokens.length - 1];
    streetTokens = tokens.slice(0, -1);
  }
  const street = streetTokens.join(' ');
  const normalized = building ? `${street} ${building}`.trim() : street;
  return { street, building, apartment, city, normalized };
}

// ── Zoho helpers ─────────────────────────────────────────────

async function getZohoAccessToken() {
  const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    },
    timeout: 10000
  });
  if (!response.data?.access_token) throw new Error('Failed to get Zoho access token');
  return response.data.access_token;
}

async function fetchCampaignBuildings(campaignId) {
  const cached = getCachedBuildings(campaignId);
  if (cached) {
    logger.debug('[buildings-cache] hit', { campaignId, count: cached.length });
    return cached;
  }
  try {
    const token = await getZohoAccessToken();
    const response = await axios.get(
      `https://www.zohoapis.com/crm/v7/Campaigns/${campaignId}/relatedlist5`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: 10000 }
    );
    const buildings = (response.data?.data || []).map(b =>
      b.Building_Address || b.address || b.Name || b.name || ''
    ).filter(Boolean);
    setCachedBuildings(campaignId, buildings);
    logger.info('[buildings-cache] fetched from Zoho', { campaignId, count: buildings.length });
    return buildings;
  } catch (err) {
    logger.warn('[buildings-cache] Zoho fetch failed', { campaignId, error: err.message });
    return [];
  }
}

// ── POST /pre-register ────────────────────────────────────────
/**
 * Called by Zoho Workflow when WA is dispatched to a contact.
 *
 * Minimum payload:
 * {
 *   phone, campaign_id, zoho_contact_id, contact_name,
 *   property_addresses, campaign_end_date, campaign_status, language
 * }
 *
 * Returns:
 * {
 *   success, building_address, apartment_number, campaign_buildings,
 *   booking_url,   ← embed this in the Zoho WA template
 *   booking_token
 * }
 */
router.post('/pre-register', async (req, res) => {
  try {
    const {
      phone,
      campaign_id,
      zoho_contact_id,
      contact_name       = '',
      property_addresses = null,
      campaign_buildings,
      campaign_end_date  = null,
      campaign_status    = 'Active',
      language           = 'he'
    } = req.body;

    if (!phone || !campaign_id) {
      return res.status(400).json({ error: 'phone and campaign_id are required' });
    }

    // ── Resolve buildings ────────────────────────────────────
    let resolvedBuildings = [];
    const buildingSource = { source: 'none', count: 0 };

    if (Array.isArray(campaign_buildings) && campaign_buildings.length > 0) {
      resolvedBuildings = campaign_buildings;
      buildingSource.source = 'body';
    } else {
      resolvedBuildings = await fetchCampaignBuildings(campaign_id);
      buildingSource.source = resolvedBuildings.length > 0 ? 'zoho' : 'none';
    }
    buildingSource.count = resolvedBuildings.length;

    // ── Parse address ────────────────────────────────────────
    const parsed = parsePropertyAddress(property_addresses);
    const buildingAddress = parsed ? parsed.normalized : null;
    const apartmentNumber = parsed ? parsed.apartment : null;

    // ── Upsert bot_session ───────────────────────────────────
    await pool.query(`
      INSERT INTO bot_sessions
        (phone, zoho_campaign_id, zoho_contact_id, language, state, context,
         building_address, apartment_number, campaign_buildings,
         campaign_end_date, campaign_status,
         contact_address, contact_street, contact_building_no)
      VALUES ($1,$2,$3,$4,'waiting',$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (phone, zoho_campaign_id)
      DO UPDATE SET
        zoho_contact_id     = EXCLUDED.zoho_contact_id,
        language            = EXCLUDED.language,
        building_address    = EXCLUDED.building_address,
        apartment_number    = EXCLUDED.apartment_number,
        campaign_buildings  = EXCLUDED.campaign_buildings,
        campaign_end_date   = EXCLUDED.campaign_end_date,
        campaign_status     = EXCLUDED.campaign_status,
        contact_address     = EXCLUDED.contact_address,
        contact_street      = EXCLUDED.contact_street,
        contact_building_no = EXCLUDED.contact_building_no,
        last_message_at     = NOW()
    `, [
      phone, campaign_id, zoho_contact_id, language,
      JSON.stringify({ contactName: contact_name }),
      buildingAddress, apartmentNumber,
      JSON.stringify(resolvedBuildings),
      campaign_end_date, campaign_status,
      property_addresses,
      parsed?.street || null,
      parsed?.building || null
    ]);

    // ── Generate / ensure booking token ─────────────────────
    const candidateToken = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `UPDATE bot_sessions
       SET booking_token = COALESCE(booking_token, $1)
       WHERE phone = $2 AND zoho_campaign_id = $3`,
      [candidateToken, phone, campaign_id]
    );
    const tokenRow = await pool.query(
      `SELECT booking_token FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id=$2`,
      [phone, campaign_id]
    );
    const bookingToken = tokenRow.rows[0]?.booking_token || null;
    const bookingUrl   = bookingToken ? `${BASE_URL}/booking/${bookingToken}` : null;

    // ── Fetch campaign config for reminder timing ────────────
    let config = {};
    try {
      const cfgRes = await pool.query(
        `SELECT reminder_delay_hours, bot_followup_delay_hours,
                vapi_call_after_hours, meeting_type
         FROM campaign_schedule_config WHERE zoho_campaign_id=$1`,
        [campaign_id]
      );
      config = cfgRes.rows[0] || {};
    } catch (_) {
      try {
        const cfgRes = await pool.query(
          `SELECT reminder_delay_hours, bot_followup_delay_hours, meeting_type
           FROM campaign_schedule_config WHERE zoho_campaign_id=$1`,
          [campaign_id]
        );
        config = cfgRes.rows[0] || {};
      } catch (__) { /* use defaults */ }
    }

    const r1Hours   = config.reminder_delay_hours    || 24;
    const r2Hours   = config.bot_followup_delay_hours || 48;
    const callHours = config.vapi_call_after_hours    || 72;

    // ── Delete stale pending no-reply reminders ──────────────
    // (handles re-registration of same contact)
    await pool.query(
      `DELETE FROM reminder_queue
       WHERE phone=$1 AND zoho_campaign_id=$2
         AND reminder_type IN ('no_reply_reminder_1','no_reply_reminder_2','no_reply_vapi_call')
         AND status='pending'`,
      [phone, campaign_id]
    ).catch(() => {});

    // ── Schedule follow-up reminders ─────────────────────────
    const now = new Date();
    const rPayload = JSON.stringify({
      contactName:     contact_name,
      language,
      meetingType:     config.meeting_type || '',
      campaignName:    campaign_id,
      bookingUrl,
      buildingAddress: buildingAddress || null,
    });

    for (const [type, hours] of [
      ['no_reply_reminder_1', r1Hours],
      ['no_reply_reminder_2', r2Hours],
      ['no_reply_vapi_call',  callHours],
    ]) {
      await pool.query(
        `INSERT INTO reminder_queue
           (phone, zoho_contact_id, zoho_campaign_id, reminder_type, scheduled_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [phone, zoho_contact_id || null, campaign_id, type,
         new Date(now.getTime() + hours * 3_600_000), rPayload]
      ).catch(e => logger.warn('[pre-register] reminder insert failed', { type, error: e.message }));
    }

    logger.info('[pre-register] session ready', {
      phone, campaign_id,
      buildingAddress, apartmentNumber,
      hasAddress: !!buildingAddress,
      buildings: buildingSource,
      remindersAt: { r1: `+${r1Hours}h`, r2: `+${r2Hours}h`, call: `+${callHours}h` }
    });

    res.json({
      success: true,
      building_address:        buildingAddress,
      apartment_number:        apartmentNumber,
      campaign_buildings:      resolvedBuildings,
      buildings_source:        buildingSource.source,
      needs_building_selection: !buildingAddress && resolvedBuildings.length > 0,
      booking_url:   bookingUrl,    // ← embed in Zoho WA template: {{booking_url}}
      booking_token: bookingToken,  // ← for reference
    });

  } catch (err) {
    logger.error('[pre-register] error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /visits — Create professional visit ──────────────────

router.post('/visits', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      campaign_id, project_id, visit_type,
      building_address, city,
      visit_date, start_time, end_time,
      slot_duration_minutes = 30,
      buffer_minutes = 5,
      professionals = []
    } = req.body;

    if (!campaign_id || !visit_type || !building_address || !visit_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['appraiser', 'surveyor'].includes(visit_type)) {
      return res.status(400).json({ error: 'visit_type must be appraiser or surveyor' });
    }
    if (professionals.length === 0 || professionals.length > 3) {
      return res.status(400).json({ error: '1 to 3 professionals required' });
    }

    await client.query('BEGIN');

    const visitRes = await client.query(`
      INSERT INTO professional_visits
        (campaign_id, project_id, visit_type, building_address, city,
         visit_date, start_time, end_time, slot_duration_minutes, buffer_minutes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
      RETURNING id
    `, [campaign_id, project_id || null, visit_type, building_address, city,
        visit_date, start_time, end_time, slot_duration_minutes, buffer_minutes]);

    const visitId = visitRes.rows[0].id;
    const stepMinutes = slot_duration_minutes + buffer_minutes;
    const slotsSummary = [];

    for (let i = 0; i < professionals.length; i++) {
      const prof = professionals[i];

      const profRes = await client.query(`
        INSERT INTO visit_professionals
          (visit_id, professional_name, professional_phone, zoho_calendar_id, display_order)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id
      `, [visitId, prof.name, prof.phone || null, prof.zoho_calendar_id || null, i]);

      const profId = profRes.rows[0].id;
      const slots = generateTimeSlots(visit_date, start_time, end_time, stepMinutes, slot_duration_minutes);

      for (const slot of slots) {
        await client.query(`
          INSERT INTO meeting_slots
            (campaign_id, project_id, meeting_type, slot_datetime, duration_minutes,
             representative_name, status, visit_professional_id)
          VALUES ($1,$2,$3,$4,$5,$6,'open',$7)
        `, [campaign_id, project_id || null, visit_type,
            slot.datetime, slot_duration_minutes, prof.name, profId]);
      }

      slotsSummary.push({
        professional: prof.name,
        slots_created: slots.length,
        first_slot: slots[0]?.time,
        last_slot: slots[slots.length - 1]?.time
      });
    }

    await client.query('COMMIT');

    const totalSlots = slotsSummary.reduce((sum, p) => sum + p.slots_created, 0);
    logger.info('[visits] created', { visitId, campaign_id, building_address, visit_date, totalSlots });

    res.json({ success: true, visit_id: visitId, building_address, visit_date, professionals: slotsSummary, total_slots: totalSlots });

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[visits] create error', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /visits ───────────────────────────────────────────────

router.get('/visits', async (req, res) => {
  try {
    const { campaign_id, project_id } = req.query;
    const conditions = [];
    const params = [];

    if (campaign_id) { conditions.push(`v.campaign_id = $${params.length + 1}`); params.push(campaign_id); }
    if (project_id)  { conditions.push(`v.project_id = $${params.length + 1}`); params.push(project_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const visits = await pool.query(`
      SELECT v.*,
        json_agg(json_build_object(
          'id', vp.id,
          'name', vp.professional_name,
          'phone', vp.professional_phone,
          'slots_open', (
            SELECT COUNT(*) FROM meeting_slots ms
            WHERE ms.visit_professional_id = vp.id AND ms.status = 'open'
          ),
          'slots_booked', (
            SELECT COUNT(*) FROM meeting_slots ms
            WHERE ms.visit_professional_id = vp.id AND ms.status = 'confirmed'
          )
        ) ORDER BY vp.display_order) AS professionals
      FROM professional_visits v
      LEFT JOIN visit_professionals vp ON vp.visit_id = v.id
      ${where}
      GROUP BY v.id
      ORDER BY v.visit_date DESC, v.created_at DESC
    `, params);

    res.json({ visits: visits.rows });
  } catch (err) {
    logger.error('[visits] list error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /visits/:id/report ────────────────────────────────────

router.get('/visits/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const visit = await pool.query(`SELECT * FROM professional_visits WHERE id = $1`, [id]);
    if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });

    const slots = await pool.query(`
      SELECT ms.slot_datetime,
        TO_CHAR(ms.slot_datetime, 'HH24:MI') AS time_str,
        ms.status, ms.contact_name, ms.contact_phone,
        ms.apartment_number, ms.contact_address,
        vp.professional_name, ms.zoho_contact_id
      FROM meeting_slots ms
      JOIN visit_professionals vp ON ms.visit_professional_id = vp.id
      WHERE vp.visit_id = $1
      ORDER BY vp.display_order, ms.slot_datetime
    `, [id]);

    const grouped = {};
    for (const s of slots.rows) {
      const key = s.professional_name;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    }

    res.json({
      visit: visit.rows[0],
      report: grouped,
      summary: {
        total:  slots.rows.length,
        booked: slots.rows.filter(s => s.status === 'confirmed').length,
        open:   slots.rows.filter(s => s.status === 'open').length
      }
    });
  } catch (err) {
    logger.error('[visits] report error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /campaigns/:campaignId/buildings ──────────────────────

router.get('/campaigns/:campaignId/buildings', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { bust_cache } = req.query;
    if (bust_cache) buildingsCache.delete(campaignId);
    const buildings = await fetchCampaignBuildings(campaignId);
    res.json({
      buildings: buildings.map(addr => ({ address: addr, name: addr })),
      count: buildings.length,
      source: getCachedBuildings(campaignId) ? 'cache' : 'zoho'
    });
  } catch (err) {
    logger.error('[campaigns/buildings] error', { error: err.message });
    res.status(500).json({ error: err.message, buildings: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────

function generateTimeSlots(visitDate, startTime, endTime, stepMinutes, durationMinutes) {
  const slots = [];
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM]     = endTime.split(':').map(Number);
  let current  = startH * 60 + startM;
  const endTotal = endH * 60 + endM;
  while (current + durationMinutes <= endTotal) {
    const h = String(Math.floor(current / 60)).padStart(2, '0');
    const m = String(current % 60).padStart(2, '0');
    slots.push({ time: `${h}:${m}`, datetime: `${visitDate}T${h}:${m}:00` });
    current += stepMinutes;
  }
  return slots;
}

module.exports = router;
