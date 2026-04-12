/**
 * Pilot Outreach Routes — Track A + B
 *
 * Investor pilot programme: targeted outreach to all known contacts
 * in the 8 pilot complexes.
 *   A1 — WhatsApp chat message via sendWhatsAppChat (free text, no template)
 *   A2 — Phone extraction from listing URLs
 *   B  — Facebook/web targeted scan per complex
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];

const WA_MESSAGE = () =>
  `שלום, שמי חמי מ-QUANTUM נדל"ן.\n` +
  `ראיתי שיש לך דירה למכירה.\n` +
  `אני מחפש דירה בסביבה, עבור לקוח שלי.\n` +
  `מתי יהיה לך נח שנדבר?`;

// ============================================================
// GET /api/pilot/status
// ============================================================
router.get('/status', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id as complex_id, c.name, c.city, c.iai_score,
        COUNT(DISTINCT l.id) as total_listings,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.phone IS NOT NULL AND l.phone != '') as unique_phones,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.message_status = 'נשלחה') as wa_sent,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.last_reply_at IS NOT NULL) as replied,
        COUNT(DISTINCT l.id) FILTER (WHERE l.source ILIKE 'web_%' OR l.source = 'facebook_group') as from_pilot_scan
      FROM complexes c
      LEFT JOIN listings l ON l.complex_id = c.id AND l.is_active = true
      WHERE c.id = ANY($1)
      GROUP BY c.id, c.name, c.city, c.iai_score
      ORDER BY c.iai_score DESC
    `, [PILOT_IDS]);

    const totals = {
      complexes: rows.length,
      total_listings: rows.reduce((s, r) => s + parseInt(r.total_listings), 0),
      unique_phones: rows.reduce((s, r) => s + parseInt(r.unique_phones), 0),
      wa_sent: rows.reduce((s, r) => s + parseInt(r.wa_sent), 0),
      replied: rows.reduce((s, r) => s + parseInt(r.replied), 0),
      from_pilot_scan: rows.reduce((s, r) => s + parseInt(r.from_pilot_scan), 0)
    };

    res.json({ success: true, pilot_complexes: rows, totals });
  } catch (err) {
    logger.error('[Pilot] Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/pilot/contacts
// ============================================================
router.get('/contacts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.id as listing_id, l.phone, l.contact_name, l.source,
        l.asking_price, l.rooms, l.area_sqm, l.address, l.url,
        l.days_on_market, l.total_price_drop_percent, l.ssi_score,
        l.message_status, l.last_reply_at, l.last_reply_text,
        c.id as complex_id, c.name as complex_name, c.city, c.iai_score
      FROM listings l
      JOIN complexes c ON c.id = l.complex_id
      WHERE c.id = ANY($1)
        AND l.phone IS NOT NULL AND l.phone != ''
        AND l.is_active = true
      ORDER BY l.ssi_score DESC NULLS LAST, c.iai_score DESC, l.days_on_market DESC NULLS LAST
    `, [PILOT_IDS]);

    const seen = new Map();
    for (const row of rows) {
      const existing = seen.get(row.phone);
      if (!existing || (row.ssi_score || 0) > (existing.ssi_score || 0)) {
        seen.set(row.phone, row);
      }
    }
    const unique = Array.from(seen.values());

    res.json({
      success: true,
      total: unique.length,
      not_contacted: unique.filter(r => r.message_status !== 'נשלחה').length,
      replied: unique.filter(r => r.last_reply_at).length,
      contacts: unique
    });
  } catch (err) {
    logger.error('[Pilot] Contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/pilot/send-wa
// Uses sendWhatsAppChat (free text) — no template required
// body: { dryRun: true/false, limit: 20, complexIds: [...] }
// ============================================================
router.post('/send-wa', async (req, res) => {
  const { dryRun = true, limit = 20, complexIds = PILOT_IDS } = req.body;

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (l.phone)
        l.id as listing_id, l.phone, l.contact_name,
        c.id as complex_id, c.name as complex_name, c.city
      FROM listings l
      JOIN complexes c ON c.id = l.complex_id
      WHERE c.id = ANY($1)
        AND l.phone IS NOT NULL AND l.phone != ''
        AND l.is_active = true
        AND (l.message_status IS NULL OR l.message_status = 'לא נשלחה')
      ORDER BY l.phone, l.ssi_score DESC NULLS LAST
      LIMIT $2
    `, [complexIds, limit]);

    if (rows.length === 0) {
      return res.json({ success: true, sent: 0, message: 'אין אנשי קשר חדשים לשליחה' });
    }

    const message = WA_MESSAGE();

    if (dryRun) {
      return res.json({
        success: true, dry_run: true, would_send: rows.length,
        message_preview: message,
        preview: rows.map(r => ({
          phone: r.phone, contact: r.contact_name,
          complex: r.complex_name, city: r.city
        }))
      });
    }

    // sendWhatsAppChat — free text, no INFORU template required
    const { sendWhatsAppChat } = require('../services/inforuService');
    let sent = 0, failed = 0;
    const results = [];

    for (const contact of rows) {
      try {
        await sendWhatsAppChat(contact.phone, message, {
          customerMessageId: `pilot_${contact.listing_id}_${Date.now()}`,
          customerParameter: 'QUANTUM_PILOT'
        });

        await pool.query(
          `UPDATE listings SET message_status = 'נשלחה', last_message_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [contact.listing_id]
        );

        sent++;
        results.push({ phone: contact.phone, complex: contact.complex_name, status: 'sent' });
        logger.info(`[Pilot] WA sent to ${contact.phone} (${contact.complex_name})`);

        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        failed++;
        results.push({ phone: contact.phone, complex: contact.complex_name, status: 'failed', error: err.message });
        logger.warn(`[Pilot] WA failed to ${contact.phone}: ${err.message}`);
      }
    }

    logger.info(`[Pilot] WA campaign done: sent=${sent}, failed=${failed}`);
    res.json({ success: true, sent, failed, results });

  } catch (err) {
    logger.error('[Pilot] Send WA error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/pilot/scan-fb
// ============================================================
router.post('/scan-fb', async (req, res) => {
  const { complexIds = null } = req.body;
  try {
    const { scanPilotComplexes } = require('../services/facebookGroupsScraper');
    res.json({ success: true, message: 'סריקה התחילה ברקע', complexes: complexIds || PILOT_IDS });
    setImmediate(async () => {
      try {
        const result = await scanPilotComplexes(complexIds);
        logger.info('[Pilot] FB scan complete:', JSON.stringify(result));
      } catch (err) {
        logger.error('[Pilot] FB scan error:', err.message);
      }
    });
  } catch (err) {
    logger.error('[Pilot] Scan FB error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/pilot/enrich-phones
// ============================================================
router.post('/enrich-phones', async (req, res) => {
  const { complexIds = null } = req.body;
  try {
    const { enrichPilotPhones } = require('../services/facebookGroupsScraper');
    const ids = complexIds || PILOT_IDS;
    const { rows: pending } = await pool.query(
      `SELECT COUNT(*) as cnt FROM listings
       WHERE complex_id = ANY($1) AND phone IS NULL AND url IS NOT NULL
         AND source ILIKE 'web_%' AND is_active = TRUE`,
      [ids]
    );
    res.json({
      success: true,
      message: 'Phone enrichment מתחיל ברקע',
      pending_listings: parseInt(pending[0]?.cnt || 0),
      complexes: ids
    });
    setImmediate(async () => {
      try {
        const result = await enrichPilotPhones(complexIds);
        logger.info(`[Pilot] Phone enrichment done: ${result?.found}/${result?.total}`);
      } catch (err) {
        logger.error('[Pilot] Phone enrichment error:', err.message);
      }
    });
  } catch (err) {
    logger.error('[Pilot] Enrich phones error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
