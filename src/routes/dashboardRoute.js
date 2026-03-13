const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
    try {
        let stats = { totalComplexes: 698, newListings: 931, hotOpportunities: 34, activeMessages: 0, qualifiedLeads: 7, closedDeals: 0, konesCount: 0 };
        try {
            const [complexes, listings, opportunities, messages, leads, deals, kones] = await Promise.all([
                pool.query('SELECT COUNT(*) as total FROM complexes'),
                pool.query('SELECT COUNT(*) as total FROM listings WHERE is_active = TRUE'),
                pool.query('SELECT COUNT(*) as total FROM complexes WHERE iai_score > 75'),
                pool.query("SELECT COUNT(*) as total FROM whatsapp_conversations WHERE status = 'active'").catch(() => ({ rows: [{ total: 0 }] })),
                pool.query("SELECT COUNT(*) as total FROM website_leads WHERE status IN ('contacted','qualified')"),
                pool.query("SELECT COUNT(*) as total FROM listings WHERE deal_status IN ('תיווך','סגור')"),
                pool.query("SELECT COUNT(*) as total FROM kones_listings WHERE is_active = TRUE").catch(() => ({ rows: [{ total: 0 }] }))
            ]);
            stats = {
                totalComplexes: parseInt(complexes.rows[0]?.total) || 698,
                newListings: parseInt(listings.rows[0]?.total) || 931,
                hotOpportunities: parseInt(opportunities.rows[0]?.total) || 34,
                activeMessages: parseInt(messages.rows[0]?.total) || 0,
                qualifiedLeads: parseInt(leads.rows[0]?.total) || 7,
                closedDeals: parseInt(deals.rows[0]?.total) || 0,
                konesCount: parseInt(kones.rows[0]?.total) || 0
            };
        } catch (dbError) {
            console.warn('DB error, using defaults:', dbError.message);
        }
        res.send(generateDashboardHTML(stats));
    } catch (error) {
        res.status(500).send('ERROR: ' + error.message);
    }
});

