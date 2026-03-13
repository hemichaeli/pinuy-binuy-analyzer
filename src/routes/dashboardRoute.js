const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const path = require('path');
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});


router.get('/api/stats', async (req, res) => {
    try {
        const [complexes, listings, opportunities, messages, leads, deals, kones] = await Promise.all([
            pool.query('SELECT COUNT(*) as total FROM complexes'),
            pool.query('SELECT COUNT(*) as total FROM listings WHERE is_active = TRUE'),
            pool.query('SELECT COUNT(*) as total FROM complexes WHERE iai_score > 75'),
            pool.query("SELECT COUNT(*) as total FROM whatsapp_conversations WHERE status = 'active'").catch(() => ({ rows: [{ total: 0 }] })),
            pool.query("SELECT COUNT(*) as total FROM website_leads WHERE status IN ('contacted','qualified')"),
            pool.query("SELECT COUNT(*) as total FROM listings WHERE deal_status IN ('תיווך','סגור')"),
            pool.query('SELECT COUNT(*) as total FROM kones_assets').catch(() => ({ rows: [{ total: 0 }] }))
        ]);
        res.json({ success: true, data: {
            totalComplexes: parseInt(complexes.rows[0]?.total) || 0,
            newListings: parseInt(listings.rows[0]?.total) || 0,
            hotOpportunities: parseInt(opportunities.rows[0]?.total) || 0,
            activeMessages: parseInt(messages.rows[0]?.total) || 0,
            qualifiedLeads: parseInt(leads.rows[0]?.total) || 0,
            closedDeals: parseInt(deals.rows[0]?.total) || 0,
            konesCount: parseInt(kones.rows[0]?.total) || 0
        }});
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/kones', async (req, res) => {
    try {
        const { city, status, search } = req.query;
        let query = `SELECT id, COALESCE(address, city, 'כינוס נכסים') as title, address, city, price, phone,
                            contact_status, contact_attempts, last_contact_at,
                            source, contact_person, email, url, gush_helka,
                            submission_deadline, property_type, created_at
                     FROM kones_listings WHERE is_active = TRUE`;
        const params = [];
        let n = 1;
        if (city?.trim()) { query += ` AND city ILIKE $${n}`; params.push('%' + city.trim() + '%'); n++; }
        if (status) { query += ` AND contact_status = $${n}`; params.push(status); n++; }
        if (search?.trim()) { query += ` AND (address ILIKE $${n} OR city ILIKE $${n} OR COALESCE(contact_person,'') ILIKE $${n})`; params.push('%' + search.trim() + '%'); n++; }
        query += ` ORDER BY created_at DESC LIMIT 100`;
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/whatsapp/messages', async (req, res) => {
    try {
        const query = `
            SELECT lm.id, lm.listing_id, l.phone as sender_phone, l.contact_name as sender_name,
                   lm.message_text as message_content, lm.status, lm.direction,
                   lm.created_at, NULL::integer as lead_id, l.source as source_platform
            FROM listing_messages lm
            LEFT JOIN listings l ON lm.listing_id = l.id
            WHERE lm.direction = 'received'
            ORDER BY lm.created_at DESC LIMIT 100`;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/leads', async (req, res) => {
    try {
        const { status } = req.query;
        let query = `SELECT id, name, phone, email, user_type, status, source, notes, is_urgent, created_at FROM website_leads WHERE 1=1`;
        const params = [];
        if (status) { query += ` AND status = $1`; params.push(status); }
        query += ` ORDER BY created_at DESC LIMIT 100`;
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/complexes', async (req, res) => {
    try {
        const { city, minIAI, maxIAI, status, sortBy, sortOrder } = req.query;
        let query = `SELECT id, name, city, address, existing_units as units_count, planned_units, iai_score, status, developer, theoretical_premium_min, theoretical_premium_max, permit_date, approval_date, deposit_date, declaration_date FROM complexes WHERE 1=1`;
        const params = [];
        let n = 1;
        if (city?.trim()) { query += ` AND city ILIKE $${n}`; params.push('%' + city.trim() + '%'); n++; }
        if (minIAI && !isNaN(minIAI)) { query += ` AND iai_score >= $${n}`; params.push(parseFloat(minIAI)); n++; }
        if (maxIAI && !isNaN(maxIAI)) { query += ` AND iai_score <= $${n}`; params.push(parseFloat(maxIAI)); n++; }
        if (status) { query += ` AND status = $${n}`; params.push(status); n++; }
        const validSort = ['name', 'city', 'iai_score', 'existing_units'];
        const sortField = validSort.includes(sortBy) ? sortBy : 'iai_score';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${sortField} ${order} NULLS LAST LIMIT 100`;
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/ads', async (req, res) => {
    try {
        const { city, minPrice, maxPrice, search, sortBy, sortOrder, phoneFilter, contactStatus, page = 1, limit = 50 } = req.query;
        let query = `
            SELECT l.id,
                   COALESCE(l.description_snippet, l.address, 'מודעה') as title,
                   l.city, l.address,
                   l.asking_price as price_current,
                   l.area_sqm, l.rooms, l.floor,
                   l.source,
                   l.first_seen as published_at,
                   ROUND(((COALESCE(c.theoretical_premium_min,0) + COALESCE(c.theoretical_premium_max,0)) / 2.0), 1) as premium_percent,
                   ROUND(COALESCE(c.theoretical_premium_min,0), 1) as premium_min,
                   ROUND(COALESCE(c.theoretical_premium_max,0), 1) as premium_max,
                   c.name as complex_name, c.status as complex_status,
                   GREATEST(c.deposit_date, c.approval_date, c.permit_date, c.declaration_date) as complex_status_date,
                   NULL::numeric as avg_price_sqm,
                   l.phone, l.message_status as contact_status, l.deal_status,
                   l.created_at, l.url, l.ssi_score,
                   -- Estimated sale price after project (using avg premium)
                   CASE WHEN l.asking_price > 0 AND (c.theoretical_premium_min IS NOT NULL OR c.theoretical_premium_max IS NOT NULL)
                        THEN ROUND(l.asking_price * (1 + (COALESCE(c.theoretical_premium_min,0) + COALESCE(c.theoretical_premium_max,0)) / 200.0))
                        ELSE NULL END as estimated_sale_price,
                   -- Profit delta in ₪
                   CASE WHEN l.asking_price > 0 AND (c.theoretical_premium_min IS NOT NULL OR c.theoretical_premium_max IS NOT NULL)
                        THEN ROUND(l.asking_price * (COALESCE(c.theoretical_premium_min,0) + COALESCE(c.theoretical_premium_max,0)) / 200.0)
                        ELSE NULL END as profit_delta_ils,
                   -- SSI breakdown
                   l.ssi_time_score, l.ssi_price_score, l.ssi_indicator_score
            FROM listings l
            LEFT JOIN complexes c ON l.complex_id = c.id
            WHERE l.is_active = TRUE AND l.asking_price > 0`;
        const params = [];
        let n = 1;
        if (city?.trim()) { query += ` AND l.city ILIKE $${n}`; params.push('%' + city.trim() + '%'); n++; }
        if (minPrice && !isNaN(minPrice)) { query += ` AND l.asking_price >= $${n}`; params.push(parseInt(minPrice)); n++; }
        if (maxPrice && !isNaN(maxPrice)) { query += ` AND l.asking_price <= $${n}`; params.push(parseInt(maxPrice)); n++; }
        if (search?.trim()) { query += ` AND (l.address ILIKE $${n} OR l.city ILIKE $${n})`; params.push('%' + search.trim() + '%'); n++; }
        if (phoneFilter === 'yes') query += ` AND l.phone IS NOT NULL AND l.phone != ''`;
        else if (phoneFilter === 'no') query += ` AND (l.phone IS NULL OR l.phone = '')`;
        if (contactStatus) { query += ` AND l.message_status = $${n}`; params.push(contactStatus); n++; }
        const validSort = ['address', 'city', 'asking_price', 'created_at', 'ssi_score', 'area_sqm', 'rooms', 'floor'];
        const sortField = validSort.includes(sortBy) ? `l.${sortBy}` : 'l.created_at';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        const offset = (parseInt(page) - 1) * parseInt(limit);
        query += ` ORDER BY ${sortField} ${order} LIMIT $${n} OFFSET $${n + 1}`;
        params.push(parseInt(limit), offset);
        const result = await pool.query(query, params);
        let countQuery = `SELECT COUNT(*) as total FROM listings l WHERE l.is_active = TRUE AND l.asking_price > 0`;
        const countParams = [];
        let cn = 1;
        if (city?.trim()) { countQuery += ` AND l.city ILIKE $${cn}`; countParams.push('%' + city.trim() + '%'); cn++; }
        if (phoneFilter === 'yes') countQuery += ` AND l.phone IS NOT NULL AND l.phone != ''`;
        else if (phoneFilter === 'no') countQuery += ` AND (l.phone IS NULL OR l.phone = '')`;
        const countResult = await pool.query(countQuery, countParams);
        res.json({ success: true, data: result.rows, pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(countResult.rows[0]?.total) || 0 } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/whatsapp/convert-to-lead', async (req, res) => {
    try {
        const { name, phone, budget, property_type, location_preference } = req.body;
        const result = await pool.query(
            `INSERT INTO website_leads (name, phone, budget, property_type, location_preference, source, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'whatsapp', 'new', NOW()) RETURNING id`,
            [name, phone, budget, property_type, location_preference]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/tasks', async (req, res) => {
    try {
        const { status } = req.query;
        let query = `SELECT * FROM tasks WHERE 1=1`;
        const params = [];
        if (status && status !== 'all') { query += ` AND status = $1`; params.push(status); }
        query += ` ORDER BY created_at DESC`;
        const result = await pool.query(query, params);
        res.json({ success: true, tasks: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/tasks', async (req, res) => {
    try {
        const { title, description, status, priority, due_date, reminder_at } = req.body;
        const result = await pool.query(
            `INSERT INTO tasks (title, description, status, priority, due_date, reminder_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
            [title, description || null, status || 'todo', priority || 'normal', due_date || null, reminder_at || null]
        );
        res.json({ success: true, task: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, status, priority, due_date, reminder_at, reminder_snoozed, trello_card_id, trello_card_url } = req.body;
        const result = await pool.query(
            `UPDATE tasks SET
                title = COALESCE($1, title),
                description = COALESCE($2, description),
                status = COALESCE($3, status),
                priority = COALESCE($4, priority),
                due_date = COALESCE($5, due_date),
                reminder_at = COALESCE($6, reminder_at),
                reminder_snoozed = COALESCE($7, reminder_snoozed),
                trello_card_id = COALESCE($8, trello_card_id),
                trello_card_url = COALESCE($9, trello_card_url),
                updated_at = NOW()
             WHERE id = $10 RETURNING *`,
            [title, description, status, priority, due_date, reminder_at, reminder_snoozed, trello_card_id, trello_card_url, id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'Task not found' });
        res.json({ success: true, task: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/api/tasks/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Monthly listings count for chart (last 13 months)
router.get('/api/chart/listings-monthly', async (req, res) => {
  try {
    const [listingsResult, leadsResult] = await Promise.all([
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS sort_key,
               COUNT(*) AS count
        FROM listings
        WHERE created_at >= NOW() - INTERVAL '13 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month,
               TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS sort_key,
               COUNT(*) AS count
        FROM website_leads
        WHERE created_at >= NOW() - INTERVAL '13 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `).catch(() => ({ rows: [] }))
    ]);
    res.json({ success: true, listings: listingsResult.rows, leads: leadsResult.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Listings by source per month (last 6 months)
router.get('/api/chart/listings-by-source', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS sort_key,
        COALESCE(source, 'unknown') AS source,
        COUNT(*) AS count
      FROM listings
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at), source
      ORDER BY DATE_TRUNC('month', created_at) ASC, source
    `).catch(() => ({ rows: [] }));
    res.json({ success: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Leads by source per month (last 6 months)
router.get('/api/chart/leads-by-source', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS sort_key,
        COALESCE(utm_source, source, 'website') AS source,
        COUNT(*) AS count
      FROM website_leads
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at), COALESCE(utm_source, source, 'website')
      ORDER BY DATE_TRUNC('month', created_at) ASC
    `).catch(() => ({ rows: [] }));
    // Also get campaign breakdown
    const campaigns = await pool.query(`
      SELECT
        COALESCE(campaign_tag, 'ללא קמפיין') AS campaign,
        COUNT(*) AS count
      FROM website_leads
      WHERE utm_source = 'flyer' AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY campaign_tag
      ORDER BY count DESC
    `).catch(() => ({ rows: [] }));
    res.json({ success: true, data: result.rows, campaigns: campaigns.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// QR campaign link generator
router.post('/api/campaign/generate-link', async (req, res) => {
  try {
    const { campaign_name, base_url } = req.body;
    if (!campaign_name) return res.status(400).json({ success: false, error: 'campaign_name required' });
    const slug = campaign_name.replace(/\s+/g, '_').replace(/[^\w\u0590-\u05FF-]/g, '').substring(0, 40);
    const siteBase = base_url || process.env.SITE_URL || 'https://quantum-nadlan.co.il';
    const link = `${siteBase}/?src=flyer&campaign=${encodeURIComponent(slug)}`;
    res.json({ success: true, link, campaign_tag: slug });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/api/trello/board', async (req, res) => {
    try {
        const trelloService = require('../services/trelloService');
        const board = await trelloService.getBoardDetails();
        res.json({ success: true, lists: board.lists || [], labels: board.labels || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/trello/create-task-card', async (req, res) => {
    try {
        const { title, description, listName, labelName, dueDate, taskId } = req.body;
        const trelloService = require('../services/trelloService');
        const card = await trelloService.createCard({ title, description, listName, labelName, dueDate });
        if (taskId) {
            await pool.query('UPDATE tasks SET trello_card_id = $1, trello_card_url = $2, updated_at = NOW() WHERE id = $3',
                [card.id, card.url, taskId]);
        }
        res.json({ success: true, id: card.id, url: card.url });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/dashboard/system-status', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString();

    // Vapi calls today
    let vapi_calls_today = 0;
    try {
      const vapiRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM vapi_calls WHERE created_at >= $1`, [todayStr]
      );
      vapi_calls_today = parseInt(vapiRes.rows[0]?.cnt || 0);
    } catch(e) { /* table may not exist yet */ }

    // INFORU messages today
    let inforu_msgs_today = 0;
    try {
      const inforuRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM inforu_messages WHERE created_at >= $1`, [todayStr]
      );
      inforu_msgs_today = parseInt(inforuRes.rows[0]?.cnt || 0);
    } catch(e) { /* table may not exist yet */ }

    // Appointments today (from scheduling)
    let appointments_today = 0;
    try {
      const apptRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM booking_sessions WHERE status = 'confirmed' AND created_at >= $1`, [todayStr]
      );
      appointments_today = parseInt(apptRes.rows[0]?.cnt || 0);
    } catch(e) { /* table may not exist yet */ }

    // Pending reminders (tasks with reminder_at in future)
    let pending_reminders = 0;
    try {
      const remRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM tasks WHERE reminder_at > NOW() AND status != 'done'`
      );
      pending_reminders = parseInt(remRes.rows[0]?.cnt || 0);
    } catch(e) { /* table may not exist yet */ }

    // Hot leads untreated (score >= 70, status = new/pending)
    let hot_leads_untreated = 0;
    try {
      const hotRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM website_leads WHERE status IN ('new','pending') AND created_at >= NOW() - INTERVAL '7 days'`
      );
      hot_leads_untreated = parseInt(hotRes.rows[0]?.cnt || 0);
    } catch(e) { /* table may not exist yet */ }

    // Pipeline last run
    let pipeline_last_run = null;
    let pipeline_last_status = null;
    try {
      const pipeRes = await pool.query(
        `SELECT last_run, status FROM pipeline_runs ORDER BY last_run DESC LIMIT 1`
      );
      if (pipeRes.rows[0]) {
        pipeline_last_run = pipeRes.rows[0].last_run;
        pipeline_last_status = pipeRes.rows[0].status;
      }
    } catch(e) { /* table may not exist yet */ }

    // Zoho CRM - check if token exists
    let zoho_connected = false;
    try {
      const zohoRes = await pool.query(`SELECT value FROM system_config WHERE key = 'zoho_access_token' LIMIT 1`);
      zoho_connected = !!(zohoRes.rows[0]?.value);
    } catch(e) { zoho_connected = !!(process.env.ZOHO_ACCESS_TOKEN); }

    res.json({
      vapi_calls_today,
      inforu_msgs_today,
      appointments_today,
      pending_reminders,
      hot_leads_untreated,
      pipeline_last_run,
      pipeline_last_status,
      zoho_connected
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dashboard/api/ssi/backfill — run SSI for all active listings (background)
router.post('/api/ssi/backfill', async (req, res) => {
  try {
    const { calculateAllSSI } = require('../services/ssiCalculator');
    res.json({ success: true, message: 'SSI backfill started in background' });
    calculateAllSSI()
      .then(r => require('../services/logger').logger.info(`[Dashboard] SSI backfill complete: ${r.updated}/${r.total}`))
      .catch(e => require('../services/logger').logger.warn(`[Dashboard] SSI backfill failed: ${e.message}`));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /dashboard/api/ssi/stats — quick SSI stats
router.get('/api/ssi/stats', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE ssi_score > 0) as scored,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE ssi_score >= 70) as high_stress,
        COUNT(*) FILTER (WHERE ssi_score >= 40 AND ssi_score < 70) as medium_stress,
        ROUND(AVG(ssi_score) FILTER (WHERE ssi_score > 0), 1) as avg_score
      FROM listings WHERE is_active = TRUE
    `);
    res.json({ success: true, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /dashboard/api/chart/conversion-rate — monthly conversion rate (leads/listings %)
router.get('/api/chart/conversion-rate', async (req, res) => {
  try {
    const [listingsResult, leadsResult] = await Promise.all([
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
               COUNT(*) as count
        FROM listings
        WHERE created_at >= NOW() - INTERVAL '13 months'
        GROUP BY month ORDER BY month
      `),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
               COUNT(*) as count
        FROM website_leads
        WHERE created_at >= NOW() - INTERVAL '13 months'
        GROUP BY month ORDER BY month
      `)
    ]);
    const listingsMap = {};
    const leadsMap = {};
    listingsResult.rows.forEach(r => { listingsMap[r.month] = parseInt(r.count); });
    leadsResult.rows.forEach(r => { leadsMap[r.month] = parseInt(r.count); });
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
      const listings = listingsMap[key] || 0;
      const leads = leadsMap[key] || 0;
      const rate = listings > 0 ? Math.round((leads / listings) * 100 * 10) / 10 : 0;
      months.push({ month: key, listings, leads, rate });
    }
    res.json({ success: true, months });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /dashboard/api/trello/cards — fetch all open cards from Trello board
router.get('/api/trello/cards', async (req, res) => {
  try {
    const trelloService = require('../services/trelloService');
    if (!trelloService.isConfigured()) {
      return res.json({ success: false, configured: false, cards: [], lists: [] });
    }
    const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
    const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
    const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;
    const [cardsResp, listsResp] = await Promise.all([
      fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=id,name,desc,due,url,idList,labels,closed&filter=open`),
      fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=id,name`)
    ]);
    if (!cardsResp.ok) throw new Error(`Trello cards API ${cardsResp.status}`);
    const cards = await cardsResp.json();
    const lists = listsResp.ok ? await listsResp.json() : [];
    const listMap = {};
    lists.forEach(l => { listMap[l.id] = l.name; });
    const enriched = cards.map(c => ({ ...c, listName: listMap[c.idList] || c.idList }));
    res.json({ success: true, configured: true, cards: enriched, lists });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /dashboard/api/trello/move-card — move a Trello card to a different list
router.post('/api/trello/move-card', async (req, res) => {
  try {
    const { cardId, listName } = req.body;
    if (!cardId || !listName) return res.status(400).json({ success: false, error: 'cardId and listName required' });
    const trelloService = require('../services/trelloService');
    const listId = await trelloService.getListId(listName);
    const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
    const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
    const resp = await fetch(
      `https://api.trello.com/1/cards/${cardId}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idList: listId }) }
    );
    if (!resp.ok) throw new Error(`Trello API ${resp.status}`);
    const card = await resp.json();
    res.json({ success: true, card });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
// v5.4.0 - SSI backfill, conversion rate chart, Trello board sync
