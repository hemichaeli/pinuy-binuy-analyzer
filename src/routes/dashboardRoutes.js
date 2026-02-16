/**
 * QUANTUM Dashboard v4.24.0 - Complete Messaging Feature (Fixed)
 * 
 * NEW: Checkbox selection for listings (individual + select all filtered)
 * NEW: Message templates (3 Hebrew templates + custom freetext)
 * NEW: Template modal with preview and edit
 * NEW: Bulk send: copy message to clipboard + open listing URLs
 * NEW: Message status tracking (נשלחה/טרם) with DB persistence
 * NEW: POST /api/dashboard/listings/message-sent endpoint
 * NEW: Sticky action bar when listings selected
 * NEW: Visual indicators for sent/pending messages
 * 
 * Previous (v4.22.1): SSI panel title, listing click opens URL directly
 */

const express = require('express');
const router = express.Router();

// --- Complex Detail API ---

router.get('/complex/:id', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const id = parseInt(req.params.id);
    
    const complex = await pool.query(`
      SELECT * FROM complexes WHERE id = $1
    `, [id]);
    
    if (!complex.rows.length) return res.status(404).json({ error: 'Not found' });
    
    const listings = await pool.query(`
      SELECT * FROM listings WHERE complex_id = $1 AND is_active = true
      ORDER BY price_changes DESC NULLS LAST, days_on_market DESC NULLS LAST
    `, [id]);
    
    const alerts = await pool.query(`
      SELECT * FROM alerts WHERE complex_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [id]);
    
    res.json({
      complex: complex.rows[0],
      listings: listings.rows,
      alerts: alerts.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Listings API ---

router.get('/listings', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { city, source, min_price, max_price, min_rooms, max_rooms, min_area, max_area, min_floor, max_floor, sort, order, limit } = req.query;
    
    let query = `SELECT l.*, c.name as complex_name, c.city as complex_city, c.status as complex_status, 
                 c.iai_score, c.developer, c.slug as complex_slug, c.id as cid
                 FROM listings l 
                 LEFT JOIN complexes c ON l.complex_id = c.id 
                 WHERE l.is_active = true`;
    const params = [];
    let pc = 0;
    
    if (city) { pc++; query += ` AND c.city = $${pc}`; params.push(city); }
    if (source) { pc++; query += ` AND l.source = $${pc}`; params.push(source); }
    if (min_price) { pc++; query += ` AND l.asking_price >= $${pc}`; params.push(min_price); }
    if (max_price) { pc++; query += ` AND l.asking_price <= $${pc}`; params.push(max_price); }
    if (min_rooms) { pc++; query += ` AND l.rooms >= $${pc}`; params.push(min_rooms); }
    if (max_rooms) { pc++; query += ` AND l.rooms <= $${pc}`; params.push(max_rooms); }
    if (min_area) { pc++; query += ` AND l.area_sqm >= $${pc}`; params.push(min_area); }
    if (max_area) { pc++; query += ` AND l.area_sqm <= $${pc}`; params.push(max_area); }
    if (min_floor) { pc++; query += ` AND l.floor >= $${pc}`; params.push(min_floor); }
    if (max_floor) { pc++; query += ` AND l.floor <= $${pc}`; params.push(max_floor); }
    
    const validSorts = ['asking_price','rooms','area_sqm','floor','price_per_sqm','ssi_score','days_on_market','city'];
    const sortCol = validSorts.includes(sort) ? sort : 'asking_price';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    if (sortCol === 'city') query += ` ORDER BY c.city ${sortOrder}`;
    else query += ` ORDER BY l.${sortCol} ${sortOrder} NULLS LAST`;
    
    const lim = Math.min(parseInt(limit) || 500, 1000);
    pc++; query += ` LIMIT $${pc}`; params.push(lim);
    
    const result = await pool.query(query, params);
    const citiesRes = await pool.query(`SELECT DISTINCT c.city FROM listings l JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true AND c.city IS NOT NULL ORDER BY c.city`);
    const sourcesRes = await pool.query(`SELECT DISTINCT source FROM listings WHERE is_active = true AND source IS NOT NULL ORDER BY source`);
    
    res.json({
      total: result.rows.length,
      cities: citiesRes.rows.map(r => r.city),
      sources: sourcesRes.rows.map(r => r.source),
      listings: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Logo endpoint ---
const fs = require('fs');
const path = require('path');

router.get('/logo.png', (req, res) => {
  try {
    const b64 = fs.readFileSync(path.join(__dirname, '../../assets/logo.b64'), 'utf8').trim();
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(404).send('Logo not found');
  }
});

// --- Message Sent API ---
router.post('/listings/message-sent', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { listing_ids, template, message } = req.body;
    if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'No listing IDs' });
    
    const now = new Date().toISOString();
    let updated = 0;
    for (const id of listing_ids) {
      await pool.query(
        `UPDATE listings SET message_status = $1, last_message_sent_at = $2, deal_status = $3, updated_at = $2 WHERE id = $4`,
        ['\u05E0\u05E9\u05DC\u05D7\u05D4', now, '\u05E0\u05E9\u05DC\u05D7\u05D4 \u05D4\u05D5\u05D3\u05E2\u05D4', id]
      );
      updated++;
    }
    
    res.json({ success: true, updated, template: template || 'custom', timestamp: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard HTML ---

router.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QUANTUM Intelligence Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Assistant',sans-serif;background:#080c14;color:#e2e8f0;direction:rtl}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#080c14}::-webkit-scrollbar-thumb{background:#1a2744;border-radius:3px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideIn{from{transform:translateX(-100%);opacity:0}to{transform:translateX(0);opacity:1}}

.header{border-bottom:1px solid #1a2744;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;background:rgba(8,12,20,.92);backdrop-filter:blur(16px);position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:10px}
.header-logo{display:flex;align-items:center;gap:14px}
.logo-q{width:36px;height:36px;background:linear-gradient(135deg,#06d6a0,#3b82f6);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#000;font-family:'DM Serif Display',serif}
.header-title{font-size:16px;font-weight:800;letter-spacing:3px;font-family:'DM Serif Display',serif}
.header-sub{font-size:9px;color:#4a5e80;margin-right:10px;letter-spacing:1px}
.header-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{padding:6px 14px;background:transparent;border:1px solid #243352;border-radius:7px;color:#e2e8f0;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap}
.btn-chat{color:#9f7aea;font-weight:700}
.btn-ssi{color:#06d6a0;font-weight:700}
.btn-ssi.loading{color:#4a5e80;cursor:default}
.time-label{font-size:10px;color:#4a5e80}

.nav{padding:0 20px;border-bottom:1px solid #1a2744;display:flex;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-btn{padding:11px 16px;background:none;border:none;border-bottom:2px solid transparent;color:#4a5e80;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}
.nav-btn.active{border-bottom-color:#06d6a0;color:#06d6a0;font-weight:700}

.main{padding:20px;max-width:1360px;margin:0 auto}
.grid{display:grid;gap:14px;margin-bottom:24px}
.grid-6{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.grid-2{grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
@media(max-width:768px){
  .grid-2{grid-template-columns:1fr}.grid-6{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
  .header{padding:10px 14px}.nav{padding:0 14px}.main{padding:14px}
  .stat{padding:14px 16px}.stat-val{font-size:26px}
  .modal-body{width:95vw!important;max-width:95vw!important}
}

.stat{background:#0f1623;border:1px solid #1a2744;border-radius:14px;padding:18px 22px;position:relative;overflow:hidden;transition:border-color .2s}
.stat-icon{position:absolute;top:-8px;left:-4px;font-size:56px;opacity:.03;font-weight:900}
.stat-label{font-size:11px;color:#8899b4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;font-weight:600}
.stat-val{font-size:32px;font-weight:800;line-height:1.1;font-family:'DM Serif Display',serif}
.stat-sub{font-size:11px;color:#4a5e80;margin-top:5px}

.panel{background:#0f1623;border:1px solid #1a2744;border-radius:14px;padding:18px;margin-bottom:20px}
.panel-gold{border-color:rgba(255,194,51,.13);background:linear-gradient(135deg,#0f1623 0%,rgba(255,194,51,.03) 100%)}
.panel-head{margin-bottom:14px;display:flex;align-items:baseline;gap:8px}
.panel-head-icon{font-size:16px;opacity:.6}
.panel-title{font-size:17px;font-weight:700;color:#e2e8f0;margin:0;font-family:'DM Serif Display',serif}
.panel-sub{font-size:11px;color:#4a5e80;margin:2px 0 0}
.section-note{background:rgba(6,214,160,.04);border:1px solid rgba(6,214,160,.12);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#8899b4;line-height:1.6}
.section-note strong{color:#06d6a0}

table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:8px 10px;color:#4a5e80;font-weight:600;border-bottom:1px solid #1a2744;font-size:10px;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap;text-align:right;cursor:pointer;user-select:none;transition:color .15s}
th:hover{color:#06d6a0}
th.sorted{color:#06d6a0}
th .sort-arrow{font-size:8px;margin-right:3px;opacity:.6}
td{padding:9px 10px;color:#e2e8f0;text-align:right}
th.c,td.c{text-align:center}
tr.clickable{cursor:pointer;transition:background .1s}
tr.clickable:hover td{background:#141d2e}
tr:hover td{background:rgba(20,29,46,.5)}
.nw{white-space:nowrap}.fw{font-weight:700}.f6{font-weight:600}.dim{color:#4a5e80}.muted{color:#8899b4}.sm{font-size:11px}.xs{font-size:10px}
.empty-msg{color:#4a5e80;padding:20px;text-align:center;font-size:13px}

.badge-ssi{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.badge-critical{background:rgba(255,77,106,.12);color:#ff4d6a}
.badge-high{background:rgba(255,140,66,.12);color:#ff8c42}
.badge-med{background:rgba(255,194,51,.12);color:#ffc233}
.badge-low{background:rgba(34,197,94,.08);color:#22c55e}

.badge-src{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.src-yad2{background:rgba(255,107,0,.12);color:#ff6b00}
.src-facebook{background:rgba(24,119,242,.12);color:#1877f2}
.src-madlan{background:rgba(0,166,153,.12);color:#00a699}
.src-homeless{background:rgba(99,102,241,.12);color:#6366f1}
.src-kones{background:rgba(220,38,127,.12);color:#dc267f}
.src-ai{background:rgba(139,92,246,.12);color:#8b5cf6}
.src-other{background:rgba(148,163,184,.12);color:#94a3b8}

.btn-link{padding:3px 10px;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;border:1px solid rgba(96,165,250,.25);background:rgba(96,165,250,.06);color:#60a5fa;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:3px}
.btn-link:hover{background:rgba(96,165,250,.15)}
.btn-link-search{border-color:rgba(139,92,246,.25);background:rgba(139,92,246,.06);color:#8b5cf6}
.btn-link-search:hover{background:rgba(139,92,246,.15)}

.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot-red{background:#ff4d6a}.dot-orange{background:#ff8c42}.dot-green{background:#22c55e}

.filter-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.filter-row select,.filter-row input{padding:5px 10px;background:#141d2e;border:1px solid #243352;border-radius:6px;color:#e2e8f0;font-size:11px;font-family:inherit;min-width:90px}
.filter-row input{width:80px}
.filter-row select:focus,.filter-row input:focus{border-color:#06d6a0;outline:none}
.filter-label{font-size:10px;color:#4a5e80;white-space:nowrap}

.bar-chart{display:flex;flex-direction:column;gap:6px;padding:4px 0}
.bar-row{display:flex;align-items:center;gap:8px}
.bar-label{width:70px;font-size:10px;color:#8899b4;text-align:left;flex-shrink:0}
.bar-track{flex:1;height:14px;background:#141d2e;border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:0 3px 3px 0;transition:width .5s ease}
.bar-val{font-size:10px;color:#8899b4;width:24px;text-align:center;flex-shrink:0}

.pie-legend{display:flex;flex-direction:column;gap:8px}
.pie-row{display:flex;justify-content:space-between;padding:5px 0}
.pie-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0;margin-top:3px}
.pie-info{display:flex;align-items:flex-start;gap:7px}

.loading-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px}
.loading-logo-wrap{position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center}
.loading-logo{width:90px;height:90px;object-fit:contain;animation:logoPulse 2s ease-in-out infinite;filter:drop-shadow(0 0 20px rgba(6,214,160,0.4))}
.orbit-ring{position:absolute;top:0;left:0;width:120px;height:120px;border:2px solid rgba(6,214,160,0.15);border-top:2px solid rgba(6,214,160,0.6);border-radius:50%;animation:orbit 2s linear infinite}
@keyframes logoPulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 20px rgba(6,214,160,0.4))}50%{transform:scale(1.05);filter:drop-shadow(0 0 30px rgba(6,214,160,0.7))}}
@keyframes orbit{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

.tab-content{animation:fadeUp .25s ease}
.hidden{display:none}
.overflow-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
.footer{border-top:1px solid #1a2744;padding:14px 20px;text-align:center;margin-top:24px}
.footer span{font-size:10px;color:#4a5e80}
.cnt-badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(6,214,160,.12);color:#06d6a0;margin-right:4px}

/* --- Messaging Feature --- */
.cb-cell{width:30px;text-align:center}
.cb-cell input[type=checkbox]{width:15px;height:15px;cursor:pointer;accent-color:#06d6a0}
.msg-bar{position:sticky;bottom:0;background:rgba(15,22,35,.96);backdrop-filter:blur(12px);border-top:1px solid #1a2744;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:50;margin:0 -18px -18px;border-radius:0 0 14px 14px}
.msg-bar-info{font-size:13px;color:#e2e8f0;font-weight:600;display:flex;align-items:center;gap:8px}
.msg-bar-count{background:rgba(6,214,160,.15);color:#06d6a0;padding:2px 10px;border-radius:12px;font-weight:800;font-size:14px}
.msg-bar-btns{display:flex;gap:8px}
.btn-msg{padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:none;font-family:inherit;transition:all .15s}
.btn-msg-send{background:linear-gradient(135deg,#06d6a0,#22c55e);color:#000}
.btn-msg-send:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(6,214,160,.3)}
.btn-msg-clear{background:transparent;border:1px solid #243352;color:#8899b4}
.btn-msg-clear:hover{border-color:#ff4d6a;color:#ff4d6a}
.btn-msg-send:disabled{opacity:.5;cursor:default;transform:none;box-shadow:none}

.tmpl-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.75);z-index:300;backdrop-filter:blur(6px);justify-content:center;align-items:center}
.tmpl-overlay.open{display:flex}
.tmpl-body{background:#0f1623;border:1px solid #1a2744;border-radius:16px;width:560px;max-width:92vw;max-height:85vh;overflow-y:auto;animation:slideIn .2s ease}
.tmpl-header{padding:18px 22px;border-bottom:1px solid #1a2744;display:flex;justify-content:space-between;align-items:center}
.tmpl-header h3{font-family:'DM Serif Display',serif;font-size:18px;color:#e2e8f0;margin:0}
.tmpl-close{background:none;border:none;color:#4a5e80;font-size:20px;cursor:pointer;padding:4px 8px;border-radius:6px}
.tmpl-close:hover{background:#1a2744;color:#e2e8f0}
.tmpl-content{padding:22px}
.tmpl-card{background:#141d2e;border:1px solid #243352;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:all .15s}
.tmpl-card:hover{border-color:#06d6a0;background:#1a2744}
.tmpl-card.selected{border-color:#06d6a0;background:rgba(6,214,160,.06);box-shadow:0 0 0 1px rgba(6,214,160,.3)}
.tmpl-card-title{font-size:13px;font-weight:700;color:#06d6a0;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.tmpl-card-body{font-size:12px;color:#8899b4;line-height:1.7;white-space:pre-wrap;direction:rtl}
.tmpl-footer{padding:16px 22px;border-top:1px solid #1a2744;display:flex;justify-content:space-between;align-items:center}
.tmpl-counter{font-size:12px;color:#4a5e80}
.tmpl-send-btn{padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;font-family:inherit;background:linear-gradient(135deg,#06d6a0,#22c55e);color:#000;transition:all .15s}
.tmpl-send-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(6,214,160,.3)}
.tmpl-send-btn:disabled{opacity:.4;cursor:default;transform:none}
.tmpl-progress{font-size:12px;color:#06d6a0;text-align:center;padding:12px}
.tmpl-edit-area{width:100%;min-height:80px;background:#0f1623;border:1px solid #243352;border-radius:8px;color:#e2e8f0;font-size:12px;padding:10px;font-family:inherit;resize:vertical;direction:rtl;line-height:1.7;margin-top:8px}
.tmpl-edit-area:focus{border-color:#06d6a0;outline:none}
tr.msg-sent td{opacity:.5}
.badge-msg{padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700}
.badge-msg-sent{background:rgba(6,214,160,.1);color:#06d6a0}
.badge-msg-pending{background:rgba(255,194,51,.08);color:#ffc233}

/* --- Modal --- */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:200;backdrop-filter:blur(4px);justify-content:center;align-items:flex-start;padding:40px 20px;overflow-y:auto}
.modal-overlay.open{display:flex}
.modal-body{background:#0f1623;border:1px solid #1a2744;border-radius:16px;width:700px;max-width:90vw;max-height:85vh;overflow-y:auto;animation:slideIn .2s ease;padding:0}
.modal-header{padding:18px 22px;border-bottom:1px solid #1a2744;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#0f1623;z-index:1;border-radius:16px 16px 0 0}
.modal-close{background:none;border:none;color:#4a5e80;font-size:20px;cursor:pointer;padding:4px 8px;border-radius:6px}
.modal-close:hover{background:#1a2744;color:#e2e8f0}
.modal-content{padding:22px}
.modal-section{margin-bottom:18px}
.modal-section-title{font-size:12px;color:#06d6a0;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;font-weight:700}
.modal-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(26,39,68,.5);font-size:13px}
.modal-row-label{color:#8899b4}
.modal-row-value{color:#e2e8f0;font-weight:600;text-align:left}
.modal-factors{display:flex;flex-direction:column;gap:6px}
.modal-factor{background:rgba(255,194,51,.06);border:1px solid rgba(255,194,51,.12);border-radius:6px;padding:6px 10px;font-size:12px;color:#ffc233}
.modal-listing{background:#141d2e;border-radius:8px;padding:12px;margin-bottom:8px}
.modal-listing-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.modal-listing-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:4px;font-size:11px;color:#8899b4}
</style>
</head>
<body>

<div id="loading" class="loading-screen">
  <div class="loading-logo-wrap">
    <img src="/api/dashboard/logo.png" class="loading-logo" alt="Q">
    <div class="orbit-ring"></div>
  </div>
  <div style="color:#4a5e80;font-size:14px;letter-spacing:2px">QUANTUM Intelligence</div>
</div>

<div id="app" class="hidden">
  <header class="header">
    <div class="header-logo">
      <div class="logo-q">Q</div>
      <div>
        <span class="header-title">QUANTUM</span>
        <span class="header-sub">INTELLIGENCE</span>
      </div>
    </div>
    <div class="header-btns">
      <a href="/api/chat/" class="btn btn-chat">Chat AI</a>
      <button id="btn-ssi" class="btn btn-ssi" data-action="ssi">SSI</button>
      <button class="btn" data-action="refresh">\u05E8\u05E2\u05E0\u05D5\u05DF</button>
      <span id="time-label" class="time-label"></span>
    </div>
  </header>
  <nav class="nav" id="nav"></nav>
  <main class="main" id="main"></main>
  <footer class="footer"><span id="footer-text">QUANTUM v4.24.0</span></footer>
</div>

<!-- Detail Modal -->
<div id="modal" class="modal-overlay">
  <div class="modal-body">
    <div class="modal-header">
      <h3 id="modal-title" style="font-family:'DM Serif Display',serif;font-size:18px;color:#e2e8f0">...</h3>
      <button class="modal-close" id="modal-close">\u2715</button>
    </div>
    <div class="modal-content" id="modal-content">
      <div style="text-align:center;padding:30px;color:#4a5e80">\u05D8\u05D5\u05E2\u05DF...</div>
    </div>
  </div>
</div>

<!-- Template Modal -->
<div id="tmpl-modal" class="tmpl-overlay">
  <div class="tmpl-body">
    <div class="tmpl-header">
      <h3>\u05E9\u05DC\u05D7 \u05D4\u05D5\u05D3\u05E2\u05D4</h3>
      <button class="tmpl-close" id="tmpl-close">\u2715</button>
    </div>
    <div class="tmpl-content" id="tmpl-content"></div>
    <div class="tmpl-footer">
      <span class="tmpl-counter" id="tmpl-counter"></span>
      <button class="tmpl-send-btn" id="tmpl-send" disabled>\u05D4\u05E2\u05EA\u05E7 \u05D5\u05E4\u05EA\u05D7 \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA</button>
    </div>
  </div>
</div>

<script>
var D=null,LD=null,currentTab='overview',aggRunning=false;
var sortStates={};
var filterStates={};
var selectedListings=new Set();
var msgTemplates=[
  {id:'inquiry',title:'\u05D1\u05D9\u05E8\u05D5\u05E8 \u05DB\u05DC\u05DC\u05D9',body:'\u05E9\u05DC\u05D5\u05DD, \u05E8\u05D0\u05D9\u05EA\u05D9 \u05D0\u05EA \u05D4\u05DE\u05D5\u05D3\u05E2\u05D4 \u05E9\u05DC\u05DA \u05D5\u05D4\u05D9\u05D0 \u05DE\u05E2\u05E0\u05D9\u05D9\u05E0\u05EA \u05D0\u05D5\u05EA\u05D9 \u05DE\u05D0\u05D5\u05D3.\n\u05D0\u05E0\u05D9 \u05DE\u05EA\u05DE\u05D7\u05D4 \u05D1\u05E0\u05D3\u05DC\"\u05DF \u05D1\u05D0\u05D6\u05D5\u05E8 \u05D5\u05D0\u05E9\u05DE\u05D7 \u05DC\u05E9\u05DE\u05D5\u05E2 \u05E4\u05E8\u05D8\u05D9\u05DD \u05E0\u05D5\u05E1\u05E4\u05D9\u05DD \u05E2\u05DC \u05D4\u05E0\u05DB\u05E1.\n\u05D0\u05E4\u05E9\u05E8 \u05DC\u05EA\u05D0\u05DD \u05E9\u05D9\u05D7\u05D4?\n\u05EA\u05D5\u05D3\u05D4!'},
  {id:'buyer',title:'\u05E7\u05D5\u05E0\u05D4 \u05E8\u05E6\u05D9\u05E0\u05D9',body:'\u05D4\u05D9\u05D9, \u05E9\u05DC\u05D5\u05DD!\n\u05D0\u05E0\u05D9 \u05DE\u05D7\u05E4\u05E9 \u05E0\u05DB\u05E1 \u05D1\u05D0\u05D6\u05D5\u05E8 \u05D5\u05D4\u05DE\u05D5\u05D3\u05E2\u05D4 \u05E9\u05DC\u05DA \u05EA\u05E4\u05E1\u05D4 \u05D0\u05EA \u05EA\u05E9\u05D5\u05DE\u05EA \u05D4\u05DC\u05D1.\n\u05D9\u05E9 \u05DC\u05D9 \u05EA\u05E7\u05E6\u05D9\u05D1 \u05DE\u05D0\u05D5\u05E9\u05E8 \u05D5\u05D0\u05E0\u05D9 \u05D9\u05DB\u05D5\u05DC \u05DC\u05D4\u05EA\u05E7\u05D3\u05DD \u05DE\u05D4\u05E8.\n\u05DE\u05EA\u05D9 \u05E0\u05D5\u05D7 \u05DC\u05DA \u05DC\u05D1\u05D5\u05D0 \u05DC\u05E8\u05D0\u05D5\u05EA \u05D0\u05EA \u05D4\u05E0\u05DB\u05E1?\n\u05EA\u05D5\u05D3\u05D4 \u05E8\u05D1\u05D4'},
  {id:'direct',title:'\u05D2\u05D9\u05E9\u05D4 \u05D9\u05E9\u05D9\u05E8\u05D4',body:'\u05E9\u05DC\u05D5\u05DD,\n\u05D0\u05E0\u05D9 \u05DE\u05EA\u05E2\u05E0\u05D9\u05D9\u05DF \u05D1\u05E0\u05DB\u05E1 \u05E9\u05E4\u05E8\u05E1\u05DE\u05EA \u05DC\u05DE\u05DB\u05D9\u05E8\u05D4 \u05D5\u05E8\u05E6\u05D9\u05EA\u05D9 \u05DC\u05D1\u05D3\u05D5\u05E7 \u05D0\u05DD \u05D4\u05D5\u05D0 \u05E2\u05D3\u05D9\u05D9\u05DF \u05D6\u05DE\u05D9\u05DF.\n\u05D0\u05DD \u05DB\u05DF, \u05D0\u05E9\u05DE\u05D7 \u05DC\u05E9\u05DE\u05D5\u05E2 \u05E4\u05E8\u05D8\u05D9\u05DD \u05E0\u05D5\u05E1\u05E4\u05D9\u05DD.\n\u05EA\u05D5\u05D3\u05D4'}
];

// --- Source normalization ---
function normSrc(s){
  if(!s)return'unknown';
  s=s.toLowerCase().trim();
  if(s.includes('yad2'))return'yad2';
  if(s.includes('madlan'))return'madlan';
  if(s==='ai_scan'||s.includes('perplexity'))return'ai_scan';
  if(s.includes('facebook'))return'facebook';
  if(s.includes('homeless'))return'homeless';
  if(s.includes('kones'))return'kones';
  return s;
}

// --- Utility functions ---
function ssiCls(sc){if(!sc&&sc!==0)return'';return sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';}
function ssiLbl(sc){if(!sc&&sc!==0)return'-';var t=sc>=80?'\u05E7\u05E8\u05D9\u05D8\u05D9':sc>=60?'\u05D2\u05D1\u05D5\u05D4':sc>=40?'\u05D1\u05D9\u05E0\u05D5\u05E0\u05D9':'\u05E0\u05DE\u05D5\u05DA';return sc+' '+t;}
function iaiH(sc){if(!sc&&sc!==0)return'<span class="dim">-</span>';var c=sc>=70?'#22c55e':sc>=50?'#06d6a0':sc>=30?'#ffc233':'#4a5e80';return'<span style="color:'+c+';font-weight:700;font-size:13px">'+sc+'</span>';}
function dotH(sev){var c=sev==='high'||sev==='critical'?'dot-red':sev==='medium'?'dot-orange':'dot-green';return'<span class="dot '+c+'"></span>';}
function cut(s,n){return s?(s.length>n?s.substring(0,n)+'...':s):'-';}
function fmtD(d){try{return new Date(d).toLocaleDateString('he-IL');}catch(e){return'-';}}
function fmtP(v){if(!v)return'-';var n=parseFloat(v);return n>=1000000?(n/1000000).toFixed(2)+'M':(n>=1000?(n/1000).toFixed(0)+'K':n.toFixed(0));}
function fmtN(v){if(!v&&v!==0)return'-';return parseFloat(v).toLocaleString('he-IL');}
function fmtPrice(v){if(!v)return'-';var n=parseFloat(v);return '\u20AA'+n.toLocaleString('he-IL');}
function pf(v){return Array.isArray(v)?v:(typeof v==='string'?JSON.parse(v||'[]'):[]);}

// Platform display
var PLAT={yad2:{name:'\u05D9\u05D3 2',cls:'src-yad2',icon:'\u25A0'},facebook:{name:'Facebook',cls:'src-facebook',icon:'f'},madlan:{name:'\u05DE\u05D3\u05DC\u05DF',cls:'src-madlan',icon:'M'},homeless:{name:'Homeless',cls:'src-homeless',icon:'H'},kones:{name:'\u05DB\u05D9\u05E0\u05D5\u05E1',cls:'src-kones',icon:'\u2696'},ai_scan:{name:'\u05E1\u05E8\u05D9\u05E7\u05EA AI',cls:'src-ai',icon:'\u2726'}};
function srcBadge(src){var ns=normSrc(src);var p=PLAT[ns]||{name:src||'?',cls:'src-other',icon:'\u25CE'};return'<span class="badge-src '+p.cls+'">'+p.icon+' '+p.name+'</span>';}

// Smart URL - construct search link if no direct URL
function smartUrl(l){
  if(l.url)return l.url;
  var city=encodeURIComponent(l.complex_city||l.city||'');
  var addr=encodeURIComponent(l.address||l.complex_name||'');
  var ns=normSrc(l.source);
  if(ns==='yad2')return'https://www.yad2.co.il/realestate/forsale?city='+city;
  if(ns==='madlan')return'https://www.madlan.co.il/for-sale/'+city;
  return'https://www.yad2.co.il/realestate/forsale?text='+addr;
}
function listingLink(l){
  var url=smartUrl(l);
  var isDirect=!!l.url;
  var label=isDirect?'\u05E6\u05E4\u05D4 \u05D1\u05DE\u05D5\u05D3\u05E2\u05D4':'\u05D7\u05E4\u05E9 \u05D1\u05D0\u05EA\u05E8';
  var cls=isDirect?'btn-link':'btn-link btn-link-search';
  return'<a href="'+url+'" target="_blank" rel="noopener" class="'+cls+'">'+(isDirect?'\u2197':'\uD83D\uDD0D')+' '+label+'</a>';
}

// --- Sorting ---
function sortData(arr,tabId,key,forcedDir){
  if(!sortStates[tabId])sortStates[tabId]={key:null,dir:-1};
  var st=sortStates[tabId];
  if(forcedDir){st.key=key;st.dir=forcedDir;}
  else if(st.key===key){st.dir=st.dir*-1;}
  else{st.key=key;st.dir=-1;}
  var sorted=arr.slice().sort(function(a,b){
    var av=a[key],bv=b[key];
    if(av==null)return 1;if(bv==null)return -1;
    var na=parseFloat(av),nb=parseFloat(bv);
    if(!isNaN(na)&&!isNaN(nb))return(na-nb)*st.dir;
    return String(av).localeCompare(String(bv),'he')*st.dir;
  });
  return sorted;
}
function sortArrow(tabId,key){if(!sortStates[tabId]||sortStates[tabId].key!==key)return'';return'<span class="sort-arrow">'+(sortStates[tabId].dir===-1?'\u25BC':'\u25B2')+'</span>';}
function thSorted(tabId,key){return(sortStates[tabId]&&sortStates[tabId].key===key)?' sorted':'';}

// --- Modal ---
function openModal(title,contentHtml){
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-content').innerHTML=contentHtml;
  document.getElementById('modal').classList.add('open');
}
function closeModal(){document.getElementById('modal').classList.remove('open');}

function openComplexModal(id,name){
  openModal(name||'...','\u05D8\u05D5\u05E2\u05DF \u05E4\u05E8\u05D8\u05D9 \u05DE\u05EA\u05D7\u05DD...');
  fetch('/api/dashboard/complex/'+id).then(function(r){return r.json();}).then(function(d){
    var c=d.complex,ls=d.listings||[],als=d.alerts||[];
    var h='';
    h+='<div class="modal-section"><div class="modal-section-title">\u05E4\u05E8\u05D8\u05D9 \u05DE\u05EA\u05D7\u05DD</div>';
    h+=mRow('\u05E2\u05D9\u05E8',c.city);
    h+=mRow('\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA',c.addresses);
    h+=mRow('\u05E1\u05D8\u05D8\u05D5\u05E1',c.status);
    h+=mRow('\u05D9\u05D6\u05DD',c.developer);
    h+=mRow('\u05EA\u05DB\u05E0\u05D9\u05EA',c.plan_number);
    h+=mRow('\u05D9\u05D7"\u05D3 \u05E7\u05D9\u05D9\u05DE\u05D5\u05EA',c.existing_units);
    h+=mRow('\u05D9\u05D7"\u05D3 \u05DE\u05EA\u05D5\u05DB\u05E0\u05E0\u05D5\u05EA',c.planned_units);
    h+=mRow('IAI',c.iai_score);
    h+=mRow('\u05E4\u05E8\u05DE\u05D9\u05D4',c.actual_premium?c.actual_premium+'%':'-');
    h+=mRow('\u05DB\u05D9\u05E0\u05D5\u05E1 \u05E0\u05DB\u05E1\u05D9\u05DD',c.is_receivership?'\u05DB\u05DF':'\u05DC\u05D0');
    h+='</div>';
    
    if(c.iai_score>=30||c.enhanced_ssi_score>=40){
      h+='<div class="modal-section"><div class="modal-section-title">\u05DC\u05DE\u05D4 \u05D6\u05D5 \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05EA?</div><div class="modal-factors">';
      if(c.iai_score>=70)h+='<div class="modal-factor">\u2B50 IAI \u05DE\u05E6\u05D5\u05D9\u05DF ('+c.iai_score+') - \u05E4\u05D5\u05D8\u05E0\u05E6\u05D9\u05D0\u05DC \u05D2\u05D1\u05D5\u05D4 \u05DC\u05E8\u05D5\u05D5\u05D7</div>';
      else if(c.iai_score>=50)h+='<div class="modal-factor">\u2605 IAI \u05D8\u05D5\u05D1 ('+c.iai_score+') - \u05E9\u05D5\u05D5\u05D4 \u05D1\u05D3\u05D9\u05E7\u05D4</div>';
      if(c.status==='approved')h+='<div class="modal-factor">\u2705 \u05EA\u05DB\u05E0\u05D9\u05EA \u05D0\u05D5\u05E9\u05E8\u05D4 - \u05E1\u05D9\u05DB\u05D5\u05DF \u05E0\u05DE\u05D5\u05DA \u05DC\u05D4\u05EA\u05E7\u05D3\u05DE\u05D5\u05EA</div>';
      if(c.is_receivership)h+='<div class="modal-factor">\u2696\uFE0F \u05DB\u05D9\u05E0\u05D5\u05E1 \u05E0\u05DB\u05E1\u05D9\u05DD - \u05D0\u05E4\u05E9\u05E8\u05D5\u05EA \u05DC\u05DE\u05D7\u05D9\u05E8 \u05DE\u05EA\u05D7\u05EA \u05DC\u05E9\u05D5\u05E7</div>';
      if(c.actual_premium&&parseFloat(c.actual_premium)>0)h+='<div class="modal-factor">\uD83D\uDCC8 \u05E4\u05E8\u05DE\u05D9\u05D4 '+c.actual_premium+'% - \u05E4\u05E2\u05E8 \u05D1\u05D9\u05DF \u05DE\u05D7\u05D9\u05E8 \u05E0\u05D5\u05DB\u05D7\u05D9 \u05DC\u05E9\u05D5\u05D5\u05D9 \u05E2\u05EA\u05D9\u05D3\u05D9</div>';
      var factors=pf(c.ssi_enhancement_factors||[]);
      factors.forEach(function(f){h+='<div class="modal-factor">'+f+'</div>';});
      h+='</div></div>';
    }
    
    if(ls.length){
      h+='<div class="modal-section"><div class="modal-section-title">\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05E4\u05E2\u05D9\u05DC\u05D5\u05EA ('+ls.length+')</div>';
      ls.forEach(function(l){
        h+='<div class="modal-listing"><div class="modal-listing-head">';
        h+=srcBadge(l.source);
        h+='<span style="font-weight:700;color:#06d6a0">'+(l.asking_price?fmtPrice(l.asking_price):'-')+'</span>';
        h+='</div><div class="modal-listing-details">';
        if(l.rooms)h+='<span>'+l.rooms+' \u05D7\u05D3\u05E8\u05D9\u05DD</span>';
        if(l.area_sqm)h+='<span>'+l.area_sqm+' \u05DE"\u05E8</span>';
        if(l.floor!=null)h+='<span>\u05E7\u05D5\u05DE\u05D4 '+l.floor+'</span>';
        if(l.days_on_market)h+='<span>'+l.days_on_market+' \u05D9\u05DE\u05D9\u05DD</span>';
        if(l.price_changes)h+='<span style="color:#ff4d6a">'+l.price_changes+' \u05D9\u05E8\u05D9\u05D3\u05D5\u05EA \u05DE\u05D7\u05D9\u05E8</span>';
        if(l.total_price_drop_percent&&parseFloat(l.total_price_drop_percent)>0)h+='<span style="color:#ff4d6a">\u05D9\u05E8\u05D9\u05D3\u05D4: '+parseFloat(l.total_price_drop_percent).toFixed(1)+'%</span>';
        h+='</div>';
        if(l.address)h+='<div style="font-size:11px;color:#4a5e80;margin-top:4px">'+l.address+'</div>';
        h+='<div style="margin-top:6px">'+listingLink(l)+'</div>';
        h+='</div>';
      });
      h+='</div>';
    }
    
    if(als.length){
      h+='<div class="modal-section"><div class="modal-section-title">\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05D0\u05D7\u05E8\u05D5\u05E0\u05D5\u05EA</div>';
      als.forEach(function(a){
        h+='<div style="padding:6px 0;border-bottom:1px solid rgba(26,39,68,.3);font-size:12px">'+dotH(a.severity)+' <span style="margin-right:6px">'+a.title+'</span><span class="xs dim">'+fmtD(a.created_at)+'</span></div>';
      });
      h+='</div>';
    }
    
    document.getElementById('modal-content').innerHTML=h;
  }).catch(function(e){
    document.getElementById('modal-content').innerHTML='<div style="color:#ff4d6a;padding:20px;text-align:center">\u05E9\u05D2\u05D9\u05D0\u05D4: '+e.message+'</div>';
  });
}

function openAlertModal(alert){
  var h='';
  h+='<div class="modal-section"><div class="modal-section-title">\u05E4\u05E8\u05D8\u05D9 \u05D4\u05EA\u05E8\u05D0\u05D4</div>';
  h+=mRow('\u05E1\u05D5\u05D2',alert.alert_type);
  h+=mRow('\u05D7\u05D5\u05DE\u05E8\u05D4',alert.severity);
  h+=mRow('\u05EA\u05D0\u05E8\u05D9\u05DA',fmtD(alert.created_at));
  h+=mRow('\u05DE\u05EA\u05D7\u05DD',alert.complex_name||'-');
  h+=mRow('\u05E2\u05D9\u05E8',alert.city||'-');
  h+='</div>';
  h+='<div class="modal-section"><div class="modal-section-title">\u05D4\u05D5\u05D3\u05E2\u05D4</div>';
  h+='<div style="font-size:13px;line-height:1.7;color:#e2e8f0">'+(alert.message||alert.title)+'</div></div>';
  if(alert.data){
    var ad=typeof alert.data==='string'?JSON.parse(alert.data):alert.data;
    if(ad.addresses)h+=mRow('\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA',ad.addresses);
    if(ad.source)h+=mRow('\u05DE\u05E7\u05D5\u05E8',ad.source);
  }
  if(alert.complex_id){
    h+='<div style="margin-top:14px"><button class="btn btn-ssi" data-cid="'+alert.complex_id+'" data-cname="'+((alert.complex_name||'').replace(/"/g,'&quot;'))+'" onclick="closeModal();openComplexModal(Number(this.dataset.cid),this.dataset.cname)">\u05E6\u05E4\u05D4 \u05D1\u05DE\u05EA\u05D7\u05DD</button></div>';
  }
  openModal(alert.title||'\u05D4\u05EA\u05E8\u05D0\u05D4',h);
}

function mRow(label,value){return'<div class="modal-row"><span class="modal-row-label">'+label+'</span><span class="modal-row-value">'+(value||'-')+'</span></div>';}

// --- Data loading ---
function loadData(){
  fetch('/api/ssi/dashboard-data').then(function(r){return r.json();}).then(function(data){
    D=data;
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('time-label').textContent=new Date().toLocaleTimeString('he-IL');
    var s=D.stats||{};
    document.getElementById('footer-text').textContent='QUANTUM v4.24.0 | '+(s.total_complexes||0)+' \u05DE\u05EA\u05D7\u05DE\u05D9\u05DD | '+(s.cities||0)+' \u05E2\u05E8\u05D9\u05DD';
    renderNav();renderTab();
  }).catch(function(e){
    console.error(e);
    document.getElementById('loading').innerHTML='<div class="loading-logo-wrap"><img src="/api/dashboard/logo.png" class="loading-logo" alt="Q" style="animation:none;filter:grayscale(1) opacity(0.5)"><div class="orbit-ring" style="animation:none;border-color:rgba(255,77,106,0.3)"></div></div><div style="color:#ff4d6a;font-size:14px;text-align:center">\u05E9\u05D2\u05D9\u05D0\u05D4</div><button class="btn" data-action="refresh" style="margin-top:8px">\u05E0\u05E1\u05D4</button>';
  });
}
function loadListings(){
  fetch('/api/dashboard/listings?limit=500').then(function(r){return r.json();}).then(function(data){
    LD=data;renderNav();renderTab();
  }).catch(function(e){console.error(e);});
}
function runSSI(){
  if(aggRunning)return;aggRunning=true;
  var btn=document.getElementById('btn-ssi');btn.textContent='...SSI';btn.classList.add('loading');
  fetch('/api/ssi/batch-aggregate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"minListings":1,"limit":500}'})
    .then(function(){return new Promise(function(r){setTimeout(r,3000);});})
    .then(function(){return loadData();})
    .catch(function(e){console.error(e);})
    .finally(function(){aggRunning=false;btn.textContent='SSI';btn.classList.remove('loading');});
}

// --- Navigation ---
var tabs=[
  {id:'overview',l:'\u05E1\u05E7\u05D9\u05E8\u05D4'},
  {id:'listings',l:'\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA'},
  {id:'ssi',l:'\u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DC\u05D7\u05D5\u05E6\u05D9\u05DD'},
  {id:'opp',l:'\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA'},
  {id:'cities',l:'\u05E2\u05E8\u05D9\u05DD'},
  {id:'alerts',l:'\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA'}
];
function renderNav(){
  var h='';
  for(var i=0;i<tabs.length;i++){
    var cnt='';
    if(tabs[i].id==='listings'&&LD)cnt='<span class="cnt-badge">'+LD.total+'</span>';
    if(tabs[i].id==='alerts'&&D&&D.recentAlerts)cnt='<span class="cnt-badge">'+D.recentAlerts.length+'</span>';
    h+='<button class="nav-btn'+(tabs[i].id===currentTab?' active':'')+'" data-tab="'+tabs[i].id+'">'+tabs[i].l+cnt+'</button>';
  }
  document.getElementById('nav').innerHTML=h;
}
function switchTab(id){currentTab=id;if(id==='listings'&&!LD)loadListings();renderNav();renderTab();}
function renderTab(){
  var m=document.getElementById('main');if(!D){m.innerHTML='';return;}
  var s=D.stats||{},dist=D.ssiDistribution||{},topSSI=D.topSSI||[],topIAI=D.topIAI||[],alerts=D.recentAlerts||[],cities=D.cityBreakdown||[],ls=D.listingStats||{};
  if(currentTab==='overview')m.innerHTML=renderOverview(s,dist,topSSI,alerts,cities,ls);
  else if(currentTab==='listings')m.innerHTML=renderListings();
  else if(currentTab==='ssi')m.innerHTML=renderSSITab(s,dist,topSSI);
  else if(currentTab==='opp')m.innerHTML=renderOpp(s,topIAI);
  else if(currentTab==='cities')m.innerHTML=renderCities(s,cities);
  else if(currentTab==='alerts')m.innerHTML=renderAlerts(alerts);
}
function statCard(label,val,sub,color,icon){return'<div class="stat"><div class="stat-icon">'+icon+'</div><div class="stat-label">'+label+'</div><div class="stat-val" style="color:'+color+'">'+(val!=null?val:'-')+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';}
function panelH(title,sub,icon){return'<div class="panel-head">'+(icon?'<span class="panel-head-icon">'+icon+'</span>':'')+'<div><h2 class="panel-title">'+title+'</h2>'+(sub?'<p class="panel-sub">'+sub+'</p>':'')+'</div></div>';}

// ==================== LISTINGS ====================
function renderListings(){
  if(!LD)return'<div class="tab-content"><div class="empty-msg" style="padding:40px">\u05D8\u05D5\u05E2\u05DF \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA...</div></div>';
  var listings=LD.listings||[],cities=LD.cities||[],sources=LD.sources||[];
  var fs=filterStates.listings||{};
  var filtered=listings.filter(function(l){
    if(fs.city&&(l.complex_city||'')!==fs.city)return false;
    if(fs.source&&normSrc(l.source)!==fs.source)return false;
    if(fs.minRooms&&parseFloat(l.rooms||0)<parseFloat(fs.minRooms))return false;
    if(fs.maxRooms&&parseFloat(l.rooms||0)>parseFloat(fs.maxRooms))return false;
    if(fs.minPrice&&parseFloat(l.asking_price||0)<parseFloat(fs.minPrice))return false;
    if(fs.maxPrice&&parseFloat(l.asking_price||0)>parseFloat(fs.maxPrice))return false;
    if(fs.minArea&&parseFloat(l.area_sqm||0)<parseFloat(fs.minArea))return false;
    if(fs.maxArea&&parseFloat(l.area_sqm||0)>parseFloat(fs.maxArea))return false;
    if(fs.minFloor&&parseInt(l.floor||0)<parseInt(fs.minFloor))return false;
    if(fs.maxFloor&&parseInt(l.floor||0)>parseInt(fs.maxFloor))return false;
    if(fs.complex&&!(l.complex_name||'').includes(fs.complex))return false;
    return true;
  });
  if(sortStates.listings&&sortStates.listings.key)filtered=sortData(filtered,'listings',sortStates.listings.key,sortStates.listings.dir);

  var h='<div class="tab-content">';
  h+='<div class="section-note"><strong>\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA</strong> - \u05DB\u05DC \u05D4\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05D4\u05E4\u05E2\u05D9\u05DC\u05D5\u05EA \u05E9\u05E0\u05DE\u05E6\u05D0\u05D5 \u05D1\u05DE\u05EA\u05D7\u05DE\u05D9 \u05E4\u05D9\u05E0\u05D5\u05D9-\u05D1\u05D9\u05E0\u05D5\u05D9. \u05DC\u05D7\u05E5 \u05E2\u05DC \u05E9\u05D5\u05E8\u05D4 \u05DC\u05E6\u05E4\u05D9\u05D9\u05D4 \u05D1\u05DE\u05D5\u05D3\u05E2\u05D4 \u05D4\u05DE\u05E7\u05D5\u05E8\u05D9\u05EA. <strong>\u05E1\u05E8\u05D9\u05E7\u05EA AI</strong> = \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05E9\u05E0\u05DE\u05E6\u05D0\u05D5 \u05E2"\u05D9 \u05E1\u05E8\u05D9\u05E7\u05D4 \u05D7\u05DB\u05DE\u05D4 \u05D5\u05DC\u05D0 \u05DE\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D4 \u05D9\u05E9\u05D9\u05E8\u05D4.</div>';

  h+='<div class="grid grid-4">';
  h+=statCard('\u05E1\u05D4"\u05DB',filtered.length,LD.total+' \u05E1\u05D4"\u05DB','#06d6a0','\u25A4');
  var urgCnt=filtered.filter(function(l){return l.has_urgent_keywords;}).length;
  h+=statCard('\u05D3\u05D7\u05D5\u05E4\u05D5\u05EA',urgCnt,'','#ff4d6a','!');
  var srcCounts={};filtered.forEach(function(l){var ns=normSrc(l.source);srcCounts[ns]=(srcCounts[ns]||0)+1;});
  var topSrc=Object.keys(srcCounts).sort(function(a,b){return srcCounts[b]-srcCounts[a];});
  h+=statCard('\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D5\u05EA',topSrc.length,topSrc.map(function(s){return(PLAT[s]?PLAT[s].name:s)+':'+srcCounts[s];}).join(', '),'#3b82f6','\u25CE');
  var avgPPM=0,ppmC=0;filtered.forEach(function(l){if(l.price_per_sqm){avgPPM+=parseFloat(l.price_per_sqm);ppmC++;}});
  h+=statCard('\u05DE\u05D7\u05D9\u05E8/\u05DE"\u05E8',ppmC?fmtN(Math.round(avgPPM/ppmC)):'-','\u05DE\u05DE\u05D5\u05E6\u05E2','#ffc233','\u20AA');
  h+='</div>';

  h+='<div class="panel"><div class="filter-row">';
  h+='<span class="filter-label">\u05E2\u05D9\u05E8:</span><select data-filter="listings-city"><option value="">\u05DB\u05DC</option>';
  cities.forEach(function(c){h+='<option value="'+c+'"'+(fs.city===c?' selected':'')+'>'+c+'</option>';});
  h+='</select>';
  h+='<span class="filter-label">\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D4:</span><select data-filter="listings-source"><option value="">\u05DB\u05DC</option>';
  var uSrc={};sources.forEach(function(s){var ns=normSrc(s);uSrc[ns]=1;});
  Object.keys(uSrc).forEach(function(ns){h+='<option value="'+ns+'"'+(fs.source===ns?' selected':'')+'>'+(PLAT[ns]?PLAT[ns].name:ns)+'</option>';});
  h+='</select>';
  h+='<span class="filter-label">\u05D7\u05D3\u05E8\u05D9\u05DD:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minRooms" value="'+(fs.minRooms||'')+'" style="width:55px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxRooms" value="'+(fs.maxRooms||'')+'" style="width:55px">';
  h+='<span class="filter-label">\u05DE\u05D7\u05D9\u05E8:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minPrice" value="'+(fs.minPrice||'')+'" step="100000" style="width:80px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxPrice" value="'+(fs.maxPrice||'')+'" step="100000" style="width:80px">';
  h+='<span class="filter-label">\u05DE\u05EA\u05D7\u05DD:</span>';
  h+='<input type="text" placeholder="\u05D7\u05D9\u05E4\u05D5\u05E9..." data-filter="listings-complex" value="'+(fs.complex||'')+'" style="width:100px">';
  h+='</div>';

  h+='<div class="overflow-x"><table><thead><tr>';
  h+='<th class="cb-cell"><input type="checkbox" id="cb-all" title="\u05D1\u05D7\u05E8 \u05D4\u05DB\u05DC"></th>';
  var cols=[{k:'source',l:'\u05DE\u05E7\u05D5\u05E8',c:true},{k:'complex_city',l:'\u05E2\u05D9\u05E8'},{k:'complex_name',l:'\u05DE\u05EA\u05D7\u05DD'},{k:'rooms',l:'\u05D7\u05D3\u05E8\u05D9\u05DD',c:true},{k:'area_sqm',l:'\u05E9\u05D8\u05D7',c:true},{k:'floor',l:'\u05E7\u05D5\u05DE\u05D4',c:true},{k:'asking_price',l:'\u05DE\u05D7\u05D9\u05E8',c:true},{k:'days_on_market',l:'\u05D9\u05DE\u05D9\u05DD',c:true},{k:'price_changes',l:'\u05D9\u05E8\u05D9\u05D3\u05D5\u05EA',c:true},{k:'message_status',l:'\u05D4\u05D5\u05D3\u05E2\u05D4',c:true},{k:'_link',l:'\u05E7\u05D9\u05E9\u05D5\u05E8',c:true}];
  for(var i=0;i<cols.length;i++){var col=cols[i];h+='<th class="'+(col.c?'c ':'')+thSorted('listings',col.k)+'" data-sort-tab="listings" data-sort-key="'+col.k+'">'+sortArrow('listings',col.k)+col.l+'</th>';}
  h+='</tr></thead><tbody>';
  if(!filtered.length)h+='<tr><td colspan="'+(cols.length+1)+'" class="empty-msg">\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D5</td></tr>';
  else for(var i=0;i<filtered.length;i++){
    var l=filtered[i];
    var isSent=l.message_status&&l.message_status!=='\u05DC\u05D0 \u05E0\u05E9\u05DC\u05D7\u05D4';
    var isChecked=selectedListings.has(l.id);
    h+='<tr class="clickable'+(isSent?' msg-sent':'')+'" data-listing-url="'+smartUrl(l)+'" data-lid="'+l.id+'">';
    h+='<td class="cb-cell" data-no-modal="1"><input type="checkbox" class="listing-cb" data-lid="'+l.id+'"'+(isChecked?' checked':'')+'></td>';
    h+='<td class="c">'+srcBadge(l.source)+'</td>';
    h+='<td class="nw">'+(l.complex_city||'-')+'</td>';
    h+='<td class="f6">'+cut(l.complex_name,25)+'</td>';
    h+='<td class="c">'+(l.rooms||'-')+'</td>';
    h+='<td class="c">'+(l.area_sqm?fmtN(l.area_sqm):'-')+'</td>';
    h+='<td class="c">'+(l.floor!=null?l.floor:'-')+'</td>';
    h+='<td class="c nw fw" style="color:#06d6a0">'+(l.asking_price?'\u20AA'+fmtP(l.asking_price):'-')+'</td>';
    h+='<td class="c">'+(l.days_on_market||'-')+'</td>';
    h+='<td class="c">'+(l.price_changes?'<span style="color:#ff4d6a;font-weight:700">'+l.price_changes+'</span>':'-')+'</td>';
    h+='<td class="c">'+(isSent?'<span class="badge-msg badge-msg-sent">\u2713 \u05E0\u05E9\u05DC\u05D7\u05D4</span>':'<span class="badge-msg badge-msg-pending">\u05D8\u05E8\u05DD</span>')+'</td>';
    h+='<td class="c">'+listingLink(l)+'</td>';
    h+='</tr>';
  }
  h+='</tbody></table></div>';
  // Message action bar
  if(selectedListings.size>0){
    h+='<div class="msg-bar"><div class="msg-bar-info"><span class="msg-bar-count">'+selectedListings.size+'</span> \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05E0\u05D1\u05D7\u05E8\u05D5</div><div class="msg-bar-btns"><button class="btn-msg btn-msg-clear" data-action="clear-selection">\u05E0\u05E7\u05D4 \u05D1\u05D7\u05D9\u05E8\u05D4</button><button class="btn-msg btn-msg-send" data-action="open-tmpl">\u2709 \u05E9\u05DC\u05D7 \u05D4\u05D5\u05D3\u05E2\u05D4</button></div></div>';
  }
  h+='</div></div>';
  return h;
}


// ==================== OVERVIEW ====================
function renderOverview(s,dist,topSSI,alerts,cities,ls){
  var h='<div class="tab-content"><div class="grid grid-6">';
  h+=statCard('\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD',s.total_complexes,s.cities+' \u05E2\u05E8\u05D9\u05DD','#06d6a0','Q');
  h+=statCard('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA',s.opportunities,s.excellent+' \u05DE\u05E6\u05D5\u05D9\u05E0\u05D5\u05EA (70+)','#ffc233','\u2605');
  h+=statCard('\u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DC\u05D7\u05D5\u05E6\u05D9\u05DD',s.stressed_sellers,s.high_stress+' \u05D1\u05E8\u05DE\u05D4 \u05D2\u05D1\u05D5\u05D4\u05D4','#ff4d6a','!');
  h+=statCard('\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA',ls.active||'0',(ls.urgent||'0')+' \u05D3\u05D7\u05D5\u05E4\u05D5\u05EA','#22c55e','\u25A4');
  h+=statCard('\u05DB\u05D9\u05E0\u05D5\u05E1\u05D9\u05DD',(D.konesStats||{}).total||'0','','#9f7aea','\u2696');
  h+=statCard('IAI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_iai||'-','','#3b82f6','\u25B3');
  h+='</div>';

  var goldOpp=topSSI.filter(function(x){return x.iai_score>=40;}).slice(0,5);
  if(goldOpp.length>0){
    h+='<div class="panel panel-gold">'+panelH('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05D6\u05D4\u05D1','\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD \u05E2\u05DD IAI \u05D2\u05D1\u05D5\u05D4 + \u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DC\u05D7\u05D5\u05E6\u05D9\u05DD. \u05DC\u05D7\u05E5 \u05DC\u05E4\u05E8\u05D8\u05D9\u05DD.','\u25C6');
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c">SSI</th><th class="c">IAI</th><th>\u05DE\u05EA\u05D7\u05DD</th><th>\u05E2\u05D9\u05E8</th><th>\u05D2\u05D5\u05E8\u05DE\u05D9\u05DD</th></tr></thead><tbody>';
    for(var i=0;i<goldOpp.length;i++){
      var r=goldOpp[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(' | ');
      h+='<tr class="clickable" data-complex-id="'+r.id+'" data-complex-name="'+((r.name||'').replace(/"/g,'&quot;'))+'">';
      h+='<td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td>';
      h+='<td class="c nw">'+iaiH(r.iai_score)+'</td>';
      h+='<td class="fw">'+cut(r.name||r.addresses,40)+'</td>';
      h+='<td class="nw">'+(r.city||'-')+'</td>';
      h+='<td class="xs muted">'+(f||'-')+'</td></tr>';
    }
    h+='</tbody></table></div></div>';
  }

  h+='<div class="grid grid-2">';
  h+='<div class="panel">'+panelH('\u05D4\u05EA\u05E4\u05DC\u05D2\u05D5\u05EA SSI','','\u25C9')+'<div class="pie-legend">';
  var di=[{l:'\u05D2\u05D1\u05D5\u05D4 (60+)',v:+(dist.high||0)+ +(dist.critical||0),c:'#ff4d6a'},{l:'\u05D1\u05D9\u05E0\u05D5\u05E0\u05D9 (40-59)',v:+(dist.medium||0),c:'#ff8c42'},{l:'\u05E0\u05DE\u05D5\u05DA (20-39)',v:+(dist.low||0),c:'#ffc233'},{l:'\u05DE\u05D6\u05E2\u05E8\u05D9 (<20)',v:+(dist.minimal||0),c:'#4a5e80'}];
  for(var i=0;i<di.length;i++){h+='<div class="pie-row"><div class="pie-info"><div class="pie-dot" style="background:'+di[i].c+'"></div><span class="sm muted">'+di[i].l+'</span></div><span style="font-weight:700;color:'+di[i].c+';font-size:14px">'+di[i].v+'</span></div>';}
  h+='</div></div>';
  h+='<div class="panel">'+panelH('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05DC\u05E4\u05D9 \u05E2\u05D9\u05E8','','\u25A3');
  var ct=cities.slice(0,10),mx=1;for(var i=0;i<ct.length;i++){if(+ct[i].opportunities>mx)mx=+ct[i].opportunities;}
  h+='<div class="bar-chart">';for(var i=0;i<ct.length;i++){var pct=Math.round((+ct[i].opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+ct[i].city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:#06d6a0"></div></div><span class="bar-val">'+ct[i].opportunities+'</span></div>';}
  h+='</div></div></div></div>';
  return h;
}

// ==================== SSI ====================
function renderSSITab(s,dist,topSSI){
  var h='<div class="tab-content">';
  h+='<div class="section-note"><strong>\u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DC\u05D7\u05D5\u05E6\u05D9\u05DD (SSI)</strong> - \u05DE\u05EA\u05D7\u05DE\u05D9\u05DD \u05E9\u05D1\u05D4\u05DD \u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DE\u05E6\u05D9\u05D2\u05D9\u05DD \u05E1\u05D9\u05DE\u05E0\u05D9 <strong>\u05DC\u05D7\u05E5 \u05DC\u05DE\u05DB\u05D5\u05E8</strong>: \u05D6\u05DE\u05DF \u05E8\u05D1 \u05D1\u05E9\u05D5\u05E7, \u05D9\u05E8\u05D9\u05D3\u05D5\u05EA \u05DE\u05D7\u05D9\u05E8 \u05D7\u05D5\u05D6\u05E8\u05D5\u05EA, \u05DE\u05D9\u05DC\u05D5\u05EA \u05DE\u05E4\u05EA\u05D7 \u05DB\u05DE\u05D5 "\u05D3\u05D7\u05D5\u05E3" \u05D0\u05D5 "\u05DE\u05D5\u05DB\u05E8\u05D7 \u05DC\u05DE\u05DB\u05D5\u05E8". \u05DB\u05D0\u05DF \u05D9\u05E9 \u05E4\u05D5\u05D8\u05E0\u05E6\u05D9\u05D0\u05DC \u05DC\u05DE\u05E9\u05D0 \u05D5\u05DE\u05EA\u05DF \u05DE\u05EA\u05D7\u05EA \u05DC\u05E9\u05D5\u05E7. \u05DC\u05D7\u05E5 \u05DC\u05E4\u05E8\u05D8\u05D9\u05DD.</div>';
  h+='<div class="grid grid-4">';
  h+=statCard('\u05DC\u05D7\u05E5 \u05D2\u05D1\u05D5\u05D4',+(dist.high||0)+ +(dist.critical||0),'','#ff4d6a','!');
  h+=statCard('\u05DC\u05D7\u05E5 \u05D1\u05D9\u05E0\u05D5\u05E0\u05D9',dist.medium||'0','','#ff8c42','\u25B2');
  h+=statCard('\u05DC\u05D7\u05E5 \u05E0\u05DE\u05D5\u05DA',dist.low||'0','','#ffc233','\u25B3');
  h+=statCard('SSI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_ssi||'-','','#06d6a0','\u25CE');
  h+='</div><div class="panel">'+panelH('\u05D3\u05D9\u05E8\u05D5\u05D2 SSI - \u05DE\u05D3\u05D3 \u05DC\u05D7\u05E5 \u05DE\u05D5\u05DB\u05E8\u05D9\u05DD','\u05DB\u05DB\u05DC \u05E9\u05D4\u05E6\u05D9\u05D5\u05DF \u05D2\u05D1\u05D5\u05D4 \u05D9\u05D5\u05EA\u05E8, \u05D4\u05DE\u05D5\u05DB\u05E8 \u05DC\u05D7\u05D5\u05E5 \u05D9\u05D5\u05EA\u05E8 - \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05EA \u05DC\u05DE\u05D5"\u05DE','\u26A1');
  if(!topSSI.length)h+='<div class="empty-msg">\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D5</div>';
  else{
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c">#</th><th class="c" data-sort-tab="ssi" data-sort-key="enhanced_ssi_score">'+sortArrow('ssi','enhanced_ssi_score')+'SSI</th>';
    h+='<th data-sort-tab="ssi" data-sort-key="name">'+sortArrow('ssi','name')+'\u05DE\u05EA\u05D7\u05DD</th>';
    h+='<th data-sort-tab="ssi" data-sort-key="city">'+sortArrow('ssi','city')+'\u05E2\u05D9\u05E8</th>';
    h+='<th class="c" data-sort-tab="ssi" data-sort-key="iai_score">'+sortArrow('ssi','iai_score')+'IAI</th>';
    h+='<th data-sort-tab="ssi" data-sort-key="status">'+sortArrow('ssi','status')+'\u05E1\u05D8\u05D8\u05D5\u05E1</th>';
    h+='<th>\u05D2\u05D5\u05E8\u05DE\u05D9\u05DD</th></tr></thead><tbody>';
    var sorted=topSSI.map(function(r,i){r._idx=i+1;return r;});
    if(sortStates.ssi&&sortStates.ssi.key)sorted=sortData(sorted,'ssi',sortStates.ssi.key,sortStates.ssi.dir);
    for(var i=0;i<sorted.length;i++){
      var r=sorted[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(' | ');
      h+='<tr class="clickable" data-complex-id="'+r.id+'" data-complex-name="'+((r.name||'').replace(/"/g,'&quot;'))+'">';
      h+='<td class="c xs dim">'+r._idx+'</td><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td><td class="f6">'+cut(r.name||r.addresses,42)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td><td class="xs muted">'+(f||'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';return h;
}

// ==================== OPPORTUNITIES ====================
function renderOpp(s,topIAI){
  var h='<div class="tab-content">';
  h+='<div class="section-note"><strong>\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05D4\u05E9\u05E7\u05E2\u05D4 (IAI)</strong> - \u05DE\u05EA\u05D7\u05DE\u05D9\u05DD \u05E2\u05DD \u05E4\u05D5\u05D8\u05E0\u05E6\u05D9\u05D0\u05DC \u05D4\u05E9\u05E7\u05E2\u05D4 \u05D2\u05D1\u05D5\u05D4 \u05DC\u05E4\u05D9 \u05E9\u05DC\u05D1 \u05D4\u05EA\u05DB\u05E0\u05D9\u05EA, \u05E4\u05E8\u05DE\u05D9\u05D4 \u05D1\u05D9\u05DF \u05DE\u05D7\u05D9\u05E8 \u05E0\u05D5\u05DB\u05D7\u05D9 \u05DC\u05E2\u05EA\u05D9\u05D3\u05D9, \u05D5\u05D0\u05D9\u05DB\u05D5\u05EA \u05D4\u05D9\u05D6\u05DD. \u05DC\u05D7\u05E5 \u05DC\u05E4\u05E8\u05D8\u05D9\u05DD.</div>';
  h+='<div class="grid grid-3">';
  h+=statCard('\u05E1\u05D4"\u05DB',s.opportunities,'IAI 30+','#ffc233','\u2605');
  h+=statCard('\u05DE\u05E6\u05D5\u05D9\u05E0\u05D5\u05EA',s.excellent,'IAI 70+','#22c55e','\u25C6');
  h+=statCard('IAI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_iai||'-','','#06d6a0','\u25B3');
  h+='</div><div class="panel">'+panelH('\u05D8\u05D5\u05E4 \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA','\u05DC\u05D7\u05E5 \u05E2\u05DC \u05E9\u05D5\u05E8\u05D4 \u05DC\u05E6\u05E4\u05D9\u05D9\u05D4 \u05D1\u05DE\u05EA\u05D7\u05DD','\u2605');
  h+='<div class="overflow-x"><table><thead><tr>';
  h+='<th class="c">#</th><th class="c" data-sort-tab="opp" data-sort-key="iai_score">'+sortArrow('opp','iai_score')+'IAI</th>';
  h+='<th data-sort-tab="opp" data-sort-key="name">'+sortArrow('opp','name')+'\u05DE\u05EA\u05D7\u05DD</th>';
  h+='<th data-sort-tab="opp" data-sort-key="city">'+sortArrow('opp','city')+'\u05E2\u05D9\u05E8</th>';
  h+='<th class="c" data-sort-tab="opp" data-sort-key="enhanced_ssi_score">'+sortArrow('opp','enhanced_ssi_score')+'SSI</th>';
  h+='<th data-sort-tab="opp" data-sort-key="developer">'+sortArrow('opp','developer')+'\u05D9\u05D6\u05DD</th>';
  h+='<th data-sort-tab="opp" data-sort-key="status">'+sortArrow('opp','status')+'\u05E1\u05D8\u05D8\u05D5\u05E1</th>';
  h+='</tr></thead><tbody>';
  var sorted=topIAI.map(function(r,i){r._idx=i+1;return r;});
  if(sortStates.opp&&sortStates.opp.key)sorted=sortData(sorted,'opp',sortStates.opp.key,sortStates.opp.dir);
  for(var i=0;i<sorted.length;i++){
    var r=sorted[i];
    h+='<tr class="clickable" data-complex-id="'+r.id+'" data-complex-name="'+((r.name||'').replace(/"/g,'&quot;'))+'">';
    h+='<td class="c xs dim">'+r._idx+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="f6">'+cut(r.name||r.addresses,45)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+(r.enhanced_ssi_score?'<span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span>':'<span class="dim">-</span>')+'</td><td class="sm muted nw">'+cut(r.developer,20)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td></tr>';
  }
  h+='</tbody></table></div></div></div>';return h;
}

// ==================== CITIES ====================
function renderCities(s,cities){
  var h='<div class="tab-content"><div class="panel">'+panelH('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05DC\u05E4\u05D9 \u05E2\u05E8\u05D9\u05DD',(s.cities||0)+' \u05E2\u05E8\u05D9\u05DD','\u25A3');
  var t10=cities.slice(0,10),mx=1;for(var i=0;i<t10.length;i++){if(+t10[i].total>mx)mx=+t10[i].total;}
  h+='<div class="bar-chart">';for(var i=0;i<t10.length;i++){var c=t10[i],p=Math.round((+c.opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+c.city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+p+'%;background:#06d6a0"></div></div><span class="bar-val">'+c.opportunities+'/'+c.total+'</span></div>';}
  h+='</div></div>';
  h+='<div class="panel"><div class="overflow-x"><table><thead><tr>';
  h+='<th data-sort-tab="cities" data-sort-key="city">'+sortArrow('cities','city')+'\u05E2\u05D9\u05E8</th>';
  h+='<th class="c" data-sort-tab="cities" data-sort-key="total">'+sortArrow('cities','total')+'\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD</th>';
  h+='<th class="c" data-sort-tab="cities" data-sort-key="opportunities">'+sortArrow('cities','opportunities')+'\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA</th>';
  h+='<th class="c" data-sort-tab="cities" data-sort-key="stressed">'+sortArrow('cities','stressed')+'\u05DC\u05D7\u05D5\u05E6\u05D9\u05DD</th>';
  h+='<th class="c" data-sort-tab="cities" data-sort-key="avg_iai">'+sortArrow('cities','avg_iai')+'IAI</th>';
  h+='</tr></thead><tbody>';
  var sorted=cities.slice();if(sortStates.cities&&sortStates.cities.key)sorted=sortData(sorted,'cities',sortStates.cities.key,sortStates.cities.dir);
  for(var i=0;i<sorted.length;i++){var c=sorted[i];h+='<tr><td class="fw">'+c.city+'</td><td class="c">'+c.total+'</td><td class="c" style="color:#06d6a0;font-weight:700">'+c.opportunities+'</td><td class="c">'+(+c.stressed>0?'<span style="color:#ff4d6a;font-weight:700">'+c.stressed+'</span>':'<span class="dim">0</span>')+'</td><td class="c" style="color:'+(+c.avg_iai>=50?'#22c55e':'#8899b4')+'">'+( c.avg_iai||'-')+'</td></tr>';}
  h+='</tbody></table></div></div></div>';return h;
}

// ==================== ALERTS ====================
function renderAlerts(alerts){
  var h='<div class="tab-content">';
  h+='<div class="section-note"><strong>\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA</strong> - \u05E9\u05D9\u05E0\u05D5\u05D9\u05D9\u05DD \u05D7\u05E9\u05D5\u05D1\u05D9\u05DD \u05E9\u05D4\u05DE\u05E2\u05E8\u05DB\u05EA \u05D6\u05D9\u05D4\u05EA\u05D4: \u05DE\u05EA\u05D7\u05DE\u05D9\u05DD \u05D7\u05D3\u05E9\u05D9\u05DD, \u05E9\u05D9\u05E0\u05D5\u05D9\u05D9 \u05E1\u05D8\u05D8\u05D5\u05E1, \u05D9\u05E8\u05D9\u05D3\u05D5\u05EA \u05DE\u05D7\u05D9\u05E8, \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05D7\u05D3\u05E9\u05D5\u05EA. \u05DC\u05D7\u05E5 \u05DC\u05E4\u05E8\u05D8\u05D9\u05DD.</div>';
  h+='<div class="panel">'+panelH('\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05D0\u05D7\u05E8\u05D5\u05E0\u05D5\u05EA','','\u25CF');
  if(!alerts.length)h+='<div class="empty-msg">\u05D0\u05D9\u05DF \u05D4\u05EA\u05E8\u05D0\u05D5\u05EA</div>';
  else{
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c"> </th><th data-sort-tab="alerts" data-sort-key="title">'+sortArrow('alerts','title')+'\u05DB\u05D5\u05EA\u05E8\u05EA</th>';
    h+='<th data-sort-tab="alerts" data-sort-key="complex_name">'+sortArrow('alerts','complex_name')+'\u05DE\u05EA\u05D7\u05DD</th>';
    h+='<th data-sort-tab="alerts" data-sort-key="city">'+sortArrow('alerts','city')+'\u05E2\u05D9\u05E8</th>';
    h+='<th data-sort-tab="alerts" data-sort-key="alert_type">'+sortArrow('alerts','alert_type')+'\u05E1\u05D5\u05D2</th>';
    h+='<th data-sort-tab="alerts" data-sort-key="created_at">'+sortArrow('alerts','created_at')+'\u05EA\u05D0\u05E8\u05D9\u05DA</th>';
    h+='</tr></thead><tbody>';
    var sorted=alerts.slice();if(sortStates.alerts&&sortStates.alerts.key)sorted=sortData(sorted,'alerts',sortStates.alerts.key,sortStates.alerts.dir);
    for(var i=0;i<sorted.length;i++){
      var a=sorted[i];
      h+='<tr class="clickable" data-alert-idx="'+i+'">';
      h+='<td class="c">'+dotH(a.severity)+'</td><td class="sm f6">'+cut(a.title,55)+'</td><td class="sm muted nw">'+(a.complex_name||'-')+'</td><td class="sm nw">'+(a.city||'-')+'</td><td class="xs dim nw">'+(a.alert_type||'-')+'</td><td class="xs dim nw">'+(a.created_at?fmtD(a.created_at):'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';return h;
}

// ==================== TEMPLATE MODAL ====================
var selectedTmpl=null;
function openTmplModal(){
  var h='';
  for(var i=0;i<msgTemplates.length;i++){
    var t=msgTemplates[i];
    h+='<div class="tmpl-card" data-tmpl-id="'+t.id+'">';
    h+='<div class="tmpl-card-title">\u2709 '+t.title+'</div>';
    h+='<div class="tmpl-card-body">'+t.body+'</div>';
    h+='</div>';
  }
  h+='<div class="tmpl-card" data-tmpl-id="custom">';
  h+='<div class="tmpl-card-title">\u270F\uFE0F \u05D4\u05D5\u05D3\u05E2\u05D4 \u05D7\u05D5\u05E4\u05E9\u05D9\u05EA</div>';
  h+='<textarea class="tmpl-edit-area" id="custom-msg" placeholder="\u05DB\u05EA\u05D5\u05D1 \u05D0\u05EA \u05D4\u05D4\u05D5\u05D3\u05E2\u05D4 \u05E9\u05DC\u05DA..."></textarea>';
  h+='</div>';
  document.getElementById('tmpl-content').innerHTML=h;
  document.getElementById('tmpl-counter').textContent=selectedListings.size+' \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA \u05E0\u05D1\u05D7\u05E8\u05D5';
  document.getElementById('tmpl-send').disabled=true;
  selectedTmpl=null;
  document.getElementById('tmpl-modal').classList.add('open');
}
function closeTmplModal(){document.getElementById('tmpl-modal').classList.remove('open');}

function getSelectedMsg(){
  if(!selectedTmpl)return null;
  if(selectedTmpl==='custom'){
    var el=document.getElementById('custom-msg');
    return el?el.value.trim():'';
  }
  var t=msgTemplates.find(function(t){return t.id===selectedTmpl;});
  return t?t.body:'';
}

function executeBulkSend(){
  var msg=getSelectedMsg();
  if(!msg||!selectedListings.size)return;
  // Copy message to clipboard
  navigator.clipboard.writeText(msg).catch(function(){});
  // Get selected listing URLs
  var listings=LD?LD.listings:[];
  var urls=[];
  selectedListings.forEach(function(lid){
    var l=listings.find(function(x){return x.id===lid;});
    if(l)urls.push(smartUrl(l));
  });
  // Open URLs (max 10 at once to avoid popup blocking)
  var toOpen=urls.slice(0,10);
  for(var i=0;i<toOpen.length;i++){
    setTimeout(function(u){window.open(u,'_blank');},i*600,toOpen[i]);
  }
  // Report status to server
  fetch('/api/dashboard/listings/message-sent',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({listing_ids:Array.from(selectedListings),template:selectedTmpl,message:msg})
  }).then(function(r){return r.json();}).then(function(d){
    // Update local data
    if(LD&&LD.listings){
      LD.listings.forEach(function(l){
        if(selectedListings.has(l.id)){l.message_status='\u05E0\u05E9\u05DC\u05D7\u05D4';}
      });
    }
    selectedListings.clear();
    closeTmplModal();
    renderTab();
  }).catch(function(e){console.error(e);closeTmplModal();});
  // Show progress
  document.getElementById('tmpl-send').textContent='\u05E0\u05E9\u05DC\u05D7... ('+urls.length+' \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA)';
  document.getElementById('tmpl-send').disabled=true;
  if(urls.length>10){
    document.getElementById('tmpl-counter').textContent='\u26A0 \u05E0\u05E4\u05EA\u05D7\u05D5 10 \u05DE\u05EA\u05D5\u05DA '+urls.length+'. \u05D4\u05D4\u05D5\u05D3\u05E2\u05D4 \u05D4\u05D5\u05E2\u05EA\u05E7\u05D4 \u05DC\u05DB\u05DC '+urls.length+'.';
  }
}

// ==================== EVENT DELEGATION ====================
document.addEventListener('click',function(e){
  // Modal close
  if(e.target.id==='modal-close'||e.target===document.getElementById('modal')){closeModal();return;}
  // Template modal close
  if(e.target.id==='tmpl-close'||e.target===document.getElementById('tmpl-modal')){closeTmplModal();return;}
  // Template card selection
  var tmplCard=e.target.closest('.tmpl-card[data-tmpl-id]');
  if(tmplCard){
    document.querySelectorAll('.tmpl-card').forEach(function(c){c.classList.remove('selected');});
    tmplCard.classList.add('selected');
    selectedTmpl=tmplCard.getAttribute('data-tmpl-id');
    document.getElementById('tmpl-send').disabled=false;
    return;
  }
  // Template send
  if(e.target.id==='tmpl-send'){executeBulkSend();return;}
  // Tabs
  var tb=e.target.closest('[data-tab]');
  if(tb){switchTab(tb.getAttribute('data-tab'));return;}
  // Actions
  var ac=e.target.closest('[data-action]');
  if(ac){
    var a=ac.getAttribute('data-action');
    if(a==='ssi')runSSI();
    else if(a==='refresh'){loadData();if(LD)loadListings();}
    else if(a==='clear-selection'){selectedListings.clear();renderTab();}
    else if(a==='open-tmpl'){openTmplModal();}
    return;
  }
  // Sorting
  var sh=e.target.closest('[data-sort-tab]');
  if(sh){var tabId=sh.getAttribute('data-sort-tab'),key=sh.getAttribute('data-sort-key');if(key==='_link')return;sortData([],tabId,key);renderTab();return;}
  // Alert row
  var alertRow=e.target.closest('[data-alert-idx]');
  if(alertRow){var idx=parseInt(alertRow.getAttribute('data-alert-idx'));var alerts=D.recentAlerts||[];if(alerts[idx])openAlertModal(alerts[idx]);return;}
  // Checkbox click - prevent row click
  if(e.target.classList.contains('listing-cb')){
    var lid=parseInt(e.target.getAttribute('data-lid'));
    if(e.target.checked)selectedListings.add(lid);else selectedListings.delete(lid);
    renderTab();return;
  }
  if(e.target.id==='cb-all'){
    var cbs=document.querySelectorAll('.listing-cb');
    if(e.target.checked){cbs.forEach(function(cb){selectedListings.add(parseInt(cb.getAttribute('data-lid')));});}
    else{cbs.forEach(function(cb){selectedListings.delete(parseInt(cb.getAttribute('data-lid')));});}
    renderTab();return;
  }
  // No-modal zones
  if(e.target.closest('[data-no-modal]')||e.target.closest('a')||e.target.closest('.listing-cb'))return;
  // Listing row click - open URL
  var lr=e.target.closest('[data-listing-url]');
  if(lr){window.open(lr.getAttribute('data-listing-url'),'_blank');return;}
  // Complex modal
  var cr=e.target.closest('[data-complex-id]');
  if(cr){var cid=cr.getAttribute('data-complex-id'),cname=cr.getAttribute('data-complex-name');openComplexModal(cid,cname);return;}
});
document.addEventListener('change',function(e){var f=e.target.closest('[data-filter]');if(f){var parts=f.getAttribute('data-filter').split('-');var tab=parts[0],field=parts.slice(1).join('');if(!filterStates[tab])filterStates[tab]={};filterStates[tab][field]=f.value;renderTab();}});
document.addEventListener('input',function(e){
  var f=e.target.closest('[data-filter]');
  if(f&&f.tagName==='INPUT'){var parts=f.getAttribute('data-filter').split('-');var tab=parts[0],field=parts.slice(1).join('');if(!filterStates[tab])filterStates[tab]={};filterStates[tab][field]=f.value;clearTimeout(f._debounce);f._debounce=setTimeout(function(){renderTab();},400);}
  // Enable send button when custom message has text
  if(e.target.id==='custom-msg'){
    if(selectedTmpl==='custom'){document.getElementById('tmpl-send').disabled=!e.target.value.trim();}
  }
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeModal();closeTmplModal();}});

loadData();
</script>
</body>
</html>`);
});

module.exports = router;