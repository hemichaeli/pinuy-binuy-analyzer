/**
 * QUANTUM Incoming WhatsApp Cron
 *
 * Polls INFORU every minute for incoming WhatsApp messages
 * and routes them through the bot engine.
 *
 * INFORU uses a "pull model": each call to PullData returns
 * unseen messages and marks them as consumed.
 *
 * Schedule: every 60 seconds (set in src/index.js)
 */

const inforuService = require('../services/inforuService');
const botEngine     = require('../services/botEngine');
const pool          = require('../db/pool');
const { logger }    = require('../services/logger');

let _running = false;  // prevent overlapping runs

async function pollIncomingWhatsApp() {
  if (_running) {
    logger.info('[IncomingWACron] Previous run still active, skipping');
    return;
  }
  _running = true;

  try {
    const result = await inforuService.pullIncomingWhatsApp(100);

    if (!result || result.StatusId !== 1) {
      // No messages or API issue - silent skip
      return;
    }

    const messages = result.Data?.Messages || [];
    if (!messages.length) return;

    logger.info(`[IncomingWACron] ${messages.length} incoming messages`);

    for (const msg of messages) {
      const phone = normalizeFromInforu(msg.Phone || msg.FromPhone || msg.phone);
      const body  = (msg.Message || msg.Body || msg.message || '').trim();

      if (!phone || !body) {
        logger.warn('[IncomingWACron] Skipping message with no phone/body:', msg);
        continue;
      }

      try {
        // Find the campaign from existing bot session
        const sess = await pool.query(
          `SELECT zoho_campaign_id FROM bot_sessions
           WHERE phone = $1
           ORDER BY last_message_at DESC
           LIMIT 1`,
          [phone]
        );
        const campaignId = sess.rows[0]?.zoho_campaign_id || null;

        // First: check if this is an optimization reschedule reply
        let handled = false;
        try {
          const { optimizationService } = requireOptimization();
          if (optimizationService?.handleRescheduleReply) {
            handled = await optimizationService.handleRescheduleReply(phone, body);
          }
        } catch (e) { /* optimization not available */ }

        if (handled) {
          logger.info(`[IncomingWACron] Reschedule reply handled for ${phone}`);
          continue;
        }

        if (!campaignId) {
          logger.warn(`[IncomingWACron] No campaign for phone ${phone}, ignoring message`);
          continue;
        }

        // Route through bot engine
        const reply = await botEngine.handleIncoming(phone, body, campaignId);
        if (reply) {
          await inforuService.sendWhatsAppChat(phone, reply);
          logger.info(`[IncomingWACron] Bot replied to ${phone}`);
        }

      } catch (msgErr) {
        logger.error(`[IncomingWACron] Error processing message from ${phone}:`, msgErr.message);
      }
    }

  } catch (err) {
    logger.error('[IncomingWACron] Poll failed:', err.message);
  } finally {
    _running = false;
  }
}

// ── Phone normalization ───────────────────────────────────────
// INFORU returns Israeli phones as "0521234567" or "972521234567"
function normalizeFromInforu(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');

  // Already in local format
  if (p.startsWith('05') && p.length === 10) return p;

  // 972XXXXXXXXX → 0XXXXXXXXX
  if (p.startsWith('972') && p.length === 12) return '0' + p.slice(3);

  // Other long formats - return as-is
  return p || null;
}

// ── Safe optional require for optimization service ────────────
function requireOptimization() {
  try {
    return { optimizationService: require('../services/optimizationService') };
  } catch (e) {
    return {};
  }
}

module.exports = { pollIncomingWhatsApp };
