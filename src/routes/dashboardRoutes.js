/**
 * QUANTUM Dashboard - Bloomberg Terminal Dark Design
 * Restored: dark #080c14 design with DM Serif Display fonts
 * API routes from v4.46.1 (PostgreSQL)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// --- API Routes ---

router.get('/complex/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const complex = await pool.query('SELECT * FROM complexes WHERE id = $1', [id]);
    if (!complex.rows.length) return res.status(404).json({ error: 'Not found' });
    const listings = await pool.query('SELECT * FROM listings WHERE complex_id = $1 AND is_active = true ORDER BY price_changes DESC NULLS LAST', [id]);
    const alerts = await pool.query('SELECT * FROM alerts WHERE complex_id = $1 ORDER BY created_at DESC LIMIT 10', [id]);
    res.json({ complex: complex.rows[0], listings: listings.rows, alerts: alerts.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/listings', async (req, res) => {
  try {
    const { city, source, min_price, max_price, min_rooms, max_rooms, min_area, max_area, sort, order, limit } = req.query;
    let query = `SELECT l.*, c.name as complex_name, c.city as complex_city, c.status as complex_status, c.iai_score, c.developer, c.slug as complex_slug, c.id as cid FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true`;
    const params = []; let idx = 1;
    if (city) { query += ` AND l.city = $${idx++}`; params.push(city); }
    if (source) { query += ` AND l.source = $${idx++}`; params.push(source); }
    if (min_price) { query += ` AND l.asking_price >= $${idx++}`; params.push(parseFloat(min_price)); }
    if (max_price) { query += ` AND l.asking_price <= $${idx++}`; params.push(parseFloat(max_price)); }
    if (min_rooms) { query += ` AND l.rooms >= $${idx++}`; params.push(parseFloat(min_rooms)); }
    if (max_rooms) { query += ` AND l.rooms <= $${idx++}`; params.push(parseFloat(max_rooms)); }
    if (min_area) { query += ` AND l.area_sqm >= $${idx++}`; params.push(parseFloat(min_area)); }
    if (max_area) { query += ` AND l.area_sqm <= $${idx++}`; params.push(parseFloat(max_area)); }
    const sortCol = ['asking_price','rooms','area_sqm','floor','days_on_market','price_changes'].includes(sort) ? sort : 'days_on_market';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY l.${sortCol} ${sortDir} NULLS LAST LIMIT $${idx++}`;
    params.push(Math.min(parseInt(limit) || 50, 200));
    const result = await pool.query(query, params);
    const citiesRes = await pool.query(`SELECT DISTINCT c.city FROM listings l JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true AND c.city IS NOT NULL ORDER BY c.city`);
    const sourcesRes = await pool.query(`SELECT DISTINCT source FROM listings WHERE is_active = true AND source IS NOT NULL ORDER BY source`);
    res.json({ listings: result.rows, total: result.rows.length, cities: citiesRes.rows.map(r => r.city), sources: sourcesRes.rows.map(r => r.source) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/listings/message-sent', async (req, res) => {
  try {
    const { listing_ids, status, deal_status } = req.body;
    if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'No listing IDs' });
    for (const id of listing_ids) {
      await pool.query(`UPDATE listings SET message_status = $1, last_message_sent_at = $2, deal_status = $3, updated_at = $2 WHERE id = $4`, [status || 'sent', new Date(), deal_status || 'contacted', id]);
    }
    res.json({ success: true, updated: listing_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/committees', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name as complex_name, city, status, approval_date as date, deposit_date, plan_number FROM complexes ORDER BY approval_date DESC NULLS LAST, updated_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/complexes', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, city, iai_score, signature_percent FROM complexes ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/complexes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    res.json(rows[0] || null);
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

router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as "totalSubscriptions", SUM(CASE WHEN active = true THEN 1 ELSE 0 END) as "activeSubscriptions", COUNT(DISTINCT lead_id) as "uniqueLeads", COALESCE(SUM(alerts_sent), 0) as "totalAlertsSent", COALESCE(SUM(CASE WHEN last_alert > NOW() - INTERVAL '1 day' THEN alerts_sent ELSE 0 END), 0) as "alerts24h", COALESCE(SUM(CASE WHEN last_alert > NOW() - INTERVAL '7 days' THEN alerts_sent ELSE 0 END), 0) as "alerts7d" FROM whatsapp_subscriptions`);
    res.json(rows[0] || { totalSubscriptions: 0, activeSubscriptions: 0, uniqueLeads: 0, totalAlertsSent: 0, alerts24h: 0, alerts7d: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM whatsapp_subscriptions WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.leadId]);
    res.json(rows.map(row => ({ ...row, criteria: row.criteria ? JSON.parse(row.criteria) : {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/whatsapp/subscriptions/test', express.json(), async (req, res) => {
  try {
    const { criteria } = req.body;
    if (!criteria || !Object.keys(criteria).length) return res.status(400).json({ error: 'Criteria required' });
    let query = "SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'yad2'";
    const params = []; let idx = 1;
    if (criteria.cities && criteria.cities.length > 0) { query += ` AND l.city = ANY($${idx++})`; params.push(criteria.cities); }
    if (criteria.rooms) {
      if (criteria.rooms.min !== undefined) { query += ` AND l.rooms >= $${idx++}`; params.push(criteria.rooms.min); }
      if (criteria.rooms.max !== undefined) { query += ` AND l.rooms <= $${idx++}`; params.push(criteria.rooms.max); }
    }
    if (criteria.price) {
      if (criteria.price.min !== undefined) { query += ` AND l.asking_price >= $${idx++}`; params.push(criteria.price.min); }
      if (criteria.price.max !== undefined) { query += ` AND l.asking_price <= $${idx++}`; params.push(criteria.price.max); }
    }
    query += ' LIMIT 10';
    const { rows } = await pool.query(query, params);
    res.json({ count: rows.length, listings: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/whatsapp/subscriptions', express.json(), async (req, res) => {
  try {
    const { leadId, criteria } = req.body;
    if (!leadId || !criteria) return res.status(400).json({ error: 'Lead ID and criteria required' });
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(`INSERT INTO whatsapp_subscriptions (id, lead_id, criteria, active, created_at) VALUES ($1, $2, $3, true, NOW())`, [id, leadId, JSON.stringify(criteria)]);
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/whatsapp/subscriptions/:id/toggle', express.json(), async (req, res) => {
  try {
    await pool.query('UPDATE whatsapp_subscriptions SET active = $1 WHERE id = $2', [req.body.active, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/whatsapp/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Main Dashboard UI (Bloomberg Terminal Dark) ---

router.get('/', async (req, res) => {
  try {
    const [enrichR, statusR, listR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN perplexity_summary IS NOT NULL THEN 1 ELSE 0 END) as perplexity, SUM(CASE WHEN iai_score IS NOT NULL AND iai_score > 0 THEN 1 ELSE 0 END) as iai FROM complexes`),
      pool.query(`SELECT SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved, SUM(CASE WHEN status IN ('deposited','pre_deposit','planning','declared') THEN 1 ELSE 0 END) as inprocess, SUM(CASE WHEN status='construction' THEN 1 ELSE 0 END) as construction FROM complexes`),
      pool.query(`SELECT COUNT(*) as yad2 FROM listings WHERE source='yad2' AND is_active=true`)
    ]);
    const e = enrichR.rows[0]; const s = statusR.rows[0]; const l = listR.rows[0];
    const pct = Math.round((e.perplexity / Math.max(e.total, 1)) * 100);
    const inPct = Math.round((s.inprocess / Math.max(e.total, 1)) * 100);
    const conPct = Math.round((s.construction / Math.max(e.total, 1)) * 100);

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>QUANTUM Intelligence Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Assistant',sans-serif;background:#080c14;color:#e2e8f0;direction:rtl}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#080c14}::-webkit-scrollbar-thumb{background:#1a2744;border-radius:3px}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.header{border-bottom:1px solid #1a2744;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;background:rgba(8,12,20,.95);backdrop-filter:blur(16px);position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:10px}
.header-logo{display:flex;align-items:center;gap:14px}
.logo-q{width:36px;height:36px;background:linear-gradient(135deg,#06d6a0,#3b82f6);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#000;font-family:'DM Serif Display',serif}
.header-title{font-size:16px;font-weight:800;letter-spacing:3px;font-family:'DM Serif Display',serif}
.header-sub{font-size:9px;color:#4a5e80;letter-spacing:1px}
.header-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{padding:6px 14px;background:transparent;border:1px solid #243352;border-radius:7px;color:#e2e8f0;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap}
.btn-chat{color:#9f7aea;font-weight:700}.btn-ssi{color:#06d6a0;font-weight:700}
.time-label{font-size:10px;color:#4a5e80}
.nav{padding:0 20px;border-bottom:1px solid #1a2744;display:flex;gap:2px;overflow-x:auto}
.nav-btn{padding:11px 16px;background:none;border:none;border-bottom:2px solid transparent;color:#4a5e80;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}
.nav-btn.active{border-bottom-color:#06d6a0;color:#06d6a0;font-weight:700}
.main{padding:20px;max-width:1360px;margin:0 auto}
.grid{display:grid;gap:14px;margin-bottom:24px}
.grid-6{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
@media(max-width:768px){.header{padding:10px 14px}.nav{padding:0 14px}.main{padding:14px}.stat-val{font-size:26px!important}}
.stat{background:#0f1623;border:1px solid #1a2744;border-radius:14px;padding:18px 22px;position:relative;overflow:hidden;transition:border-color .2s,background .2s;cursor:pointer}
.stat:hover{border-color:#06d6a0;background:#0a1118}
.stat-label{font-size:11px;color:#8899b4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;font-weight:600}
.stat-val{font-size:32px;font-weight:800;line-height:1.1;font-family:'DM Serif Display',serif}
.stat-sub{font-size:11px;color:#4a5e80;margin-top:5px}
.panel{background:#0f1623;border:1px solid #1a2744;border-radius:14px;padding:18px;margin-bottom:20px}
.panel-gold{border-color:rgba(255,194,51,.15);background:linear-gradient(135deg,#0f1623,rgba(255,194,51,.02))}
.panel-head{margin-bottom:14px;display:flex;align-items:baseline;gap:8px}
.panel-title{font-size:17px;font-weight:700;color:#e2e8f0;font-family:'DM Serif Display',serif}
.panel-sub{font-size:11px;color:#4a5e80}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:8px 10px;color:#4a5e80;font-weight:600;border-bottom:1px solid #1a2744;font-size:10px;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap;text-align:right;cursor:pointer;transition:color .15s}
th:hover{color:#06d6a0}
td{padding:9px 10px;color:#e2e8f0;text-align:right}
th.c,td.c{text-align:center}
tr:hover td{background:rgba(20,29,46,.5)}
.nw{white-space:nowrap}.fw{font-weight:700}.dim{color:#4a5e80}.sm{font-size:11px}.xs{font-size:10px}
.empty-msg{color:#4a5e80;padding:20px;text-align:center;font-size:13px}
.badge{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.badge-critical{background:rgba(255,77,106,.12);color:#ff4d6a}
.badge-high{background:rgba(255,140,66,.12);color:#ff8c42}
.badge-med{background:rgba(255,194,51,.12);color:#ffc233}
.badge-low{background:rgba(34,197,94,.08);color:#22c55e}
.badge-src{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;display:inline-flex;align-items:center}
.src-yad2{background:rgba(255,107,0,.12);color:#ff6b00}
.src-kones{background:rgba(220,38,127,.12);color:#dc267f}
.src-ai{background:rgba(139,92,246,.12);color:#8b5cf6}
.badge-status{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
.status-approved{background:rgba(6,214,160,.12);color:#06d6a0}
.status-deposited,.status-pre_deposit,.status-planning,.status-declared{background:rgba(255,194,51,.12);color:#ffc233}
.status-construction{background:rgba(59,130,246,.12);color:#3b82f6}
.status-unknown{background:rgba(148,163,184,.12);color:#94a3b8}
.btn-link{padding:3px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid rgba(96,165,250,.25);background:rgba(96,165,250,.06);color:#60a5fa;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center}
.btn-link:hover{background:rgba(96,165,250,.15)}
.filter-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.filter-row select,.filter-row input{padding:5px 10px;background:#141d2e;border:1px solid #243352;border-radius:6px;color:#e2e8f0;font-size:11px;font-family:inherit;min-width:90px}
.tab-content{display:none}.tab-content.active{display:block;animation:fadeUp .2s ease}
.prog-bar{height:4px;background:#1a2744;border-radius:2px;margin-top:8px;overflow:hidden}
.prog-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,#06d6a0,#3b82f6)}
.morning-hero{background:linear-gradient(135deg,rgba(6,214,160,.08),rgba(59,130,246,.05));border:1px solid rgba(6,214,160,.15);border-radius:14px;padding:24px;margin-bottom:20px}
.morning-title{font-size:24px;font-weight:800;font-family:'DM Serif Display',serif;margin-bottom:4px}
.morning-sub{font-size:13px;color:#8899b4}
.morning-date{font-size:11px;color:#4a5e80;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
</style>
</head>
<body>
<header class="header">
  <div class="header-logo">
    <div class="logo-q">Q</div>
    <div>
      <div class="header-title">QUANTUM <span style="color:#06d6a0;font-weight:300">INTELLIGENCE</span></div>
      <div class="header-sub">REAL ESTATE INTELLIGENCE SYSTEM</div>
    </div>
  </div>
  <div class="header-btns">
    <span class="time-label" id="time-display"></span>
    <a href="/api/chat" class="btn btn-chat">⌘ צ'אט</a>
    <button onclick="reloadSSI()" class="btn btn-ssi" id="ssi-btn">⌬ SSI</button>
  </div>
</header>
<nav class="nav">
  <button class="nav-btn active" data-tab="overview" onclick="navigate('overview')">⬡ SUMMARY</button>
  <button class="nav-btn" data-tab="properties" onclick="navigate('properties')">⬢ PROPERTIES</button>
  <button class="nav-btn" data-tab="leads" onclick="navigate('leads')">⚡ LEADS</button>
  <button class="nav-btn" data-tab="morning" onclick="navigate('morning')">☀ MORNING</button>
</nav>
<main class="main">

<div id="tab-overview" class="tab-content active">
<div class="grid grid-6">
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">MATAHAMIM</div>
    <div class="stat-val" id="stat-complexes"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub">PINUY-BINUY COMPLEXES</div>
  </div>
  <div class="stat">
    <div class="stat-label">PERPLEXITY</div>
    <div class="stat-val">${e.perplexity}</div>
    <div class="stat-sub">ENRICHED (${pct}%)</div>
  </div>
  <div class="stat">
    <div class="stat-label">IAI SCORED</div>
    <div class="stat-val">${e.iai}</div>
    <div class="stat-sub">COMPLEXES</div>
  </div>
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">APPROVED</div>
    <div class="stat-val" style="color:#06d6a0">${s.approved}</div>
    <div class="stat-sub">AUTHORIZED</div>
  </div>
  <div class="stat" onclick="navigate('leads')">
    <div class="stat-label">YAD2</div>
    <div class="stat-val">${l.yad2}</div>
    <div class="stat-sub">LISTINGS</div>
  </div>
  <div class="stat">
    <div class="stat-label">ALERTS</div>
    <div class="stat-val" id="stat-alerts"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub">UNREAD</div>
  </div>
</div>
<div class="grid grid-4">
  <div class="stat" style="border-color:rgba(255,194,51,.15)">
    <div class="stat-label" style="color:#ffc233">IN PROCESS</div>
    <div class="stat-val" style="color:#ffc233">${s.inprocess}</div>
    <div class="stat-sub">DEPOSITED / PLANNING</div>
    <div class="prog-bar"><div class="prog-fill" style="width:${inPct}%;background:linear-gradient(90deg,#ffc233,#ff8c42)"></div></div>
  </div>
  <div class="stat" style="border-color:rgba(59,130,246,.15)">
    <div class="stat-label" style="color:#3b82f6">CONSTRUCTION</div>
    <div class="stat-val" style="color:#3b82f6">${s.construction}</div>
    <div class="stat-sub">UNDER BUILD</div>
    <div class="prog-bar"><div class="prog-fill" style="width:${conPct}%;background:linear-gradient(90deg,#3b82f6,#9f7aea)"></div></div>
  </div>
  <div class="stat" style="border-color:rgba(6,214,160,.15)">
    <div class="stat-label" style="color:#06d6a0">ENRICHMENT</div>
    <div class="stat-val" style="color:#06d6a0">${pct}%</div>
    <div class="stat-sub">${e.perplexity} / ${e.total}</div>
    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
  </div>
  <div class="stat" style="border-color:rgba(139,92,246,.15)">
    <div class="stat-label" style="color:#8b5cf6">SCANS</div>
    <div class="stat-val" id="stat-scans" style="color:#8b5cf6"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub" id="stat-scans-sub">LOADING...</div>
  </div>
</div>
<div class="panel panel-gold">
  <div class="panel-head">
    <div class="panel-title">Morning Intelligence</div>
    <span class="panel-sub">Top opportunities by IAI score</span>
  </div>
  <div id="top-opps-list"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-properties" class="tab-content">
<div class="panel">
  <div class="panel-head"><div class="panel-title">Property Database</div><span class="panel-sub" id="prop-count"></span></div>
  <div class="filter-row">
    <input type="text" id="prop-search" placeholder="חיפוש מתחם / עיר..." oninput="filterProps()" style="min-width:200px">
    <select id="prop-status" onchange="filterProps()">
      <option value="">כל הסטטוסים</option><option value="approved">מאושר</option><option value="deposited">הופקדה</option>
      <option value="pre_deposit">להפקדה</option><option value="planning">בתכנון</option>
      <option value="construction">בביצוע</option><option value="declared">הוכרז</option>
    </select>
    <select id="prop-sort" onchange="filterProps()">
      <option value="date">מיין: תאריך</option><option value="name">מיין: שם</option><option value="city">מיין: עיר</option>
    </select>
  </div>
  <div id="props-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-leads" class="tab-content">
<div class="panel">
  <div class="panel-head"><div class="panel-title">Lead Management</div><span class="panel-sub">Yad2 listings + stress indicators</span></div>
  <div class="filter-row">
    <select id="leads-city" onchange="loadLeads()"><option value="">כל הערים</option></select>
    <select id="leads-source" onchange="loadLeads()"><option value="">כל המקורות</option></select>
    <select id="leads-sort" onchange="loadLeads()">
      <option value="days_on_market">ימים בשוק</option><option value="price_changes">שינויי מחיר</option><option value="asking_price">מחיר</option>
    </select>
    <button class="btn" onclick="loadLeads()">רענן</button>
  </div>
  <div id="leads-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-morning" class="tab-content">
<div class="morning-hero">
  <div class="morning-date" id="morning-date"></div>
  <div class="morning-title">☀ QUANTUM Morning Brief</div>
  <div class="morning-sub">Daily intelligence report</div>
</div>
<div id="morning-content"><div class="empty-msg">Loading...</div></div>
</div>

</main>
<script>
let allProps=[];
function setTime(){const n=new Date();document.getElementById('time-display').textContent=n.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});}
setTime();setInterval(setTime,30000);
document.getElementById('morning-date').textContent=new Date().toLocaleDateString('he-IL',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
function navigate(tab){
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.toggle('active',t.id==='tab-'+tab));
  if(tab==='properties'&&!allProps.length)loadProps();
  if(tab==='leads')loadLeads();
  if(tab==='morning')loadMorning();
}
async function reloadSSI(){
  const btn=document.getElementById('ssi-btn');btn.textContent='⌬ ...';
  try{await fetch('/api/scan/ai/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'quick'})});btn.textContent='⌬ OK!';}catch(e){}
  setTimeout(()=>{btn.textContent='⌬ SSI';},3000);
}
(async()=>{
  try{
    const[health,alerts,scans]=await Promise.all([fetch('/api/health').then(r=>r.json()),fetch('/api/alerts?limit=1').then(r=>r.json()),fetch('/api/scan/ai/status').then(r=>r.json())]);
    if(health.complexes)document.getElementById('stat-complexes').textContent=health.complexes.toLocaleString();
    document.getElementById('stat-alerts').textContent=alerts.alerts?alerts.alerts.filter(a=>!a.read).length:0;
    if(scans){const run=scans.running||0;document.getElementById('stat-scans').textContent=run>0?('⚡'+run):(scans.completed||0);document.getElementById('stat-scans-sub').textContent=run>0?'RUNNING':'COMPLETED';}
  }catch(e){}
  try{
    const data=await fetch('/api/opportunities').then(r=>r.json());
    const opps=(data.opportunities||[]).slice(0,5);
    if(!opps.length){document.getElementById('top-opps-list').innerHTML='<div class="empty-msg">No data</div>';return;}
    let h='<table><thead><tr><th>מתחם</th><th>עיר</th><th>IAI</th><th>סטטוס</th><th class="c">פעולה</th></tr></thead><tbody>';
    opps.forEach(o=>{const sc=parseFloat(o.iai_score)||0;const cl=sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';h+=\`<tr><td class="fw nw">\${o.name||''}</td><td class="dim">\${o.city||''}</td><td><span class="badge \${cl}">\${sc.toFixed(1)}</span></td><td class="xs dim">\${o.status||''}</td><td class="c"><a href="/api/dashboard/complex/\${o.id}" target="_blank" class="btn-link">פרטים</a></td></tr>\`;});
    h+='</tbody></table>';document.getElementById('top-opps-list').innerHTML=h;
  }catch(e){document.getElementById('top-opps-list').innerHTML='<div class="empty-msg">Error</div>';}
})();
async function loadProps(){
  try{const data=await fetch('/api/dashboard/committees').then(r=>r.json());allProps=data;filterProps();}
  catch(e){document.getElementById('props-table').innerHTML='<div class="empty-msg">Error</div>';}
}
function filterProps(){
  const search=(document.getElementById('prop-search').value||'').toLowerCase();
  const status=document.getElementById('prop-status').value;
  const sort=document.getElementById('prop-sort').value;
  let f=allProps.filter(p=>(!status||p.status===status)&&(!search|||(p.complex_name||'').toLowerCase().includes(search)||(p.city||'').toLowerCase().includes(search)));
  if(sort==='name')f.sort((a,b)=>(a.complex_name||'').localeCompare(b.complex_name||''));
  else if(sort==='city')f.sort((a,b)=>(a.city||'').localeCompare(b.city||''));
  document.getElementById('prop-count').textContent=f.length+' מתחמים';
  if(!f.length){document.getElementById('props-table').innerHTML='<div class="empty-msg">לא נמצאו</div>';return;}
  const stMap={approved:'מאושר',deposited:'הופקדה',pre_deposit:'להפקדה',planning:'בתכנון',construction:'בביצוע',declared:'הוכרז',unknown:'לא ידוע'};
  let h='<table><thead><tr><th>מתחם</th><th>עיר</th><th>תאריך</th><th>סטטוס</th></tr></thead><tbody>';
  f.forEach(p=>{h+=\`<tr><td class="fw">\${p.complex_name||''}</td><td class="dim">\${p.city||''}</td><td class="xs dim">\${p.date?new Date(p.date).toLocaleDateString('he-IL'):'-'}</td><td><span class="badge-status status-\${p.status||'unknown'}">\${stMap[p.status]||p.status||''}</span></td></tr>\`;});
  h+='</tbody></table>';document.getElementById('props-table').innerHTML=h;
}
async function loadLeads(){
  const city=document.getElementById('leads-city').value;const source=document.getElementById('leads-source').value;const sort=document.getElementById('leads-sort').value;
  document.getElementById('leads-table').innerHTML='<div class="empty-msg">Loading...</div>';
  try{
    const url=\`/api/dashboard/listings?sort=\${sort}&limit=100\${city?'&city='+city:''}\${source?'&source='+source:''}\`;
    const data=await fetch(url).then(r=>r.json());const listings=data.listings||[];
    if(document.getElementById('leads-city').options.length===1&&data.cities)data.cities.forEach(c=>{document.getElementById('leads-city').add(new Option(c,c));});
    if(document.getElementById('leads-source').options.length===1&&data.sources)data.sources.forEach(s=>{document.getElementById('leads-source').add(new Option(s,s));});
    if(!listings.length){document.getElementById('leads-table').innerHTML='<div class="empty-msg">לא נמצאו רישומים</div>';return;}
    let h='<table><thead><tr><th>מתחם</th><th>עיר</th><th>מחיר</th><th>חד\'</th><th>מ"ר</th><th>ימים</th><th>מקור</th><th class="c">קישור</th></tr></thead><tbody>';
    listings.forEach(l=>{const dom=l.days_on_market||0;const dc=dom>60?'style="color:#ff4d6a"':dom>30?'style="color:#ffc233"':'';h+=\`<tr><td class="fw sm">\${l.complex_name||''}</td><td class="dim xs">\${l.city||''}</td><td class="nw fw">\${l.asking_price?'₪'+Math.round(l.asking_price/1000)+'K':'-'}</td><td class="c">\${l.rooms||'-'}</td><td class="c">\${l.area_sqm||'-'}</td><td class="c" \${dc}>\${dom||'-'}</td><td><span class="badge-src src-\${l.source||'other'}">\${l.source||''}</span></td><td class="c">\${l.url?'<a href="'+l.url+'" target="_blank" class="btn-link">פתח</a>':'-'}</td></tr>\`;});
    h+='</tbody></table>';document.getElementById('leads-table').innerHTML=h;
  }catch(e){document.getElementById('leads-table').innerHTML='<div class="empty-msg">Error</div>';}
}
async function loadMorning(){
  try{
    const[op,al]=await Promise.all([fetch('/api/opportunities').then(r=>r.json()),fetch('/api/alerts?limit=10').then(r=>r.json())]);
    const opps=(op.opportunities||[]).slice(0,8);const alerts=(al.alerts||[]).slice(0,8);
    let h='';
    if(opps.length){h+='<div class="panel"><div class="panel-head"><div class="panel-title">Top Opportunities</div></div><table><thead><tr><th>מתחם</th><th>עיר</th><th>IAI</th><th>סטטוס</th></tr></thead><tbody>';opps.forEach(o=>{const sc=parseFloat(o.iai_score)||0;const cl=sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';h+=\`<tr><td class="fw">\${o.name||''}</td><td class="dim">\${o.city||''}</td><td><span class="badge \${cl}">\${sc.toFixed(1)}</span></td><td class="xs dim">\${o.status||''}</td></tr>\`;});h+='</tbody></table></div>';}
    if(alerts.length){h+='<div class="panel"><div class="panel-head"><div class="panel-title">Recent Alerts</div></div><table><thead><tr><th>תיאור</th><th>סוג</th><th>תאריך</th></tr></thead><tbody>';alerts.forEach(a=>{h+=\`<tr><td>\${a.description||a.message||''}</td><td class="xs dim">\${a.type||''}</td><td class="xs dim">\${a.created_at?new Date(a.created_at).toLocaleDateString('he-IL'):''}</td></tr>\`;});h+='</tbody></table></div>';}
    if(!h)h='<div class="panel"><div class="empty-msg">No morning data yet</div></div>';
    document.getElementById('morning-content').innerHTML=h;
  }catch(e){document.getElementById('morning-content').innerHTML='<div class="panel"><div class="empty-msg">Error</div></div>';}
}
</script>
</body></html>`);
  } catch (err) {
    res.status(500).send('Dashboard error: ' + err.message);
  }
});

module.exports = router;
