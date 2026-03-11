/**
 * QUANTUM Campaign Routes — v1.0
 * Manages outreach campaigns: WA→Call or Call-Only
 * Agent: רן מ-QUANTUM
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');
const { logger } = require('../services/logger');

const INFORU_BASE = 'https://capi.inforu.co.il/api/v2';
const VAPI_BASE = 'https://api.vapi.ai';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBasicAuth() {
  const u = process.env.INFORU_USERNAME;
  const p = process.env.INFORU_PASSWORD;
  if (!u || !p) throw new Error('INFORU credentials missing');
  return Buffer.from(`${u}:${p}`).toString('base64');
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return '+' + digits;
  if (digits.startsWith('0')) return '+972' + digits.slice(1);
  return '+972' + digits;
}

function buildWaMessage(campaign, leadName) {
  if (campaign.wa_message) {
    return campaign.wa_message.replace('{{name}}', leadName || 'שלום');
  }
  const name = leadName ? `${leadName}, ` : '';
  return `שלום${name ? ' ' + name : '!'} אני רן מ-QUANTUM - משרד תיווך בוטיק המתמחה בפינוי-בינוי.\n\nיש לנו נכסים ומידע שאחרים לא יודעים עליהם.\nמתי נוח לדבר 2 דקות?`;
}

async function sendWhatsApp(phone, message, campaignLeadId) {
  const auth = getBasicAuth();
  const resp = await axios.post(`${INFORU_BASE}/WhatsApp/SendWhatsAppChat`, {
    Data: {
      Message: message,
      Phone: phone,
      Settings: {
        CustomerMessageId: `camp_${campaignLeadId}_${Date.now()}`,
        CustomerParameter: 'QUANTUM_CAMPAIGN'
      }
    }
  }, {
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    timeout: 15000,
    validateStatus: () => true
  });
  return resp.data?.StatusId === 1;
}

async function initiateVapiCall(phone, leadName, campaign) {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_COLD ||
                      process.env.VAPI_ASSISTANT_SELLER ||
                      process.env.VAPI_ASSISTANT_ID;

  if (!apiKey || !phoneNumberId) throw new Error('Vapi credentials missing');
  if (!assistantId) throw new Error('No Vapi assistant configured');

  const e164 = normalizePhone(phone);

  const resp = await axios.post(`${VAPI_BASE}/call/phone`, {
    phoneNumberId,
    assistantId,
    customer: { number: e164, name: leadName || 'לקוח' },
    assistantOverrides: {
      variableValues: {
        lead_name: leadName || '',
        agent_name: campaign.agent_name || 'רן',
        campaign_id: String(campaign.id),
        campaign_name: campaign.name
      }
    }
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return resp.data?.id;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

// GET /api/campaigns — list all
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(cl.id)                                                         AS total_leads,
        COUNT(CASE WHEN cl.status = 'wa_sent'          THEN 1 END)          AS wa_sent,
        COUNT(CASE WHEN cl.status = 'wa_replied'       THEN 1 END)          AS wa_replied,
        COUNT(CASE WHEN cl.status = 'call_initiated'   THEN 1 END)          AS calls_made,
        COUNT(CASE WHEN cl.status = 'call_done'        THEN 1 END)          AS calls_done
      FROM campaigns c
      LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, campaigns: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows: [campaign] } = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1', [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { rows: leads } = await pool.query(
      'SELECT * FROM campaign_leads WHERE campaign_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, campaign, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — create
router.post('/', async (req, res) => {
  try {
    const {
      name,
      mode = 'wa_then_call',
      wa_wait_minutes = 60,
      agent_name = 'רן',
      wa_message,
      notes
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!['wa_then_call', 'call_only'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be wa_then_call or call_only' });
    }

    const { rows: [campaign] } = await pool.query(`
      INSERT INTO campaigns (name, mode, wa_wait_minutes, agent_name, wa_message, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name, mode, wa_wait_minutes, agent_name, wa_message || null, notes || null]);

    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — update settings
router.patch('/:id', async (req, res) => {
  try {
    const { name, mode, wa_wait_minutes, agent_name, wa_message, notes, status } = req.body;
    const { rows: [campaign] } = await pool.query(`
      UPDATE campaigns SET
        name            = COALESCE($1, name),
        mode            = COALESCE($2, mode),
        wa_wait_minutes = COALESCE($3, wa_wait_minutes),
        agent_name      = COALESCE($4, agent_name),
        wa_message      = COALESCE($5, wa_message),
        notes           = COALESCE($6, notes),
        status          = COALESCE($7, status),
        updated_at      = NOW()
      WHERE id = $8
      RETURNING *
    `, [name, mode, wa_wait_minutes, agent_name, wa_message, notes, status, req.params.id]);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lead Management ───────────────────────────────────────────────────────────

// POST /api/campaigns/:id/leads — add leads
router.post('/:id/leads', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { leads } = req.body; // [{ phone, name, source, lead_id }]

    if (!Array.isArray(leads) || !leads.length) {
      return res.status(400).json({ error: 'leads array required' });
    }

    const inserted = [];
    for (const l of leads) {
      if (!l.phone) continue;
      try {
        const { rows: [row] } = await pool.query(`
          INSERT INTO campaign_leads (campaign_id, phone, name, source, lead_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (campaign_id, phone) DO NOTHING
          RETURNING *
        `, [campaignId, l.phone, l.name || null, l.source || 'manual', l.lead_id || null]);
        if (row) inserted.push(row);
      } catch (e) {
        logger.warn(`[Campaign] Failed to insert lead ${l.phone}:`, e.message);
      }
    }

    res.json({ success: true, inserted: inserted.length, leads: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign Execution ────────────────────────────────────────────────────────

// POST /api/campaigns/:id/launch — start the campaign
router.post('/:id/launch', async (req, res) => {
  try {
    const { rows: [campaign] } = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1', [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Mark campaign active
    await pool.query(
      "UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = $1",
      [campaign.id]
    );

    // Get pending leads
    const { rows: leads } = await pool.query(
      "SELECT * FROM campaign_leads WHERE campaign_id = $1 AND status = 'pending'",
      [campaign.id]
    );

    if (!leads.length) {
      return res.json({ success: true, message: 'No pending leads', sent: 0 });
    }

    let waSent = 0, callsInitiated = 0, errors = 0;

    for (const lead of leads) {
      try {
        if (campaign.mode === 'call_only') {
          // ── Direct call ──
          const vapiCallId = await initiateVapiCall(lead.phone, lead.name, campaign);
          await pool.query(`
            UPDATE campaign_leads
            SET status = 'call_initiated', call_initiated_at = NOW(), vapi_call_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [vapiCallId, lead.id]);
          callsInitiated++;
        } else {
          // ── WA first ──
          const message = buildWaMessage(campaign, lead.name);
          const ok = await sendWhatsApp(lead.phone, message, lead.id);
          await pool.query(`
            UPDATE campaign_leads
            SET status = $1, wa_sent_at = NOW(), updated_at = NOW()
            WHERE id = $2
          `, [ok ? 'wa_sent' : 'failed', lead.id]);
          if (ok) waSent++;
          else errors++;
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        logger.error(`[Campaign] Lead ${lead.phone} error:`, e.message);
        await pool.query(
          "UPDATE campaign_leads SET status = 'failed', notes = $1, updated_at = NOW() WHERE id = $2",
          [e.message.substring(0, 200), lead.id]
        );
        errors++;
      }
    }

    res.json({
      success: true,
      mode: campaign.mode,
      total: leads.length,
      wa_sent: waSent,
      calls_initiated: callsInitiated,
      errors,
      message: campaign.mode === 'wa_then_call'
        ? `נשלחו ${waSent} הודעות WA. המערכת תתקשר אוטומטית אחרי ${campaign.wa_wait_minutes} דקות ללא מענה.`
        : `יזומו ${callsInitiated} שיחות ישירות.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
  try {
    await pool.query(
      "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    res.json({ success: true, status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/followup — called by cron every minute
// Finds WA-sent leads with no reply after wa_wait_minutes → calls them
router.post('/followup/run', async (req, res) => {
  try {
    const { rows: overdueLeads } = await pool.query(`
      SELECT cl.*, c.wa_wait_minutes, c.agent_name, c.name AS campaign_name, c.id AS camp_id
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      WHERE cl.status = 'wa_sent'
        AND c.mode = 'wa_then_call'
        AND c.status = 'active'
        AND cl.wa_sent_at < NOW() - (c.wa_wait_minutes * INTERVAL '1 minute')
        AND cl.vapi_call_id IS NULL
      LIMIT 20
    `);

    if (!overdueLeads.length) return res.json({ success: true, processed: 0 });

    let called = 0, errors = 0;

    for (const lead of overdueLeads) {
      try {
        const campaign = {
          id: lead.camp_id,
          name: lead.campaign_name,
          agent_name: lead.agent_name
        };
        const vapiCallId = await initiateVapiCall(lead.phone, lead.name, campaign);
        await pool.query(`
          UPDATE campaign_leads
          SET status = 'call_initiated', call_initiated_at = NOW(),
              call_queued_at = NOW(), vapi_call_id = $1, updated_at = NOW()
          WHERE id = $2
        `, [vapiCallId, lead.id]);
        logger.info(`[Campaign] Called ${lead.phone} after WA no-response (campaign: ${lead.campaign_name})`);
        called++;
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        logger.error(`[Campaign] Follow-up call failed for ${lead.phone}:`, e.message);
        errors++;
      }
    }

    res.json({ success: true, processed: overdueLeads.length, called, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/webhook/wa-reply — called when WA bot detects a reply from a campaign lead
router.post('/webhook/wa-reply', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const { rowCount } = await pool.query(`
      UPDATE campaign_leads
      SET status = 'wa_replied', wa_replied_at = NOW(), updated_at = NOW()
      WHERE phone = $1
        AND status = 'wa_sent'
        AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
    `, [phone]);

    if (rowCount > 0) {
      logger.info(`[Campaign] WA reply registered for ${phone} — call cancelled`);
    }

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status = 'pending'        THEN 1 END) AS pending,
        COUNT(CASE WHEN status = 'wa_sent'        THEN 1 END) AS wa_sent,
        COUNT(CASE WHEN status = 'wa_replied'     THEN 1 END) AS wa_replied,
        COUNT(CASE WHEN status = 'call_initiated' THEN 1 END) AS calls_initiated,
        COUNT(CASE WHEN status = 'call_done'      THEN 1 END) AS calls_done,
        COUNT(CASE WHEN status = 'failed'         THEN 1 END) AS failed
      FROM campaign_leads WHERE campaign_id = $1
    `, [req.params.id]);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
