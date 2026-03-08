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
const TEST_PHONE  = '972525959103';

async function getZohoToken() {
  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    }
  });
  if (!res.data.access_token) throw new Error('No access_token: ' + JSON.stringify(res.data));
  return res.data.access_token;
}

async function findHemiInZoho(token) {
  const res = await axios.get('https://www.zohoapis.com/crm/v3/Contacts/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { word: 'מיכאלי', fields: 'id,First_Name,Last_Name,Phone,Mobile,Mailing_Street,Mailing_City' }
  });
  const contacts = res.data?.data || [];
  return contacts.find(c => c.Last_Name === 'מיכאלי') || contacts[0] || null;
}

async function ensureZohoAddress(token, contactId, currentStreet) {
  if (currentStreet) return { updated: false, street: currentStreet };
  await axios.put(`https://www.zohoapis.com/crm/v3/Contacts/${contactId}`, {
    data: [{ Mailing_Street: 'הרצל 20', Mailing_City: 'תל אביב' }]
  }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  return { updated: true, street: 'הרצל 20' };
}

async function ensureZohoCampaign(token, contactId) {
  const search = await axios.get('https://www.zohoapis.com/crm/v3/Campaigns/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { word: CAMPAIGN_ID, fields: 'id,Campaign_Name' }
  }).catch(() => ({ data: {} }));

  let campaignZohoId = search.data?.data?.[0]?.id;
  if (!campaignZohoId) {
    const create = await axios.post('https://www.zohoapis.com/crm/v3/Campaigns', {
      data: [{ Campaign_Name: CAMPAIGN_ID, Status: 'Active', Start_Date: new Date().toISOString().split('T')[0], Type: 'Email' }]
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

async function seedTestSlots(phone, street) {
  const projRow = await pool.query('SELECT id FROM projects ORDER BY id LIMIT 1');
  const projectId = projRow.rows[0]?.id || null;

  await pool.query(
    `INSERT INTO campaign_schedule_config
       (zoho_campaign_id, project_id, meeting_type, slot_duration_minutes, buffer_minutes, wa_language, updated_at)
     VALUES ($1, $2, 'appraiser', 45, 15, 'he', NOW())
     ON CONFLICT (zoho_campaign_id) DO UPDATE SET project_id=$2, meeting_type='appraiser', updated_at=NOW()`,
    [CAMPAIGN_ID, projectId]
  );

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tDate = tomorrow.toISOString().split('T')[0];

  // Israel = UTC+2 (winter) / UTC+3 (summer)
  const isDST = (() => {
    const jan = new Date(new Date().getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(new Date().getFullYear(), 6, 1).getTimezoneOffset();
    return Math.min(jan, jul) === new Date().getTimezoneOffset();
  })();
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
  await pool.query(`DELETE FROM bot_sessions WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);

  // NOTE: All inserts include meeting_type (NOT NULL column)
  const ins = (time, status, phone, name, street, addr) => pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, meeting_type, status, contact_phone, contact_name, contact_street, contact_address)
     VALUES ($1,$2,45,'appraiser',$3,$4,$5,$6,$7) RETURNING id`,
    [CAMPAIGN_ID, dt(time), status, phone || null, name || null, street || null, addr || null]
  );

  await ins('09:00', 'confirmed', '972501111111', 'ישראל ישראלי', 'הרצל', null);
  await ins('09:45', 'confirmed', '972502222222', 'שרה כהן', 'הרצל', null);
  const hemiSlot = await ins('13:30', 'confirmed', phone, 'חמי מיכאלי', street, `${street}, תל אביב`);
  await ins('16:00', 'confirmed', '972503333333', 'דוד לוי', 'הרצל', null);
  await ins('16:45', 'confirmed', '972504444444', 'רחל מזרחי', 'הרצל', null);
  const proposedSlot = await ins('10:30', 'open', null, null, null, null);

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

  return { hemi_slot_id: hemiSlot.rows[0].id, proposed_slot_id: proposedSlot.rows[0].id, tomorrow: tDate, project_id: projectId, slots_created: 6 };
}

// ══════════════════════════════════════════════════════════════

router.post('/setup', async (req, res) => {
  const log = [];
  const step = (msg, data) => { log.push({ msg, data }); logger.info(`[TestSetup] ${msg}`); };

  try {
    let zohoContactId = null, hemiPhone = TEST_PHONE, hemiStreet = 'הרצל', zohoOk = false;

    step('Fetching Zoho token...');
    try {
      const token = await getZohoToken();
      step('Zoho token OK');
      const contact = await findHemiInZoho(token);
      if (contact) {
        zohoContactId = contact.id;
        const raw = (contact.Mobile || contact.Phone || TEST_PHONE).replace(/\D/g, '');
        hemiPhone = raw.startsWith('972') ? raw : '972' + raw.replace(/^0/, '');
        step(`✅ Found: ${contact.First_Name} ${contact.Last_Name} | ${hemiPhone} | street: ${contact.Mailing_Street}`);
        const addr = await ensureZohoAddress(token, zohoContactId, contact.Mailing_Street);
        hemiStreet = (addr.street || 'הרצל').replace(/^(רחוב|שד'|דרך)\s+/i, '').trim();
        step(addr.updated ? `✅ Address added: ${addr.street}` : `Address exists: ${addr.street}`);
      } else {
        step('⚠️  Hemi not found in Zoho - using defaults');
      }
      const zohoId = await ensureZohoCampaign(token, zohoContactId);
      step(`Zoho campaign OK (id=${zohoId})`);
      zohoOk = true;
    } catch (e) {
      step(`⚠️  Zoho error (DB-only): ${e.message}`);
    }

    step('Seeding slots...');
    const seed = await seedTestSlots(hemiPhone, hemiStreet);
    step('Slots seeded ✅', seed);

    step('Running optimization engine...');
    const optimizationService = require('../services/optimizationService');
    const opt = await optimizationService.sendRescheduleOffers(CAMPAIGN_ID);
    step(`Optimization done: sent=${opt.sent} skipped=${opt.skipped} errors=${opt.errors}`, opt);

    const slots = await pool.query(
      `SELECT id, TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time, status, contact_name, contact_phone
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`, [CAMPAIGN_ID]
    );
    const reqs = await pool.query(
      `SELECT * FROM reschedule_requests WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 5`, [CAMPAIGN_ID]
    );

    res.json({ success: true, campaign_id: CAMPAIGN_ID, hemi_phone: hemiPhone, hemi_street: hemiStreet, zoho_ok: zohoOk, zoho_contact_id: zohoContactId, seed, optimization: opt, slots: slots.rows, reschedule_requests: reqs.rows, log });

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
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`, [CAMPAIGN_ID]
    );
    const requests = await pool.query(
      `SELECT rr.*,
              TO_CHAR(ms_o.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS orig_time,
              TO_CHAR(ms_p.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS prop_time
       FROM reschedule_requests rr
       LEFT JOIN meeting_slots ms_o ON ms_o.id = rr.original_slot_id
       LEFT JOIN meeting_slots ms_p ON ms_p.id = rr.proposed_slot_id
       WHERE rr.campaign_id=$1 ORDER BY rr.created_at DESC`, [CAMPAIGN_ID]
    );
    const sessions = await pool.query(
      `SELECT phone, state, language, contact_street, context FROM bot_sessions WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]
    );
    res.json({ campaign_id: CAMPAIGN_ID, slots: slots.rows, requests: requests.rows, sessions: sessions.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reset', async (req, res) => {
  try {
    await pool.query(`DELETE FROM reschedule_requests WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM meeting_slots WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM bot_sessions WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    res.json({ success: true, message: 'Test data cleared' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