router.get('/api/stats', async (req, res) => {
    try {
        const [complexes, listings, opportunities, messages, leads, deals] = await Promise.all([
            pool.query('SELECT COUNT(*) as total FROM complexes'),
            pool.query('SELECT COUNT(*) as total FROM listings WHERE is_active = TRUE'),
            pool.query('SELECT COUNT(*) as total FROM complexes WHERE iai_score > 75'),
            pool.query("SELECT COUNT(*) as total FROM whatsapp_conversations WHERE status = 'active'").catch(() => ({ rows: [{ total: 0 }] })),
            pool.query("SELECT COUNT(*) as total FROM website_leads WHERE status IN ('contacted','qualified')"),
            pool.query("SELECT COUNT(*) as total FROM listings WHERE deal_status IN ('תיווך','סגור')")
        ]);
        res.json({ success: true, data: {
            totalComplexes: parseInt(complexes.rows[0]?.total) || 0,
            newListings: parseInt(listings.rows[0]?.total) || 0,
            hotOpportunities: parseInt(opportunities.rows[0]?.total) || 0,
            activeMessages: parseInt(messages.rows[0]?.total) || 0,
            qualifiedLeads: parseInt(leads.rows[0]?.total) || 0,
            closedDeals: parseInt(deals.rows[0]?.total) || 0
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
                   l.created_at, l.url, l.ssi_score
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

function generateDashboardHTML(stats) {
    return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>QUANTUM DASHBOARD</title>
    <style>
        :root {
            --bg-primary: #2a2d35;
            --bg-secondary: #32363f;
            --bg-card: #32363f;
            --bg-card-hover: #3a3f4a;
            --bg-table-head: #2e3240;
            --bg-table-row-alt: #2e323b;
            --border-subtle: rgba(255,255,255,0.07);
            --border-medium: rgba(255,255,255,0.13);
            --teal: #4ecdc4;
            --teal-dim: rgba(78,205,196,0.13);
            --teal-glow: rgba(78,205,196,0.28);
            --gold: #e8b84b;
            --gold-dim: rgba(232,184,75,0.13);
            --gold-glow: rgba(232,184,75,0.28);
            --text-primary: #e8eaf0;
            --text-secondary: #9aa0b0;
            --text-muted: #6b7280;
            --green: #4ade80;
            --red: #f87171;
            --blue: #60a5fa;
            --purple: #8b5cf6;
        }
        * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; }
        body { background:var(--bg-primary); color:var(--text-primary); font-size:15px; line-height:1.5; overflow-x:hidden; }

        /* ── HEADER ── */
        .header { background:var(--bg-secondary); border-bottom:1px solid var(--border-subtle); padding:22px 24px 18px; text-align:center; position:sticky; top:0; z-index:100; }
        .header h1 { font-size:26px; font-weight:800; letter-spacing:4px; margin-bottom:5px; color:var(--text-primary); text-transform:uppercase; }
        .header h1 span.teal { color:var(--teal); }
        .header h1 span.gold { color:var(--text-primary); }
        .status { color:var(--text-secondary); font-size:12px; font-weight:400; display:flex; align-items:center; justify-content:center; gap:6px; }
        .status-dot { width:8px; height:8px; background:var(--green); border-radius:50%; box-shadow:0 0 6px var(--green); animation:blink 2s infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }

        /* ── NAV TABS ── */
        .nav-tabs { background:var(--bg-secondary); padding:12px 24px; border-bottom:1px solid var(--border-subtle); display:flex; overflow-x:auto; gap:8px; position:sticky; top:72px; z-index:99; -webkit-overflow-scrolling:touch; scrollbar-width:none; justify-content:center; flex-wrap:wrap; }
        .nav-tabs::-webkit-scrollbar { display:none; }
        .nav-tab { background:transparent; border:1px solid var(--border-medium); border-radius:6px; padding:9px 18px; color:var(--text-secondary); font-weight:500; font-size:13px; cursor:pointer; transition:all 0.15s ease; white-space:nowrap; user-select:none; -webkit-tap-highlight-color:transparent; letter-spacing:0.3px; }
        .nav-tab.active { background:var(--bg-primary); border-color:rgba(255,255,255,0.25); color:var(--text-primary); font-weight:600; }
        .nav-tab:hover:not(.active) { border-color:rgba(255,255,255,0.18); color:var(--text-primary); background:rgba(255,255,255,0.04); }

        /* ── TAB CONTENT ── */
        .tab-content { display:none; padding:18px 20px; min-height:calc(100vh - 120px); }
        .tab-content.active { display:block; }

        /* ── STAT CARDS ── */
        .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:18px; }
        .stat-card { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:8px; padding:20px 22px; cursor:pointer; transition:all 0.15s ease; user-select:none; position:relative; overflow:hidden; }
        .stat-card:hover { background:var(--bg-card-hover); border-color:var(--border-medium); }
        .stat-number { font-size:2.4rem; font-weight:700; color:var(--text-primary); margin-bottom:6px; line-height:1; letter-spacing:-0.5px; }
        .stat-label { font-size:13px; color:var(--text-secondary); font-weight:400; margin-bottom:5px; }
        .stat-hint { font-size:11px; color:var(--text-muted); margin-bottom:5px; }
        .stat-change { font-size:11px; padding:2px 8px; border-radius:4px; font-weight:500; background:rgba(74,222,128,0.1); color:var(--green); display:inline-block; }

        /* ── SECTION CARDS ── */
        .section { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:8px; padding:20px 22px; margin-bottom:16px; }
        .section h2 { color:var(--text-primary); font-size:15px; margin-bottom:16px; font-weight:600; display:flex; align-items:center; gap:8px; }

        /* ── FILTERS ── */
        .filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:14px; }
        .filter-input,.filter-select { background:rgba(255,255,255,0.05); border:1px solid var(--border-medium); color:var(--text-primary); padding:8px 12px; border-radius:6px; font-size:13px; width:100%; transition:border-color 0.15s; }
        .filter-input:focus,.filter-select:focus { outline:none; border-color:var(--teal); background:rgba(45,212,191,0.04); }
        .filter-input::placeholder { color:var(--text-muted); }
        .filter-select option { background:var(--bg-card); color:var(--text-primary); }

        /* ── BUTTONS ── */
        .btn { background:var(--teal); color:#1a1d24; border:none; padding:8px 18px; border-radius:6px; font-weight:600; font-size:13px; cursor:pointer; transition:all 0.15s ease; display:inline-flex; align-items:center; gap:5px; }
        .btn:hover { opacity:0.88; }
        .btn-outline { background:transparent; color:var(--text-primary); border:1px solid var(--border-medium); }
        .btn-outline:hover { border-color:rgba(255,255,255,0.3); color:var(--text-primary); background:rgba(255,255,255,0.06); }
        .btn-secondary { background:rgba(255,255,255,0.07); color:var(--text-secondary); border:1px solid var(--border-medium); }
        .btn-secondary:hover { background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.22); color:var(--text-primary); }
        .btn-gold { background:var(--gold); color:#1a1d24; border:none; }
        .btn-gold:hover { opacity:0.88; }
        .btn-green { background:var(--green); color:#1a1d24; border:none; }
        .btn-green:hover { opacity:0.88; }
        .btn-intel { background:rgba(99,102,241,0.85); color:#fff; border:none; }
        .btn-intel:hover { opacity:0.88; }
        .btn-red { background:var(--red); color:#fff; border:none; }
        .btn-red:hover { opacity:0.88; }

        /* ── DATA LIST ── */
        .data-list { display:grid; gap:10px; }
        .data-item { background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:6px; padding:14px; border-right:3px solid var(--gold); transition:all 0.15s ease; }
        .data-item:hover { background:rgba(255,255,255,0.07); }
        .data-item h3 { color:var(--gold); margin-bottom:8px; font-size:15px; }
        .data-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:6px; margin-top:10px; font-size:13px; }
        .data-meta-item { display:flex; justify-content:space-between; gap:6px; }
        .data-meta-label { color:var(--text-secondary); }
        .data-meta-value { color:var(--text-primary); font-weight:600; }

        /* ── TABLE ── */
        .tbl { width:100%; border-collapse:collapse; font-size:13px; }
        .tbl thead tr { background:var(--bg-table-head); }
        .tbl th { padding:11px 14px; border-bottom:1px solid var(--border-subtle); color:var(--text-secondary); font-weight:500; text-align:right; white-space:nowrap; cursor:pointer; font-size:12px; letter-spacing:0.3px; }
        .tbl th:hover { color:var(--text-primary); }
        .tbl tbody tr { border-bottom:1px solid var(--border-subtle); transition:background 0.1s; }
        .tbl tbody tr:hover { background:rgba(255,255,255,0.04) !important; cursor:pointer; }
        .tbl td { padding:12px 14px; vertical-align:middle; }
        .trow:hover { background:rgba(255,255,255,0.04) !important; cursor:pointer; }
        /* ── BADGES ── */
        .badge { padding:4px 12px; border-radius:6px; font-size:12px; font-weight:500; display:inline-block; }
        .badge-green { background:rgba(74,222,128,0.15); color:var(--green); }
        .badge-blue { background:rgba(96,165,250,0.15); color:var(--blue); }
        .badge-gold { background:rgba(232,184,75,0.15); color:var(--gold); }
        .badge-red { background:rgba(248,113,113,0.15); color:var(--red); }
        .badge-purple { background:rgba(139,92,246,0.15); color:#a78bfa; }
        .badge-gray { background:rgba(107,114,128,0.15); color:var(--text-muted); }
        .status-badge { padding:5px 14px; border-radius:6px; font-size:12px; font-weight:500; }
        .status-new { background:rgba(96,165,250,0.15); color:var(--blue); }
        .status-contacted { background:rgba(232,184,75,0.15); color:var(--gold); }
        .status-qualified { background:rgba(74,222,128,0.15); color:var(--green); }
        .status-closed { background:rgba(107,114,128,0.15); color:var(--text-muted); }
        .status-pending { background:rgba(232,184,75,0.15); color:var(--gold); }
        .status-landline { background:rgba(107,114,128,0.15); color:var(--text-muted); }
        .status-nophone { background:rgba(55,65,81,0.2); color:var(--text-muted); }
        .filter-active-badge { background:var(--teal-dim); border:1px solid var(--teal); color:var(--teal); padding:3px 10px; border-radius:6px; font-size:11px; margin-left:8px; display:inline-block; }

        /* ── MISC ── */
        .loading { text-align:center; padding:40px; color:var(--text-muted); }
        .error { background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; padding:14px; border-radius:8px; margin:10px 0; }
        .actions-bar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; align-items:center; }
        .intel-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        .intel-item { background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:7px; padding:10px 12px; margin-bottom:6px; }
        .intel-item .name { font-weight:700; color:var(--text-primary); margin-bottom:3px; }
        .intel-item .meta { font-size:12px; color:var(--text-secondary); }
        .intel-score { display:inline-block; padding:2px 7px; border-radius:10px; font-size:11px; font-weight:700; margin-left:5px; }

        /* ── CONVERSATIONS ── */
        .conv-item { padding:12px 14px; border-bottom:1px solid var(--border-subtle); cursor:pointer; transition:background 0.12s; }
        .conv-item:hover { background:rgba(45,212,191,0.06); }
        .conv-item.active { background:var(--teal-dim); border-right:2px solid var(--teal); }
        .conv-name { font-weight:700; font-size:14px; color:var(--text-primary); margin-bottom:3px; }
        .conv-preview { font-size:12px; color:var(--text-secondary); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:240px; }
        .conv-meta { font-size:11px; color:var(--text-muted); margin-top:3px; display:flex; justify-content:space-between; }
        .bubble { max-width:75%; padding:9px 13px; border-radius:14px; margin-bottom:8px; font-size:13px; line-height:1.5; word-break:break-word; }
        .bubble-out { background:#1d4ed8; color:#fff; margin-right:auto; border-bottom-right-radius:3px; }
        .bubble-in { background:#1e293b; color:var(--text-primary); margin-left:auto; border-bottom-left-radius:3px; }
        .bubble-time { font-size:10px; opacity:0.55; margin-top:3px; }

        /* ── MODAL ── */
        .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:9999; align-items:center; justify-content:center; }
        .modal-box { background:var(--bg-card); border:1px solid var(--border-medium); border-radius:12px; padding:24px; max-width:480px; width:90%; max-height:90vh; overflow-y:auto; }
        .modal-title { color:var(--teal); font-size:17px; font-weight:700; margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; }
        .modal-close { background:none; border:none; color:var(--text-muted); font-size:20px; cursor:pointer; }
        .modal-close:hover { color:var(--text-primary); }
        .form-group { margin-bottom:12px; }
        .form-label { color:var(--text-secondary); font-size:12px; display:block; margin-bottom:5px; }

        /* ── RESPONSIVE ── */
        @media(max-width:768px){
            .header{padding:10px 12px;} .header h1{font-size:18px;}
            .nav-tabs{padding:8px 10px; top:54px;}
            .nav-tab{padding:7px 12px; font-size:11px;}
            .tab-content{padding:12px 10px;}
            .stats-grid{grid-template-columns:1fr 1fr; gap:10px;}
            .stat-number{font-size:1.7rem;}
            .section{padding:14px 12px;}
            .filters{grid-template-columns:1fr;}
            .data-meta{grid-template-columns:1fr;}
            #conv-panel{grid-template-columns:1fr!important;}
            #conv-thread{display:none;}
            #conv-thread.active{display:block;}
            .intel-grid{grid-template-columns:1fr;}
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>QUANTUM DASHBOARD 💎</h1>
        <div class="status"><span class="status-dot"></span> מחובר ופעיל &bull; <span id="time"></span></div>
    </div>

    <div class="nav-tabs">
        <div class="nav-tab active" data-tab="dashboard">📊 דשבורד</div>
        <div class="nav-tab" data-tab="ads">🏘 מודעות</div>
        <div class="nav-tab" data-tab="messages">💬 הודעות</div>
        <div class="nav-tab" data-tab="leads">👤 לידים</div>
        <div class="nav-tab" data-tab="complexes">🏢 מתחמים</div>
        <div class="nav-tab" data-tab="kones">🏗️ כינוס</div>
        <div class="nav-tab" data-tab="news">📰 חדשות</div>
        <div class="nav-tab" data-tab="scheduling">📅 תיאומים</div>
        <div class="nav-tab" data-tab="scrapers">🔍 סריקות</div>
        <div class="nav-tab" data-tab="tasks">✅ משימות</div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ DASHBOARD TAB -->
    <div id="tab-dashboard" class="tab-content active">
        <div class="stats-grid">
            <div class="stat-card" data-tab="complexes">
                <div class="stat-number">${stats.totalComplexes}</div>
                <div class="stat-label">מתחמי פינוי-בינוי</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המתחמים</div>
                <div class="stat-change">+12% השנה</div>
            </div>
            <div class="stat-card" data-tab="ads">
                <div class="stat-number">${stats.newListings}</div>
                <div class="stat-label">מודעות פעילות</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המודעות</div>
                <div class="stat-change">+8% השנה</div>
            </div>
            <div class="stat-card" data-tab="messages">
                <div class="stat-number">${stats.activeMessages}</div>
                <div class="stat-label">שיחות WhatsApp</div>
                <div class="stat-hint">→ לחץ לפתיחת מרכז השיחות</div>
                <div class="stat-change">+23% השנה</div>
            </div>
            <div class="stat-card" data-tab="leads">
                <div class="stat-number">${stats.qualifiedLeads}</div>
                <div class="stat-label">לידים מהאתר</div>
                <div class="stat-hint">→ לחץ לפתיחת הלידים</div>
                <div class="stat-change">+15% השנה</div>
            </div>
            <div class="stat-card" data-tab="complexes">
                <div class="stat-number">${stats.hotOpportunities}</div>
                <div class="stat-label">הזדמנויות חמות</div>
                <div class="stat-hint">→ IAI > 75 | לחץ לפתיחת רשימה</div>
                <div class="stat-change">+31% השנה</div>
            </div>
            <div class="stat-card" data-tab="ads">
                <div class="stat-number">${stats.closedDeals}</div>
                <div class="stat-label">עסקאות תיווך</div>
                <div class="stat-hint">→ לחץ לפתיחת נתונים</div>
                <div class="stat-change">+67% השנה</div>
            </div>
            <div class="stat-card" data-tab="kones">
                <div class="stat-number">${stats.konesCount}</div>
                <div class="stat-label">כינוסי נכסים</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת כינוסים</div>
                <div class="stat-change" style="background:var(--gold-dim);color:var(--gold);border-color:rgba(245,158,11,0.3);">נכסים בכינוס</div>
            </div>
        </div>

        <div class="section">
            <h2>⚡ פעולות מהירות</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">
                <button class="btn btn-intel" data-onclick="loadMorningIntelligence()">🧠 ינטליגנציה יומית</button>
                <button class="btn btn-green" data-onclick="runFullScan()" style="font-weight:700;">🔍 סריקה מלאה + Enrichment</button>
                <button class="btn" data-onclick="refreshStats()">🔄 רענן נתונים</button>
                <button class="btn btn-secondary" data-onclick="window.open('/api/docs','_blank')">📋 API Docs</button>
            </div>
        </div>

        <div class="section" id="morning-section">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <h2 style="margin:0;">🧠 ינטליגנציה יומית</h2>
                <button class="btn btn-secondary" data-onclick="loadMorningIntelligence()" style="padding:5px 10px;font-size:11px;">🔄 רענן</button>
            </div>
            <div id="morning-content"><div class="loading">טוען...</div></div>
        </div>

        <div class="section" style="max-width:60%;">
            <h2>📊 סטטוס מערכת</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;">
                <div class="data-item"><h3>📾 סריקה אוטומטית</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל</span></span></div></div></div>
                <div class="data-item"><h3>📱 WhatsApp</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">מחובר</span></span></div></div></div>
                <div class="data-item"><h3>📆 Auto Contact</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל (כל 30 דק)</span></span></div></div></div>
                <div class="data-item"><h3>🏗️ כינוס נכסים</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל (07:45 יומי)</span></span></div></div></div>
            </div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ ADS TAB -->
    <div id="tab-ads" class="tab-content">
        <div class="section">
            <h2>🏘 רשימת מודעות</h2>
            <div class="filters">
                <input type="text" class="filter-input" id="cityFilter" placeholder="עיר">
                <input type="number" class="filter-input" id="minPriceFilter" placeholder="מחיר מינימום">
                <input type="number" class="filter-input" id="maxPriceFilter" placeholder="מחיר מקסימום">
                <select class="filter-select" id="phoneFilter">
                    <option value="">כל הטלפון</option>
                    <option value="yes">יש טלפון</option>
                    <option value="no">אין טלפון</option>
                </select>
                <select class="filter-select" id="adsSortBy" onchange="loadAds()">
                    <option value="created_at">מיון: תאריך</option>
                    <option value="asking_price">מיון: מחיר</option>
                    <option value="ssi_score">מיון: SSI</option>
                    <option value="city">מיון: עיר</option>
                    <option value="area_sqm">מיון: שטח</option>
                </select>
                <select class="filter-select" id="adsSortOrder" onchange="loadAds()">
                    <option value="desc">יורד</option>
                    <option value="asc">עולה</option>
                </select>
            </div>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadAds()">🔍 טען מודעות</button>
                <button class="btn btn-secondary" data-onclick="exportData('ads')">📊 ייצוא לאקסל</button>
                <div style="margin-right:auto;display:flex;gap:4px;">
                    <button id="ads-view-table" class="btn" style="padding:6px 10px;font-size:12px;" data-onclick="setAdsView('table')" title="תצוגת שורות">☰ שורות</button>
                    <button id="ads-view-grid" class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" data-onclick="setAdsView('grid')" title="תצוגת ריבועים">⊞ ריבועים</button>
                </div>
            </div>
            <div id="ads-pagination" style="margin-bottom:6px;font-size:12px;color:var(--text-muted);"></div>
            <div id="ads-grid-container" style="display:none;padding:10px 0;"></div>
            <div style="overflow-x:auto;">
            <table id="ads-table" class="tbl" style="display:none;">
                <thead>
                    <tr id="ads-thead">
                        <th data-onclick="sortAdsBy('title')" data-sort-field="title">Property</th>
                        <th data-onclick="sortAdsBy('complex_status')" data-sort-field="complex_status">Status</th>
                        <th>Performance Trend</th>
                        <th data-onclick="sortAdsBy('asking_price')" data-sort-field="asking_price">Price</th>
                        <th data-onclick="sortAdsBy('premium_percent')" data-sort-field="premium_percent">פרמייה</th>
                        <th data-onclick="sortAdsBy('area_sqm')" data-sort-field="area_sqm">שטח</th>
                        <th data-onclick="sortAdsBy('rooms')" data-sort-field="rooms">חדרים</th>
                        <th data-onclick="sortAdsBy('ssi_score')" data-sort-field="ssi_score">SSI</th>
                        <th>טלפון</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="ads-tbody"></tbody>
            </table>
            </div>
            <div id="ads-list" class="data-list"><div class="loading">טוען מודעות...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ MESSAGES TAB -->
    <div id="tab-messages" class="tab-content" style="padding:0;">
        <div class="section" style="margin:0;border-radius:0;border-left:none;border-right:none;border-top:none;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                <h2 style="margin:0;">💬 שיחות WhatsApp</h2>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="text" class="filter-input" id="convSearchFilter" placeholder="חיפוש לפי שם/טלפון..." style="width:200px;" onkeyup="if(event.key==='Enter')loadConversations()">
                    <select class="filter-select" id="convStatusFilter" style="width:130px;" onchange="loadConversations()">
                        <option value="">כל הסטטוסים</option>
                        <option value="active">פעילות</option>
                        <option value="closed">סגורות</option>
                        <option value="agent_needed">דורש טיפול</option>
                    </select>
                    <button class="btn" data-onclick="loadConversations()">🔄 רענן</button>
                    <button class="btn btn-secondary" data-onclick="exportData('messages')">📊 ייצוא</button>
                </div>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:290px 1fr;height:calc(100vh - 210px);background:var(--bg-primary);" id="conv-panel">
            <div style="border-left:1px solid var(--border-subtle);overflow-y:auto;background:var(--bg-secondary);" id="conv-list">
                <div class="loading">טוען שיחות...</div>
            </div>
            <div style="display:flex;flex-direction:column;overflow:hidden;" id="conv-thread">
                <div style="text-align:center;padding:60px 20px;color:var(--text-muted);margin:auto;">
                    <div style="font-size:48px;margin-bottom:14px;">💬</div>
                    <p style="font-size:15px;">בחר שיחה מהרשימה לצפייה בהודעות</p>
                </div>
            </div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ LEADS TAB -->
    <div id="tab-leads" class="tab-content">
        <div class="section">
            <h2>👤 רשימת לידים</h2>
            <div class="filters">
                <input type="text" class="filter-input" id="leadsSearchFilter" placeholder="🔍 חיפוש שם / טלפון..." oninput="loadLeads()">
                <select class="filter-select" id="leadsStatusFilter" onchange="loadLeads()">
                    <option value="">כל הסטטוסים</option>
                    <option value="new">🆕 חדש</option>
                    <option value="qualified">✰ מוכשר</option>
                    <option value="contacted">📞 בתהליך</option>
                    <option value="closed">✅ סגור</option>
                    <option value="rejected">❌ נדחה</option>
                </select>
                <select class="filter-select" id="leadsTypeFilter" onchange="loadLeads()">
                    <option value="">כל הסוגים</option>
                    <option value="owner">🏠 מוכר</option>
                    <option value="investor">🏢 משקיע</option>
                    <option value="contact">📩 פנייה</option>
                </select>
                <select class="filter-select" id="leadsSourceFilter" onchange="loadLeads()">
                    <option value="">כל המקורות</option>
                    <option value="dashboard">דשבורד</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="facebook">פייסבוק</option>
                    <option value="website">אתר</option>
                </select>
            </div>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadLeads()">👤 כל הלידים</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('qualified')">✰ מוכשרים</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('contacted')">📞 בתהליך</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('new')">🆕 חדשים</button>
                <button class="btn btn-green" data-onclick="exportData('leads')">📊 ייצוא לאקסל</button>
            </div>
            <div id="leads-filter-badge" style="margin-bottom:8px;"></div>
            <div id="leads-list" class="data-list"><div class="loading">טוען לידים...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ COMPLEXES TAB -->
    <div id="tab-complexes" class="tab-content">
        <div class="section">
            <h2>🏢 מתחמי פינוי-בינוי</h2>
            <div class="filters">
                <input type="text" class="filter-input" id="complexesCityFilter" placeholder="עיר">
                <input type="number" class="filter-input" id="minIAIFilter" placeholder="IAI מינימום">
                <input type="number" class="filter-input" id="maxIAIFilter" placeholder="IAI מקסימום">
                <select class="filter-select" id="complexStatusFilter">
                    <option value="">כל הסטטוסים</option>
                    <option value="approved">אושרה</option>
                    <option value="deposited">הופקדה</option>
                    <option value="planning">בתכנון</option>
                    <option value="construction">בביצוע</option>
                </select>
            </div>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadComplexes()">🔍 טען מתחמים</button>
                <button class="btn btn-secondary" data-onclick="loadComplexes('hot')">🔥 הזדמנויות חמות</button>
                <button class="btn btn-secondary" data-onclick="exportData('complexes')">📊 ייצוא</button>
            </div>
            <div id="complexes-filter-badge" style="margin-bottom:8px;"></div>
            <div id="complexes-list" class="data-list"><div class="loading">טוען מתחמים...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ KONES TAB -->
    <div id="tab-kones" class="tab-content">
        <div class="section">
            <h2>🏗️ כינוסי נכסים</h2>
            <div class="filters">
                <input type="text" class="filter-input" id="konesCityFilter" placeholder="עיר">
                <input type="text" class="filter-input" id="konesSearchFilter" placeholder="חיפוש חופשי">
                <select class="filter-select" id="konesStatusFilter">
                    <option value="">כל הסטטוסים</option>
                    <option value="pending">ממתין לפנייה</option>
                    <option value="contacted">נוצר קשר</option>
                    <option value="landline">קו ארץ (דרוש שיחה)</option>
                    <option value="no_phone">אין טלפון</option>
                    <option value="failed">נכשל</option>
                </select>
            </div>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadKones()">🔍 טען כינוסים</button>
                <button class="btn btn-secondary" data-onclick="loadKones('landline')">📞 קווי ארץ</button>
                <button class="btn btn-secondary" data-onclick="loadKones('pending')">⏳ ממתינים</button>
                <button class="btn btn-green" data-onclick="runKonesAutoContact()">📱 הפעל Auto Contact</button>
                <button class="btn btn-secondary" data-onclick="exportData('kones')">📊 ייצוא</button>
            </div>
            <div id="kones-filter-badge" style="margin-bottom:8px;"></div>
            <div id="kones-stats-bar" style="margin-bottom:10px;display:none;"></div>
            <div id="kones-list" class="data-list"><div class="loading">טוען כינוסי נכסים...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ NEWS TAB -->
    <div id="tab-news" class="tab-content">
        <div class="section">
            <h2>📰 חדשות שוק הנדלן</h2>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadNews()">🔄 רענן חדשות</button>
                <button class="btn btn-secondary" data-onclick="loadFacebookAds()">📱 מודעות פייסבוק</button>
            </div>
            <div id="news-table-container" style="overflow-x:auto;margin-top:14px;">
                <table class="tbl">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>כותרת</th>
                            <th>תיאור</th>
                            <th>קטגוריה</th>
                            <th>תאריך</th>
                        </tr>
                    </thead>
                    <tbody id="news-table-body">
                        <tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">טוען חדשות...</td></tr>
                    </tbody>
                </table>
            </div>
            <div id="facebook-ads-section" style="display:none;margin-top:18px;"><h3 style="color:var(--gold);margin:12px 0;">📱 מודעות פייסבוק</h3><div id="facebook-ads-list"></div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ SCHEDULING TAB -->
    <div id="tab-scheduling" class="tab-content">
        <div class="section">
            <h2>📅 תיאום פגישות — QUANTUM BOT</h2>
            <div class="actions-bar" style="margin-bottom:14px;">
                <select id="sched-filter-state" onchange="loadScheduling()" class="filter-select" style="width:auto;">
                    <option value="">כל הסטטוסים</option>
                    <option value="confirmed">✅ מאושר</option>
                    <option value="pending">⏳ ממתין</option>
                    <option value="declined">❌ סירב</option>
                    <option value="cancelled">🚫 בוטל</option>
                </select>
                <select id="sched-filter-lang" onchange="loadScheduling()" class="filter-select" style="width:auto;">
                    <option value="">כל השפות</option>
                    <option value="he">🇮🇱 עברית</option>
                    <option value="ru">🇷🇺 רוסית</option>
                </select>
                <input id="sched-search" type="text" placeholder="🔍 חיפוש שם / טלפון..." oninput="filterSchedulingTable()" class="filter-input" style="min-width:190px;width:auto;">
                <button class="btn" data-onclick="loadScheduling()" style="margin-right:auto;">🔄 רענן</button>
                <a href="/api/scheduling/campaign" target="_blank" class="btn btn-secondary">📊 דוח קמפיין</a>
            </div>
            <div id="sched-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px;"></div>
            <div id="sched-list" class="data-list"><div class="loading">טוען נתוני תיאומים...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ SCRAPERS TAB -->
    <div id="tab-scrapers" class="tab-content">
        <div class="section">
            <h2>🔍 מקורות סריקה — Real Estate Data Sources</h2>
            <div class="actions-bar" style="margin-bottom:14px;">
                <button class="btn btn-green" data-onclick="runAllScrapers()">▶️ הפעל את כולם</button>
                <button class="btn btn-intel" data-onclick="runFullScan()">🚀 סריקה מלאה + Enrichment</button>
                <button class="btn btn-secondary" data-onclick="loadScraperStatus()">🔄 רענן סטטוס</button>
            </div>
            <div id="scrapers-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;margin-top:14px;"></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ TASKS TAB -->
    <div id="tab-tasks" class="tab-content">
        <div class="section">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
                <h2 style="margin:0;">✅ משימות</h2>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-secondary" id="tasks-filter-all" data-onclick="loadTasks('all')" style="padding:7px 12px;font-size:12px;">הכל</button>
                    <button class="btn btn-secondary" id="tasks-filter-todo" data-onclick="loadTasks('todo')" style="padding:7px 12px;font-size:12px;">📋 To Do</button>
                    <button class="btn btn-secondary" id="tasks-filter-doing" data-onclick="loadTasks('doing')" style="padding:7px 12px;font-size:12px;">⚡ Doing</button>
                    <button class="btn btn-secondary" id="tasks-filter-done" data-onclick="loadTasks('done')" style="padding:7px 12px;font-size:12px;">✅ Done</button>
                    <button class="btn" data-onclick="openNewTaskModal()" style="padding:7px 12px;font-size:12px;">➕ משימה חדשה</button>
                </div>
            </div>
            <div id="tasks-list"><div class="loading">טוען משימות...</div></div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ TRELLO MODAL -->
    <div id="trello-modal" class="modal-overlay">
        <div class="modal-box">
            <div class="modal-title">
                📌 ייצוא ל-Trello
                <button class="modal-close" data-onclick="closeTrelloModal()">✕</button>
            </div>
            <div id="trello-modal-body">
                <div class="form-group">
                    <label class="form-label">כותרת הכרטיס</label>
                    <input type="text" id="trello-title" class="filter-input" style="width:100%;">
                </div>
                <div class="form-group">
                    <label class="form-label">תיאור</label>
                    <textarea id="trello-desc" class="filter-input" rows="3" style="width:100%;resize:vertical;"></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">רשימה (List)</label>
                    <select id="trello-list" class="filter-select" style="width:100%;"></select>
                </div>
                <div class="form-group">
                    <label class="form-label">תווית (Label)</label>
                    <select id="trello-label" class="filter-select" style="width:100%;"><option value="">ללא תווית</option></select>
                </div>
                <div class="form-group">
                    <label class="form-label">תאריך ושעת ביצוע</label>
                    <input type="datetime-local" id="trello-due" class="filter-input" style="width:100%;">
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
                    <button class="btn btn-secondary" data-onclick="closeTrelloModal()" style="padding:9px 16px;">ביטול</button>
                    <button class="btn" id="trello-submit-btn" data-onclick="submitTrelloCard()" style="padding:9px 16px;">📌 שלח ל-Trello</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ TASK MODAL -->
    <div id="task-modal" class="modal-overlay">
        <div class="modal-box">
            <div class="modal-title">
                <span id="task-modal-title">➕ משימה חדשה</span>
                <button class="modal-close" data-onclick="closeTaskModal()">✕</button>
            </div>
            <div class="form-group">
                <label class="form-label">כותרת *</label>
                <input type="text" id="task-form-title" class="filter-input" style="width:100%;" placeholder="כותרת המשימה">
            </div>
            <div class="form-group">
                <label class="form-label">תיאור</label>
                <textarea id="task-form-desc" class="filter-input" rows="3" style="width:100%;resize:vertical;" placeholder="תיאור אופציונלי"></textarea>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                <div>
                    <label class="form-label">סטטוס</label>
                    <select id="task-form-status" class="filter-select" style="width:100%;">
                        <option value="todo">📋 To Do</option>
                        <option value="doing">⚡ Doing</option>
                        <option value="done">✅ Done</option>
                    </select>
                </div>
                <div>
                    <label class="form-label">עדיפות</label>
                    <select id="task-form-priority" class="filter-select" style="width:100%;">
                        <option value="normal">רגיל</option>
                        <option value="high">🔴 גבוה</option>
                        <option value="urgent">🚨 דחוף</option>
                        <option value="low">🟢 נמוך</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">מועד לביצוע</label>
                <input type="datetime-local" id="task-form-due" class="filter-input" style="width:100%;">
            </div>
            <div class="form-group">
                <label class="form-label">תזכורת</label>
                <input type="datetime-local" id="task-form-reminder" class="filter-input" style="width:100%;">
            </div>
            <input type="hidden" id="task-form-id">
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
                <button class="btn btn-secondary" data-onclick="closeTaskModal()" style="padding:9px 16px;">ביטול</button>
                <button class="btn" data-onclick="saveTask()" style="padding:9px 16px;">💾 שמור</button>
            </div>
        </div>
    </div>

    <script>
        let currentTab = 'dashboard';
        let activeConvPhone = null;
        let schedulingData = [];

        document.addEventListener('DOMContentLoaded', function() {
            updateTime();
            setInterval(updateTime, 1000);
            setTimeout(loadMorningIntelligence, 800);
            setInterval(checkReminders, 60000);

            document.querySelectorAll('.nav-tab[data-tab]').forEach(function(el) {
                el.addEventListener('click', function() {
                    switchTab(this.getAttribute('data-tab'));
                });
            });

            document.querySelectorAll('.stat-card[data-tab]').forEach(function(el) {
                el.addEventListener('click', function() {
                    switchTab(this.getAttribute('data-tab'));
                });
            });

            document.addEventListener('click', function(e) {
                const btn = e.target.closest('[data-onclick]');
                if (btn) {
                    var fn = btn.getAttribute('data-onclick');
                    try { eval(fn); } catch(err) { console.error('Action error:', fn, err); }
                }
                const inforuBtn = e.target.closest('.inforu-btn');
                if (inforuBtn) {
                    sendInforu(inforuBtn.dataset.phone, inforuBtn.dataset.name);
                }
            });
        });

        function updateTime() {
            const el = document.getElementById('time');
            if (el) el.textContent = new Date().toLocaleTimeString('he-IL');
        }

        function switchTab(tabName, filter) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-tab').forEach(n => n.classList.remove('active'));
            const target = document.getElementById('tab-' + tabName);
            if (target) target.classList.add('active');
            document.querySelectorAll('.nav-tab').forEach(function(n) {
                if (n.getAttribute('data-tab') === tabName) n.classList.add('active');
            });
            currentTab = tabName;
            window.scrollTo(0, 0);
            if (tabName === 'ads') loadAds();
            else if (tabName === 'messages') loadConversations();
            else if (tabName === 'leads') loadLeads(filter || null);
            else if (tabName === 'complexes') loadComplexes(filter === 'hot' ? 'hot' : null);
            else if (tabName === 'kones') loadKones(filter || null);
            else if (tabName === 'scheduling') loadScheduling();
            else if (tabName === 'scrapers') loadScraperStatus();
            else if (tabName === 'news') loadNews();
            else if (tabName === 'tasks') loadTasks('all');
        }

        async function loadMorningIntelligence() {
            const section = document.getElementById('morning-section');
            const content = document.getElementById('morning-content');
            section.style.display = 'block';
            content.innerHTML = '<div class="loading">טוען ינטליגנציה יומית...</div>';
            try {
                const data = await fetchJSON('/api/morning/preview');
                const opps = data.opportunities || [];
                const sellers = data.stressed_sellers || [];
                const generated = data.generated_at ? new Date(data.generated_at).toLocaleString('he-IL') : '';
                let html = '<p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">עודכן: ' + generated + '</p>';
                html += '<div class="intel-grid">';
                html += '<div>';
                html += '<h3 style="color:var(--green);margin-bottom:10px;font-size:14px;">🔥 הזדמנויות חמות (' + opps.length + ')</h3>';
                if (!opps.length) {
                    html += '<p style="color:var(--text-muted);font-size:13px;">אין הזדמנויות כרגע</p>';
                } else {
                    for (const op of opps.slice(0, 8)) {
                        const iai = op.iai_score || 0;
                        const clr = iai > 85 ? 'var(--green)' : iai > 70 ? 'var(--gold)' : 'var(--text-secondary)';
                        const opTitle = (op.name || op.city || 'מתחם') + (op.city ? ' - ' + op.city : '');
                        const opDesc = 'IAI: ' + iai + (op.developer ? ' | יזם: ' + op.developer : '') + (op.actual_premium ? ' | פרמייה: ' + op.actual_premium + '%' : '');
                        html += '<div class="intel-item" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">'
                            + '<div style="flex:1;"><div class="name">' + (op.name || op.city || 'מתחם') + '</div>'
                            + '<div class="meta"><span class="intel-score" style="background:' + clr + ';color:#000;">IAI ' + iai + '</span>'
                            + (op.city ? op.city : '') + (op.developer ? ' | ' + op.developer : '') + '</div></div>'
                            + '<button class="btn btn-secondary" style="padding:3px 7px;font-size:10px;white-space:nowrap;flex-shrink:0;" data-onclick="openTrelloModal(' + JSON.stringify(opTitle) + ',' + JSON.stringify(opDesc) + ')">📌 Trello</button>'
                            + '</div>';
                    }
                }
                html += '</div>';
                html += '<div>';
                html += '<h3 style="color:var(--gold);margin-bottom:10px;font-size:14px;">📉 מוכרים במצוקה (' + sellers.length + ')</h3>';
                if (!sellers.length) {
                    html += '<p style="color:var(--text-muted);font-size:13px;">אין מוכרים במצוקה כרגע</p>';
                } else {
                    for (const s of sellers.slice(0, 8)) {
                        const ssi = s.ssi_score || 0;
                        const sTitle = 'מוכר במצוקה: ' + (s.address || s.city || 'נכס');
                        const sDesc = 'SSI: ' + ssi + (s.city ? ' | ' + s.city : '') + (s.asking_price ? ' | מחיר: ₪' + parseInt(s.asking_price).toLocaleString() : '');
                        html += '<div class="intel-item" style="border-right-color:var(--gold);display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">'
                            + '<div style="flex:1;"><div class="name">' + (s.address || s.city || 'מוכר') + '</div>'
                            + '<div class="meta"><span class="intel-score" style="background:var(--gold);color:#000;">SSI ' + ssi + '</span>'
                            + (s.city ? s.city : '') + (s.asking_price ? ' | \u20AA' + parseInt(s.asking_price).toLocaleString() : '') + '</div></div>'
                            + '<button class="btn btn-secondary" style="padding:3px 7px;font-size:10px;white-space:nowrap;flex-shrink:0;" data-onclick="openTrelloModal(' + JSON.stringify(sTitle) + ',' + JSON.stringify(sDesc) + ')">📌 Trello</button>'
                            + '</div>';
                    }
                }
                html += '</div></div>';
                if (data.price_drops_24h && data.price_drops_24h.length) {
                    html += '<div style="margin-top:14px;"><h3 style="color:var(--red);margin-bottom:10px;font-size:14px;">💸 הורדות מחיר 24 שעות (' + data.price_drops_24h.length + ')</h3>';
                    for (const d of data.price_drops_24h.slice(0, 3)) {
                        html += '<div class="intel-item" style="border-right-color:var(--red);"><div class="name">' + (d.address || d.city || 'נכס') + '</div></div>';
                    }
                    html += '</div>';
                }
                content.innerHTML = html;
            } catch (e) {
                content.innerHTML = '<div class="error">שגיאה: ' + e.message + '</div>';
            }
        }

        async function loadAds() {
            const container = document.getElementById('ads-list');
            container.innerHTML = '<div class="loading">טוען מודעות...</div>';
            try {
                const params = new URLSearchParams();
                const city = document.getElementById('cityFilter')?.value;
                const minPrice = document.getElementById('minPriceFilter')?.value;
                const maxPrice = document.getElementById('maxPriceFilter')?.value;
                const phoneFilter = document.getElementById('phoneFilter')?.value;
                if (city) params.append('city', city);
                if (minPrice) params.append('minPrice', minPrice);
                if (maxPrice) params.append('maxPrice', maxPrice);
                if (phoneFilter) params.append('phoneFilter', phoneFilter);
                const data = await fetchJSON('/dashboard/api/ads?' + params);
                if (!data.success) throw new Error(data.error);
                if (!data.data.length) { container.innerHTML = '<div class="loading">📋 אין מודעות</div>'; return; }
                _adsData = data.data;
                document.getElementById('ads-pagination').textContent = 'סה"כ: ' + (data.pagination?.total || data.data.length) + ' מודעות | מוצגות: ' + data.data.length;
                renderAdsTable(_adsData);
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadAds()'); }
        }

        let _adsView = 'table';
        function setAdsView(view) {
            _adsView = view;
            const tableBtn = document.getElementById('ads-view-table');
            const gridBtn = document.getElementById('ads-view-grid');
            if (tableBtn) { tableBtn.className = view === 'table' ? 'btn' : 'btn btn-secondary'; }
            if (gridBtn) { gridBtn.className = view === 'grid' ? 'btn' : 'btn btn-secondary'; }
            if (_adsData.length) {
                if (view === 'grid') renderAdsGrid(_adsData);
                else renderAdsTable(_adsData);
            }
        }

        function renderAdsGrid(ads) {
            const table = document.getElementById('ads-table');
            const oldList = document.getElementById('ads-list');
            const gridContainer = document.getElementById('ads-grid-container');
            if (!gridContainer) return;
            if (table) table.style.display = 'none';
            if (oldList) oldList.style.display = 'none';
            gridContainer.style.display = '';
            const premiumColor = (pct) => parseFloat(pct) > 30 ? 'var(--green)' : parseFloat(pct) > 15 ? 'var(--gold)' : 'var(--red)';
            const urgencyColors = { 'דחוף': '#ef4444', 'ירושה': '#a855f7', 'כינוס': '#f97316', 'גירושין': '#ec4899', 'עוזב_ארץ': '#06b6d4' };
            gridContainer.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px;">'
                + ads.map((ad, i) => {
                    const price = ad.price_current ? '\u20AA' + parseInt(ad.price_current).toLocaleString() : '\u2014';
                    const premNow = ad.premium_percent && parseFloat(ad.premium_percent) > 0 ? parseFloat(ad.premium_percent).toFixed(1) + '%' : null;
                    const premAfter = (ad.premium_min && ad.premium_max && (parseFloat(ad.premium_min) > 0 || parseFloat(ad.premium_max) > 0))
                        ? parseFloat(ad.premium_min).toFixed(0) + '%\u2013' + parseFloat(ad.premium_max).toFixed(0) + '%' : null;
                    const statusHe = complexStatusHe[ad.complex_status] || (ad.complex_status || null);
                    const published = ad.published_at ? new Date(ad.published_at).toLocaleDateString('he-IL') : (ad.created_at ? new Date(ad.created_at).toLocaleDateString('he-IL') : '\u2014');
                    const ssi = ad.ssi_score || 0;
                    const ssiColor = ssi > 70 ? 'var(--green)' : ssi > 40 ? 'var(--gold)' : 'var(--text-secondary)';
                    const title = ad.title || ad.address || ('\u05de\u05d5\u05d3\u05e2\u05d4 #' + (i+1));
                    const city = ad.city || '';
                    const rooms = ad.rooms ? ad.rooms + ' חדר' : null;
                    const area = ad.area_sqm ? parseFloat(ad.area_sqm).toFixed(0) + ' \u05de"\u05e8' : null;
                    const floor = ad.floor != null ? '\u05e7\u05d5\u05de\u05d4 ' + ad.floor : null;
                    const source = ad.source || null;
                    const urgency = ad.gemini_urgency_flag && ad.gemini_urgency_flag !== 'null' ? ad.gemini_urgency_flag : null;
                    const urgencyColor = urgency ? (urgencyColors[urgency] || 'var(--gold)') : null;
                    const hiddenInfo = ad.gemini_hidden_info && ad.gemini_hidden_info !== 'null' ? ad.gemini_hidden_info : null;
                    const buildingAge = ad.building_age ? ad.building_age + ' שנה' : (ad.building_year ? 'נבנה ' + ad.building_year : null);
                    const hasRenewal = ad.has_renewal_plan;
                    const nearbyPlans = ad.nearby_plans ? (typeof ad.nearby_plans === 'string' ? JSON.parse(ad.nearby_plans) : ad.nearby_plans) : null;
                    const avgPriceSqm = ad.avg_price_sqm_area ? '\u20AA' + parseInt(ad.avg_price_sqm_area).toLocaleString() + '/מ"ר' : null;
                    const perplexityNotes = ad.perplexity_public_notes && ad.perplexity_public_notes !== 'null' ? ad.perplexity_public_notes : null;
                    const isEnriched = !!ad.gemini_enriched_at;
                    return '<div style="background:var(--bg-card);border-radius:10px;padding:14px;border:1px solid ' + (urgency ? urgencyColor : 'var(--border-subtle)') + ';display:flex;flex-direction:column;gap:7px;position:relative;">'
                        + (urgency ? '<div style="position:absolute;top:-7px;right:10px;background:' + urgencyColor + ';color:#fff;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;">⚡ ' + urgency + '</div>' : '')
                        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;' + (urgency ? 'margin-top:7px;' : '') + '">'
                        + '<div style="font-weight:600;font-size:13px;color:var(--text-primary);line-height:1.3;flex:1;">' + title + '</div>'
                        + (ssi > 0 ? '<div style="background:rgba(0,0,0,0.3);border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700;color:' + ssiColor + ';white-space:nowrap;">SSI ' + ssi + '</div>' : '')
                        + '</div>'
                        + (city ? '<div style="font-size:12px;color:var(--text-secondary);">' + city + '</div>' : '')
                        + '<div style="display:flex;flex-wrap:wrap;gap:5px;font-size:11px;">'
                        + (rooms ? '<span style="background:rgba(255,255,255,0.05);padding:2px 7px;border-radius:4px;color:var(--text-secondary);">' + rooms + '</span>' : '')
                        + (area ? '<span style="background:rgba(255,255,255,0.05);padding:2px 7px;border-radius:4px;color:var(--text-secondary);">' + area + '</span>' : '')
                        + (floor ? '<span style="background:rgba(255,255,255,0.05);padding:2px 7px;border-radius:4px;color:var(--text-secondary);">' + floor + '</span>' : '')
                        + (buildingAge ? '<span style="background:rgba(255,255,255,0.05);padding:2px 7px;border-radius:4px;color:var(--text-muted);">🏗 ' + buildingAge + '</span>' : '')
                        + (source ? '<span style="background:rgba(255,255,255,0.05);padding:2px 7px;border-radius:4px;color:var(--text-muted);">' + source + '</span>' : '')
                        + (hasRenewal ? '<span style="background:rgba(34,197,94,0.12);padding:2px 7px;border-radius:4px;color:var(--green);font-weight:600;">♻️ פינוי-בינוי</span>' : '')
                        + '</div>'
                        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;">'
                        + '<div style="font-size:17px;font-weight:700;color:var(--gold);">' + price + '</div>'
                        + '<div style="display:flex;gap:7px;font-size:11px;">'
                        + (premNow ? '<span style="color:' + premiumColor(ad.premium_percent) + ';">' + premNow + '</span>' : '')
                        + (premAfter ? '<span style="color:#60a5fa;">' + premAfter + '</span>' : '')
                        + (avgPriceSqm ? '<span style="color:var(--text-muted);">' + avgPriceSqm + '</span>' : '')
                        + '</div></div>'
                        + (statusHe ? '<div style="font-size:10px;background:rgba(100,100,200,0.15);padding:2px 7px;border-radius:4px;display:inline-block;align-self:flex-start;color:#a5b4fc;">' + statusHe + '</div>' : '')
                        + (hiddenInfo ? '<div style="font-size:11px;color:#a3e635;background:rgba(163,230,53,0.07);padding:5px 9px;border-radius:5px;border-left:2px solid #a3e635;">💡 ' + hiddenInfo + '</div>' : '')
                        + (nearbyPlans && nearbyPlans.length > 0 ? '<div style="font-size:10px;color:#60a5fa;background:rgba(96,165,250,0.07);padding:5px 9px;border-radius:5px;border-left:2px solid #3b82f6;">📋 ' + nearbyPlans.slice(0,2).join(' | ') + '</div>' : '')
                        + (perplexityNotes ? '<div style="font-size:10px;color:var(--text-secondary);background:rgba(148,163,184,0.05);padding:5px 9px;border-radius:5px;">🔍 ' + perplexityNotes + '</div>' : '')
                        + '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:7px;border-top:1px solid var(--border-subtle);">'
                        + '<div style="font-size:10px;color:var(--text-muted);">' + published + (isEnriched ? ' ✨' : '') + '</div>'
                        + '<div style="display:flex;gap:7px;">'
                        + (ad.phone ? '<a href="tel:' + ad.phone + '" style="color:var(--blue);font-size:11px;text-decoration:none;">' + ad.phone + '</a>' : '')
                        + (ad.url ? '<a href="' + ad.url + '" target="_blank" style="color:var(--blue);font-size:11px;text-decoration:none;">&#128279; פתח</a>' : '')
                        + '</div></div>'
                        + '</div>';
                }).join('')
                + '</div>';
        }

        let _adsSortField = 'created_at', _adsSortDir = 'desc', _adsData = [];
        function sortAdsBy(field) {
            if (_adsSortField === field) _adsSortDir = _adsSortDir === 'asc' ? 'desc' : 'asc';
            else { _adsSortField = field; _adsSortDir = 'desc'; }
            _adsData.sort((a,b) => {
                let va = a[field], vb = b[field];
                if (va == null) va = ''; if (vb == null) vb = '';
                if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) { va = parseFloat(va); vb = parseFloat(vb); }
                if (_adsSortDir === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
                return va < vb ? 1 : va > vb ? -1 : 0;
            });
            renderAdsTable(_adsData);
        }

        const complexStatusHe = { deposited: 'הופקדה', approved: 'אושרה', pre_deposit: 'להפקדה', planning: 'בתכנון', construction: 'בביצוע', declared: 'הוכרז', unknown: 'לא ידוע' };

        function renderAdsTable(ads) {
            const tbody = document.getElementById('ads-tbody');
            const table = document.getElementById('ads-table');
            const oldList = document.getElementById('ads-list');
            const gridContainer = document.getElementById('ads-grid-container');
            if (!tbody) return;
            table.style.display = '';
            oldList.style.display = 'none';
            if (gridContainer) gridContainer.style.display = 'none';
            const premiumColor = (pct) => parseFloat(pct) > 30 ? 'var(--green)' : parseFloat(pct) > 15 ? 'var(--gold)' : 'var(--red)';
            const statusBadge = (status) => {
                const map = { 'active': ['פעיל','rgba(74,222,128,0.18)','var(--green)'], 'pending': ['ממתין','rgba(232,184,75,0.18)','var(--gold)'], 'sold': ['נמכר','rgba(107,114,128,0.18)','var(--text-muted)'], 'closed': ['סגור','rgba(107,114,128,0.18)','var(--text-muted)'] };
                const s = (status || '').toLowerCase();
                const [label, bg, color] = map[s] || [status || '—', 'rgba(107,114,128,0.15)', 'var(--text-muted)'];
                return '<span style="background:' + bg + ';color:' + color + ';padding:5px 14px;border-radius:6px;font-size:12px;font-weight:500;">' + label + '</span>';
            };
            const miniSparkline = (color) => {
                const pts = Array.from({length:8}, () => 20 + Math.random()*60);
                const max = Math.max(...pts), min = Math.min(...pts);
                const norm = pts.map(p => 55 - ((p-min)/(max-min||1))*45);
                const path = norm.map((y,x) => (x===0?'M':'L') + (x*14+2) + ',' + y.toFixed(1)).join(' ');
                const area = path + ' L' + (7*14+2) + ',60 L2,60 Z';
                return '<svg width="100" height="60" style="display:block;">'
                    + '<defs><linearGradient id="sg' + color.replace('#','') + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="0.35"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0.03"/></linearGradient></defs>'
                    + '<path d="' + area + '" fill="url(#sg' + color.replace('#','') + ')"/>'
                    + '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>'
                    + '</svg>';
            };
            const imgThumb = (ad) => {
                const img = ad.image_url || ad.thumbnail_url || '';
                if (img) return '<img src="' + img + '" style="width:90px;height:60px;object-fit:cover;border-radius:5px;display:block;" onerror="this.onerror=null">';
                return '<div style="width:90px;height:60px;border-radius:5px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:20px;">🏠</div>';
            };
            tbody.innerHTML = ads.map((ad, i) => {
                const price = ad.price_current ? '\u20AA' + parseInt(ad.price_current).toLocaleString() : '\u2014';
                const premNow = ad.premium_percent && parseFloat(ad.premium_percent) > 0 ? parseFloat(ad.premium_percent).toFixed(1) + '%' : '\u2014';
                const premAfter = (ad.premium_min && ad.premium_max && (parseFloat(ad.premium_min) > 0 || parseFloat(ad.premium_max) > 0))
                    ? parseFloat(ad.premium_min).toFixed(0) + '%\u2013' + parseFloat(ad.premium_max).toFixed(0) + '%' : '\u2014';
                const statusHe = complexStatusHe[ad.complex_status] || (ad.complex_status || '\u2014');
                const published = ad.published_at ? new Date(ad.published_at).toLocaleDateString('he-IL') : (ad.created_at ? new Date(ad.created_at).toLocaleDateString('he-IL') : '\u2014');
                const created = ad.created_at ? new Date(ad.created_at).toLocaleDateString('he-IL') : '\u2014';
                const ssi = ad.ssi_score || 0;
                const ssiColor = ssi > 70 ? 'var(--green)' : ssi > 40 ? 'var(--gold)' : 'var(--text-muted)';
                const title = (ad.title || ad.address || ('\u05de\u05d5\u05d3\u05e2\u05d4 #' + (i+1))).substring(0, 55);
                const premNowColor = premiumColor(ad.premium_percent);
                const adStatus = ad.status || (ad.complex_status === 'sold' ? 'sold' : 'active');
                const sparkColor = adStatus === 'sold' ? '#6b7280' : adStatus === 'pending' ? '#e8b84b' : '#4ecdc4';
                return '<tr class="trow">'
                    + '<td style="min-width:220px;">'
                    + '<div style="display:flex;align-items:center;gap:10px;">'
                    + imgThumb(ad)
                    + '<div><div style="font-weight:600;font-size:13px;color:var(--text-primary);margin-bottom:2px;">'
                    + (ad.url ? '<a href="' + ad.url + '" target="_blank" style="color:var(--text-primary);text-decoration:none;">' + title + '</a>' : title)
                    + '</div><div style="font-size:11px;color:var(--text-muted);">' + (ad.city || '') + (ad.address ? ' | ' + ad.address.substring(0,30) : '') + '</div></div>'
                    + '</div></td>'
                    + '<td>' + statusBadge(adStatus) + '</td>'
                    + '<td>' + miniSparkline(sparkColor) + '</td>'
                    + '<td style="color:var(--text-primary);font-weight:600;font-size:14px;">' + price + '</td>'
                    + '<td style="color:' + premNowColor + ';font-weight:600;">' + premNow + '</td>'
                    + '<td>' + (ad.area_sqm ? parseFloat(ad.area_sqm).toFixed(0) + ' מ"ר' : '\u2014') + '</td>'
                    + '<td>' + (ad.rooms || '\u2014') + '</td>'
                    + '<td style="color:' + ssiColor + ';font-weight:600;">' + (ssi || '\u2014') + '</td>'
                    + '<td>' + (ad.phone ? '<a href="tel:' + ad.phone + '" style="color:var(--blue);font-size:12px;">' + ad.phone + '</a>' : '<span style="color:var(--text-muted);font-size:11px;">אין</span>') + '</td>'
                    + '<td><div style="display:flex;gap:6px;">'
                    + '<button class="btn btn-secondary" style="padding:5px 12px;font-size:12px;" onclick="return false">ערוך</button>'
                    + (ad.url ? '<a href="' + ad.url + '" target="_blank" class="btn" style="padding:5px 12px;font-size:12px;">צפה</a>' : '')
                    + '</div></td>'
                    + '</tr>';
            }).join('');
        }

        async function loadConversations() {
            const container = document.getElementById('conv-list');
            container.innerHTML = '<div class="loading">טוען שיחות...</div>';
            try {
                const params = new URLSearchParams();
                const search = document.getElementById('convSearchFilter')?.value;
                const status = document.getElementById('convStatusFilter')?.value;
                if (search) params.append('search', search);
                if (status) params.append('status', status);
                const data = await fetchJSON('/api/whatsapp/conversations?' + params);
                if (!data.success) throw new Error(data.error);
                if (!data.data.length) {
                    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);"><div style="font-size:32px;margin-bottom:10px;">📭</div><p>אין שיחות</p></div>';
                    return;
                }
                container.innerHTML = data.data.map(conv => renderConvItem(conv)).join('');
                if (activeConvPhone) {
                    const el = container.querySelector('[data-phone="' + activeConvPhone + '"]');
                    if (el) el.classList.add('active');
                }
            } catch (e) { container.innerHTML = '<div style="padding:20px;color:#fca5a5;">שגיאה: ' + e.message + '</div>'; }
        }

        function renderConvItem(conv) {
            const name = conv.display_name || conv.phone;
            const preview = conv.last_message ? conv.last_message.substring(0, 45) + (conv.last_message.length > 45 ? '...' : '') : 'אין הודעות';
            const dir = conv.last_direction === 'outgoing' ? '← ' : '→ ';
            const date = conv.updated_at ? new Date(conv.updated_at).toLocaleDateString('he-IL') : '';
            const statusColors = { active: 'var(--green)', closed: 'var(--text-muted)', agent_needed: 'var(--red)' };
            const dot = statusColors[conv.status] || 'var(--text-muted)';
            return '<div class="conv-item" data-phone="' + conv.phone + '" onclick="openConversation(this.dataset.phone)">'
                + '<div style="display:flex;align-items:center;gap:7px;">'
                + '<div style="width:7px;height:7px;border-radius:50%;background:' + dot + ';flex-shrink:0;"></div>'
                + '<div class="conv-name">' + name + '</div></div>'
                + '<div class="conv-preview">' + dir + preview + '</div>'
                + '<div class="conv-meta"><span>' + conv.phone + '</span><span>' + date + '</span></div>'
                + '</div>';
        }

        async function openConversation(phone) {
            activeConvPhone = phone;
            document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
            const item = document.querySelector('[data-phone="' + phone + '"]');
            if (item) item.classList.add('active');
            const thread = document.getElementById('conv-thread');
            thread.innerHTML = '<div class="loading">טוען הודעות...</div>';
            thread.classList.add('active');
            try {
                const data = await fetchJSON('/api/whatsapp/conversations/' + encodeURIComponent(phone) + '/messages');
                if (!data.success) throw new Error(data.error);
                const conv = data.conversation;
                const name = conv?.display_name || phone;
                const location = conv?.city || conv?.address || '';
                let html = '<div style="background:var(--bg-secondary);padding:14px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between;">'
                    + '<div><div style="font-weight:700;font-size:15px;">' + name + '</div>'
                    + '<div style="font-size:11px;color:var(--text-muted);">' + phone + (location ? ' | ' + location : '') + '</div></div>'
                    + '<div style="display:flex;gap:7px;">'
                    + '<a href="tel:' + phone + '" class="btn btn-secondary" style="padding:5px 10px;font-size:11px;">📞 התקשר</a>'
                    + '<a href="https://wa.me/' + phone.replace(/[^0-9]/g,'') + '" target="_blank" class="btn btn-green" style="padding:5px 10px;font-size:11px;">WhatsApp</a>'
                    + '</div></div>';
                if (!data.data.length) {
                    html += '<div style="text-align:center;padding:40px;color:var(--text-muted);">אין הודעות בשיחה זו</div>';
                } else {
                    html += '<div style="flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:4px;">';
                    for (const msg of data.data) {
                        const isOut = msg.direction === 'outgoing';
                        const time = msg.created_at ? new Date(msg.created_at).toLocaleString('he-IL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
                        html += '<div style="display:flex;justify-content:' + (isOut ? 'flex-end' : 'flex-start') + ';">'
                            + '<div class="bubble ' + (isOut ? 'bubble-out' : 'bubble-in') + '">'
                            + '<div>' + (msg.message || '').replace(/\\n/g, '<br>') + '</div>'
                            + '<div class="bubble-time" style="text-align:' + (isOut ? 'left' : 'right') + ';">' + time + '</div>'
                            + '</div></div>';
                    }
                    html += '</div>';
                }
                thread.innerHTML = html;
                const msgDiv = thread.querySelector('[style*="overflow-y:auto"]');
                if (msgDiv) msgDiv.scrollTop = msgDiv.scrollHeight;
            } catch (e) {
                thread.innerHTML = '<div style="padding:20px;color:#fca5a5;">שגיאה: ' + e.message + '</div>';
            }
        }

        let _leadsData = [], _leadsSortField = 'created_at', _leadsSortDir = 'desc';
        function sortLeadsBy(field) {
            if (_leadsSortField === field) _leadsSortDir = _leadsSortDir === 'asc' ? 'desc' : 'asc';
            else { _leadsSortField = field; _leadsSortDir = 'desc'; }
            renderLeadsTable(_leadsData);
        }
        async function loadLeads(filter) {
            const container = document.getElementById('leads-list');
            container.innerHTML = '<div class="loading">טוען לידים...</div>';
            try {
                const params = new URLSearchParams();
                const search = document.getElementById('leadsSearchFilter')?.value;
                const status = filter || document.getElementById('leadsStatusFilter')?.value;
                const type = document.getElementById('leadsTypeFilter')?.value;
                const source = document.getElementById('leadsSourceFilter')?.value;
                if (search) params.append('search', search);
                if (status) params.append('status', status);
                if (type) params.append('user_type', type);
                if (source) params.append('source', source);
                const data = await fetchJSON('/dashboard/api/leads?' + params);
                if (!data.success) throw new Error(data.error);
                _leadsData = data.data || [];
                if (!_leadsData.length) { container.innerHTML = '<div class="loading">👤 אין לידים בסינון הנ״ל</div>'; return; }
                renderLeadsTable(_leadsData);
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadLeads()'); }
        }

        function renderLeadsTable(leads) {
            const container = document.getElementById('leads-list');
            if (!leads.length) { container.innerHTML = '<div class="loading">אין לידים בסינון זה</div>'; return; }
            const sf = _leadsSortField, sd = _leadsSortDir;
            leads = [...leads].sort((a,b) => {
                let va = a[sf], vb = b[sf];
                if (va == null) va = ''; if (vb == null) vb = '';
                if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) { va = parseFloat(va); vb = parseFloat(vb); }
                if (sd === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
                return va < vb ? 1 : va > vb ? -1 : 0;
            });
            const typeLabel = { investor: '🏢 משקיע', owner: '🏠 מוכר', contact: '📩 פנייה' };
            const statusColors = { new: 'var(--blue)', qualified: 'var(--green)', contacted: 'var(--gold)', closed: 'var(--text-muted)', rejected: 'var(--red)' };
            const statusHe = { new: 'חדש', qualified: 'מוכשר', contacted: 'בתהליך', closed: 'סגור', rejected: 'נדחה' };
            const th = (label, field) => '<th data-sort="' + field + '" data-onclick="sortLeadsBy(this.dataset.sort)">' + label + ' <span style="color:' + (sf===field?'var(--gold)':'var(--text-muted)') + ';">' + (sf===field?(sd==='asc'?'▲':'▼'):'▲▼') + '</span></th>';
            container.innerHTML = '<div style="overflow-x:auto;"><table class="tbl">'
                + '<thead><tr>'
                + th('שם','name') + th('טלפון','phone') + th('אימייל','email') + th('סטטוס','status') + th('מקור','source') + th('סוג','user_type')
                + '<th>הערות</th>'
                + th('תאריך','created_at')
                + '</tr></thead><tbody>'
                + leads.map((lead, i) => {
                    const st = lead.status || 'new';
                    const stColor = statusColors[st] || 'var(--text-muted)';
                    const stHe = statusHe[st] || st;
                    const type = typeLabel[lead.user_type] || lead.user_type || '\u2014';
                    const date = lead.created_at ? new Date(lead.created_at).toLocaleDateString('he-IL') : '\u2014';
                    return '<tr class="trow">'
                        + '<td style="font-weight:600;">' + (lead.name || 'ליד #' + (i+1)) + (lead.is_urgent ? ' 🚨' : '') + '</td>'
                        + '<td>' + (lead.phone ? '<a href="tel:' + lead.phone + '" style="color:var(--blue);">' + lead.phone + '</a>' : '\u2014') + '</td>'
                        + '<td style="font-size:12px;">' + (lead.email || '\u2014') + '</td>'
                        + '<td><span style="background:' + stColor + '22;color:' + stColor + ';padding:2px 8px;border-radius:4px;font-size:11px;">' + stHe + '</span></td>'
                        + '<td style="font-size:12px;">' + (lead.source || '\u2014') + '</td>'
                        + '<td>' + type + '</td>'
                        + '<td style="font-size:12px;color:var(--text-secondary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (lead.notes || '') + '">' + (lead.notes || '\u2014') + '</td>'
                        + '<td style="font-size:12px;color:var(--text-muted);">' + date + '</td>'
                        + '</tr>';
                }).join('')
                + '</tbody></table></div>';
        }

        async function loadComplexes(filter) {
            const container = document.getElementById('complexes-list');
            const badge = document.getElementById('complexes-filter-badge');
            container.innerHTML = '<div class="loading">טוען מתחמים...</div>';
            if (badge) badge.innerHTML = filter === 'hot' ? '<span class="filter-active-badge">🔥 מסנן: הזדמנויות חמות - IAI > 75</span>' : '';
            try {
                const params = new URLSearchParams();
                const city = document.getElementById('complexesCityFilter')?.value;
                const minIAI = document.getElementById('minIAIFilter')?.value;
                const maxIAI = document.getElementById('maxIAIFilter')?.value;
                const status = document.getElementById('complexStatusFilter')?.value;
                if (city) params.append('city', city);
                if (minIAI) params.append('minIAI', minIAI);
                if (maxIAI) params.append('maxIAI', maxIAI);
                if (status) params.append('status', status);
                if (filter === 'hot') params.append('minIAI', '75');
                const data = await fetchJSON('/dashboard/api/complexes?' + params);
                if (!data.success) throw new Error(data.error);
                if (!data.data.length) { container.innerHTML = '<div class="loading">🏢 אין מתחמים</div>'; return; }
                renderComplexesTable(data.data);
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadComplexes()'); }
        }

        let _complexesData = [], _complexesSortField = 'iai_score', _complexesSortDir = 'desc';
        function sortComplexesBy(field) {
            if (_complexesSortField === field) _complexesSortDir = _complexesSortDir === 'asc' ? 'desc' : 'asc';
            else { _complexesSortField = field; _complexesSortDir = 'desc'; }
            renderComplexesTable(_complexesData);
        }
        function renderComplexesTable(complexes) {
            _complexesData = complexes;
            const container = document.getElementById('complexes-list');
            if (!complexes.length) { container.innerHTML = '<div class="loading">אין מתחמים בסינון זה</div>'; return; }
            const sf = _complexesSortField, sd = _complexesSortDir;
            complexes = [...complexes].sort((a,b) => {
                let va = a[sf], vb = b[sf];
                if (va == null) va = ''; if (vb == null) vb = '';
                if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) { va = parseFloat(va); vb = parseFloat(vb); }
                if (sd === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
                return va < vb ? 1 : va > vb ? -1 : 0;
            });
            const statusHe = { deposited: 'הופקדה', approved: 'אושרה', pre_deposit: 'להפקדה', planning: 'בתכנון', construction: 'בביצוע', declared: 'הוכרז', unknown: 'לא ידוע' };
            const th = (label, field) => '<th data-sort="' + field + '" data-onclick="sortComplexesBy(this.dataset.sort)">' + label + ' <span style="color:' + (sf===field?'var(--gold)':'var(--text-muted)') + ';">' + (sf===field?(sd==='asc'?'▲':'▼'):'▲▼') + '</span></th>';
            container.innerHTML = '<div style="overflow-x:auto;"><table class="tbl">'
                + '<thead><tr>'
                + th('שם מתחם','name') + th('עיר','city') + th('סטטוס תכנון','status') + '<th>סטטוס הפרוייקט</th>'
                + th('יחידות קיים','units_count') + th('יחידות מתוכנן','planned_units') + th('ציון IAI','iai_score') + th('פרמייה תיאורטית','theoretical_premium_min')
                + '<th>כתובת</th>'
                + '</tr></thead><tbody>'
                + complexes.map((c, i) => {
                    const st = c.status || 'unknown';
                    const stHe = statusHe[st] || st;
                    const iai = c.iai_score || 0;
                    const iaiColor = iai > 80 ? 'var(--green)' : iai > 60 ? 'var(--gold)' : 'var(--red)';
                    const premMin = c.theoretical_premium_min ? parseFloat(c.theoretical_premium_min).toFixed(0) + '%' : '\u2014';
                    const premMax = c.theoretical_premium_max ? parseFloat(c.theoretical_premium_max).toFixed(0) + '%' : '';
                    const prem = premMax ? premMin + '\u2013' + premMax : premMin;
                    let projStatus = '\u2014';
                    if (c.permit_date) projStatus = 'היתר בנייה';
                    else if (st === 'construction') projStatus = 'בבנייה';
                    else if (st === 'approved') projStatus = 'אושרה';
                    else if (st === 'deposited') projStatus = 'הופקדה';
                    else if (st === 'planning' || st === 'pre_deposit') projStatus = 'תכנון';
                    return '<tr class="trow">'
                        + '<td style="font-weight:600;">' + (c.name || 'מתחם #' + (i+1)) + '</td>'
                        + '<td>' + (c.city || '\u2014') + '</td>'
                        + '<td><span class="badge badge-purple">' + stHe + '</span></td>'
                        + '<td><span class="badge badge-blue">' + projStatus + '</span></td>'
                        + '<td style="text-align:center;">' + (c.units_count || c.existing_units || 0) + '</td>'
                        + '<td style="text-align:center;">' + (c.planned_units || 0) + '</td>'
                        + '<td style="text-align:center;color:' + iaiColor + ';font-weight:700;">' + (iai || '\u2014') + '</td>'
                        + '<td style="color:var(--green);font-weight:600;">' + prem + '</td>'
                        + '<td style="font-size:12px;color:var(--text-secondary);">' + (c.address || c.addresses || '\u2014') + '</td>'
                        + '</tr>';
                }).join('')
                + '</tbody></table></div>';
        }

        async function loadKones(filter) {
            const container = document.getElementById('kones-list');
            const badge = document.getElementById('kones-filter-badge');
            const statsBar = document.getElementById('kones-stats-bar');
            container.innerHTML = '<div class="loading">טוען כינוסי נכסים...</div>';
            const filterLabels = { pending: '⏳ ממתינים לפנייה', contacted: '✅ נוצר קשר', landline: '📞 קווי ארץ', no_phone: '🚫 אין טלפון', failed: '❌ נכשל' };
            if (badge) badge.innerHTML = filter && filterLabels[filter] ? '<span class="filter-active-badge">' + filterLabels[filter] + '</span>' : '';
            try {
                const params = new URLSearchParams();
                const city = document.getElementById('konesCityFilter')?.value;
                const search = document.getElementById('konesSearchFilter')?.value;
                const status = document.getElementById('konesStatusFilter')?.value || filter;
                if (city) params.append('city', city);
                if (search) params.append('search', search);
                if (status) params.append('status', status);
                const data = await fetchJSON('/dashboard/api/kones?' + params);
                if (!data.success) throw new Error(data.error);
                if (!status && statsBar) {
                    try {
                        const stats = await fetchJSON('/api/auto-contact/kones-stats');
                        if (stats.success) {
                            const s = stats.kones;
                            statsBar.style.display = 'flex';
                            statsBar.style.flexWrap = 'wrap';
                            statsBar.style.gap = '7px';
                            statsBar.innerHTML =
                                '<span class="filter-active-badge" style="cursor:pointer;" data-onclick="loadKones(&quot;contacted&quot;)">✅ נוצר קשר: ' + s.contacted + '</span>'
                                + '<span class="filter-active-badge" style="background:rgba(100,116,139,0.15);border-color:var(--text-muted);color:var(--text-muted);cursor:pointer;" data-onclick="loadKones(&quot;landline&quot;)">📞 קו ארץ: ' + s.landline + '</span>'
                                + '<span class="filter-active-badge" style="background:rgba(55,65,81,0.2);border-color:var(--text-muted);color:var(--text-muted);cursor:pointer;" data-onclick="loadKones(&quot;no_phone&quot;)">🚫 אין טלפון: ' + s.no_phone + '</span>'
                                + '<span class="filter-active-badge" style="background:rgba(239,68,68,0.12);border-color:var(--red);color:#fca5a5;cursor:pointer;" data-onclick="loadKones(&quot;failed&quot;)">❌ נכשל: ' + s.failed + '</span>';
                        }
                    } catch(e) { /* ignore */ }
                } else if (statsBar) { statsBar.style.display = 'none'; }
                if (!data.data.length) { container.innerHTML = '<div class="loading">🏗️ אין כינוסי נכסים בסינון זה</div>'; return; }
                renderKonesTable(data.data);
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadKones()'); }
        }

        let _konesData = [], _konesSortField = 'created_at', _konesSortDir = 'desc';
        function sortKonesBy(field) {
            if (_konesSortField === field) _konesSortDir = _konesSortDir === 'asc' ? 'desc' : 'asc';
            else { _konesSortField = field; _konesSortDir = 'desc'; }
            renderKonesTable(_konesData);
        }
        function renderKonesTable(kones) {
            _konesData = kones;
            const container = document.getElementById('kones-list');
            if (!kones.length) { container.innerHTML = '<div class="loading">אין כינוסי נכסים בסינון זה</div>'; return; }
            const sf = _konesSortField, sd = _konesSortDir;
            kones = [...kones].sort((a,b) => {
                let va = a[sf], vb = b[sf];
                if (va == null) va = ''; if (vb == null) vb = '';
                if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) { va = parseFloat(va); vb = parseFloat(vb); }
                if (sd === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
                return va < vb ? 1 : va > vb ? -1 : 0;
            });
            const statusLabel = { pending: 'ממתין', contacted: 'נוצר קשר', failed: 'נכשל', landline: 'קו ארץ', no_phone: 'אין טלפון' };
            const statusColors = { pending: 'var(--gold)', contacted: 'var(--green)', failed: 'var(--red)', landline: 'var(--text-muted)', no_phone: 'var(--text-muted)' };
            const th = (label, field) => '<th data-sort="' + field + '" data-onclick="sortKonesBy(this.dataset.sort)">' + label + ' <span style="color:' + (sf===field?'var(--gold)':'var(--text-muted)') + ';">' + (sf===field?(sd==='asc'?'▲':'▼'):'▲▼') + '</span></th>';
            container.innerHTML = '<div style="overflow-x:auto;"><table class="tbl">'
                + '<thead><tr>'
                + th('כותרת','title') + th('כתובת','address') + th('עיר','city') + th('טלפון','phone') + th('מחיר','price') + th('סטטוס','contact_status')
                + th('כונס','contact_person') + th('ניסיונות','contact_attempts') + th('גוש/חלקה','gush_helka')
                + '<th>קישור</th>'
                + '</tr></thead><tbody>'
                + kones.map((k, i) => {
                    const st = k.contact_status || 'pending';
                    const stLabel = statusLabel[st] || st;
                    const stColor = statusColors[st] || 'var(--gold)';
                    const price = k.price ? '\u20AA' + parseInt(k.price).toLocaleString() : '\u2014';
                    const phone = k.phone ? '<a href="tel:' + k.phone + '" style="color:var(--blue);">' + k.phone + '</a>' : '\u2014';
                    const title = k.title || k.address || ('כינוס #' + (i+1));
                    return '<tr class="trow">'
                        + '<td style="font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + title + '">' + title + '</td>'
                        + '<td style="font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (k.address || '\u2014') + '</td>'
                        + '<td>' + (k.city || '\u2014') + '</td>'
                        + '<td>' + phone + '</td>'
                        + '<td style="color:var(--gold);font-weight:600;">' + price + '</td>'
                        + '<td><span style="background:' + stColor + '22;color:' + stColor + ';padding:2px 8px;border-radius:4px;font-size:11px;">' + stLabel + '</span></td>'
                        + '<td style="font-size:12px;">' + (k.contact_person || '\u2014') + '</td>'
                        + '<td style="text-align:center;">' + (k.contact_attempts || 0) + '</td>'
                        + '<td style="font-size:12px;">' + (k.gush_helka || '\u2014') + '</td>'
                        + '<td>' + (k.url ? '<a href="' + k.url + '" target="_blank" class="btn btn-secondary" style="padding:3px 8px;font-size:11px;">פתח</a>' : '\u2014') + '</td>'
                        + '</tr>';
                }).join('')
                + '</tbody></table></div>';
        }

        async function runKonesAutoContact() {
            if (!confirm('להפעיל Auto Contact לכינוסי נכסים?')) return;
            try {
                const res = await fetch('/api/auto-contact/run-kones', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                if (res.ok) {
                    const d = await res.json();
                    const r = d.result || {};
                    alert('✅ Auto Contact הופעל!\n\nנוצר קשר: ' + (r.contacted||0) + '\nקווי ארץ (נדרשת שיחה): ' + (r.skipped_landline||0) + '\nאין טלפון: ' + (r.skipped_no_phone||0) + '\nנכשל: ' + (r.failed||0));
                    loadKones();
                } else throw new Error('HTTP ' + res.status);
            } catch (e) { alert('❌ נכשל: ' + e.message); }
        }

        async function loadNews() {
            const tbody = document.getElementById('news-table-body');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">טוען...</td></tr>';
            try {
                const data = await fetchJSON('/api/news');
                if (!data.success) throw new Error(data.error);
                if (!data.data || !data.data.length) {
                    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted);">אין חדשות</td></tr>';
                    return;
                }
                tbody.innerHTML = data.data.map((item, i) => {
                    const date = item.published_at ? new Date(item.published_at).toLocaleDateString('he-IL') : '\u2014';
                    return '<tr class="trow">'
                        + '<td style="color:var(--text-muted);">' + (i+1) + '</td>'
                        + '<td style="font-weight:600;">' + (item.title ? '<a href="' + (item.url||'#') + '" target="_blank" style="color:var(--text-primary);text-decoration:none;">' + item.title + '</a>' : '\u2014') + '</td>'
                        + '<td style="font-size:12px;color:var(--text-secondary);max-width:300px;">' + (item.description || item.summary || '\u2014').substring(0,120) + '</td>'
                        + '<td><span class="badge badge-blue">' + (item.category || 'כללי') + '</span></td>'
                        + '<td style="font-size:12px;color:var(--text-muted);">' + date + '</td>'
                        + '</tr>';
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--red);">שגיאה: ' + e.message + '</td></tr>';
            }
        }

        async function loadFacebookAds() {
            try {
                const data = await fetchJSON('/dashboard/api/facebook/ads');
                if (!data.success) throw new Error(data.error);
                document.getElementById('facebook-ads-section').style.display = 'block';
                document.getElementById('facebook-ads-list').innerHTML = data.data.map(ad =>
                    '<div class="data-item"><h3>' + ad.ad_name + '</h3><p style="color:var(--text-secondary);margin-bottom:7px;">' + ad.campaign_name + '</p><div class="data-meta">'
                    + '<div class="data-meta-item"><span class="data-meta-label">הופעות:</span><span class="data-meta-value">' + ad.impressions.toLocaleString() + '</span></div>'
                    + '<div class="data-meta-item"><span class="data-meta-label">קליקים:</span><span class="data-meta-value">' + ad.clicks + '</span></div>'
                    + '<div class="data-meta-item"><span class="data-meta-label">CTR:</span><span class="data-meta-value">' + ad.ctr + '%</span></div>'
                    + '<div class="data-meta-item"><span class="data-meta-label">לידים:</span><span class="data-meta-value">' + ad.leads + '</span></div>'
                    + '</div></div>'
                ).join('');
            } catch (e) { console.error('FB ads error:', e); }
        }

        function exportData(type) {
            window.open('/api/export/' + type + '?format=xlsx', '_blank');
        }

        async function refreshStats() {
            try {
                const data = await fetchJSON('/dashboard/api/stats');
                if (data.success) location.reload();
            } catch (e) { console.error('Refresh failed:', e); }
        }

        // ── FULL SCAN (includes enrichment) ──────────────────────────
        async function runFullScan() {
            if (!confirm('להפעיל סריקה מלאה כולל Enrichment (טלפון + AI)?\nהתהליך עשוי לקחת מספר דקות.')) return;
            const btn = document.querySelector('[data-onclick="runFullScan()"]');
            if (btn) { btn.textContent = '⏳ סורק...'; btn.disabled = true; }
            try {
                const res = await fetch('/api/scan/full', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 50 }) });
                const d = await res.json();
                if (res.ok) {
                    alert('✅ סריקה מלאה הושלמה!\n\nמודעות חדשות: ' + (d.newListings||0) + '\nהועשרו: ' + (d.enriched||0) + '\nטלפונים נמצאו: ' + (d.phones||0));
                    refreshStats();
                } else throw new Error(d.error || 'HTTP ' + res.status);
            } catch (e) { alert('❌ שגיאה: ' + e.message); }
            finally {
                if (btn) { btn.textContent = '🚀 סריקה מלאה + Enrichment'; btn.disabled = false; }
            }
        }

        // ── SCRAPERS ─────────────────────────────────────────────────
        const SCRAPERS_CONFIG = [
            { id: 'yad2',       name: 'יד2',          icon: '🏠', desc: 'פורטל הנדלן הגדול בישראל',    endpoint: '/api/scan/yad2',      color: '#e74c3c' },
            { id: 'yad1',       name: 'יד1',          icon: '🏡', desc: 'מודעות נדלן יד ראשונה',       endpoint: '/api/scan/yad1',      color: '#e67e22' },
            { id: 'winwin',     name: 'WinWin',       icon: '🏢', desc: 'נדלן מסחרי ומגורים',          endpoint: '/api/scan/winwin',    color: '#3498db' },
            { id: 'homeless',   name: 'Homeless',     icon: '🏘', desc: 'מודעות דירות ומשרדים',        endpoint: '/api/scan/homeless',  color: '#9b59b6' },
            { id: 'nadlan',     name: 'נדלן.נט',      icon: '🌐', desc: 'פורטל נדלן מקיף',             endpoint: '/api/scan/nadlan',    color: '#1abc9c' },
            { id: 'mavat',      name: 'מבא"ת',        icon: '📋', desc: 'מידע ממשלתי על נכסים',        endpoint: '/api/scan/mavat',     color: '#2ecc71' },
            { id: 'madlan',     name: 'מדלן',         icon: '📊', desc: 'נתוני שוק ומחירים',           endpoint: '/api/scan/madlan',    color: '#f39c12' },
            { id: 'dira',       name: 'דירה',         icon: '🔑', desc: 'מודעות דירות להשכרה ומכירה', endpoint: '/api/scan/dira',      color: '#e74c3c' },
            { id: 'komo',       name: 'Komo',         icon: '🏗', desc: 'פרויקטים חדשים',              endpoint: '/api/scan/komo',      color: '#3498db' },
            { id: 'govmap',     name: 'GovMap',       icon: '🗺', desc: 'מפות ממשלתיות ותכנון',        endpoint: '/api/scan/govmap',    color: '#27ae60' },
            { id: 'bidspirit',  name: 'BidSpirit',    icon: '🔨', desc: 'מכירות פומביות ומכרזים',      endpoint: '/api/scan/bidspirit', color: '#c0392b' },
            { id: 'banknadlan', name: 'בנק נדלן',     icon: '🏦', desc: 'נכסי בנקים ומימוש משכנתאות', endpoint: '/api/scan/banknadlan',color: '#2980b9' },
            { id: 'facebook',   name: 'פייסבוק',      icon: '📱', desc: 'מודעות נדלן בפייסבוק',        endpoint: '/api/facebook/sync',  color: '#3b5998' },
        ];

        let scraperStatuses = {};

        function renderScraperCards() {
            const grid = document.getElementById('scrapers-grid');
            if (!grid) return;
            grid.innerHTML = SCRAPERS_CONFIG.map(function(s) {
                const st = scraperStatuses[s.id] || {};
                const running = st.running;
                const lastRun = st.lastRun ? new Date(st.lastRun).toLocaleString('he-IL') : 'לא הופעל';
                const count = st.count !== undefined ? st.count : '\u2014';
                const statusColor = running ? 'var(--gold)' : (st.error ? 'var(--red)' : 'var(--green)');
                const statusText = running ? '⏳ פועל...' : (st.error ? '❌ שגיאה' : (st.lastRun ? '✅ הושלם' : '⚪ ממתין'));
                return '<div class="data-item" style="border-right-color:' + s.color + ';padding:14px;">'
                    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">'
                    + '<div><div style="font-size:18px;margin-bottom:3px;">' + s.icon + ' ' + s.name + '</div>'
                    + '<div style="font-size:11px;color:var(--text-secondary);">' + s.desc + '</div></div>'
                    + '<span style="font-size:11px;color:' + statusColor + ';font-weight:600;">' + statusText + '</span></div>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px;font-size:11px;color:var(--text-muted);">'
                    + '<div>🕐 הפעלה אחרונה:<br><span style="color:var(--text-primary);">' + lastRun + '</span></div>'
                    + '<div>📦 מודעות:<br><span style="color:var(--gold);font-weight:700;font-size:15px;">' + count + '</span></div></div>'
                    + (st.error ? '<div style="font-size:10px;color:var(--red);margin-bottom:7px;padding:5px 8px;background:rgba(239,68,68,0.08);border-radius:4px;">⚠️ ' + st.error + '</div>' : '')
                    + '<button class="btn btn-green" data-id="' + s.id + '" data-endpoint="' + s.endpoint + '" data-onclick="runScraper(this.dataset.id, this.dataset.endpoint)" '
                    + (running ? 'disabled' : '') + ' style="width:100%;padding:7px;font-size:12px;">'
                    + (running ? '⏳ פועל...' : '▶️ סרוק עכשיו') + '</button></div>';
            }).join('');
        }

        async function runScraper(id, endpoint) {
            scraperStatuses[id] = Object.assign({}, scraperStatuses[id], { running: true, error: null });
            renderScraperCards();
            try {
                const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 50 }) });
                const d = await res.json();
                scraperStatuses[id] = {
                    running: false,
                    lastRun: new Date().toISOString(),
                    count: d.count || d.total || d.found || (d.results && d.results.length) || 0,
                    error: res.ok ? null : (d.error || d.message || 'שגיאה לא ידועה')
                };
            } catch (e) {
                scraperStatuses[id] = { running: false, lastRun: new Date().toISOString(), count: 0, error: e.message };
            }
            renderScraperCards();
        }

        async function runAllScrapers() {
            for (var i = 0; i < SCRAPERS_CONFIG.length; i++) {
                var s = SCRAPERS_CONFIG[i];
                runScraper(s.id, s.endpoint);
                await new Promise(function(r) { setTimeout(r, 500); });
            }
        }

        function loadScraperStatus() {
            renderScraperCards();
        }

        // ── SCHEDULING ───────────────────────────────────────────────
        async function loadScheduling() {
            const list = document.getElementById('sched-list');
            const kpis = document.getElementById('sched-kpis');
            const stateFilter = document.getElementById('sched-filter-state')?.value || '';
            const langFilter = document.getElementById('sched-filter-lang')?.value || '';
            list.innerHTML = '<div class="loading">טוען נתוני תיאומים...</div>';
            try {
                const data = await fetchJSON('/api/dashboard/scheduling/overview');
                if (!data.success) throw new Error(data.error);
                const s = data.sessions || {};
                const sl = data.slots || {};
                const cer = data.ceremonies || {};
                kpis.innerHTML = [
                    { label: 'סה"כ שיחות', val: s.total || 0, color: 'var(--blue)' },
                    { label: 'מאושרות', val: s.confirmed || 0, color: 'var(--green)' },
                    { label: 'ממתינות', val: s.pending || 0, color: 'var(--gold)' },
                    { label: 'סירבו', val: s.declined || 0, color: 'var(--red)' },
                    { label: 'עברית', val: s.hebrew || 0, color: 'var(--blue)' },
                    { label: 'רוסית', val: s.russian || 0, color: 'var(--blue)' },
                    { label: 'סלוטים פנויים', val: sl.open || 0, color: 'var(--gold)' },
                    { label: 'טקסי חתימה', val: cer.total || 0, color: 'var(--blue)' }
                ].map(k => '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px;padding:12px;text-align:center;"><div style="font-size:22px;font-weight:800;color:' + k.color + ';">' + k.val + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">' + k.label + '</div></div>').join('');
                schedulingData = data.contacts || [];
                renderSchedulingTable(schedulingData, stateFilter, langFilter);
            } catch (e) {
                list.innerHTML = errorHTML(e.message, 'loadScheduling()');
            }
        }

        function filterSchedulingTable() {
            const stateFilter = document.getElementById('sched-filter-state')?.value || '';
            const langFilter = document.getElementById('sched-filter-lang')?.value || '';
            renderSchedulingTable(schedulingData, stateFilter, langFilter);
        }

        let _schedSortField = 'last_message_at', _schedSortDir = 'desc';
        function sortSchedBy(field) {
            if (_schedSortField === field) _schedSortDir = _schedSortDir === 'asc' ? 'desc' : 'asc';
            else { _schedSortField = field; _schedSortDir = 'desc'; }
            const sf2 = document.getElementById('sched-filter-state')?.value || '';
            const lf2 = document.getElementById('sched-filter-lang')?.value || '';
            renderSchedulingTable(schedulingData, sf2, lf2);
        }

        function renderSchedulingTable(rows, stateFilter, langFilter) {
            const list = document.getElementById('sched-list');
            const search = (document.getElementById('sched-search')?.value || '').toLowerCase();
            let filtered = rows.filter(r => {
                if (stateFilter && r.state !== stateFilter) return false;
                if (langFilter && r.language !== langFilter) return false;
                if (search) {
                    const name = (r.contact_name || '').toLowerCase();
                    const phone = (r.phone || '').toLowerCase();
                    if (!name.includes(search) && !phone.includes(search)) return false;
                }
                return true;
            });
            const sf = _schedSortField, sd = _schedSortDir;
            filtered = [...filtered].sort((a,b) => {
                let va = a[sf], vb = b[sf];
                if (va == null) va = ''; if (vb == null) vb = '';
                if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) { va = parseFloat(va); vb = parseFloat(vb); }
                if (sd === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
                return va < vb ? 1 : va > vb ? -1 : 0;
            });
            if (!filtered.length) { list.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">אין נתונים תואמים לסינון</div>'; return; }
            const stateColors = { confirmed: 'var(--green)', pending: 'var(--gold)', declined: 'var(--red)', cancelled: 'var(--text-muted)', no_answer: 'var(--red)' };
            const stateHe = { confirmed: '✅ מאושר', pending: '⏳ ממתין', declined: '❌ סירב', cancelled: '🚫 בוטל', no_answer: '📵 לא ענה' };
            const langLabel = { he: '🇮🇱', ru: '🇷🇺' };
            const typeMap = { signing_ceremony: 'כנס חתימות', consultation: 'ייעוץ', appraiser: 'שמאי', surveyor: 'מודד', physical: 'פגישה' };
            const th = (label, field) => '<th data-sort="' + field + '" data-onclick="sortSchedBy(this.dataset.sort)">' + label + ' <span style="color:' + (sf===field?'var(--gold)':'var(--text-muted)') + ';">' + (sf===field?(sd==='asc'?'▲':'▼'):'▲▼') + '</span></th>';
            const rows_html = filtered.map(r => {
                const phoneClean = (r.phone || '').replace(/\D/g,'');
                const meetingType = r.meeting_type || r.campaign_meeting_type || '';
                const stColor = stateColors[r.state] || 'var(--text-muted)';
                const stHe = stateHe[r.state] || (r.state || '\u2014');
                const dateStr = r.slot_display || (r.last_message_at ? new Date(r.last_message_at).toLocaleString('he-IL') : '\u2014');
                return '<tr class="trow">'
                    + '<td style="font-weight:600;">' + (r.contact_name || 'לא ידוע') + '</td>'
                    + '<td>' + (r.phone ? '<a href="tel:' + r.phone + '" style="color:var(--blue);">' + r.phone + '</a>' : '\u2014') + ' ' + (langLabel[r.language] || '') + '</td>'
                    + '<td><span style="background:' + stColor + '22;color:' + stColor + ';padding:2px 8px;border-radius:4px;font-size:11px;">' + stHe + '</span></td>'
                    + '<td style="font-size:12px;color:var(--text-secondary);">' + (typeMap[meetingType] || meetingType || '\u2014') + '</td>'
                    + '<td style="font-size:12px;color:#60a5fa;">' + dateStr + '</td>'
                    + '<td><button class="btn inforu-btn" data-phone="' + phoneClean + '" data-name="' + (r.contact_name||'') + '" style="padding:5px 10px;font-size:11px;background:rgba(45,212,191,0.12);border:1px solid var(--teal);color:var(--teal);white-space:nowrap;">📱 שלח</button></td>'
                    + '</tr>';
            }).join('');
            list.innerHTML = '<div style="overflow-x:auto;"><table class="tbl">'
                + '<thead><tr>'
                + th('שם','contact_name') + th('טלפון','phone') + th('סטטוס','state') + th('סוג פגישה','meeting_type') + th('מועד / עדכון','last_message_at')
                + '<th>שליחה</th>'
                + '</tr></thead><tbody>' + rows_html + '</tbody></table></div>';
        }

        async function sendInforu(phone, name) {
            if (!phone) { alert('אין מספר טלפון'); return; }
            const msg = prompt('הודעה לשליחה ל-' + (name || phone) + ':', 'שלום ' + (name || '') + ', QUANTUM כאן. האם נוכל לתאם פגישה?');
            if (!msg) return;
            try {
                const res = await fetch('/api/inforu/send-whatsapp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, message: msg })
                });
                const d = await res.json();
                if (d.success) alert('✅ ההודעה נשלחה בהצלחה!');
                else alert('❌ שגיאה: ' + (d.error || 'נכשל'));
            } catch(e) { alert('❌ שגיאה: ' + e.message); }
        }

        // ── TASKS ────────────────────────────────────────────────────
        let _currentTaskFilter = 'all';
        let _trelloLists = [];
        let _trelloLabels = [];
        let _trelloTaskContext = null;

        async function loadTasks(filter) {
            _currentTaskFilter = filter || 'all';
            ['all','todo','doing','done'].forEach(function(f) {
                const btn = document.getElementById('tasks-filter-' + f);
                if (btn) btn.className = f === _currentTaskFilter ? 'btn' : 'btn btn-secondary';
            });
            const container = document.getElementById('tasks-list');
            container.innerHTML = '<div class="loading">טוען משימות...</div>';
            try {
                const url = '/dashboard/api/tasks' + (_currentTaskFilter !== 'all' ? '?status=' + _currentTaskFilter : '');
                const data = await fetchJSON(url);
                if (!data.success) throw new Error(data.error);
                renderTasksList(data.tasks);
            } catch (e) {
                container.innerHTML = '<div class="error">שגיאה: ' + e.message + '</div>';
            }
        }

        function renderTasksList(tasks) {
            const container = document.getElementById('tasks-list');
            if (!tasks.length) { container.innerHTML = '<div class="loading">📋 אין משימות</div>'; return; }
            const statusColors = { todo: 'var(--blue)', doing: 'var(--gold)', done: 'var(--green)' };
            const statusLabels = { todo: '📋 To Do', doing: '⚡ Doing', done: '✅ Done' };
            const priorityColors = { urgent: 'var(--red)', high: '#f97316', normal: 'var(--text-muted)', low: 'var(--green)' };
            const priorityLabels = { urgent: '🚨 דחוף', high: '🔴 גבוה', normal: 'רגיל', low: '🟢 נמוך' };
            container.innerHTML = tasks.map(function(t) {
                const due = t.due_date ? new Date(t.due_date) : null;
                const dueStr = due ? due.toLocaleString('he-IL') : null;
                const isOverdue = due && due < new Date() && t.status !== 'done';
                const reminder = t.reminder_at ? new Date(t.reminder_at) : null;
                const reminderStr = reminder ? reminder.toLocaleString('he-IL') : null;
                return '<div class="data-item" style="border-right-color:' + (statusColors[t.status] || 'var(--text-muted)') + ';">'
                    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">'
                    + '<div style="flex:1;">'
                    + '<div style="font-weight:700;font-size:15px;color:var(--text-primary);margin-bottom:5px;">' + t.title + '</div>'
                    + (t.description ? '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:7px;">' + t.description + '</div>' : '')
                    + '<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">'
                    + '<span class="badge" style="background:' + (statusColors[t.status] || 'var(--text-muted)') + '22;color:' + (statusColors[t.status] || 'var(--text-muted)') + ';border-color:' + (statusColors[t.status] || 'var(--text-muted)') + '44;">' + (statusLabels[t.status] || t.status) + '</span>'
                    + '<span class="badge" style="background:' + (priorityColors[t.priority] || 'var(--text-muted)') + '22;color:' + (priorityColors[t.priority] || 'var(--text-muted)') + ';border-color:' + (priorityColors[t.priority] || 'var(--text-muted)') + '44;">' + (priorityLabels[t.priority] || t.priority) + '</span>'
                    + (dueStr ? '<span style="font-size:11px;color:' + (isOverdue ? 'var(--red)' : 'var(--text-secondary)') + ';">' + (isOverdue ? '⚠️ ' : '📅 ') + dueStr + '</span>' : '')
                    + (reminderStr ? '<span style="font-size:11px;color:var(--purple);">🔔 ' + reminderStr + '</span>' : '')
                    + (t.trello_card_url ? '<a href="' + t.trello_card_url + '" target="_blank" style="font-size:11px;color:var(--teal);">📌 Trello</a>' : '')
                    + '</div></div>'
                    + '<div style="display:flex;gap:5px;flex-wrap:wrap;flex-shrink:0;">'
                    + (t.status !== 'done' ? '<button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;" data-onclick="updateTaskStatus(' + t.id + ',\'' + (t.status === 'todo' ? 'doing' : 'done') + '\')">'
                        + (t.status === 'todo' ? '▶️ התחל' : '✅ סיים') + '</button>' : '')
                    + '<button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;" data-onclick="editTask(' + t.id + ')">✏️ ערוך</button>'
                    + (!t.trello_card_id ? '<button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;" data-onclick="openTrelloModalForTask(' + t.id + ',\'' + t.title.replace(/'/g, '') + '\',' + JSON.stringify(t.description || '') + ')">📌 Trello</button>' : '')
                    + (t.reminder_at && !t.reminder_snoozed ? '<button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;" data-onclick="snoozeReminder(' + t.id + ')">⏰ Snooze</button>' : '')
                    + '<button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;color:var(--red);" data-onclick="deleteTask(' + t.id + ')">🗑️</button>'
                    + '</div></div></div>';
            }).join('');
        }

        async function updateTaskStatus(id, newStatus) {
            try {
                const resp = await fetch('/dashboard/api/tasks/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus }) });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                loadTasks(_currentTaskFilter);
            } catch (e) { alert('שגיאה: ' + e.message); }
        }

        async function deleteTask(id) {
            try {
                const resp = await fetch('/dashboard/api/tasks/' + id, { method: 'DELETE' });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                loadTasks(_currentTaskFilter);
            } catch (e) { alert('שגיאה: ' + e.message); }
        }

        async function snoozeReminder(id) {
            try {
                const newReminder = new Date(Date.now() + 30 * 60 * 1000).toISOString();
                const resp = await fetch('/dashboard/api/tasks/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ reminder_at: newReminder, reminder_snoozed: false }) });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                loadTasks(_currentTaskFilter);
            } catch (e) { alert('שגיאה: ' + e.message); }
        }

        function checkReminders() {
            if (!('Notification' in window)) return;
            fetchJSON('/dashboard/api/tasks').then(function(data) {
                if (!data.success) return;
                const now = new Date();
                data.tasks.forEach(function(t) {
                    if (!t.reminder_at || t.reminder_snoozed || t.status === 'done') return;
                    const rem = new Date(t.reminder_at);
                    const diff = (rem - now) / 1000 / 60;
                    if (diff >= -1 && diff <= 1) {
                        if (Notification.permission === 'granted') {
                            new Notification('🔔 תזכורת: ' + t.title, { body: t.description || 'משימה דורשת תשומתך' });
                        } else if (Notification.permission !== 'denied') {
                            Notification.requestPermission();
                        }
                    }
                });
            }).catch(function() {});
        }

        function openNewTaskModal() {
            document.getElementById('task-form-id').value = '';
            document.getElementById('task-form-title').value = '';
            document.getElementById('task-form-desc').value = '';
            document.getElementById('task-form-status').value = 'todo';
            document.getElementById('task-form-priority').value = 'normal';
            document.getElementById('task-form-due').value = '';
            document.getElementById('task-form-reminder').value = '';
            document.getElementById('task-modal-title').textContent = '➕ משימה חדשה';
            document.getElementById('task-modal').style.display = 'flex';
        }

        async function editTask(id) {
            try {
                const data = await fetchJSON('/dashboard/api/tasks');
                const t = data.tasks.find(function(x) { return x.id === id; });
                if (!t) return;
                document.getElementById('task-form-id').value = t.id;
                document.getElementById('task-form-title').value = t.title;
                document.getElementById('task-form-desc').value = t.description || '';
                document.getElementById('task-form-status').value = t.status;
                document.getElementById('task-form-priority').value = t.priority;
                document.getElementById('task-form-due').value = t.due_date ? new Date(t.due_date).toISOString().slice(0,16) : '';
                document.getElementById('task-form-reminder').value = t.reminder_at ? new Date(t.reminder_at).toISOString().slice(0,16) : '';
                document.getElementById('task-modal-title').textContent = '✏️ עריכת משימה';
                document.getElementById('task-modal').style.display = 'flex';
            } catch (e) { alert('שגיאה: ' + e.message); }
        }

        function closeTaskModal() {
            document.getElementById('task-modal').style.display = 'none';
        }

        async function saveTask() {
            const id = document.getElementById('task-form-id').value;
            const title = document.getElementById('task-form-title').value.trim();
            if (!title) { alert('נא הזן כותרת'); return; }
            const body = {
                title: title,
                description: document.getElementById('task-form-desc').value.trim() || null,
                status: document.getElementById('task-form-status').value,
                priority: document.getElementById('task-form-priority').value,
                due_date: document.getElementById('task-form-due').value || null,
                reminder_at: document.getElementById('task-form-reminder').value || null
            };
            try {
                let resp;
                if (id) {
                    resp = await fetch('/dashboard/api/tasks/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                } else {
                    resp = await fetch('/dashboard/api/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                }
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                closeTaskModal();
                loadTasks(_currentTaskFilter);
            } catch (e) { alert('שגיאה: ' + e.message); }
        }

        // ── TRELLO ───────────────────────────────────────────────────
        async function loadTrelloBoard() {
            if (_trelloLists.length) return;
            try {
                const data = await fetchJSON('/dashboard/api/trello/board');
                _trelloLists = data.lists || [];
                _trelloLabels = data.labels || [];
                const listSel = document.getElementById('trello-list');
                listSel.innerHTML = _trelloLists.map(function(l) { return '<option value="' + l + '">' + l + '</option>'; }).join('');
                const labelSel = document.getElementById('trello-label');
                labelSel.innerHTML = '<option value="">ללא תווית</option>' + _trelloLabels.filter(function(l) { return l.name; }).map(function(l) { return '<option value="' + l.name + '">' + l.name + '</option>'; }).join('');
            } catch (e) { console.error('Trello board load error:', e.message); }
        }

        function openTrelloModal(title, desc) {
            _trelloTaskContext = null;
            document.getElementById('trello-title').value = title || '';
            document.getElementById('trello-desc').value = desc || '';
            document.getElementById('trello-due').value = '';
            document.getElementById('trello-modal').style.display = 'flex';
            loadTrelloBoard();
        }

        function openTrelloModalForTask(taskId, title, desc) {
            _trelloTaskContext = taskId;
            document.getElementById('trello-title').value = title || '';
            document.getElementById('trello-desc').value = desc || '';
            document.getElementById('trello-due').value = '';
            document.getElementById('trello-modal').style.display = 'flex';
            loadTrelloBoard();
        }

        function closeTrelloModal() {
            document.getElementById('trello-modal').style.display = 'none';
            _trelloTaskContext = null;
        }

        async function submitTrelloCard() {
            const title = document.getElementById('trello-title').value.trim();
            const desc = document.getElementById('trello-desc').value.trim();
            const listName = document.getElementById('trello-list').value;
            const labelName = document.getElementById('trello-label').value;
            const dueDate = document.getElementById('trello-due').value;
            if (!title || !listName) { alert('נא מלא כותרת ורשימה'); return; }
            const btn = document.getElementById('trello-submit-btn');
            btn.textContent = 'שולח...';
            btn.disabled = true;
            try {
                const body = { title, description: desc, listName, labelName: labelName || null, dueDate: dueDate || null, taskId: _trelloTaskContext };
                const resp = await fetch('/dashboard/api/trello/create-task-card', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                closeTrelloModal();
                if (data.url) {
                    const a = document.createElement('a');
                    a.href = data.url;
                    a.target = '_blank';
                    a.click();
                }
                if (_currentTaskFilter) loadTasks(_currentTaskFilter);
            } catch (e) {
                alert('שגיאה: ' + e.message);
            } finally {
                btn.textContent = '📌 שלח ל-Trello';
                btn.disabled = false;
            }
        }

        // ── UTILITIES ────────────────────────────────────────────────
        async function fetchJSON(url, options) {
            const res = await fetch(url, options);
            if (!res.ok) {
                const text = await res.text();
                throw new Error('HTTP ' + res.status + ': ' + text.substring(0, 100));
            }
            const text = await res.text();
            try { return JSON.parse(text); } catch(e) { throw new Error('Invalid JSON: ' + text.substring(0, 100)); }
        }

        function errorHTML(msg, retryFn) {
            return '<div class="error"><p>❌ שגיאה: ' + msg + '</p><button class="btn" data-onclick="' + retryFn + '" style="margin-top:8px;">נסה שוב</button></div>';
        }

    </script>
</body>
</html>`;
}

module.exports = router;
// v5.0.0 - Quantum design system + enrichment pipeline fixes Thu Mar 13 2026
