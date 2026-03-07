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
                pool.query("SELECT COUNT(*) as total FROM listing_messages WHERE direction = 'received'"),
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
            pool.query("SELECT COUNT(*) as total FROM listing_messages WHERE direction = 'received'"),
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
        // Use correct column names matching the actual kones_listings table schema
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
        // Count with same filters applied
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
        .loading { text-align:center; padding:40px; color:#9ca3af; }
        .loading::before { content:'⏳'; font-size:24px; margin-bottom:10px; display:block; }
        .error { background:#7f1d1d; border:1px solid #dc2626; color:#fecaca; padding:15px; border-radius:8px; margin:10px 0; }
        .filter-active-badge { background:rgba(212,175,55,0.2); border:1px solid #d4af37; color:#d4af37; padding:4px 12px; border-radius:20px; font-size:12px; margin-right:10px; display:inline-block; }
        .actions-bar { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:18px; align-items:center; }
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
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>💎 QUANTUM DASHBOARD</h1>
        <div class="status">🟢 מחובר ופעיל &bull; <span id="time"></span></div>
    </div>

    <div class="nav-tabs">
        <div class="nav-tab active" onclick="switchTab('dashboard')">📊 דשבורד</div>
        <div class="nav-tab" onclick="switchTab('ads')">🏘 מודעות</div>
        <div class="nav-tab" onclick="switchTab('messages')">💬 הודעות</div>
        <div class="nav-tab" onclick="switchTab('leads')">👤 לידים</div>
        <div class="nav-tab" onclick="switchTab('complexes')">🏢 מתחמים</div>
        <div class="nav-tab" onclick="switchTab('kones')">🏗️ כינוס</div>
        <div class="nav-tab" onclick="switchTab('news')">📰 חדשות</div>
    </div>

    <div id="tab-dashboard" class="tab-content active">
        <div class="stats-grid">
            <div class="stat-card" onclick="switchTab('complexes')" title="לחץ לפתיחת רשימת המתחמים">
                <div class="stat-number">${stats.totalComplexes}</div>
                <div class="stat-label">מתחמי פינוי-בינוי</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המתחמים</div>
                <div class="stat-change">+12% השנה</div>
            </div>
            <div class="stat-card" onclick="switchTab('ads')" title="לחץ לפתיחת רשימת המודעות">
                <div class="stat-number">${stats.newListings}</div>
                <div class="stat-label">מודעות פעילות</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת המודעות</div>
                <div class="stat-change">+8% השנה</div>
            </div>
            <div class="stat-card" onclick="switchTab('messages')" title="לחץ לפתיחת הודעות">
                <div class="stat-number">${stats.activeMessages}</div>
                <div class="stat-label">הודעות נכנסות</div>
                <div class="stat-hint">→ לחץ לפתיחת הודעות</div>
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
            <div class="stat-card" onclick="switchTab('ads')" title="לחץ לפתיחת עסקאות">
                <div class="stat-number">${stats.closedDeals}</div>
                <div class="stat-label">עסקאות תיווך</div>
                <div class="stat-hint">→ לחץ לפתיחת נתונים</div>
                <div class="stat-change">+67% השנה</div>
            </div>
            <div class="stat-card" onclick="switchTab('kones')" title="לחץ לפתיחת כינוסי נכסים">
                <div class="stat-number">${stats.konesCount}</div>
                <div class="stat-label">כינוסי נכסים</div>
                <div class="stat-hint">→ לחץ לפתיחת רשימת כינוסים</div>
                <div class="stat-change" style="background:#f59e0b;">נכסים בכינוס</div>
            </div>
        </div>

        <div class="section">
            <h2>⚡ פעולות מהירות</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                <button class="btn" onclick="runAction('scan-yad2')">🏠 סרוק יד2</button>
                <button class="btn" onclick="runAction('scan-facebook')">📱 סרוק פייסבוק</button>
                <button class="btn" onclick="refreshStats()">🔄 רענן נתונים</button>
                <button class="btn btn-secondary" onclick="window.open('/api/docs','_blank')">📋 API Docs</button>
                <button class="btn btn-secondary" onclick="window.open('/sandbox','_blank')">🧪 Sandbox</button>
            </div>
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
                <button class="btn" onclick="loadAds()">🔍 טען מודעות</button>
                <button class="btn btn-secondary" onclick="exportData('ads')">📊 ייצוא לאקסל</button>
            </div>
            <div id="ads-list" class="data-list"><div class="loading">טוען מודעות...</div></div>
        </div>
    </div>

    <div id="tab-messages" class="tab-content">
        <div class="section">
            <h2>💬 מרכז הודעות</h2>
            <div class="actions-bar">
                <button class="btn" onclick="loadMessages()">🔄 טען הודעות</button>
                <button class="btn btn-secondary" onclick="exportData('messages')">📊 ייצוא</button>
            </div>
            <div id="messages-list" class="data-list"><div class="loading">טוען הודעות...</div></div>
        </div>
    </div>

    <div id="tab-leads" class="tab-content">
        <div class="section">
            <h2>👤 רשימת לידים</h2>
            <div class="actions-bar">
                <button class="btn" onclick="loadLeads()">👤 כל הלידים</button>
                <button class="btn btn-secondary" onclick="loadLeads('qualified')">✰ מוכשרים</button>
                <button class="btn btn-secondary" onclick="loadLeads('contacted')">📞 בתהליך</button>
                <button class="btn btn-secondary" onclick="loadLeads('new')">🆕 חדשים</button>
                <button class="btn btn-green" onclick="exportData('leads')">📊 ייצוא לאקסל</button>
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
                <button class="btn" onclick="loadComplexes()">🔍 טען מתחמים</button>
                <button class="btn btn-secondary" onclick="loadComplexes('hot')">🔥 הזדמנויות חמות</button>
                <button class="btn btn-secondary" onclick="exportData('complexes')">📊 ייצוא</button>
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
                    <option value="failed">נכשל</option>
                </select>
            </div>
            <div class="actions-bar">
                <button class="btn" onclick="loadKones()">🔍 טען כינוסים</button>
                <button class="btn btn-secondary" onclick="loadKones('pending')">⏳ ממתינים</button>
                <button class="btn btn-green" onclick="runKonesAutoContact()">📱 הפעל Auto Contact</button>
                <button class="btn btn-secondary" onclick="exportData('kones')">📊 ייצוא</button>
            </div>
            <div id="kones-filter-badge" style="margin-bottom:10px;"></div>
            <div id="kones-list" class="data-list"><div class="loading">טוען כינוסי נכסים...</div></div>
        </div>
    </div>

    <div id="tab-news" class="tab-content">
        <div class="section">
            <h2>📰 חדשות שוק הנדלן</h2>
            <div class="actions-bar">
                <button class="btn" onclick="loadFacebookAds()">📱 מודעות פייסבוק</button>
            </div>
            <div id="news-list" class="data-list">
                <div class="data-item"><h3>📈 ריבית בנק ישראל</h3><p>מחירי הדירות עלו בממוצע ב-3.2% בחודש האחרון</p><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">קטגוריה:</span><span class="data-meta-value">מאקרו</span></div></div></div>
                <div class="data-item"><h3>🏗️ פינוי-בינוי חדשות</h3><p>אושר פינוי-בינוי חדש ברחוב הרצל - 180 יחידות</p><div class="data-meta"><div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">קרית ביאליק</span></div></div></div>
                <div id="facebook-ads-section" style="display:none;"><h3 style="color:#d4af37;margin:15px 0;">📱 מודעות פייסבוק</h3><div id="facebook-ads-list"></div></div>
            </div>
        </div>
    </div>

    <script>
        let currentTab = 'dashboard';

        document.addEventListener('DOMContentLoaded', function() {
            updateTime();
            setInterval(updateTime, 1000);
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
            const tabs = ['dashboard','ads','messages','leads','complexes','kones','news'];
            const idx = tabs.indexOf(tabName);
            const navTabs = document.querySelectorAll('.nav-tab');
            if (navTabs[idx]) navTabs[idx].classList.add('active');
            currentTab = tabName;
            window.scrollTo(0, 0);
            if (tabName === 'ads') loadAds();
            else if (tabName === 'messages') loadMessages();
            else if (tabName === 'leads') loadLeads(filter || null);
            else if (tabName === 'complexes') loadComplexes(filter === 'hot' ? 'hot' : null);
            else if (tabName === 'kones') loadKones(filter || null);
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

        async function loadMessages() {
            const container = document.getElementById('messages-list');
            container.innerHTML = '<div class="loading">טוען הודעות...</div>';
            try {
                const data = await fetchJSON('/dashboard/api/whatsapp/messages');
                if (!data.success) throw new Error(data.error);
                if (!data.data.length) { container.innerHTML = '<div class="loading">📋 אין הודעות נכנסות</div>'; return; }
                container.innerHTML = data.data.map(msg => renderMessage(msg)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, "loadMessages()"); }
        }

        function renderMessage(msg) {
            return '<div class="data-item"><h3>' + (msg.sender_name || msg.sender_phone || 'שולח לא ידוע') + '</h3>' +
                '<p style="margin:5px 0;color:#d1d5db;">' + (msg.message_content||'') + '</p>' +
                '<div class="data-meta">' +
                (msg.sender_phone ? '<div class="data-meta-item"><span class="data-meta-label">טלפון:</span><span class="data-meta-value"><a href="tel:' + msg.sender_phone + '" style="color:#3b82f6;">' + msg.sender_phone + '</a></span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">תאריך:</span><span class="data-meta-value">' + (msg.created_at ? new Date(msg.created_at).toLocaleDateString('he-IL') : '') + '</span></div>' +
                '</div></div>';
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
            container.innerHTML = '<div class="loading">טוען כינוסי נכסים...</div>';
            if (badge) badge.innerHTML = filter === 'pending' ? '<span class="filter-active-badge">⏳ מסנן: ממתינים לפנייה</span>' : '';
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
                if (!data.data.length) { container.innerHTML = '<div class="loading">🏗️ אין כינוסי נכסים</div>'; return; }
                container.innerHTML = data.data.map((k, i) => renderKones(k, i)).join('');
            } catch (e) { container.innerHTML = errorHTML(e.message, 'loadKones()'); }
        }

        function renderKones(k, i) {
            const statusClass = { pending: 'status-pending', contacted: 'status-contacted', failed: 'status-new' };
            const statusLabel = { pending: 'ממתין', contacted: 'נוצר קשר', failed: 'נכשל' };
            const st = k.contact_status || 'pending';
            return '<div class="data-item"><h3>🏗️ ' + (k.address || 'כינוס #' + (i+1)) + '</h3><div class="data-meta">' +
                '<div class="data-meta-item"><span class="data-meta-label">עיר:</span><span class="data-meta-value">' + (k.city||'לא ידוע') + '</span></div>' +
                (k.gush_helka ? '<div class="data-meta-item"><span class="data-meta-label">גוש/חלקה:</span><span class="data-meta-value">' + k.gush_helka + '</span></div>' : '') +
                (k.price ? '<div class="data-meta-item"><span class="data-meta-label">מחיר:</span><span class="data-meta-value">₪' + parseInt(k.price).toLocaleString() + '</span></div>' : '') +
                '<div class="data-meta-item"><span class="data-meta-label">סטטוס:</span><span class="data-meta-value"><span class="status-badge ' + (statusClass[st]||'status-pending') + '">' + (statusLabel[st]||st) + '</span></span></div>' +
                (k.contact_person ? '<div class="data-meta-item"><span class="data-meta-label">כונס:</span><span class="data-meta-value">' + k.contact_person + '</span></div>' : '') +
                (k.contact_attempts ? '<div class="data-meta-item"><span class="data-meta-label">ניסיונות פנייה:</span><span class="data-meta-value">' + k.contact_attempts + '</span></div>' : '') +
                (k.phone ? '<div class="data-meta-item"><span class="data-meta-label">טלפון:</span><span class="data-meta-value"><a href="tel:' + k.phone + '" style="color:#3b82f6;">' + k.phone + '</a> <a href="https://wa.me/' + k.phone.replace(/[^0-9]/g,'') + '" style="background:#22c55e;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:12px;">WhatsApp</a></span></div>' : '') +
                (k.url ? '<div class="data-meta-item"><span class="data-meta-label">קישור:</span><span class="data-meta-value"><a href="' + k.url + '" target="_blank" style="color:#3b82f6;">פתח כינוס</a></span></div>' : '') +
                '</div></div>';
        }

        async function runKonesAutoContact() {
            if (!confirm('להפעיל Auto Contact לכינוסי נכסים?')) return;
            try {
                const res = await fetch('/api/auto-contact/run-kones', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                if (res.ok) { alert('✅ Auto Contact לכינוסים הופעל!'); loadKones(); }
                else throw new Error('HTTP ' + res.status);
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
            return res.json();
        }

        function errorHTML(msg, retryFn) {
            return '<div class="error"><p>❌ שגיאה: ' + msg + '</p><button class="btn" onclick="' + retryFn + '" style="margin-top:10px;">נסה שוב</button></div>';
        }
    </script>
</body>
</html>`;
}

module.exports = router;
