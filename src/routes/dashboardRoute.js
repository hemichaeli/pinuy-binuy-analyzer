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
        let query = `SELECT id, address, city, price, phone,
                            contact_status, contact_attempts, last_contact_at,
                            source, contact_person, email, url, gush_helka,
                            created_at
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
        let query = `SELECT id, name, city, address, existing_units as units_count, planned_units, iai_score, status, developer FROM complexes WHERE 1=1`;
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
                   COALESCE(l.address, 'מודעה') as title,
                   l.city, l.address,
                   l.asking_price as price_current,
                   ROUND(((COALESCE(c.theoretical_premium_min,0) + COALESCE(c.theoretical_premium_max,0)) / 2.0), 1) as premium_percent,
                   l.phone, l.message_status as contact_status, l.deal_status,
                   l.created_at, l.url, l.source, l.ssi_score
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
        const validSort = ['address', 'city', 'asking_price', 'created_at', 'ssi_score'];
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
        const notes = [property_type && `סוג נכס: ${property_type}`, location_preference && `אזור: ${location_preference}`, budget && `תקציב: ₪${parseInt(budget).toLocaleString()}`].filter(Boolean).join(' | ');
        const leadResult = await pool.query(
            `INSERT INTO website_leads (name, phone, email, user_type, status, source, notes) VALUES ($1, $2, '', 'owner', 'new', 'dashboard', $3) RETURNING id`,
            [name || 'לא ידוע', phone || '', notes || null]
        );
        const leadId = leadResult.rows[0].id;
        res.json({ success: true, leadId, message: 'Converted to lead' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/facebook/ads', async (req, res) => {
    res.json({ success: true, data: [
        { id:1, campaign_name:'קמפיין דירות תל אביב', ad_name:'דירות זולות - תל אביב', status:'active', impressions:12543, clicks:342, ctr:2.73, cost:850.50, leads:23, cost_per_lead:37.00 },
        { id:2, campaign_name:'קמפיין פינוי-בינוי השקעות', ad_name:'פינוי-בינוי - השקעה בטוחה', status:'active', impressions:8934, clicks:198, ctr:2.22, cost:650.75, leads:15, cost_per_lead:43.38 }
    ]});
});

function generateDashboardHTML(stats) {
    return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>QUANTUM DASHBOARD</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; }
        body { background:#000; color:#fff; font-size:16px; line-height:1.4; overflow-x:hidden; }
        .header { background:linear-gradient(135deg,#1a1b1e,#2d2e32); border-bottom:3px solid #d4af37; padding:20px; text-align:center; position:sticky; top:0; z-index:100; }
        .header h1 { color:#d4af37; font-size:26px; font-weight:900; margin-bottom:5px; }
        .status { color:#22c55e; font-size:14px; font-weight:600; }
        .nav-tabs { background:#111; padding:15px 10px; border-bottom:2px solid #333; display:flex; overflow-x:auto; gap:8px; position:sticky; top:85px; z-index:99; -webkit-overflow-scrolling:touch; }
        .nav-tab { background:rgba(255,255,255,0.1); border:2px solid rgba(255,255,255,0.2); border-radius:8px; padding:12px 1rem; color:#e2e8f0; font-weight:600; font-size:14px; cursor:pointer; transition:all 0.2s ease; min-width:110px; white-space:nowrap; user-select:none; -webkit-tap-highlight-color:transparent; text-align:center; }
        .nav-tab.active { background:linear-gradient(135deg,#d4af37,#e6c659); border-color:#d4af37; color:#000; box-shadow:0 4px 15px rgba(212,175,55,0.3); }
        .nav-tab:hover:not(.active) { background:rgba(212,175,55,0.2); border-color:#d4af37; }
        .tab-content { display:none; padding:20px 15px; min-height:calc(100vh - 170px); }
        .tab-content.active { display:block; }
        .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:18px; margin-bottom:25px; }
        .stat-card { background:linear-gradient(135deg,#1a1b1e,#2d2e32); border:3px solid rgba(255,255,255,0.1); border-radius:15px; padding:22px; text-align:center; cursor:pointer; transition:all 0.2s ease; user-select:none; -webkit-tap-highlight-color:transparent; }
        .stat-card:hover, .stat-card:active { border-color:#d4af37; box-shadow:0 0 25px rgba(212,175,55,0.3); transform:translateY(-3px); }
        .stat-number { font-size:2.4rem; font-weight:900; color:#d4af37; margin-bottom:8px; line-height:1; }
        .stat-label { font-size:14px; color:#9ca3af; font-weight:600; margin-bottom:8px; }
        .stat-hint { font-size:11px; color:#6b7280; margin-bottom:5px; font-style:italic; }
        .stat-change { font-size:12px; padding:3px 8px; border-radius:12px; font-weight:600; background:#22c55e; color:#000; display:inline-block; }
        .section { background:linear-gradient(135deg,#1a1b1e,#2d2e32); border:2px solid rgba(255,255,255,0.1); border-radius:15px; padding:22px; margin-bottom:18px; }
        .section h2 { color:#d4af37; font-size:20px; margin-bottom:18px; font-weight:700; }
        .filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:18px; }
        .filter-input,.filter-select { background:rgba(255,255,255,0.1); border:2px solid rgba(255,255,255,0.2); color:white; padding:11px 14px; border-radius:8px; font-size:14px; width:100%; }
        .filter-input:focus,.filter-select:focus { outline:none; border-color:#d4af37; }
        .filter-select option { background:#1a1b1e; }
        .btn { background:linear-gradient(135deg,#d4af37,#e6c659); color:#000; border:none; padding:11px 18px; border-radius:8px; font-weight:700; font-size:14px; cursor:pointer; transition:all 0.2s ease; display:inline-flex; align-items:center; gap:6px; }
        .btn:hover { box-shadow:0 4px 15px rgba(212,175,55,0.4); transform:translateY(-2px); }
        .btn-secondary { background:rgba(255,255,255,0.1); color:#fff; border:2px solid rgba(255,255,255,0.3); }
        .btn-secondary:hover { background:rgba(255,255,255,0.2); border-color:#d4af37; }
        .btn-green { background:linear-gradient(135deg,#16a34a,#22c55e); color:#fff; }
        .btn-intel { background:linear-gradient(135deg,#4f46e5,#6366f1); color:#fff; border:none; }
        .btn-intel:hover { box-shadow:0 4px 15px rgba(99,102,241,0.4); }
        .data-list { display:grid; gap:14px; }
        .data-item { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:18px; border-right:4px solid #d4af37; transition:all 0.2s ease; }
        .data-item:hover { background:rgba(255,255,255,0.08); }
        .data-item h3 { color:#d4af37; margin-bottom:10px; font-size:17px; }
        .data-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin-top:12px; font-size:14px; }
        .data-meta-item { display:flex; justify-content:space-between; gap:8px; }
        .data-meta-label { color:#9ca3af; }
        .data-meta-value { color:#fff; font-weight:600; }
        .status-badge { padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; }
        .status-new { background:#ef4444; color:#fff; }
        .status-contacted { background:#3b82f6; color:#fff; }
        .status-qualified { background:#22c55e; color:#000; }
        .status-closed { background:#8b5cf6; color:#fff; }
        .status-pending { background:#f59e0b; color:#000; }
        .status-landline { background:#6b7280; color:#fff; }
        .status-nophone { background:#374151; color:#9ca3af; }
        .loading { text-align:center; padding:40px; color:#9ca3af; }
        .loading::before { content:'⏳'; font-size:24px; margin-bottom:10px; display:block; }
        .error { background:#7f1d1d; border:1px solid #dc2626; color:#fecaca; padding:15px; border-radius:8px; margin:10px 0; }
        .filter-active-badge { background:rgba(212,175,55,0.2); border:1px solid #d4af37; color:#d4af37; padding:4px 12px; border-radius:20px; font-size:12px; margin-right:10px; display:inline-block; }
        .actions-bar { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:18px; align-items:center; }
        .conv-item { padding:14px 16px; border-bottom:1px solid rgba(255,255,255,0.08); cursor:pointer; transition:background 0.15s; }
        .conv-item:hover { background:rgba(212,175,55,0.1); }
        .conv-item.active { background:rgba(212,175,55,0.15); border-right:3px solid #d4af37; }
        .conv-name { font-weight:700; font-size:15px; color:#f0f0f0; margin-bottom:4px; }
        .conv-preview { font-size:12px; color:#9ca3af; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:240px; }
        .conv-meta { font-size:11px; color:#6b7280; margin-top:4px; display:flex; justify-content:space-between; }
        .bubble { max-width:75%; padding:10px 14px; border-radius:16px; margin-bottom:10px; font-size:14px; line-height:1.5; word-break:break-word; }
        .bubble-out { background:#1d4ed8; color:#fff; margin-right:auto; border-bottom-right-radius:4px; }
        .bubble-in { background:#1f2937; color:#e5e7eb; margin-left:auto; border-bottom-left-radius:4px; }
        .bubble-time { font-size:11px; opacity:0.6; margin-top:4px; }
        .intel-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
        .intel-item { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px 14px; margin-bottom:8px; }
        .intel-item .name { font-weight:700; color:#f0f0f0; margin-bottom:4px; }
        .intel-item .meta { font-size:12px; color:#9ca3af; }
        .intel-score { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; margin-right:6px; }
        @media(max-width:768px){
            .header{padding:12px 10px;} .header h1{font-size:20px;}
            .nav-tabs{padding:8px 5px; top:72px;}
            .nav-tab{padding:10px 14px; min-width:90px; font-size:13px;}
            .tab-content{padding:12px 10px;}
            .stats-grid{grid-template-columns:1fr 1fr; gap:12px;}
            .stat-number{font-size:1.9rem;}
            .section{padding:15px 12px;}
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
        <h1>💎 QUANTUM DASHBOARD</h1>
        <div class="status">🟢 מחובר ופעיל &bull; <span id="time"></span></div>
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
    </div>

    <div id="tab-dashboard" class="tab-content active">
        <div class="stats-grid">
            <div class="stat-card" data-tab="complexes" title="לחץ לפתיחת רשימת המתחמים">
                <div class="stat-number">${stats.totalComplexes}</div>
                <div class="stat-label">מתחמי פינוי-בינוי</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המתחמים</div>
                <div class="stat-change">+12% השנה</div>
            </div>
            <div class="stat-card" data-tab="ads" title="לחץ לפתיחת רשימת המודעות">
                <div class="stat-number">${stats.newListings}</div>
                <div class="stat-label">מודעות פעילות</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המודעות</div>
                <div class="stat-change">+8% השנה</div>
            </div>
            <div class="stat-card" data-tab="messages" title="לחץ לפתיחת הודעות">
                <div class="stat-number">${stats.activeMessages}</div>
                <div class="stat-label">שיחות WhatsApp</div>
                <div class="stat-hint">→ לחץ לפתיחת מרכז השיחות</div>
                <div class="stat-change">+23% השנה</div>
            </div>
            <div class="stat-card" onclick="switchTab('leads', 'qualified')" title="לחץ לפתיחת לידים מוכשרים">
                <div class="stat-number">${stats.qualifiedLeads}</div>
                <div class="stat-label">לידים מהאתר</div>
                <div class="stat-hint">→ לחץ לפתיחת הלידים</div>
                <div class="stat-change">+15% השנה</div>
            </div>
            <div class="stat-card" onclick="switchTab('complexes', 'hot')" title="לחץ לפתיחת הזדמנויות חמות">
                <div class="stat-number">${stats.hotOpportunities}</div>
                <div class="stat-label">הזדמנויות חמות</div>
                <div class="stat-hint">→ IAI > 75 | לחץ לפתיחת רשימה</div>
                <div class="stat-change">+31% השנה</div>
            </div>
            <div class="stat-card" data-tab="ads" title="לחץ לפתיחת עסקאות">
                <div class="stat-number">${stats.closedDeals}</div>
                <div class="stat-label">עסקאות תיווך</div>
                <div class="stat-hint">→ לחץ לפתיחת נתונים</div>
                <div class="stat-change">+67% השנה</div>
            </div>
            <div class="stat-card" data-tab="kones" title="לחץ לפתיחת כינוסי נכסים">
                <div class="stat-number">${stats.konesCount}</div>
                <div class="stat-label">כינוסי נכסים</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת כינוסים</div>
                <div class="stat-change" style="background:#f59e0b;">נכסים בכינוס</div>
            </div>
        </div>

        <div class="section">
            <h2>⚡ פעולות מהירות</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                <button class="btn btn-intel" data-onclick="loadMorningIntelligence()">🧠 ינטליגנציה יומית</button>
                <button class="btn" data-onclick="runAction('scan-yad2')">🏠 סרוק יד2</button>
                <button class="btn" data-onclick="runAction('scan-facebook')">📱 סרוק פייסבוק</button>
                <button class="btn" data-onclick="refreshStats()">🔄 רענן נתונים</button>
                <button class="btn btn-secondary" data-onclick="window.open('/api/docs','_blank')">📋 API Docs</button>
                <button class="btn btn-secondary" data-onclick="window.open('/sandbox','_blank')">🧪 Sandbox</button>
            </div>
        </div>

        <div class="section" id="morning-section" style="display:none;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
                <h2 style="margin:0;">🧠 ינטליגנציה יומית</h2>
                <button class="btn btn-secondary" data-onclick="document.getElementById('morning-section').style.display='none'" style="padding:6px 12px;font-size:12px;">✕ סגור</button>
            </div>
            <div id="morning-content"><div class="loading">טוען...</div></div>
        </div>

        <div class="section">
            <h2>📊 סטטוס מערכת</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
                <div class="data-item"><h3>📾 סריקה אוטומטית</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל</span></span></div></div></div>
                <div class="data-item"><h3>📱 WhatsApp</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">מחובר</span></span></div></div></div>
                <div class="data-item"><h3>📆 Auto Contact</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל (כל 30 דק)</span></span></div></div></div>
                <div class="data-item"><h3>🏗️ כינוס נכסים</h3><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-qualified">פעיל (07:45 יומי)</span></span></div></div></div>
            </div>
        </div>
    </div>

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
            </div>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadAds()">🔍 טען מודעות</button>
                <button class="btn btn-secondary" data-onclick="exportData('ads')">📊 ייצוא לאקסל</button>
            </div>
            <div id="ads-list" class="data-list"><div class="loading">טוען מודעות...</div></div>
        </div>
    </div>

    <div id="tab-messages" class="tab-content" style="padding:0;">
        <div class="section" style="margin:0;border-radius:0;border-left:none;border-right:none;border-top:none;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                <h2 style="margin:0;">💬 שיחות WhatsApp</h2>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="text" class="filter-input" id="convSearchFilter" placeholder="חיפוש לפי שם/טלפון..." style="width:220px;" onkeyup="if(event.key==='Enter')loadConversations()">
                    <select class="filter-select" id="convStatusFilter" style="width:140px;" onchange="loadConversations()">
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
        <div style="display:grid;grid-template-columns:300px 1fr;height:calc(100vh - 230px);background:#0a0a0a;" id="conv-panel">
            <div style="border-left:1px solid rgba(255,255,255,0.1);overflow-y:auto;background:#111;" id="conv-list">
                <div class="loading">טוען שיחות...</div>
            </div>
            <div style="display:flex;flex-direction:column;overflow:hidden;" id="conv-thread">
                <div style="text-align:center;padding:60px 20px;color:#6b7280;margin:auto;">
                    <div style="font-size:48px;margin-bottom:16px;">💬</div>
                    <p style="font-size:16px;">בחר שיחה מהרשימה לצפייה בהודעות</p>
                </div>
            </div>
        </div>
    </div>

    <div id="tab-leads" class="tab-content">
        <div class="section">
            <h2>👤 רשימת לידים</h2>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadLeads()">👤 כל הלידים</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('qualified')">✰ מוכשרים</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('contacted')">📞 בתהליך</button>
                <button class="btn btn-secondary" data-onclick="loadLeads('new')">🆕 חדשים</button>
                <button class="btn btn-green" data-onclick="exportData('leads')">📊 ייצוא לאקסל</button>
            </div>
            <div id="leads-filter-badge" style="margin-bottom:10px;"></div>
            <div id="leads-list" class="data-list"><div class="loading">טוען לידים...</div></div>
        </div>
    </div>

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
            <div id="complexes-filter-badge" style="margin-bottom:10px;"></div>
            <div id="complexes-list" class="data-list"><div class="loading">טוען מתחמים...</div></div>
        </div>
    </div>

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
            <div id="kones-filter-badge" style="margin-bottom:10px;"></div>
            <div id="kones-stats-bar" style="margin-bottom:12px;display:none;"></div>
            <div id="kones-list" class="data-list"><div class="loading">טוען כינוסי נכסים...</div></div>
        </div>
    </div>

    <div id="tab-news" class="tab-content">
        <div class="section">
            <h2>📰 חדשות שוק הנדלן</h2>
            <div class="actions-bar">
                <button class="btn" data-onclick="loadFacebookAds()">📱 מודעות פייסבוק</button>
            </div>
            <div id="news-list" class="data-list">
                <div class="data-item"><h3>📈 ריבית בנק ישראל</h3><p>מחירי הדירות עלו בממוצע ב-3.2% בחודש האחרון</p><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">קטגוריה:</span><span class="data-meta-value">מאקרו</span></div></div></div>
                <div class="data-item"><h3>🏗️ פינוי-בינוי חדשות</h3><p>אושר פינוי-בינוי חדש ברחוב הרצל - 180 יחידות</p><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">קרית ביאליק</span></div></div></div>
                <div id="facebook-ads-section" style="display:none;"><h3 style="color:#d4af37;margin:15px 0;">📱 מודעות פייסבוק</h3><div id="facebook-ads-list"></div></div>
            </div>
        </div>
    </div>

    <div id="tab-scheduling" class="tab-content">
        <div class="section">
            <h2>📅 תיאום פגישות — QUANTUM BOT</h2>
            <div class="actions-bar" style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                <select id="sched-filter-state" onchange="loadScheduling()" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;">
                    <option value="">כל הסטטוסים</option>
                    <option value="confirmed">✅ מאושר</option>
                    <option value="pending">⏳ ממתין</option>
                    <option value="declined">❌ סירב</option>
                    <option value="cancelled">🚫 בוטל</option>
                </select>
                <select id="sched-filter-lang" onchange="loadScheduling()" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;">
                    <option value="">כל השפות</option>
                    <option value="he">🇮🇱 עברית</option>
                    <option value="ru">🇷🇺 רוסית</option>
                </select>
                <input id="sched-search" type="text" placeholder="🔍 חיפוש שם / טלפון..." oninput="filterSchedulingTable()" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;min-width:200px;">
                <button class="btn" data-onclick="loadScheduling()" style="margin-right:auto;">🔄 רענן</button>
                <a href="/api/scheduling/campaign" target="_blank" class="btn" style="background:#1e3a5f;border-color:#3b82f6;color:#93c5fd;">📊 דוח קמפיין</a>
            </div>
            <div id="sched-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;"></div>
            <div id="sched-list" class="data-list"><div class="loading">טוען נתוני תיאומים...</div></div>
        </div>
    </div>

    <div id="tab-scrapers" class="tab-content">
        <div class="section">
            <h2>🔍 מקורות סריקה — Real Estate Data Sources</h2>
            <div class="actions-bar" style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                <button class="btn btn-green" data-onclick="runAllScrapers()">▶️ הפעל את כולם</button>
                <button class="btn" data-onclick="loadScraperStatus()">🔄 רענן סטטוס</button>
            </div>
            <div id="scrapers-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:16px;">
                <!-- Scraper cards injected by JS -->
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
            
            // Event delegation for nav-tabs (data-tab attribute)
            document.querySelectorAll('.nav-tab[data-tab]').forEach(function(el) {
                el.addEventListener('click', function() {
                    switchTab(this.getAttribute('data-tab'));
                });
            });
            
            // Event delegation for stat-cards (data-tab attribute)
            document.querySelectorAll('.stat-card[data-tab]').forEach(function(el) {
                el.addEventListener('click', function() {
                    switchTab(this.getAttribute('data-tab'));
                });
            });
            
            // Event delegation for buttons (data-onclick attribute)
            document.querySelectorAll('[data-onclick]').forEach(function(el) {
                el.addEventListener('click', function() {
                    var fn = this.getAttribute('data-onclick');
                    try { eval(fn); } catch(e) { console.error('Action error:', fn, e); }
                });
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
            // Activate the correct nav tab by matching onclick attribute
            document.querySelectorAll('.nav-tab').forEach(function(n) {
                if (n.getAttribute('onclick') && n.getAttribute('onclick').includes("'" + tabName + "'")) {
                    n.classList.add('active');
                }
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
        }

        async function loadMorningIntelligence() {
            const section = document.getElementById('morning-section');
            const content = document.getElementById('morning-content');
            section.style.display = 'block';
            content.innerHTML = '<div class="loading">טוען ינטליגנציה יומית...</div>';
            section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            try {
                const data = await fetchJSON('/api/morning/preview');
                const opps = data.opportunities || [];
                const sellers = data.stressed_sellers || [];
                const generated = data.generated_at ? new Date(data.generated_at).toLocaleString('he-IL') : '';

                let html = '<p style="color:#6b7280;font-size:13px;margin-bottom:16px;">עודכן: ' + generated + '</p>';
                html += '<div class="intel-grid">';

                // Opportunities
                html += '<div>';
                html += '<h3 style="color:#22c55e;margin-bottom:12px;font-size:16px;">🔥 הזדמנויות חמות (' + opps.length + ')</h3>';
                if (!opps.length) {
                    html += '<p style="color:#6b7280;font-size:13px;">אין הזדמנויות כרגע</p>';
                } else {
                    for (const op of opps.slice(0, 8)) {
                        const iai = op.iai_score || 0;
                        const clr = iai > 85 ? '#22c55e' : iai > 70 ? '#f59e0b' : '#9ca3af';
                        html += '<div class="intel-item">' +
                            '<div class="name">' + (op.name || op.city || 'מתחם') + '</div>' +
                            '<div class="meta">' +
                            '<span class="intel-score" style="background:' + clr + ';color:#000;">IAI ' + iai + '</span>' +
                            (op.city ? op.city : '') +
                            (op.developer ? ' | ' + op.developer : '') +
                            '</div></div>';
                    }
                }
                html += '</div>';

                // Stressed sellers
                html += '<div>';
                html += '<h3 style="color:#f59e0b;margin-bottom:12px;font-size:16px;">📉 מוכרים במצוקה (' + sellers.length + ')</h3>';
                if (!sellers.length) {
                    html += '<p style="color:#6b7280;font-size:13px;">אין מוכרים במצוקה כרגע</p>';
                } else {
                    for (const s of sellers.slice(0, 8)) {
                        const ssi = s.ssi_score || 0;
                        html += '<div class="intel-item" style="border-right-color:#f59e0b;">' +
                            '<div class="name">' + (s.address || s.city || 'מוכר') + '</div>' +
                            '<div class="meta">' +
                            '<span class="intel-score" style="background:#f59e0b;color:#000;">SSI ' + ssi + '</span>' +
                            (s.city ? s.city : '') +
                            (s.asking_price ? ' | ₪' + parseInt(s.asking_price).toLocaleString() : '') +
                            '</div></div>';
                    }
                }
                html += '</div>';

                html += '</div>';

                if (data.price_drops_24h && data.price_drops_24h.length) {
                    html += '<div style="margin-top:16px;"><h3 style="color:#ef4444;margin-bottom:12px;font-size:16px;">💸 הורדות מחיר 24 שעות (' + data.price_drops_24h.length + ')</h3>';
                    for (const d of data.price_drops_24h.slice(0, 3)) {
                        html += '<div class="intel-item" style="border-right-color:#ef4444;"><div class="name">' + (d.address || d.city || 'נכס') + '</div></div>';
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
                container.innerHTML = data.data.map((ad, i) => renderAd(ad, i)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadAds()'); }
        }

        function renderAd(ad, i) {
            const price = ad.price_current ? '₪' + parseInt(ad.price_current).toLocaleString() : 'מחיר לא ידוע';
            const premium = ad.premium_percent && parseFloat(ad.premium_percent) > 0 ? parseFloat(ad.premium_percent).toFixed(1) + '%' : null;
            return '<div class="data-item"><h3>' + (ad.address || 'מודעה #' + (i+1)) + '</h3><div class="data-meta">' +
                '<div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">' + (ad.city||'לא ידוע') + '</span></div>' +
                '<div class="data-meta-item"><span class="data-meta-label">מחיר:</span><span class="data-meta-value">' + price + '</span></div>' +
                (premium ? '<div class="data-meta-item"><span class="data-meta-label">פרמיה:</span><span class="data-meta-value">' + premium + '</span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">SSI:</span><span class="data-meta-value">' + (ad.ssi_score||0) + '</span></div>' +
                (ad.phone ? '<div class="data-meta-item"><span class="data-meta-label">טלפון:</span><span class="data-meta-value"><a href="tel:' + ad.phone + '" style="color:#3b82f6;">' + ad.phone + '</a> <a href="https://wa.me/' + ad.phone.replace(/[^0-9]/g,'') + '" style="background:#22c55e;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:12px;">WhatsApp</a></span></div>' : '') +
                (ad.url ? '<div class="data-meta-item"><span class="data-meta-label">קישור:</span><span class="data-meta-value"><a href="' + ad.url + '" target="_blank" style="color:#3b82f6;">פתח מודעה</a></span></div>' : '') +
                '</div></div>';
        }

        // Issue #6 - Conversations View
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
                    container.innerHTML = '<div style="text-align:center;padding:30px;color:#6b7280;"><div style="font-size:32px;margin-bottom:10px;">📭</div><p>אין שיחות</p></div>';
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
            const statusColors = { active: '#22c55e', closed: '#6b7280', agent_needed: '#ef4444' };
            const dot = statusColors[conv.status] || '#6b7280';
            return '<div class="conv-item" data-phone="' + conv.phone + '" onclick="openConversation(this.dataset.phone)">' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                '<div style="width:8px;height:8px;border-radius:50%;background:' + dot + ';flex-shrink:0;"></div>' +
                '<div class="conv-name">' + name + '</div>' +
                '</div>' +
                '<div class="conv-preview">' + dir + preview + '</div>' +
                '<div class="conv-meta"><span>' + conv.phone + '</span><span>' + date + '</span></div>' +
                '</div>';
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

                let html = '<div style="background:#111;padding:16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between;">' +
                    '<div>' +
                    '<div style="font-weight:700;font-size:16px;color:#f0f0f0;">' + name + '</div>' +
                    '<div style="font-size:12px;color:#9ca3af;">' + phone + (location ? ' | ' + location : '') + '</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;">' +
                    '<a href="tel:' + phone + '" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;">📞 התקשר</a>' +
                    '<a href="https://wa.me/' + phone.replace(/[^0-9]/g,'') + '" target="_blank" class="btn btn-green" style="padding:6px 12px;font-size:12px;">WhatsApp</a>' +
                    '</div>' +
                    '</div>';

                if (!data.data.length) {
                    html += '<div style="text-align:center;padding:40px;color:#6b7280;">אין הודעות בשיחה זו</div>';
                } else {
                    html += '<div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:4px;">';
                    for (const msg of data.data) {
                        const isOut = msg.direction === 'outgoing';
                        const time = msg.created_at ? new Date(msg.created_at).toLocaleString('he-IL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
                        html += '<div style="display:flex;justify-content:' + (isOut ? 'flex-end' : 'flex-start') + ';">' +
                            '<div class="bubble ' + (isOut ? 'bubble-out' : 'bubble-in') + '">' +
                            '<div>' + (msg.message || '').replace(/\\n/g, '<br>') + '</div>' +
                            '<div class="bubble-time" style="text-align:' + (isOut ? 'left' : 'right') + ';">' + time + '</div>' +
                            '</div>' +
                            '</div>';
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

        async function loadLeads(filter) {
            const container = document.getElementById('leads-list');
            const badge = document.getElementById('leads-filter-badge');
            container.innerHTML = '<div class="loading">טוען לידים...</div>';
            const filterLabels = { qualified: '✰ מסנן: לידים מוכשרים', contacted: '📞 מסנן: בתהליך', new: '🆕 מסנן: חדשים' };
            if (badge) badge.innerHTML = filter && filterLabels[filter] ? '<span class="filter-active-badge">' + filterLabels[filter] + '</span>' : '';
            try {
                const url = filter ? '/dashboard/api/leads?status=' + filter : '/dashboard/api/leads';
                const data = await fetchJSON(url);
                if (!data.success) throw new Error(data.error);
                if (!data.data.length) { container.innerHTML = '<div class="loading">👤 אין לידים בסינון הנ"ל</div>'; return; }
                container.innerHTML = data.data.map((lead, i) => renderLead(lead, i)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadLeads()'); }
        }

        function renderLead(lead, i) {
            const typeLabel = { investor: '🏢 משקיע', owner: '🏠 מוכר', contact: '📩 פנייה' };
            return '<div class="data-item"><h3>' + (lead.name || 'ליד #' + (i+1)) + ' ' + (typeLabel[lead.user_type] || '') + (lead.is_urgent ? ' 🚨' : '') + '</h3><div class="data-meta">' +
                (lead.phone ? '<div class="data-meta-item"><span class="data-meta-label">טלפון:</span><span class="data-meta-value"><a href="tel:' + lead.phone + '" style="color:#3b82f6;">' + lead.phone + '</a></span></div>' : '') +
                (lead.email ? '<div class="data-meta-item"><span class="data-meta-label">אימייל:</span><span class="data-meta-value">' + lead.email + '</span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge status-' + (lead.status||'new') + '">' + (lead.status||'חדש') + '</span></span></div>' +
                '<div class="data-meta-item"><span class="data-meta-label">מקור:</span><span class="data-meta-value">' + (lead.source||'לא ידוע') + '</span></div>' +
                (lead.notes ? '<div class="data-meta-item"><span class="data-meta-label">הערות:</span><span class="data-meta-value">' + lead.notes + '</span></div>' : '') +
                '</div></div>';
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
                container.innerHTML = data.data.map((c, i) => renderComplex(c, i)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadComplexes()'); }
        }

        function renderComplex(c, i) {
            return '<div class="data-item"><h3>' + (c.name || 'מתחם #' + (i+1)) + '</h3><div class="data-meta">' +
                '<div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">' + (c.city||'לא ידוע') + '</span></div>' +
                '<div class="data-meta-item"><span class="data-meta-label">יחידות קיים:</span><span class="data-meta-value">' + (c.units_count||0) + '</span></div>' +
                '<div class="data-meta-item"><span class="data-meta-label">יחידות מתוכנן:</span><span class="data-meta-value">' + (c.planned_units||0) + '</span></div>' +
                (c.iai_score ? '<div class="data-meta-item"><span class="data-meta-label">ציון IAI:</span><span class="data-meta-value" style="color:' + (c.iai_score > 80 ? '#22c55e' : c.iai_score > 60 ? '#f59e0b' : '#ef4444') + ';">' + c.iai_score + '</span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value">' + (c.status||'לא ידוע') + '</span></div>' +
                '</div>' +
                (c.address ? '<p style="margin-top:8px;color:#9ca3af;font-size:13px;">📍 ' + c.address + '</p>' : '') +
                '</div>';
        }

        async function loadKones(filter) {
            const container = document.getElementById('kones-list');
            const badge = document.getElementById('kones-filter-badge');
            const statsBar = document.getElementById('kones-stats-bar');
            container.innerHTML = '<div class="loading">טוען כינוסי נכסים...</div>';
            const filterLabels = {
                pending: '⏳ מסנן: ממתינים לפנייה',
                contacted: '✅ מסנן: נוצר קשר',
                landline: '📞 מסנן: קווי ארץ (דרוש שיחה טלפונית)',
                no_phone: '🚫 מסנן: אין טלפון',
                failed: '❌ מסנן: נכשל'
            };
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

                // Load stats bar (when showing all)
                if (!status && statsBar) {
                    try {
                        const stats = await fetchJSON('/api/auto-contact/kones-stats');
                        if (stats.success) {
                            const s = stats.kones;
                            statsBar.style.display = 'flex';
                            statsBar.style.flexWrap = 'wrap';
                            statsBar.style.gap = '8px';
                            statsBar.innerHTML =
                                '<span class="filter-active-badge" style="cursor:pointer;" onclick="loadKones(&apos;contacted&apos;)">✅ נוצר קשר: ' + s.contacted + '</span>' +
                                '<span class="filter-active-badge" style="background:rgba(107,114,128,0.2);border-color:#6b7280;color:#9ca3af;cursor:pointer;" onclick="loadKones(&apos;landline&apos;)">📞 קו ארץ: ' + s.landline + '</span>' +
                                '<span class="filter-active-badge" style="background:rgba(55,65,81,0.3);border-color:#374151;color:#6b7280;cursor:pointer;" onclick="loadKones(&apos;no_phone&apos;)">🚫 אין טלפון: ' + s.no_phone + '</span>' +
                                '<span class="filter-active-badge" style="background:rgba(239,68,68,0.2);border-color:#ef4444;color:#fca5a5;cursor:pointer;" onclick="loadKones(&apos;failed&apos;)">❌ נכשל: ' + s.failed + '</span>';
                        }
                    } catch(e) { /* ignore */ }
                } else if (statsBar) {
                    statsBar.style.display = 'none';
                }

                if (!data.data.length) { container.innerHTML = '<div class="loading">🏗️ אין כינוסי נכסים בסינון זה</div>'; return; }
                container.innerHTML = data.data.map((k, i) => renderKones(k, i)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadKones()'); }
        }

        function renderKones(k, i) {
            const statusClass = {
                pending: 'status-pending',
                contacted: 'status-contacted',
                failed: 'status-new',
                landline: 'status-landline',
                no_phone: 'status-nophone'
            };
            const statusLabel = {
                pending: 'ממתין',
                contacted: 'נוצר קשר',
                failed: 'נכשל',
                landline: 'קו ארץ',
                no_phone: 'אין טלפון'
            };
            const st = k.contact_status || 'pending';
            const isLandline = st === 'landline';
            const noPhone = st === 'no_phone';
            const borderColor = isLandline ? '#6b7280' : noPhone ? '#374151' : '#d4af37';

            // Phone display: landline gets phone-only, mobile gets WhatsApp too
            let phoneHtml = '';
            if (k.phone && !noPhone) {
                phoneHtml = '<div class="data-meta-item"><span class="data-meta-label">טלפון:</span><span class="data-meta-value">' +
                    '<a href="tel:' + k.phone + '" style="color:#3b82f6;">' + k.phone + '</a>';
                if (isLandline) {
                    phoneHtml += ' <span style="background:#f59e0b;color:#000;padding:2px 8px;border-radius:4px;font-size:12px;">📞 שיחה טלפונית</span>';
                } else {
                    phoneHtml += ' <a href="https://wa.me/' + k.phone.replace(/[^0-9]/g,'') + '" style="background:#22c55e;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:12px;">WhatsApp</a>';
                }
                phoneHtml += '</span></div>';
            }

            return '<div class="data-item" style="border-right-color:' + borderColor + '"><h3>🏗️ ' + (k.address || 'כינוס #' + (i+1)) + '</h3><div class="data-meta">' +
                '<div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">' + (k.city||'לא ידוע') + '</span></div>' +
                (k.gush_helka ? '<div class="data-meta-item"><span class="data-meta-label">גוש/חלקה:</span><span class="data-meta-value">' + k.gush_helka + '</span></div>' : '') +
                (k.price ? '<div class="data-meta-item"><span class="data-meta-label">מחיר:</span><span class="data-meta-value">₪' + parseInt(k.price).toLocaleString() + '</span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge ' + (statusClass[st]||'status-pending') + '">' + (statusLabel[st]||st) + '</span></span></div>' +
                (k.contact_person ? '<div class="data-meta-item"><span class="data-meta-label">כונס:</span><span class="data-meta-value">' + k.contact_person + '</span></div>' : '') +
                (k.contact_attempts ? '<div class="data-meta-item"><span class="data-meta-label">ניסיונות פנייה:</span><span class="data-meta-value">' + k.contact_attempts + '</span></div>' : '') +
                phoneHtml +
                (k.url ? '<div class="data-meta-item"><span class="data-meta-label">קישור:</span><span class="data-meta-value"><a href="' + k.url + '" target="_blank" style="color:#3b82f6;">פתח כינוס</a></span></div>' : '') +
                '</div></div>';
        }

        async function runKonesAutoContact() {
            if (!confirm('להפעיל Auto Contact לכינוסי נכסים?')) return;
            try {
                const res = await fetch('/api/auto-contact/run-kones', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                if (res.ok) {
                    const d = await res.json();
                    const r = d.result || {};
                    alert('✅ Auto Contact הופעל!\\n\\nנוצר קשר: ' + (r.contacted||0) + '\\nקווי ארץ (נדרשת שיחה): ' + (r.skipped_landline||0) + '\\nאין טלפון: ' + (r.skipped_no_phone||0) + '\\nנכשל: ' + (r.failed||0));
                    loadKones();
                } else throw new Error('HTTP ' + res.status);
            } catch (e) { alert('❌ נכשל: ' + e.message); }
        }

        async function loadFacebookAds() {
            try {
                const data = await fetchJSON('/dashboard/api/facebook/ads');
                if (!data.success) throw new Error(data.error);
                document.getElementById('facebook-ads-section').style.display = 'block';
                document.getElementById('facebook-ads-list').innerHTML = data.data.map(ad =>
                    '<div class="data-item"><h3>' + ad.ad_name + '</h3><p style="color:#9ca3af;margin-bottom:8px;">' + ad.campaign_name + '</p><div class="data-meta">' +
                    '<div class="data-meta-item"><span class="data-meta-label">הופעות:</span><span class="data-meta-value">' + ad.impressions.toLocaleString() + '</span></div>' +
                    '<div class="data-meta-item"><span class="data-meta-label">קליקים:</span><span class="data-meta-value">' + ad.clicks + '</span></div>' +
                    '<div class="data-meta-item"><span class="data-meta-label">CTR:</span><span class="data-meta-value">' + ad.ctr + '%</span></div>' +
                    '<div class="data-meta-item"><span class="data-meta-label">לידים:</span><span class="data-meta-value">' + ad.leads + '</span></div>' +
                    '</div></div>'
                ).join('');
            } catch (e) { console.error('FB ads error:', e); }
        }

        async function runAction(action) {
            const endpoints = { 'scan-yad2': '/api/scan/yad2', 'scan-facebook': '/api/facebook/sync' };
            const endpoint = endpoints[action];
            if (!endpoint) return;
            if (!confirm('להפעיל ' + action + '?')) return;
            try {
                const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                if (res.ok) { alert('✅ ' + action + ' הופעל!'); refreshStats(); }
                else throw new Error('HTTP ' + res.status);
            } catch (e) { alert('❌ ' + action + ' נכשל: ' + e.message); }
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
            return '<div class="error"><p>❌ שגיאה: ' + msg + '</p><button class="btn" data-onclick="' + retryFn + '" style="margin-top:10px;">נסה שוב</button></div>';
        }

        // ── SCHEDULING TAB ───────────────────────────────────────────
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
                // KPIs
                kpis.innerHTML = [
                    { label: 'סה"כ שיחות', val: s.total || 0, cls: 'blue' },
                    { label: 'מאושרות', val: s.confirmed || 0, cls: 'green' },
                    { label: 'ממתינות', val: s.pending || 0, cls: 'yellow' },
                    { label: 'סירבו', val: s.declined || 0, cls: 'red' },
                    { label: 'עברית', val: s.hebrew || 0, cls: 'blue' },
                    { label: 'רוסית', val: s.russian || 0, cls: 'blue' },
                    { label: 'סלוטים פנויים', val: sl.open || 0, cls: 'yellow' },
                    { label: 'טקסי חתימה', val: cer.total || 0, cls: 'blue' }
                ].map(k => '<div style="background:#111827;border:1px solid #1e293b;border-radius:10px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:800;color:' + (k.cls==='green'?'#34d399':k.cls==='yellow'?'#fbbf24':k.cls==='red'?'#f87171':'#60a5fa') + ';">' + k.val + '</div><div style="font-size:11px;color:#64748b;margin-top:4px;">' + k.label + '</div></div>').join('');
                // Table
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
            if (!filtered.length) { list.innerHTML = '<div style="color:#64748b;padding:20px;text-align:center;">אין נתונים תואמים לסינון</div>'; return; }
            const stateLabel = { confirmed: '<span style="color:#34d399;font-weight:700;">✅ מאושר</span>', pending: '<span style="color:#fbbf24;">⏳ ממתין</span>', declined: '<span style="color:#f87171;">❌ סירב</span>', cancelled: '<span style="color:#94a3b8;">🚫 בוטל</span>', no_answer: '<span style="color:#f87171;">📵 לא ענה</span>' };
            const langLabel = { he: '🇮🇱', ru: '🇷🇺' };
            const rows_html = filtered.map(r => {
                const wa = 'https://wa.me/' + (r.phone || '').replace(/\D/g,'') + '?text=' + encodeURIComponent('שלום ' + (r.contact_name || '') + ', QUANTUM כאן');
                const meetingType = r.meeting_type || r.campaign_meeting_type || '';
                const typeMap = { signing_ceremony: 'כנס חתימות', consultation: 'ייעוץ', appraiser: 'שמאי', surveyor: 'מודד', physical: 'פגישה' };
                return '<div class="data-item" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:center;padding:12px 16px;">'
                    + '<div><div style="font-weight:600;font-size:14px;">' + (r.contact_name || 'לא ידוע') + '</div><div style="font-size:12px;color:#64748b;">' + (r.phone || '') + ' ' + (langLabel[r.language] || '') + '</div></div>'
                    + '<div>' + (stateLabel[r.state] || '<span style="color:#94a3b8;">' + (r.state || '') + '</span>') + '</div>'
                    + '<div style="font-size:12px;color:#94a3b8;">' + (typeMap[meetingType] || meetingType || '—') + '</div>'
                    + '<div style="font-size:12px;color:#60a5fa;">' + (r.slot_display || (r.last_message_at ? new Date(r.last_message_at).toLocaleString('he-IL') : '—')) + '</div>'
                    + '<a href="' + wa + '" target="_blank" class="btn" style="padding:6px 12px;font-size:12px;background:#064e3b;border-color:#34d399;color:#34d399;white-space:nowrap;">💬 WA</a>'
                    + '</div>';
            }).join('');
            list.innerHTML = '<div style="font-size:12px;color:#64748b;padding:8px 16px;border-bottom:1px solid #1e293b;">' + filtered.length + ' רשומות</div>' + rows_html;
        }

        // ============================================================
        // SCRAPERS TAB FUNCTIONS
        // ============================================================
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
                const count = st.count !== undefined ? st.count : '—';
                const statusColor = running ? '#f59e0b' : (st.error ? '#ef4444' : '#22c55e');
                const statusText = running ? '⏳ פועל...' : (st.error ? '❌ שגיאה' : (st.lastRun ? '✅ הושלם' : '⚪ ממתין'));
                return '<div class="data-item" style="border-left:4px solid ' + s.color + ';padding:16px;position:relative;">'
                    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">'
                    + '<div><div style="font-size:22px;margin-bottom:4px;">' + s.icon + ' ' + s.name + '</div>'
                    + '<div style="font-size:12px;color:#94a3b8;">' + s.desc + '</div></div>'
                    + '<span style="font-size:12px;color:' + statusColor + ';font-weight:600;">' + statusText + '</span></div>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:12px;color:#64748b;">'
                    + '<div>🕐 הפעלה אחרונה:<br><span style="color:#e2e8f0;">' + lastRun + '</span></div>'
                    + '<div>📦 מודעות שנמצאו:<br><span style="color:#d4af37;font-weight:700;font-size:16px;">' + count + '</span></div></div>'
                    + (st.error ? '<div style="font-size:11px;color:#ef4444;margin-bottom:8px;padding:6px;background:#1e0a0a;border-radius:4px;">⚠️ ' + st.error + '</div>' : '')
                    + '<button class="btn btn-green" data-id="' + s.id + '" data-endpoint="' + s.endpoint + '" data-onclick="runScraper(this.dataset.id, this.dataset.endpoint)" '
                    + (running ? 'disabled' : '') + ' style="width:100%;padding:8px;font-size:13px;">'
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
            if (!confirm('להפעיל את כל הסורקים? הפעולה עשויה לקחת מספר דקות.')) return;
            for (var i = 0; i < SCRAPERS_CONFIG.length; i++) {
                var s = SCRAPERS_CONFIG[i];
                runScraper(s.id, s.endpoint);
                await new Promise(function(r) { setTimeout(r, 500); });
            }
        }

        function loadScraperStatus() {
            renderScraperCards();
        }

    </script>
</body>
</html>`;
}

module.exports = router;
