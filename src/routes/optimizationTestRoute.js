/**
 * QUANTUM Optimization Test Route
 * POST /api/test/optimization/setup   - seed test data (Zoho + DB)
 * POST /api/test/optimization/reset   - clean up test data
 * GET  /api/test/optimization/state   - show current test state
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');
const { logger } = require('../services/logger');

const CAMPAIGN_ID = 'HEMI-TEST-001';
const TEST_PHONE  = '972525959103'; // Hemi's default number

// ── Zoho OAuth helper ──────────────────────────────────────────
async function getZohoToken() {
  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    }
  });
  if (!res.data.access_token) throw new Error('No access_token in response: ' + JSON.stringify(res.data));
  return res.data.access_token;
}

// ── Search Zoho Contacts by word search ───────────────────────
async function findHemiInZoho(token) {
  // Use word search (simpler than criteria, handles Hebrew better)
  const res = await axios.get('https://www.zohoapis.com/crm/v3/Contacts/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: {
      word: 'מיכאלי',
      fields: 'id,First_Name,Last_Name,Phone,Mobile,Mailing_Street,Mailing_City'
    }
  });
  // Find the one named מיכאלי
  const contacts = res.data?.data || [];
  return contacts.find(c => c.Last_Name === 'מיכאלי') || contacts[0] || null;
}

// ── Update Zoho Contact address if missing ────────────────────
async function ensureZohoAddress(token, contactId, currentStreet) {
  if (currentStreet) return { updated: false, street: currentStreet };
  await axios.put(`https://www.zohoapis.com/crm/v3/Contacts/${contactId}`, {
    data: [{ Mailing_Street: 'הרצל 20', Mailing_City: 'תל אביב' }]
  }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  return { updated: true, street: 'הרצל 20' };
}

// ── Create Zoho Campaign with Hemi only ───────────────────────
async function ensureZohoCampaign(token, contactId) {
  const search = await axios.get('https://www.zohoapis.com/crm/v3/Campaigns/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { word: CAMPAIGN_ID, fields: 'id,Campaign_Name' }
  }).catch(() => ({ data: {} }));

  let campaignZohoId = search.data?.data?.[0]?.id;

  if (!campaignZohoId) {
    const create = await axios.post('https://www.zohoapis.com/crm/v3/Campaigns', {
      data: [{
        Campaign_Name: CAMPAIGN_ID,
        Status: 'Active',
        Start_Date: new Date().toISOString().split('T')[0],
        Type: 'Email'
      }]
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    campaignZohoId = create.data?.data?.[0]?.details?.id;
  }

  if (campaignZohoId && contactId) {
    await axios.post(`https://www.zohoapis.com/crm/v3/Campaigns/${campaignZohoId}/Contacts`, {
      data: [{ id: contactId }]
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } }).catch(() => {});
  }

  return campaignZohoId;
}

// ── Seed meeting_slots for tomorrow ───────────────────────────
async function seedTestSlots(phone, street) {
  // Get any valid project_id from the DB to satisfy the FK constraint
  const projRow = await pool.query('SELECT id FROM projects ORDER BY id LIMIT 1');
  const projectId = projRow.rows[0]?.id || null;

  // Campaign config (project_id can be null if FK allows, else use first available)
  await pool.query(
    `INSERT INTO campaign_schedule_config
       (zoho_campaign_id, project_id, meeting_type, slot_duration_minutes, buffer_minutes, wa_language, updated_at)
     VALUES ($1, $2, 'appraiser', 45, 15, 'he', NOW())
     ON CONFLICT (zoho_campaign_id) DO UPDATE
     SET project_id=$2, meeting_type='appraiser', updated_at=NOW()`,
    [CAMPAIGN_ID, projectId]
  );

  // Tomorrow date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tDate = tomorrow.toISOString().split('T')[0];

  // Israel timezone offset (UTC+2 winter / UTC+3 summer)
  const isDST = new Date().getTimezoneOffset() < -120;
  const utcOffset = isDST ? 3 : 2;
  const dt = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(tDate + 'T00:00:00Z');
    d.setUTCHours(h - utcOffset, m, 0, 0);
    return d.toISOString();
  };

  // Clean previous test data
  await pool.query(`DELETE FROM reschedule_requests WHERE campaign_id=$1`, [CAMPAIGN_ID]);
  await pool.query(`DELETE FROM meeting_slots WHERE campaign_id=$1`, [CAMPAIGN_ID]);

  // ── 09:00 — "אחר 1" (morning cluster)
  await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972501111111','ישראל ישראלי','הרצל')`,
    [CAMPAIGN_ID, dt('09:00')]
  );
  // ── 09:45 — "אחר 2" (morning cluster)
  await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972502222222','שרה כהן','הרצל')`,
    [CAMPAIGN_ID, dt('09:45')]
  );
  // ── 13:30 — HEMI (ISOLATED: gap >150m from 09:45 and >90m from 16:00)
  const hemiSlot = await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street, contact_address)
     VALUES ($1,$2,45,'confirmed',$3,'חמי מיכאלי',$4,$5) RETURNING id`,
    [CAMPAIGN_ID, dt('13:30'), phone, street, `${street}, תל אביב`]
  );
  // ── 16:00 — "אחר 3" (afternoon cluster)
  await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972503333333','דוד לוי','הרצל')`,
    [CAMPAIGN_ID, dt('16:00')]
  );
  // ── 16:45 — "אחר 4" (afternoon cluster)
  await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972504444444','רחל מזרחי','הרצל')`,
    [CAMPAIGN_ID, dt('16:45')]
  );
  // ── 10:30 OPEN — best proposal for Hemi (close to morning cluster)
  const proposedSlot = await pool.query(
    `INSERT INTO meeting_slots (campaign_id, slot_datetime, duration_minutes, status)
     VALUES ($1,$2,45,'open') RETURNING id`,
    [CAMPAIGN_ID, dt('10:30')]
  );

  // Bot session for Hemi
  await pool.query(
    `INSERT INTO bot_sessions (phone, zoho_campaign_id, state, language, contact_address, contact_street, context)
     VALUES ($1,$2,'confirmed','he',$3,$4,$5)
     ON CONFLICT (phone, zoho_campaign_id) DO UPDATE
     SET state='confirmed', contact_address=EXCLUDED.contact_address,
         contact_street=EXCLUDED.contact_street, context=EXCLUDED.context`,
    [phone, CAMPAIGN_ID, `${street}, תל אביב`, street,
     JSON.stringify({ contactName: 'חמי מיכאלי', confirmedSlot: { dateStr: tDate, timeStr: '13:30' } })]
  );

  return {
    hemi_slot_id: hemiSlot.rows[0].id,
    proposed_slot_id: proposedSlot.rows[0].id,
    tomorrow: tDate,
    project_id: projectId,
    slots_created: 6
  };
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

router.post('/setup', async (req, res) => {
  const log = [];
  const step = (msg, data) => { log.push({ msg, data }); logger.info(`[TestSetup] ${msg}`); };

  try {
    step('Fetching Zoho token...');
    let zohoContactId = null;
    let hemiPhone = TEST_PHONE;
    let hemiStreet = 'הרצל 20';
    let zohoOk = false;

    try {
      const token = await getZohoToken();
      step('Zoho token OK');

      const contact = await findHemiInZoho(token);
      if (contact) {
        zohoContactId = contact.id;
        const rawPhone = (contact.Mobile || contact.Phone || TEST_PHONE).replace(/\D/g, '');
        hemiPhone = rawPhone.startsWith('972') ? rawPhone : '972' + rawPhone.replace(/^0/, '');
        step(`Found: ${contact.First_Name} ${contact.Last_Name} | phone: ${hemiPhone} | street: ${contact.Mailing_Street}`);

        const addrResult = await ensureZohoAddress(token, zohoContactId, contact.Mailing_Street);
        hemiStreet = (addrResult.street || 'הרצל 20').replace(/^(רחוב|שד'|דרך)\s+/i, '').trim();
        step(addrResult.updated ? `✅ Address added: ${addrResult.street}` : `Address exists: ${addrResult.street}`);
      } else {
        step('⚠️ Hemi not found in Zoho — using defaults');
      }

      const zohoId = await ensureZohoCampaign(token, zohoContactId);
      step(`Zoho campaign: ${CAMPAIGN_ID} (id=${zohoId})`);
      zohoOk = true;
    } catch (zohoErr) {
      step(`⚠️ Zoho error (DB-only mode): ${zohoErr.message}`);
    }

    step('Seeding test slots...');
    const seedResult = await seedTestSlots(hemiPhone, hemiStreet);
    step('Slots seeded', seedResult);

    step('Running optimization engine...');
    const optimizationService = require('../services/optimizationService');
    const optResult = await optimizationService.sendRescheduleOffers(CAMPAIGN_ID);
    step('Optimization complete', optResult);

    const slotRows = await pool.query(
      `SELECT id, TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time,
              status, contact_name, contact_phone
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`,
      [CAMPAIGN_ID]
    );
    const reqRows = await pool.query(
      `SELECT * FROM reschedule_requests WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [CAMPAIGN_ID]
    );

    res.json({
      success: true,
      campaign_id: CAMPAIGN_ID,
      hemi_phone: hemiPhone,
      hemi_street: hemiStreet,
      zoho_ok: zohoOk,
      zoho_contact_id: zohoContactId,
      seed: seedResult,
      optimization: optResult,
      slots: slotRows.rows,
      reschedule_requests: reqRows.rows,
      log
    });

  } catch (err) {
    logger.error('[TestSetup] Fatal:', err.message);
    res.status(500).json({ success: false, error: err.message, log });
  }
});

router.get('/state', async (req, res) => {
  try {
    const slots = await pool.query(
      `SELECT id, TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time,
              status, contact_name, contact_phone, contact_street
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`,
      [CAMPAIGN_ID]
    );
    const requests = await pool.query(
      `SELECT rr.*,
              TO_CHAR(ms_orig.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS orig_time,
              TO_CHAR(ms_prop.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS prop_time
       FROM reschedule_requests rr
       LEFT JOIN meeting_slots ms_orig ON ms_orig.id = rr.original_slot_id
       LEFT JOIN meeting_slots ms_prop ON ms_prop.id = rr.proposed_slot_id
       WHERE rr.campaign_id=$1 ORDER BY rr.created_at DESC`,
      [CAMPAIGN_ID]
    );
    const session = await pool.query(
      `SELECT phone, state, language, contact_street, context FROM bot_sessions WHERE zoho_campaign_id=$1`,
      [CAMPAIGN_ID]
    );
    res.json({ campaign_id: CAMPAIGN_ID, slots: slots.rows, requests: requests.rows, sessions: session.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset', async (req, res) => {
  try {
    await pool.query(`DELETE FROM reschedule_requests WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM meeting_slots WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM bot_sessions WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    res.json({ success: true, message: 'Test data cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
