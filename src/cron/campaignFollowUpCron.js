/**
 * QUANTUM Campaign Follow-Up Cron
 * Checks WA leads with no reply → triggers Vapi call after campaign's wa_wait_minutes
 * Runs every minute
 */

const pool    = require('../db/pool');
const axios   = require('axios');
const { placeVapiCall } = require('../services/vapiCampaignService');
const { logger }        = require('../services/logger');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

function getBasicAuth() {
  const u = process.env.INFORU_USERNAME, p = process.env.INFORU_PASSWORD;
  if (!u || !p) throw new Error('INFORU credentials not set');
  return Buffer.from(`${u}:${p}`).toString('base64');
}

async function sendWA(phone, message, campaignLeadId) {
  const auth = getBasicAuth();
  const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
    Data: {
      Message: message,
      Phone:   phone,
      Settings: {
        CustomerMessageId: `campaign_${campaignLeadId}_${Date.now()}`,
        CustomerParameter: 'QUANTUM_CAMPAIGN'
      }
    }
  }, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    timeout: 15000,
    validateStatus: () => true
  });
  return result.data?.StatusId === 1;
}

// ─── Main tick ───────────────────────────────────────────────────────────────

async function runCampaignFollowUp() {
  try {
    // 1. Send initial WA to new pending leads in wa_then_call or wa_only campaigns
    const pendingWA = await pool.query(`
      SELECT cl.*, c.mode, c.wa_wait_minutes, c.script_type, c.agent_name
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      WHERE cl.flow_status = 'pending'
        AND c.status = 'active'
        AND c.mode IN ('wa_then_call', 'wa_only')
      ORDER BY cl.created_at ASC
      LIMIT 10
    `);

    for (const lead of pendingWA.rows) {
      try {
        const { buildWaFirstMessage } = require('../services/vapiCampaignService');
        const msg = buildWaFirstMessage(lead.script_type, lead.name);
        const ok  = await sendWA(lead.phone, msg, lead.id);
        await pool.query(`
          UPDATE campaign_leads
          SET flow_status = 'wa_sent', wa_sent_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [lead.id]);
        logger.info(`[Campaign] WA sent to ${lead.phone} (lead #${lead.id}, campaign #${lead.campaign_id}): ${ok ? 'ok' : 'failed'}`);
      } catch (err) {
        logger.error(`[Campaign] Failed to send WA to lead #${lead.id}: ${err.message}`);
      }
    }

    // 2. Send initial call to new pending leads in call_only campaigns
    const pendingCalls = await pool.query(`
      SELECT cl.*, c.mode, c.script_type, c.agent_name
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      WHERE cl.flow_status = 'pending'
        AND c.status = 'active'
        AND c.mode = 'call_only'
      ORDER BY cl.created_at ASC
      LIMIT 5
    `);

    for (const lead of pendingCalls.rows) {
      try {
        const { callId, status } = await placeVapiCall({
          phone:          lead.phone,
          leadName:       lead.name,
          leadCity:       lead.city,
          scriptType:     lead.script_type,
          campaignLeadId: lead.id,
          campaignId:     lead.campaign_id
        });
        await pool.query(`
          UPDATE campaign_leads
          SET flow_status = 'call_placed', call_triggered_at = NOW(), call_id = $1, call_status = $2, updated_at = NOW()
          WHERE id = $3
        `, [callId, status, lead.id]);
        logger.info(`[Campaign] Direct call placed to ${lead.phone} (lead #${lead.id}): callId=${callId}`);
      } catch (err) {
        logger.error(`[Campaign] Failed to call lead #${lead.id}: ${err.message}`);
      }
    }

    // 3. WA→Call fallback: WA sent, no reply, wait time elapsed
    const readyForCall = await pool.query(`
      SELECT cl.*, c.mode, c.wa_wait_minutes, c.script_type, c.agent_name
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      WHERE cl.flow_status = 'wa_sent'
        AND c.status = 'active'
        AND c.mode = 'wa_then_call'
        AND cl.wa_replied_at IS NULL
        AND cl.wa_sent_at < NOW() - (c.wa_wait_minutes || ' minutes')::interval
        AND cl.call_triggered_at IS NULL
      ORDER BY cl.wa_sent_at ASC
      LIMIT 5
    `);

    for (const lead of readyForCall.rows) {
      try {
        logger.info(`[Campaign] WA no-reply timeout (${lead.wa_wait_minutes}m) for lead #${lead.id} — placing call`);
        const { callId, status } = await placeVapiCall({
          phone:          lead.phone,
          leadName:       lead.name,
          leadCity:       lead.city,
          scriptType:     lead.script_type,
          campaignLeadId: lead.id,
          campaignId:     lead.campaign_id
        });
        await pool.query(`
          UPDATE campaign_leads
          SET flow_status = 'call_placed', call_triggered_at = NOW(), call_id = $1, call_status = $2, updated_at = NOW()
          WHERE id = $3
        `, [callId, status, lead.id]);
        logger.info(`[Campaign] Fallback call placed to ${lead.phone}: callId=${callId}`);
      } catch (err) {
        logger.error(`[Campaign] Fallback call failed for lead #${lead.id}: ${err.message}`);
        // Mark as call_queued (retry next tick)
        await pool.query(`UPDATE campaign_leads SET flow_status='call_queued', updated_at=NOW() WHERE id=$1`, [lead.id]);
      }
    }

  } catch (err) {
    logger.error('[Campaign] Follow-up cron error:', err.message);
  }
}

// ─── Mark WA reply (called from WA webhook) ─────────────────────────────────

async function markWaReplied(phone) {
  try {
    const { rowCount } = await pool.query(`
      UPDATE campaign_leads
      SET wa_replied_at = COALESCE(wa_replied_at, NOW()),
          wa_message_count = wa_message_count + 1,
          flow_status = CASE WHEN flow_status = 'wa_sent' THEN 'wa_replied' ELSE flow_status END,
          updated_at = NOW()
      WHERE phone = $1
        AND flow_status IN ('wa_sent', 'wa_replied')
        AND wa_sent_at > NOW() - INTERVAL '7 days'
    `, [phone]);
    if (rowCount > 0) logger.info(`[Campaign] WA reply marked for ${phone}`);
  } catch (err) {
    logger.error('[Campaign] markWaReplied error:', err.message);
  }
}

module.exports = { runCampaignFollowUp, markWaReplied };
