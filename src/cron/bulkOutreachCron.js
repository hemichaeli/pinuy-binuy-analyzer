/**
 * QUANTUM Bulk Outreach Campaign Cron
 *
 * Sends WhatsApp template messages (via InForu) to all scraped listings
 * that have a phone number but haven't been contacted yet.
 *
 * Flow per listing:
 *   1. WhatsApp Template (InForu CAPI v2) — requires Meta-approved template
 *   2. SMS fallback (InForu XML) — if WA template fails or not configured
 *   3. Log to unified_messages + update listing.message_status
 *
 * Rate limits:
 *   - 1 message every 3-5 seconds (randomised)
 *   - Max 50 per cron tick (configurable via system_settings)
 *   - Daily cap of 200 (configurable)
 *   - Runs every 15 minutes when enabled
 *
 * Dashboard settings (system_settings keys):
 *   bulk_outreach_enabled        — 'true'/'false'
 *   bulk_outreach_template_id    — InForu WhatsApp template ID (e.g. '157823')
 *   bulk_outreach_batch_size     — per-tick batch (default 50)
 *   bulk_outreach_daily_limit    — daily cap (default 200)
 *   bulk_outreach_message_text   — SMS/fallback text template
 *
 * Schedule: * /15 * * * * (set in src/index.js)
 */

const pool = require('../db/pool');
const { logger } = require('../services/logger');

let _running = false;
let _dailyCount = 0;
let _dailyDate = '';
let _lastRunResult = null;

// ─── Config helpers ─────────────────────────────────────────────────────────

async function getSetting(key, defaultValue = null) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM system_settings WHERE key = $1", [key]
    );
    return rows.length > 0 ? rows[0].value : defaultValue;
  } catch (e) { return defaultValue; }
}

async function getConfig() {
  const [enabled, templateId, batchSize, dailyLimit, messageText, agentPhone] = await Promise.all([
    getSetting('bulk_outreach_enabled', 'false'),
    getSetting('bulk_outreach_template_id', ''),
    getSetting('bulk_outreach_batch_size', '50'),
    getSetting('bulk_outreach_daily_limit', '200'),
    getSetting('bulk_outreach_message_text', ''),
    getSetting('agent_phone', '050-0000000'),
  ]);

  return {
    enabled: enabled === 'true',
    templateId: templateId || '',
    batchSize: Math.min(parseInt(batchSize) || 50, 100),
    dailyLimit: parseInt(dailyLimit) || 200,
    messageText: messageText || '',
    agentPhone: agentPhone || '050-0000000',
  };
}

// ─── Template fill ──────────────────────────────────────────────────────────

function fillMessageTemplate(text, listing, agentPhone) {
  return text
    .replace(/{address}/g, listing.address || listing.street || '')
    .replace(/{city}/g, listing.city || '')
    .replace(/{price}/g, listing.asking_price ? `${Number(listing.asking_price).toLocaleString()} ש"ח` : '')
    .replace(/{rooms}/g, listing.rooms || '')
    .replace(/{area}/g, listing.area_sqm || '')
    .replace(/{contact_name}/g, listing.contact_name || '')
    .replace(/{complex_name}/g, listing.complex_name || '')
    .replace(/{agent_phone}/g, agentPhone)
    .replace(/{platform}/g, listing.source || 'yad2')
    .trim();
}

const DEFAULT_SMS_TEXT = `שלום,
ראיתי את הנכס שלך ב{address}, {city}.
אני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים רציניים לאזור שלך.
אשמח לשוחח - {agent_phone}
QUANTUM Real Estate`;

// ─── Main tick ──────────────────────────────────────────────────────────────

