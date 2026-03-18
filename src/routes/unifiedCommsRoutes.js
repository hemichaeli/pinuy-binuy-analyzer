/**
 * Unified Communications Routes
 * 
 * SELLERS (outreach = whatsapp_conversations with sellers we contacted)
 *         (inbound = seller_inbound = sellers who contacted us)
 * 
 * GET  /api/comms/sellers              ?view=outreach|inbound&search=
 * GET  /api/comms/sellers/:id/messages ?view=outreach|inbound
 * POST /api/comms/sellers/:id/send     { message, phone }
 * POST /api/comms/sellers/inbound      { name, phone, address, source, initial_message }
 * 
 * BUYERS
 * GET  /api/comms/buyers               ?search=&source=&status=
 * GET  /api/comms/buyers/:id/messages
 * POST /api/comms/buyers/:id/send      { message, phone }
 * PATCH /api/comms/buyers/:id/status   { status }
 * 
 * LISTINGS
 * GET  /api/comms/listings
 * POST /api/comms/listings             { address, asking_price, rooms, area_sqm, floor, deal_type, description, target_platforms[] }
 * POST /api/comms/listings/:id/publish
 * 
 * STATS
 * GET  /api/comms/stats
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { publishListing, getPlatformStatus } = require('../services/listingPublisher');

// ─────────────────────────────────────────────
// INIT: ensure tables exist
// ─────────────────────────────────────────────
async function ensureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outgoing_listings (
        id                  SERIAL PRIMARY KEY,
        address             TEXT,
        city                TEXT,
        asking_price        BIGINT,
        rooms               NUMERIC(3,1),
        floor               INTEGER,
        area_sqm            INTEGER,
        deal_type           TEXT DEFAULT 'sale',
        description         TEXT,
        images              JSONB DEFAULT '[]',
        target_platforms    TEXT[] DEFAULT '{}',
        published_platforms TEXT[] DEFAULT '{}',
        status              TEXT DEFAULT 'draft',
        source              TEXT DEFAULT 'manual',
        notes               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS seller_inbound (
        id              SERIAL PRIMARY KEY,
        phone           TEXT NOT NULL,
        name            TEXT,
        source          TEXT DEFAULT 'flyer',
        address         TEXT,
        city            TEXT,
        asking_price    BIGINT,
        notes           TEXT,
        status          TEXT DEFAULT 'new',
        first_contact_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS seller_inbound_messages (
        id          SERIAL PRIMARY KEY,
        seller_id   INTEGER NOT NULL REFERENCES seller_inbound(id) ON DELETE CASCADE,
        direction   TEXT NOT NULL DEFAULT 'outgoing',
        channel     TEXT NOT NULL DEFAULT 'whatsapp',
        message     TEXT NOT NULL,
        status      TEXT DEFAULT 'sent',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buyer_conversations (
        id              SERIAL PRIMARY KEY,
        phone           TEXT NOT NULL,
        name            TEXT,
        source          TEXT DEFAULT 'unknown',
        campaign_id     INTEGER,
        outgoing_listing_id INTEGER,
        status          TEXT DEFAULT 'new',
        notes           TEXT,
        first_contact_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buyer_messages (
        id          SERIAL PRIMARY KEY,
        buyer_id    INTEGER NOT NULL REFERENCES buyer_conversations(id) ON DELETE CASCADE,
        direction   TEXT NOT NULL DEFAULT 'outgoing',
        channel     TEXT NOT NULL DEFAULT 'whatsapp',
        message     TEXT NOT NULL,
        status      TEXT DEFAULT 'sent',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    logger.info('[UnifiedComms] Tables ensured');
  } catch (err) {
    logger.error('[UnifiedComms] Table init error:', err.message);
  }
}
ensureTables();

// ─────────────────────────────────────────────
// HELPER: send WhatsApp via inforu
// ─────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  try {
    const axios = require('axios');
    const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
    const INFORU_TOKEN = process.env.INFORU_TOKEN || process.env.INFORU_API_TOKEN;
    const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '972' + cleanPhone.substring(1);
    if (!cleanPhone.startsWith('972')) cleanPhone = '972' + cleanPhone;
    const payload = {
      Data: { Message: message, Recipients: [{ Phone: cleanPhone }] },
      Settings: { BusinessLine: INFORU_BUSINESS_LINE },
      Authentication: { Username: INFORU_USERNAME, ApiToken: INFORU_TOKEN }
    };
    const resp = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return resp.data?.Status === 'SUCCESS' || resp.status === 200;
  } catch (e) {
    logger.error('[UnifiedComms] sendWhatsApp error:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [sellers, buyers, listings] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) as cnt FROM seller_inbound GROUP BY status`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as cnt FROM buyer_conversations GROUP BY status`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as cnt FROM outgoing_listings GROUP BY status`).catch(() => ({ rows: [] }))
    ]);
    const toMap = rows => rows.reduce((m, r) => { m[r.status] = parseInt(r.cnt); return m; }, {});
    res.json({ success: true, sellers: toMap(sellers.rows), buyers: toMap(buyers.rows), listings: toMap(listings.rows) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// SELLERS
// view=outreach → whatsapp_conversations (sellers we contacted)
// view=inbound  → seller_inbound (sellers who contacted us)
// ═══════════════════════════════════════════════
router.get('/sellers', async (req, res) => {
  try {
    const { view = 'outreach', search } = req.query;

    if (view === 'outreach') {
      // Use existing whatsapp_conversations table
      let q = `SELECT wc.id, wc.phone, wc.display_name, wc.city, wc.address,
                      wc.status, wc.last_message, wc.updated_at,
                      l.url as listing_url
               FROM whatsapp_conversations wc
               LEFT JOIN listings l ON l.id = wc.listing_id
               WHERE 1=1`;
      const params = [];
      let n = 1;
      if (search?.trim()) {
        q += ` AND (wc.phone ILIKE $${n} OR wc.display_name ILIKE $${n} OR wc.city ILIKE $${n} OR wc.address ILIKE $${n})`;
        params.push('%' + search.trim() + '%'); n++;
      }
      q += ` ORDER BY wc.updated_at DESC LIMIT 200`;
      const result = await pool.query(q, params).catch(async () => {
        // Fallback if whatsapp_conversations doesn't have listing_id
        const q2 = `SELECT id, phone, display_name, city, address, status, last_message, updated_at FROM whatsapp_conversations WHERE 1=1` +
          (search?.trim() ? ` AND (phone ILIKE $1 OR display_name ILIKE $1)` : '') + ` ORDER BY updated_at DESC LIMIT 200`;
        return pool.query(q2, search?.trim() ? ['%' + search.trim() + '%'] : []);
      });
      res.json({ success: true, data: result.rows, total: result.rows.length, view: 'outreach' });
    } else {
      // seller_inbound
      let q = `SELECT * FROM seller_inbound WHERE 1=1`;
      const params = [];
      let n = 1;
      if (search?.trim()) {
        q += ` AND (phone ILIKE $${n} OR name ILIKE $${n} OR address ILIKE $${n} OR city ILIKE $${n})`;
        params.push('%' + search.trim() + '%'); n++;
      }
      q += ` ORDER BY last_activity_at DESC LIMIT 200`;
      const result = await pool.query(q, params);
      res.json({ success: true, data: result.rows, total: result.rows.length, view: 'inbound' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comms/sellers/:id/messages
router.get('/sellers/:id/messages', async (req, res) => {
  try {
    const { view = 'outreach' } = req.query;
    const id = parseInt(req.params.id);

    if (view === 'outreach') {
      // whatsapp_conversations + whatsapp_messages
      const conv = await pool.query(`SELECT * FROM whatsapp_conversations WHERE id = $1`, [id]);
      if (!conv.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      const msgs = await pool.query(
        `SELECT id, direction, message, created_at FROM whatsapp_messages WHERE phone = $1 ORDER BY created_at ASC`,
        [conv.rows[0].phone]
      ).catch(() => ({ rows: [] }));
      res.json({ success: true, contact: conv.rows[0], data: msgs.rows });
    } else {
      // seller_inbound + seller_inbound_messages
      const seller = await pool.query(`SELECT * FROM seller_inbound WHERE id = $1`, [id]);
      if (!seller.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      const msgs = await pool.query(
        `SELECT id, direction, channel, message, status, created_at FROM seller_inbound_messages WHERE seller_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      // Also merge whatsapp_messages for same phone
      const waMsgs = await pool.query(
        `SELECT id, direction, message, created_at FROM whatsapp_messages WHERE phone = $1 ORDER BY created_at ASC`,
        [seller.rows[0].phone]
      ).catch(() => ({ rows: [] }));
      const allMsgs = [...msgs.rows, ...waMsgs.rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      res.json({ success: true, contact: seller.rows[0], data: allMsgs });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comms/sellers/:id/send
router.post('/sellers/:id/send', express.json(), async (req, res) => {
  try {
    const { message, phone, view = 'outreach' } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message required' });
    const id = parseInt(req.params.id);

    let targetPhone = phone;
    if (!targetPhone) {
      if (view === 'outreach') {
        const r = await pool.query(`SELECT phone FROM whatsapp_conversations WHERE id = $1`, [id]);
        targetPhone = r.rows[0]?.phone;
      } else {
        const r = await pool.query(`SELECT phone FROM seller_inbound WHERE id = $1`, [id]);
        targetPhone = r.rows[0]?.phone;
      }
    }
    if (!targetPhone) return res.status(400).json({ success: false, error: 'phone not found' });

    const sent = await sendWhatsApp(targetPhone, message);

    if (view === 'inbound') {
      await pool.query(
        `INSERT INTO seller_inbound_messages (seller_id, direction, channel, message, status) VALUES ($1,'outgoing','whatsapp',$2,$3)`,
        [id, message, sent ? 'sent' : 'failed']
      );
      await pool.query(`UPDATE seller_inbound SET last_activity_at = NOW() WHERE id = $1`, [id]);
    }
    // Also save to whatsapp_messages for unified view
    await pool.query(
      `INSERT INTO whatsapp_messages (phone, direction, message, status, created_at) VALUES ($1,'outgoing',$2,'sent',NOW())`,
      [targetPhone, message]
    ).catch(() => null);

    res.json({ success: sent, phone: targetPhone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comms/sellers/inbound - Add a new inbound seller
router.post('/sellers/inbound', express.json(), async (req, res) => {
  try {
    const { name, phone, address, source = 'flyer', initial_message } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const result = await pool.query(
      `INSERT INTO seller_inbound (phone, name, source, address) VALUES ($1,$2,$3,$4) RETURNING *`,
      [phone, name, source, address]
    );
    const seller = result.rows[0];
    if (initial_message) {
      await pool.query(
        `INSERT INTO seller_inbound_messages (seller_id, direction, channel, message) VALUES ($1,'incoming','manual',$2)`,
        [seller.id, initial_message]
      );
    }
    res.json({ success: true, seller });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// BUYERS
// ═══════════════════════════════════════════════
router.get('/buyers', async (req, res) => {
  try {
    const { search, status, source } = req.query;
    let q = `SELECT b.*, ol.address as listing_address
             FROM buyer_conversations b
             LEFT JOIN outgoing_listings ol ON ol.id = b.outgoing_listing_id
             WHERE 1=1`;
    const params = [];
    let n = 1;
    if (status) { q += ` AND b.status = $${n++}`; params.push(status); }
    if (source) { q += ` AND b.source = $${n++}`; params.push(source); }
    if (search?.trim()) {
      q += ` AND (b.phone ILIKE $${n} OR b.name ILIKE $${n})`;
      params.push('%' + search.trim() + '%'); n++;
    }
    q += ` ORDER BY b.last_activity_at DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comms/buyers/:id/messages
router.get('/buyers/:id/messages', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const buyer = await pool.query(
      `SELECT b.*, ol.address as listing_address FROM buyer_conversations b LEFT JOIN outgoing_listings ol ON ol.id = b.outgoing_listing_id WHERE b.id = $1`,
      [id]
    );
    if (!buyer.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const msgs = await pool.query(
      `SELECT * FROM buyer_messages WHERE buyer_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    // Also merge whatsapp_messages for same phone
    const waMsgs = await pool.query(
      `SELECT id, direction, message, created_at FROM whatsapp_messages WHERE phone = $1 ORDER BY created_at ASC`,
      [buyer.rows[0].phone]
    ).catch(() => ({ rows: [] }));
    const allMsgs = [...msgs.rows, ...waMsgs.rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json({ success: true, contact: buyer.rows[0], data: allMsgs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comms/buyers/:id/send
router.post('/buyers/:id/send', express.json(), async (req, res) => {
  try {
    const { message, phone } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message required' });
    const id = parseInt(req.params.id);

    let targetPhone = phone;
    if (!targetPhone) {
      const r = await pool.query(`SELECT phone FROM buyer_conversations WHERE id = $1`, [id]);
      targetPhone = r.rows[0]?.phone;
    }
    if (!targetPhone) return res.status(400).json({ success: false, error: 'phone not found' });

    const sent = await sendWhatsApp(targetPhone, message);
    await pool.query(
      `INSERT INTO buyer_messages (buyer_id, direction, channel, message, status) VALUES ($1,'outgoing','whatsapp',$2,$3)`,
      [id, message, sent ? 'sent' : 'failed']
    );
    await pool.query(`UPDATE buyer_conversations SET last_activity_at = NOW() WHERE id = $1`, [id]);
    await pool.query(
      `INSERT INTO whatsapp_messages (phone, direction, message, status, created_at) VALUES ($1,'outgoing',$2,'sent',NOW())`,
      [targetPhone, message]
    ).catch(() => null);

    res.json({ success: sent, phone: targetPhone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/comms/buyers/:id/status
router.patch('/buyers/:id/status', express.json(), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new', 'active', 'qualified', 'closed'];
    if (!valid.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
    const result = await pool.query(
      `UPDATE buyer_conversations SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json({ success: true, buyer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// OUTGOING LISTINGS
// ═══════════════════════════════════════════════
router.get('/listings', async (req, res) => {
  try {
    const { status, deal_type } = req.query;
    let q = `SELECT * FROM outgoing_listings WHERE 1=1`;
    const params = [];
    let n = 1;
    if (status) { q += ` AND status = $${n++}`; params.push(status); }
    if (deal_type) { q += ` AND deal_type = $${n++}`; params.push(deal_type); }
    q += ` ORDER BY updated_at DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comms/listings
router.post('/listings', express.json(), async (req, res) => {
  try {
    const {
      address, city, asking_price, rooms, floor, area_sqm,
      deal_type = 'sale', description, target_platforms = [], notes
    } = req.body;
    if (!address) return res.status(400).json({ success: false, error: 'address required' });
    const result = await pool.query(
      `INSERT INTO outgoing_listings (address, city, asking_price, rooms, floor, area_sqm, deal_type, description, target_platforms, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [address, city, asking_price, rooms, floor, area_sqm, deal_type, description, target_platforms, notes]
    );
    const listing = result.rows[0];
    // If target_platforms specified, trigger async publishing
    if (target_platforms.length > 0) {
      triggerPublish(listing.id, target_platforms).catch(e => logger.error('[Publish] Error:', e.message));
    }
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comms/listings/:id/publish
router.post('/listings/:id/publish', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const listing = await pool.query(`SELECT * FROM outgoing_listings WHERE id = $1`, [id]);
    if (!listing.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const platforms = req.body.platforms || listing.rows[0].target_platforms || [];
    if (!platforms.length) return res.status(400).json({ success: false, error: 'No platforms specified' });
    // Mark as publishing
    await pool.query(`UPDATE outgoing_listings SET status = 'publishing', updated_at = NOW() WHERE id = $1`, [id]);
    // Trigger async publish (non-blocking)
    publishListing(id, platforms)
      .then(results => logger.info(`[Publish] Done for listing ${id}:`, JSON.stringify(results)))
      .catch(e => logger.error('[Publish] Error:', e.message));
    res.json({ success: true, message: 'פרסום התחיל', platforms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comms/platforms/status — which platforms are configured
router.get('/platforms/status', (req, res) => {
  res.json({ success: true, platforms: getPlatformStatus() });
});

module.exports = router;
