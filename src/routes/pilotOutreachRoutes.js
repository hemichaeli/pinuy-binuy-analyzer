/**
 * Pilot Outreach Routes — Track A
 *
 * Investor pilot programme: targeted outreach to all known contacts
 * in the 8 pilot complexes. Two sub-tracks:
 *   A1 — WhatsApp to existing listings (even via agents - message directed at owner)
 *   A2 — Trigger phone enrichment on complex addresses to find resident phones
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// Pilot complex IDs
const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];

// WhatsApp message template — directed at actual owner, not agent
const WA_MESSAGE = (complexName, city) =>
  `שלום, שמי חמי מ-QUANTUM נדל"ן.\n` +
  `אני מחפש דירה במתחם "${complexName}" ב${city} עבור משקיע רציני שמוכן לסגור מהר.\n` +
  `אם אתה/את בעל הדירה או מכיר מישהו שמוכר שם - שמח לשוחח.\n` +
  `תודה 🙏`;

// ============================================================
// GET /api/pilot/status
// מצב הפיילוט — כמה אנשי קשר, כמה נשלח, כמה ענו
// ============================================================
router.get('/status', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id as complex_id,
        c.name,
        c.city,
        c.iai_score,
        COUNT(DISTINCT l.id) as total_listings,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.phone IS NOT NULL AND l.phone != '') as unique_phones,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.message_status = 'נשלחה') as wa_sent,
        COUNT(DISTINCT l.phone) FILTER (WHERE l.last_reply_at IS NOT NULL) as replied,
        COUNT(DISTINCT l.id) FILTER (WHERE l.source IN ('facebook_group','web_facebook','web_yad2','web_madlan','web_forum')) as from_pilot_scan
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
// כל אנשי הקשר הייחודיים בפיילוט
// ============================================================
router.get('/contacts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.id as listing_id,
        l.phone,
        l.contact_name,
        l.source,
        l.asking_price,
        l.rooms,
        l.area_sqm,
        l.address,
        l.days_on_market,
        l.total_price_drop_percent,
        l.ssi_score,
        l.message_status,
        l.last_reply_at,
        l.last_reply_text,
        c.id as complex_id,
        c.name as complex_name,
        c.city,
        c.iai_score
      FROM listings l
      JOIN complexes c ON c.id = l.complex_id
      WHERE c.id = ANY($1)
        AND l.phone IS NOT NULL AND l.phone != ''
        AND l.is_active = true
      ORDER BY l.ssi_score DESC NULLS LAST, c.iai_score DESC, l.days_on_market DESC NULLS LAST
    `, [PILOT_IDS]);

    // Deduplicate by phone — keep highest SSI per phone
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
// שלח WhatsApp לכל אנשי קשר שעוד לא פנינו אליהם
// body: { dryRun: true/false, limit: 10, complexIds: [250, 205] }
// ============================================================
router.post('/send-wa', async (req, res) => {
  const { dryRun = true, limit = 20, complexIds = PILOT_IDS } = req.body;

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (l.phone)
        l.id as listing_id,
        l.phone,
        l.contact_name,
        c.id as complex_id,
        c.name as complex_name,
        c.city
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

    if (dryRun) {
      return res.json({
        success: true,
        dry_run: true,
        would_send: rows.length,
        preview: rows.map(r => ({
          phone: r.phone,
          contact: r.contact_name,
          complex: r.complex_name,
          city: r.city,
          message: WA_MESSAGE(r.complex_name, r.city)
        }))
      });
    }

    // Live send via INFORU
    const { sendWhatsApp } = require('../services/inforuService');
    let sent = 0, failed = 0;
    const results = [];

    for (const contact of rows) {
      try {
        const message = WA_MESSAGE(contact.complex_name, contact.city);
        await sendWhatsApp({ phone: contact.phone, message });

        // Mark as sent
        await pool.query(
          `UPDATE listings SET message_status = 'נשלחה', last_message_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [contact.listing_id]
        );

        sent++;
        results.push({ phone: contact.phone, complex: contact.complex_name, status: 'sent' });

        // Rate limit: 2 seconds between messages
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        failed++;
        results.push({ phone: contact.phone, complex: contact.complex_name, status: 'failed', error: err.message });
        logger.warn(`[Pilot] WA send failed to ${contact.phone}: ${err.message}`);
      }
    }

    logger.info(`[Pilot] WA campaign: sent=${sent}, failed=${failed}`);
    res.json({ success: true, sent, failed, results });

  } catch (err) {
    logger.error('[Pilot] Send WA error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/pilot/scan-fb
// הפעל סריקת Facebook ממוקדת ל-8 המתחמים (Track B)
// ============================================================
router.post('/scan-fb', async (req, res) => {
  const { complexIds = null } = req.body;
  try {
    const { scanPilotComplexes } = require('../services/facebookGroupsScraper');
    logger.info('[Pilot] Starting targeted Facebook/web scan...');

    // Run async — return immediately with job confirmation
    res.json({ success: true, message: 'סריקה התחילה ברקע', complexes: complexIds || PILOT_IDS });

    // Execute in background
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
// הפעל phone enrichment על כתובות המתחמים (חיפוש דיירים שלא מפרסמים)
// ============================================================
router.post('/enrich-phones', async (req, res) => {
  try {
    const { rows: complexes } = await pool.query(
      `SELECT id, name, city, addresses, address FROM complexes WHERE id = ANY($1)`,
      [PILOT_IDS]
    );

    // Queue each complex for phone enrichment via komo direct API
    const { enrichExistingListings } = require('../services/komoDirectScraper');

    res.json({ success: true, message: 'Phone enrichment מתחיל ברקע', complexes: complexes.map(c => ({ id: c.id, name: c.name, city: c.city })) });

    setImmediate(async () => {
      try {
        const result = await enrichExistingListings(100);
        logger.info('[Pilot] Phone enrichment done:', JSON.stringify(result));
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