async function runBulkOutreach() {
  if (_running) {
    logger.info('[BulkOutreach] Previous run still active, skipping');
    return { skipped: true, reason: 'already_running' };
  }
  _running = true;

  try {
    const config = await getConfig();

    if (!config.enabled) {
      _lastRunResult = { disabled: true, timestamp: new Date().toISOString() };
      return _lastRunResult;
    }

    // Reset daily counter at midnight
    const today = new Date().toISOString().split('T')[0];
    if (_dailyDate !== today) {
      _dailyCount = 0;
      _dailyDate = today;
    }

    const remaining = config.dailyLimit - _dailyCount;
    if (remaining <= 0) {
      _lastRunResult = { skipped: true, reason: 'daily_limit_reached', dailyCount: _dailyCount, dailyLimit: config.dailyLimit, timestamp: new Date().toISOString() };
      logger.info(`[BulkOutreach] Daily limit reached (${_dailyCount}/${config.dailyLimit})`);
      return _lastRunResult;
    }

    const batchSize = Math.min(config.batchSize, remaining);

    // Get unsent listings with phone numbers
    const { rows: listings } = await pool.query(`
      SELECT l.id, l.address, l.street, l.city, l.phone, l.contact_name,
             l.contact_phone, l.asking_price, l.rooms, l.area_sqm,
             l.source, l.source_listing_id, l.url, l.complex_id,
             c.name as complex_name
      FROM listings l
      LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = TRUE
        AND (l.message_status IS NULL OR l.message_status = 'לא נשלחה')
        AND (l.phone IS NOT NULL AND l.phone != '')
        AND l.phone NOT IN ('0000000000', '000-0000000')
      ORDER BY l.created_at DESC
      LIMIT $1
    `, [batchSize]);

    if (listings.length === 0) {
      _lastRunResult = { processed: 0, reason: 'no_unsent_listings', timestamp: new Date().toISOString() };
      logger.info('[BulkOutreach] No unsent listings with phones found');
      return _lastRunResult;
    }

    logger.info(`[BulkOutreach] Starting batch: ${listings.length} listings (daily: ${_dailyCount}/${config.dailyLimit})`);

    // Load InForu service
    let inforu;
    try { inforu = require('../services/inforuService'); }
    catch (e) {
      _lastRunResult = { error: 'InForu service not available', timestamp: new Date().toISOString() };
      logger.error('[BulkOutreach] InForu service not available:', e.message);
      return _lastRunResult;
    }

    let sent = 0, failed = 0, smsFallback = 0;
    const results = [];

    for (const listing of listings) {
      const phone = listing.phone || listing.contact_phone;
      if (!phone || phone.length < 7) {
        results.push({ listing_id: listing.id, success: false, error: 'invalid_phone' });
        failed++;
        continue;
      }

      const smsText = fillMessageTemplate(
        config.messageText || DEFAULT_SMS_TEXT, listing, config.agentPhone
      );

      try {
        let result;
        let channel = 'unknown';

        // Strategy 1: WhatsApp Template (first contact with new recipient)
        if (config.templateId) {
          try {
            const waResult = await inforu.sendWhatsApp(phone, config.templateId, {
              param1: listing.contact_name || '',
              param2: listing.address || listing.city || '',
              param3: listing.city || '',
              param4: config.agentPhone,
            }, { listingId: listing.id });

            if (waResult.success) {
              result = waResult;
              channel = 'whatsapp_template';
            } else {
              logger.info(`[BulkOutreach] WA template failed for listing #${listing.id}, falling back to SMS`, {
                status: waResult.status, description: waResult.description
              });
            }
          } catch (waErr) {
            logger.info(`[BulkOutreach] WA template error for listing #${listing.id}: ${waErr.message}, trying SMS`);
          }
        }

        // Strategy 2: SMS fallback
        if (!result || !result.success) {
          try {
            result = await inforu.sendSms(phone, smsText, {
              listingId: listing.id,
              complexId: listing.complex_id,
            });
            channel = 'sms';
            if (result.success) smsFallback++;
          } catch (smsErr) {
            result = { success: false, error: smsErr.message };
            channel = 'sms_failed';
          }
        }

        // Log to unified_messages
        const convId = `conv_${listing.id}_${channel}`;
        try {
          await pool.query(`
            INSERT INTO unified_messages (
              listing_id, complex_id, contact_phone, direction, channel,
              platform, message_text, status, conversation_id, metadata
            ) VALUES ($1, $2, $3, 'outgoing', $4, 'inforu', $5, $6, $7, $8::jsonb)
          `, [
            listing.id,
            listing.complex_id || null,
            phone,
            channel,
            channel === 'whatsapp_template'
              ? `[WA Template: ${config.templateId}]`
              : smsText,
            result.success ? 'sent' : 'failed',
            convId,
            JSON.stringify({
              campaign: 'bulk_outreach',
              template_id: config.templateId || null,
              inforu_status: result.status,
              inforu_description: result.description,
              channel_used: channel,
            })
          ]);
        } catch (logErr) {
          logger.warn(`[BulkOutreach] Failed to log message: ${logErr.message}`);
        }

        // Update listing status
        if (result.success) {
          await pool.query(
            `UPDATE listings SET message_status = $1, last_message_sent_at = NOW(), updated_at = NOW() WHERE id = $2`,
            [channel === 'whatsapp_template' ? 'נשלחה' : 'נשלחה SMS', listing.id]
          ).catch(() => {});
          sent++;
          _dailyCount++;
        } else {
          await pool.query(
            `UPDATE listings SET message_status = 'שליחה נכשלה', updated_at = NOW() WHERE id = $1`,
            [listing.id]
          ).catch(() => {});
          failed++;
        }

        results.push({
          listing_id: listing.id,
          phone: phone.substring(0, 4) + '****',
          channel,
          success: result.success,
          error: result.success ? null : (result.description || result.error),
        });

      } catch (err) {
        logger.error(`[BulkOutreach] Error for listing #${listing.id}: ${err.message}`);
        results.push({ listing_id: listing.id, success: false, error: err.message });
        failed++;
      }

      // Rate limit: 3-5 seconds between messages
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    }

    _lastRunResult = {
      processed: listings.length,
      sent,
      failed,
      sms_fallback: smsFallback,
      wa_template: sent - smsFallback,
      daily_count: _dailyCount,
      daily_limit: config.dailyLimit,
      template_id: config.templateId || 'none',
      timestamp: new Date().toISOString(),
    };

    logger.info(`[BulkOutreach] Done: ${JSON.stringify(_lastRunResult)}`);
    return _lastRunResult;

  } catch (err) {
    logger.error('[BulkOutreach] Cron error:', err.message);
    _lastRunResult = { error: err.message, timestamp: new Date().toISOString() };
    return _lastRunResult;
  } finally {
    _running = false;
  }
}

function getStatus() {
  return {
    running: _running,
    dailyCount: _dailyCount,
    dailyDate: _dailyDate,
    lastRun: _lastRunResult,
  };
}

function resetDailyCount() {
  _dailyCount = 0;
  _dailyDate = new Date().toISOString().split('T')[0];
}

module.exports = { runBulkOutreach, getStatus, resetDailyCount };
