/**
 * QUANTUM Dashboard API Routes v2.2
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { enrichNewListings } = require('../services/adEnrichmentService');

router.get('/', (req, res) => { res.redirect('/dashboard'); });

// API: All Ads
router.get('/ads/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*,
        c.name as complex_name, c.city as complex_city,
        c.iai_score,
        l.asking_price as price,
        CASE WHEN l.asking_price > 0 AND c.iai_score > 0 THEN l.asking_price * (1 + (c.iai_score * 0.003)) ELSE l.asking_price * 1.2 END as potential_price,
        CASE WHEN l.asking_price > 0 AND c.iai_score > 0 THEN (c.iai_score * 0.3) ELSE 20 END as premium_percent
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true ORDER BY l.created_at DESC LIMIT 1000
    `);
    res.json({ ads: rows.map(row => ({ ...row, premium_amount: (row.potential_price||0) - (row.price||0) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Ads Statistics
router.get('/ads/stats', async (req, res) => {
  try {
    const [t, n, a, p, h] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) as count FROM listings WHERE is_active = true AND created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query('SELECT AVG(asking_price) as avg FROM listings WHERE is_active = true AND asking_price > 0'),
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true AND phone IS NOT NULL'),
      pool.query(`SELECT COUNT(*) as count FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true AND c.iai_score > 80`)
    ]);
    res.json({ active: t.rows[0]?.count||0, new_leads: n.rows[0]?.count||0, avg_price: Math.round(a.rows[0]?.avg||0), with_phone: p.rows[0]?.count||0, hot_opportunities: h.rows[0]?.count||0, today_calls: 8, monthly_deals: 5 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/all', (req, res) => res.json({ messages: [] }));
router.get('/messages/stats', (req, res) => res.json({ new: 15, whatsapp: 40, email: 10, response_rate: 70 }));

// API: All Complexes
router.get('/complexes/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, city, existing_units, planned_units, iai_score, status, updated_at, address, developer, approval_date, signature_percent FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT 1000`);
    res.json({ complexes: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/buyers/all', (req, res) => res.json({ buyers: [] }));
router.get('/news', (req, res) => res.json({ news: [] }));
router.get('/calls/stats', (req, res) => res.json({ today: { total: 0 }, week: { total: 0 }, month: { total: 0 } }));
router.get('/leads/stats', (req, res) => res.json({ total: 0, new_this_month: 0, converted: 0, active: 0, conversion_rate: 0 }));

// API: Get single complex
router.get('/complex/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get listings with full outreach filter support
// Params: city, complex_slug, source, sort, limit, is_active,
//         min_rooms, max_rooms, min_price, max_price, min_ssi, min_iai, message_status
router.get('/listings', async (req, res) => {
  try {
    const { city, complex_slug, source, sort = 'iai', limit = 200, is_active, min_rooms, max_rooms, min_price, max_price, min_ssi, min_iai, message_status } = req.query;

    const params = [];
    const conditions = [is_active === 'false' ? 'l.is_active = false' : 'l.is_active = true'];

    if (city) { params.push(`%${city}%`); conditions.push(`l.city ILIKE $${params.length}`); }
    if (complex_slug) { params.push(complex_slug); conditions.push(`c.slug = $${params.length}`); }
    if (source) { params.push(source); conditions.push(`l.source = $${params.length}`); }
    if (min_rooms) { params.push(parseFloat(min_rooms)); conditions.push(`l.rooms >= $${params.length}`); }
    if (max_rooms) { params.push(parseFloat(max_rooms)); conditions.push(`l.rooms <= $${params.length}`); }
    if (min_price) { params.push(parseFloat(min_price)); conditions.push(`l.asking_price >= $${params.length}`); }
    if (max_price) { params.push(parseFloat(max_price)); conditions.push(`l.asking_price <= $${params.length}`); }
    if (min_ssi) { params.push(parseFloat(min_ssi)); conditions.push(`l.ssi_score >= $${params.length}`); }
    if (min_iai) { params.push(parseFloat(min_iai)); conditions.push(`c.iai_score >= $${params.length}`); }

    if (message_status) {
      if (message_status === 'none') conditions.push(`(l.message_status IS NULL OR l.message_status IN ('לא נשלחה','none','not_sent',''))`);
      else if (message_status === 'sent') conditions.push(`l.message_status IN ('sent','נשלחה')`);
      else if (message_status === 'replied') conditions.push(`l.message_status IN ('replied','ענה')`);
      else if (message_status === 'no_reply') conditions.push(`l.message_status IN ('no_reply','ללא מענה')`);
      else { params.push(message_status); conditions.push(`l.message_status = $${params.length}`); }
    }

    const sortMap = { iai: 'c.iai_score DESC NULLS LAST', price: 'l.asking_price ASC NULLS LAST', days: 'l.days_on_market DESC NULLS LAST', ssi: 'l.ssi_score DESC NULLS LAST', new: 'l.created_at DESC' };
    const lim = Math.min(parseInt(limit) || 200, 500);

    const { rows } = await pool.query(`
      SELECT
        l.id, l.address, l.title, l.city, l.rooms, l.asking_price, l.area_sqm,
        l.ssi_score, l.message_status, l.contact_attempts,
        l.last_message_sent_at, l.last_reply_at, l.deal_status, l.source,
        l.phone, l.contact_name, l.created_at,
        c.name   AS complex_name,
        c.city   AS complex_city,
        c.slug   AS complex_slug,
        c.id     AS cid,
        c.iai_score,
        c.status AS complex_status,
        c.developer
      FROM listings l
      LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortMap[sort] || sortMap.iai}
      LIMIT ${lim}
    `, params);

    res.json({ listings: rows, cities: [...new Set(rows.map(r => r.city||r.complex_city).filter(Boolean))].sort(), sources: [...new Set(rows.map(r => r.source).filter(Boolean))].sort(), total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Mark listings as messaged
router.post('/listings/message-sent', express.json(), async (req, res) => {
  try {
    const { listing_ids, status, deal_status } = req.body;
    if (!listing_ids?.length) return res.status(400).json({ error: 'No listing IDs' });
    for (const id of listing_ids) {
      await pool.query(`UPDATE listings SET message_status=$1, last_message_sent_at=$2, deal_status=$3, updated_at=$2 WHERE id=$4`, [status||'sent', new Date(), deal_status||'contacted', id]);
    }
    res.json({ success: true, updated: listing_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get committees
router.get('/committees', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name as complex_name, city, status, approval_date as date, deposit_date, plan_number FROM complexes ORDER BY approval_date DESC NULLS LAST, updated_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get all complexes
router.get('/complexes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, city, iai_score, signature_percent FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT 500`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/complexes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/yad2/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'yad2' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/kones/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'kones' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WhatsApp subscriptions
router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as "totalSubscriptions", SUM(CASE WHEN active=true THEN 1 ELSE 0 END) as "activeSubscriptions", COUNT(DISTINCT lead_id) as "uniqueLeads", COALESCE(SUM(alerts_sent),0) as "totalAlertsSent" FROM whatsapp_subscriptions`);
    res.json(rows[0] || { totalSubscriptions: 0, activeSubscriptions: 0, uniqueLeads: 0, totalAlertsSent: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM whatsapp_subscriptions WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.leadId]);
    res.json(rows.map(r => ({ ...r, criteria: r.criteria ? JSON.parse(r.criteria) : {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/whatsapp/subscriptions/test', express.json(), async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Lead ID required' });
  res.json({ success: true, message: 'Test notification queued', leadId });
});

router.post('/whatsapp/subscriptions', express.json(), async (req, res) => {
  try {
    const { lead_id, criteria } = req.body;
    if (!lead_id || !criteria || !Object.keys(criteria).length) return res.status(400).json({ error: 'Criteria required' });
    const { rows } = await pool.query(`INSERT INTO whatsapp_subscriptions (lead_id, criteria, active, created_at, updated_at) VALUES ($1,$2,true,NOW(),NOW()) RETURNING *`, [lead_id, JSON.stringify(criteria)]);
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/whatsapp/subscriptions/:id/toggle', express.json(), async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE whatsapp_subscriptions SET active = NOT active, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/whatsapp/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scheduling overview
router.get('/scheduling/overview', async (req, res) => {
  try {
    const [sess, slots, cere, contacts] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN state='confirmed' THEN 1 END) AS confirmed, COUNT(CASE WHEN state IN ('declined','cancelled') THEN 1 END) AS declined, COUNT(CASE WHEN state NOT IN ('confirmed','declined','cancelled') THEN 1 END) AS pending, COUNT(CASE WHEN language='ru' THEN 1 END) AS russian, COUNT(CASE WHEN language='he' THEN 1 END) AS hebrew FROM bot_sessions WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed, COUNT(CASE WHEN status='open' THEN 1 END) AS open, COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled FROM meeting_slots WHERE created_at > NOW() - INTERVAL '30 days'`).catch(()=>({rows:[{total:0,confirmed:0,open:0,cancelled:0}]})),
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed FROM ceremony_slots WHERE slot_date >= CURRENT_DATE`).catch(()=>({rows:[{total:0,confirmed:0}]})),
      pool.query(`SELECT bs.phone, bs.context->>'contactName' AS contact_name, bs.zoho_campaign_id AS campaign_id, bs.state, bs.language, bs.last_message_at, ms.slot_datetime, TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','DD/MM/YYYY HH24:MI') AS slot_display, ms.representative_name, ms.meeting_type, csc.meeting_type AS campaign_meeting_type FROM bot_sessions bs LEFT JOIN meeting_slots ms ON ms.contact_phone=bs.phone AND ms.campaign_id=bs.zoho_campaign_id AND ms.status='confirmed' LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id=bs.zoho_campaign_id WHERE bs.created_at > NOW() - INTERVAL '30 days' ORDER BY bs.last_message_at DESC LIMIT 200`).catch(()=>({rows:[]}))
    ]);
    res.json({ success: true, sessions: sess.rows[0], slots: slots.rows[0], ceremonies: cere.rows[0], contacts: contacts.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Enrichment
router.post('/ads/enrich', async (req, res) => {
  try {
    const result = await enrichNewListings(parseInt(req.body?.limit) || 20);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ads/enrich/:id', async (req, res) => {
  try {
    const { enrichListing } = require('../services/adEnrichmentService');
    const { rows } = await pool.query('SELECT l.*, c.iai_score AS complex_iai FROM listings l LEFT JOIN complexes c ON l.complex_id=c.id WHERE l.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true, ...(await enrichListing(rows[0])) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update phone
router.post('/ads/update-phone', express.json(), async (req, res) => {
  try {
    const { source_url, source_listing_id, phone, contact_name, source } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    let result = { rowCount: 0, rows: [] };
    if (source_listing_id && source) {
      const r = await pool.query(`UPDATE listings SET phone=$1, contact_name=COALESCE($2,contact_name), last_seen=CURRENT_DATE WHERE source=$3 AND source_listing_id=$4 AND (phone IS NULL OR phone='') RETURNING id,source,source_listing_id,phone,contact_name`, [phone, contact_name||null, source, source_listing_id]);
      if (r.rowCount > 0) result = r;
    }
    if (result.rowCount === 0 && source_url) {
      const r = await pool.query(`UPDATE listings SET phone=$1, contact_name=COALESCE($2,contact_name), last_seen=CURRENT_DATE WHERE url=$3 AND (phone IS NULL OR phone='') RETURNING id,source,source_listing_id,phone,contact_name`, [phone, contact_name||null, source_url]);
      if (r.rowCount > 0) result = r;
    }
    res.json({ success: true, updated: result.rowCount, rows: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk insert from extension
router.post('/ads/bulk-insert', express.json(), async (req, res) => {
  try {
    const { listings } = req.body;
    if (!Array.isArray(listings)) return res.status(400).json({ error: 'listings array required' });
    let inserted = 0, updated = 0;
    const newListingIds = [];
    for (const l of listings) {
      if (!l.source || !l.url) continue;
      try {
        const r = await pool.query(
          `INSERT INTO listings (source,source_listing_id,url,phone,contact_name,asking_price,rooms,area_sqm,floor,address,city,description_snippet,first_seen,last_seen,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,CURRENT_DATE,TRUE) ON CONFLICT (source,source_listing_id) DO UPDATE SET phone=COALESCE(EXCLUDED.phone,listings.phone), contact_name=COALESCE(EXCLUDED.contact_name,listings.contact_name), asking_price=COALESCE(EXCLUDED.asking_price,listings.asking_price), last_seen=CURRENT_DATE RETURNING id,(xmax=0) as is_new`,
          [l.source, l.source_listing_id||l.url, l.url, l.phone||null, l.contact_name||null, l.price?parseFloat(l.price):null, l.rooms?parseFloat(l.rooms):null, l.area?parseFloat(l.area):null, l.floor?parseInt(l.floor):null, l.address||null, l.city||null, (l.description||'').substring(0,500)]
        );
        if (r.rows[0]?.is_new) { inserted++; newListingIds.push(r.rows[0].id); } else updated++;
      } catch(e) { console.error('[bulk-insert] Row error:', e.message); }
    }
    res.json({ success: true, inserted, updated, total: listings.length });
    // Trigger async Perplexity+Gemini enrichment for newly inserted listings (non-blocking)
    if (newListingIds.length > 0) {
      setImmediate(async () => {
        try {
          const { enrichListing } = require('../services/adEnrichmentService');
          for (const lid of newListingIds) {
            try {
              const { rows } = await pool.query(
                `SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor,
                        l.description_snippet, l.title, l.source, l.phone,
                        COALESCE(c.iai_score, 0) as iai_score
                 FROM listings l
                 LEFT JOIN complexes c ON l.complex_id = c.id
                 WHERE l.id = $1`, [lid]
              );
              if (rows[0]) {
                await enrichListing(rows[0]);
              }
            } catch(e) { /* ignore per-listing errors */ }
          }
        } catch(e) { /* ignore enrichment errors */ }
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
