/**
 * QUANTUM Dashboard API Routes
 * HTML is served from /dashboard (dashboardRoute.js -> src/views/dashboard.html)
 * This file provides all the DATA API endpoints used by the dashboard.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { enrichNewListings } = require('../services/adEnrichmentService');

// Redirect root to the new dashboard
router.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ===== NEW DASHBOARD V2 API ENDPOINTS =====

// API: All Ads with comprehensive data
router.get('/ads/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        l.*,
        c.name as complex_name,
        c.city as complex_city,
        c.iai_score,
        l.asking_price as price,
        CASE 
          WHEN l.asking_price > 0 AND c.iai_score > 0 
          THEN l.asking_price * (1 + (c.iai_score * 0.003))
          ELSE l.asking_price * 1.2
        END as potential_price,
        CASE 
          WHEN l.asking_price > 0 AND c.iai_score > 0 
          THEN (c.iai_score * 0.3)
          ELSE 20
        END as premium_percent,
        l.contact_phone as phone,
        l.created_at as date,
        l.title,
        l.address,
        l.gemini_urgency_flag,
        l.gemini_urgency_reason,
        l.gemini_hidden_info,
        l.exact_address_enriched,
        l.gemini_score_boost,
        l.building_year,
        l.building_age,
        l.nearby_plans,
        l.has_renewal_plan,
        l.recent_transactions,
        l.avg_price_sqm_area,
        l.perplexity_public_notes,
        l.gemini_enriched_at,
        l.perplexity_enriched_at
      FROM listings l 
      LEFT JOIN complexes c ON l.complex_id = c.id 
      WHERE l.is_active = true 
      ORDER BY l.created_at DESC 
      LIMIT 1000
    `);
    
    // Calculate premium amount
    const listings = rows.map(row => ({
      ...row,
      premium_amount: row.potential_price - row.price
    }));
    
    res.json({ ads: listings });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: Ads Statistics
router.get('/ads/stats', async (req, res) => {
  try {
    const [totalRes, newRes, avgPriceRes, withPhoneRes, hotRes] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) as count FROM listings WHERE is_active = true AND created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query('SELECT AVG(asking_price) as avg FROM listings WHERE is_active = true AND asking_price > 0'),
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true AND contact_phone IS NOT NULL'),
      pool.query(`SELECT COUNT(*) as count FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true AND c.iai_score > 80`)
    ]);

    res.json({
      active: totalRes.rows[0]?.count || 0,
      new_leads: newRes.rows[0]?.count || 0,
      avg_price: Math.round(avgPriceRes.rows[0]?.avg || 0),
      with_phone: withPhoneRes.rows[0]?.count || 0,
      hot_opportunities: hotRes.rows[0]?.count || 0,
      today_calls: Math.floor(Math.random() * 20) + 5, // Mock data - replace with real call tracking
      monthly_deals: Math.floor(Math.random() * 10) + 3 // Mock data - replace with real deal tracking
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: All Messages (Mock data - replace with real message integration)
router.get('/messages/all', async (req, res) => {
  try {
    // Mock message data - replace with real WhatsApp/Email integration
    const messages = [
      {
        id: 1,
        platform: 'WhatsApp',
        sender: 'דוד כהן',
        content: 'שלום, מעוניין לשמוע על דירות בתל אביב בטווח של 2.5-3 מיליון',
        status: 'new',
        date: new Date(),
        phone: '050-1234567'
      },
      {
        id: 2,
        platform: 'Email', 
        sender: 'שרה לוי',
        content: 'בדקתי את הפרויקט שהצעתם בהרצליה, נשמע מעניין. מתי נוכל לקבוע פגישה?',
        status: 'read',
        date: new Date(Date.now() - 3600000),
        email: 'sarah.levi@email.com'
      },
      {
        id: 3,
        platform: 'WhatsApp',
        sender: 'מיכאל שחר',
        content: 'תודה על המידע. אשמח לקבל עוד פרטים על התהליך המשפטי',
        status: 'replied',
        date: new Date(Date.now() - 7200000),
        phone: '052-9876543'
      }
    ];
    
    res.json({ messages });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: Messages Statistics  
router.get('/messages/stats', async (req, res) => {
  try {
    // Mock data - replace with real message tracking
    res.json({
      new: Math.floor(Math.random() * 30) + 10,
      whatsapp: Math.floor(Math.random() * 50) + 20,
      email: Math.floor(Math.random() * 20) + 5,
      response_rate: Math.floor(Math.random() * 30) + 60
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: All Complexes with comprehensive data
router.get('/complexes/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        id,
        name,
        city,
        existing_units,
        planned_units,
        iai_score,
        status,
        updated_at,
        address,
        developer,
        approval_date,
        signature_percent
      FROM complexes 
      ORDER BY iai_score DESC NULLS LAST, updated_at DESC
      LIMIT 1000
    `);
    
    res.json({ complexes: rows });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: All Buyers/Leads (Mock data - replace with real CRM integration)
router.get('/buyers/all', async (req, res) => {
  try {
    // Mock buyer data - replace with real CRM integration
    const buyers = [
      {
        id: 1,
        name: 'אברהם כהן',
        phone: '050-1234567',
        email: 'avraham.cohen@email.com',
        status: 'qualified',
        source: 'website',
        budget: 2800000,
        last_contact: new Date(),
        notes: 'מחפש דירת 4 חדרים בתל אביב'
      },
      {
        id: 2,
        name: 'רחל לוי',
        phone: '052-7654321',
        email: 'rachel.levy@email.com',
        status: 'negotiating',
        source: 'whatsapp',
        budget: 3200000,
        last_contact: new Date(Date.now() - 86400000),
        notes: 'במו"מ על פרויקט בהרצליה'
      },
      {
        id: 3,
        name: 'יוסף דוד',
        phone: '054-9876543',
        email: 'yosef.david@email.com',
        status: 'new',
        source: 'facebook',
        budget: 2100000,
        last_contact: new Date(Date.now() - 172800000),
        notes: 'ליד חדש מפייסבוק'
      }
    ];
    
    res.json({ buyers });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: News Feed (Activity tracking)
router.get('/news', async (req, res) => {
  try {
    const { period } = req.query;
    
    // Mock news data - replace with real activity tracking
    const news = [
      {
        id: 1,
        type: 'ad',
        title: 'מודעה חדשה נוספה',
        description: 'דירת 4 חדרים בתל אביב - ₪2.8M',
        timestamp: new Date(),
        icon: 'home'
      },
      {
        id: 2,
        type: 'lead',
        title: 'ליד חדש התקבל',
        description: 'קונה פוטנציאלי בהרצליה עם תקציב ₪3.2M',
        timestamp: new Date(Date.now() - 1800000),
        icon: 'person_add'
      },
      {
        id: 3,
        type: 'complex',
        title: 'עדכון מתחם',
        description: 'פרויקט "הנחל" - אושרה תוכנית חדשה',
        timestamp: new Date(Date.now() - 3600000),
        icon: 'domain'
      }
    ];
    
    res.json({ news });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: Call Statistics (Mock data - replace with real call tracking)
router.get('/calls/stats', async (req, res) => {
  try {
    res.json({
      today: {
        total: 12,
        answered: 8,
        missed: 4,
        leads_generated: 3
      },
      week: {
        total: 67,
        answered: 45,
        missed: 22,
        leads_generated: 15
      },
      month: {
        total: 289,
        answered: 201,
        missed: 88,
        leads_generated: 67
      }
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// API: Lead Statistics
router.get('/leads/stats', async (req, res) => {
  try {
    // Mock data - replace with real lead tracking
    res.json({
      total: 156,
      new_this_month: 23,
      converted: 12,
      active: 89,
      conversion_rate: 7.7
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ===== EXISTING ENDPOINTS =====

// API: Get single complex
router.get('/complex/:id', async (req, res) => {
  try {
    const complex = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!complex.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(complex.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get listings with filters
router.get('/listings', async (req, res) => {
  try {
    const { city, source, sort = 'iai', limit = 100 } = req.query;
    let query = `SELECT l.*, c.name as complex_name, c.city as complex_city, c.status as complex_status, c.iai_score, c.developer, c.slug as complex_slug, c.id as cid FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true`;
    const params = [];
    if (city) { params.push(city); query += ` AND l.city = $${params.length}`; }
    if (source) { params.push(source); query += ` AND l.source = $${params.length}`; }
    const sortMap = { iai: 'c.iai_score DESC NULLS LAST', price: 'l.asking_price ASC NULLS LAST', days: 'l.days_on_market DESC NULLS LAST', ssi: 'l.ssi_score DESC NULLS LAST' };
    query += ` ORDER BY ${sortMap[sort] || sortMap.iai} LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) || 100);
    const { rows } = await pool.query(query, params);
    const cities = [...new Set(rows.map(r => r.city || r.complex_city).filter(Boolean))].sort();
    const sources = [...new Set(rows.map(r => r.source).filter(Boolean))].sort();
    res.json({ listings: rows, cities, sources });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Mark listings as messaged
router.post('/listings/message-sent', express.json(), async (req, res) => {
  try {
    const { listing_ids, status, deal_status } = req.body;
    if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'No listing IDs' });
    for (const id of listing_ids) {
      await pool.query(`UPDATE listings SET message_status = $1, last_message_sent_at = $2, deal_status = $3, updated_at = $2 WHERE id = $4`, [status || 'sent', new Date(), deal_status || 'contacted', id]);
    }
    res.json({ success: true, updated: listing_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get committees (complexes ordered by date)
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

// API: Get single complex details
router.get('/complexes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Yad2 listings
router.get('/yad2/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'yad2' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Kones listings
router.get('/kones/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'kones' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: WhatsApp subscription stats
router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as "totalSubscriptions", SUM(CASE WHEN active = true THEN 1 ELSE 0 END) as "activeSubscriptions", COUNT(DISTINCT lead_id) as "uniqueLeads", COALESCE(SUM(alerts_sent), 0) as "totalAlertsSent" FROM whatsapp_subscriptions`);
    res.json(rows[0] || { totalSubscriptions: 0, activeSubscriptions: 0, uniqueLeads: 0, totalAlertsSent: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get subscriptions by lead
router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM whatsapp_subscriptions WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.leadId]);
    res.json(rows.map(row => ({ ...row, criteria: row.criteria ? JSON.parse(row.criteria) : {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Test WhatsApp subscription
router.post('/whatsapp/subscriptions/test', express.json(), async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Lead ID required' });
    res.json({ success: true, message: 'Test notification queued', leadId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Create subscription
router.post('/whatsapp/subscriptions', express.json(), async (req, res) => {
  try {
    const { lead_id, criteria } = req.body;
    if (!lead_id || !criteria || !Object.keys(criteria).length) return res.status(400).json({ error: 'Criteria required' });
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_subscriptions (lead_id, criteria, active, created_at, updated_at) VALUES ($1, $2, true, NOW(), NOW()) RETURNING *`,
      [lead_id, JSON.stringify(criteria)]
    );
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Toggle subscription
router.patch('/whatsapp/subscriptions/:id/toggle', express.json(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE whatsapp_subscriptions SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Delete subscription
router.delete('/whatsapp/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== SCHEDULING / APPOINTMENTS OVERVIEW =====

// API: Scheduling overview — sessions + slots summary
router.get('/scheduling/overview', async (req, res) => {
  try {
    const [sessionStats, slotStats, ceremonyStats, contacts] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN state = 'confirmed' THEN 1 END) AS confirmed,
          COUNT(CASE WHEN state IN ('declined','cancelled') THEN 1 END) AS declined,
          COUNT(CASE WHEN state NOT IN ('confirmed','declined','cancelled') THEN 1 END) AS pending,
          COUNT(CASE WHEN language = 'ru' THEN 1 END) AS russian,
          COUNT(CASE WHEN language = 'he' THEN 1 END) AS hebrew
        FROM bot_sessions
        WHERE created_at > NOW() - INTERVAL '30 days'
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS confirmed,
          COUNT(CASE WHEN status = 'open' THEN 1 END) AS open,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled
        FROM meeting_slots
        WHERE created_at > NOW() - INTERVAL '30 days'
      `).catch(() => ({ rows: [{ total: 0, confirmed: 0, open: 0, cancelled: 0 }] })),
      pool.query(`
        SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS confirmed
        FROM ceremony_slots
        WHERE slot_date >= CURRENT_DATE
      `).catch(() => ({ rows: [{ total: 0, confirmed: 0 }] })),
      pool.query(`
        SELECT
          bs.phone,
          bs.context->>'contactName' AS contact_name,
          bs.zoho_campaign_id AS campaign_id,
          bs.state,
          bs.language,
          bs.last_message_at,
          ms.slot_datetime,
          TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY HH24:MI') AS slot_display,
          ms.representative_name,
          ms.meeting_type,
          csc.meeting_type AS campaign_meeting_type
        FROM bot_sessions bs
        LEFT JOIN meeting_slots ms ON ms.contact_phone = bs.phone AND ms.campaign_id = bs.zoho_campaign_id AND ms.status = 'confirmed'
        LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id = bs.zoho_campaign_id
        WHERE bs.created_at > NOW() - INTERVAL '30 days'
        ORDER BY bs.last_message_at DESC
        LIMIT 200
      `).catch(() => ({ rows: [] }))
    ]);
    res.json({
      success: true,
      sessions: sessionStats.rows[0],
      slots: slotStats.rows[0],
      ceremonies: ceremonyStats.rows[0],
      contacts: contacts.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// API: Manually trigger enrichment for unenriched listings
router.post('/ads/enrich', async (req, res) => {
  try {
    const limit = parseInt(req.body?.limit) || 20;
    const result = await enrichNewListings(limit);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Enrich a specific listing
router.post('/ads/enrich/:id', async (req, res) => {
  try {
    const { enrichListing } = require('../services/adEnrichmentService');
    const { rows } = await pool.query(
      'SELECT l.*, c.iai_score FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const result = await enrichListing(rows[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;