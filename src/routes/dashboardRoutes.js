/**
 * QUANTUM Dashboard v4.18.0 - Full-featured listings, sorting & filtering
 * Zero-dependency vanilla JS - works in ALL browsers including Brave
 * Features:
 * - NEW "מודעות" (Listings) tab with all active listings
 * - Sortable columns (click any header to toggle asc/desc) across ALL tabs
 * - Filters per column header in ALL tabs  
 * - Platform badges (yad2, facebook, madlan, homeless, kones)
 * - Deep links to platform messaging/chat
 * - Facebook Marketplace integration ready
 */

const express = require('express');
const router = express.Router();

// API endpoint: Get all listings with optional filters
router.get('/listings', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { city, source, min_price, max_price, min_rooms, max_rooms, min_area, max_area, min_floor, max_floor, sort, order, limit } = req.query;
    
    let query = `SELECT l.*, c.name as complex_name, c.city as complex_city, c.status as complex_status, 
                 c.iai_score, c.developer, c.slug as complex_slug
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

table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:8px 10px;color:#4a5e80;font-weight:600;border-bottom:1px solid #1a2744;font-size:10px;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap;text-align:right;cursor:pointer;user-select:none;transition:color .15s}
th:hover{color:#06d6a0}
th.sorted{color:#06d6a0}
th .sort-arrow{font-size:8px;margin-right:3px;opacity:.6}
td{padding:9px 10px;color:#e2e8f0;text-align:right}
th.c,td.c{text-align:center}
tr:hover td{background:#141d2e}
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
.src-other{background:rgba(148,163,184,.12);color:#94a3b8}

.btn-msg{padding:3px 10px;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;border:1px solid rgba(96,165,250,.25);background:rgba(96,165,250,.06);color:#60a5fa;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:3px}
.btn-msg:hover{background:rgba(96,165,250,.15)}

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
.loading-q{width:48px;height:48px;background:linear-gradient(135deg,#06d6a0,#3b82f6);border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;color:#000;font-family:'DM Serif Display',serif;animation:pulse 1.5s infinite}

.tab-content{animation:fadeUp .25s ease}
.hidden{display:none}
.overflow-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
.footer{border-top:1px solid #1a2744;padding:14px 20px;text-align:center;margin-top:24px}
.footer span{font-size:10px;color:#4a5e80}
.cnt-badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(6,214,160,.12);color:#06d6a0;margin-right:4px}
</style>
</head>
<body>

<div id="loading" class="loading-screen">
  <div class="loading-q">Q</div>
  <div style="color:#8899b4;font-size:13px">QUANTUM Intelligence</div>
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

  <footer class="footer">
    <span id="footer-text">QUANTUM Intelligence v4.18.0</span>
  </footer>
</div>

<script>
var D=null,LD=null,currentTab='overview',aggRunning=false;
var sortStates={};
var filterStates={};

// --- Utility functions ---
function ssiCls(sc){if(!sc&&sc!==0)return'';return sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';}
function ssiLbl(sc){if(!sc&&sc!==0)return'-';var t=sc>=80?'\u05E7\u05E8\u05D9\u05D8\u05D9':sc>=60?'\u05D2\u05D1\u05D5\u05D4':sc>=40?'\u05D1\u05D9\u05E0\u05D5\u05E0\u05D9':'\u05E0\u05DE\u05D5\u05DA';return sc+' '+t;}
function iaiH(sc){if(!sc&&sc!==0)return'<span class="dim">-</span>';var c=sc>=70?'#22c55e':sc>=50?'#06d6a0':sc>=30?'#ffc233':'#4a5e80';return'<span style="color:'+c+';font-weight:700;font-size:13px">'+sc+'</span>';}
function dotH(sev){var c=sev==='high'||sev==='critical'?'dot-red':sev==='medium'?'dot-orange':'dot-green';return'<span class="dot '+c+'"></span>';}
function cut(s,n){return s?(s.length>n?s.substring(0,n)+'...':s):'-';}
function fmtD(d){try{return new Date(d).toLocaleDateString('he-IL');}catch(e){return'-';}}
function fmtP(v){if(!v)return'-';var n=parseFloat(v);return n>=1000000?(n/1000000).toFixed(2)+'M':(n>=1000?(n/1000).toFixed(0)+'K':n.toFixed(0));}
function fmtN(v){if(!v&&v!==0)return'-';return parseFloat(v).toLocaleString('he-IL');}
function pf(v){return Array.isArray(v)?v:(typeof v==='string'?JSON.parse(v||'[]'):[]);}

// Platform display
var PLAT={yad2:{name:'\u05D9\u05D3 2',cls:'src-yad2',icon:'\u25A0'},facebook:{name:'Facebook',cls:'src-facebook',icon:'f'},madlan:{name:'\u05DE\u05D3\u05DC\u05DF',cls:'src-madlan',icon:'M'},homeless:{name:'Homeless',cls:'src-homeless',icon:'H'},kones:{name:'\u05DB\u05D9\u05E0\u05D5\u05E1',cls:'src-kones',icon:'\u2696'},perplexity:{name:'AI Search',cls:'src-other',icon:'\u25CE'}};
function srcBadge(src){var p=PLAT[src]||{name:src||'?',cls:'src-other',icon:'?'};return'<span class="badge-src '+p.cls+'">'+p.icon+' '+p.name+'</span>';}
function msgLink(src,url){
  if(!url)return'<span class="dim">-</span>';
  var label='\u05E9\u05DC\u05D7 \u05D4\u05D5\u05D3\u05E2\u05D4';
  return'<a href="'+url+'" target="_blank" rel="noopener" class="btn-msg">\u2709 '+label+'</a>';
}

// --- Sorting ---
function sortData(arr, tabId, key, forcedDir){
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
function sortArrow(tabId,key){
  if(!sortStates[tabId]||sortStates[tabId].key!==key)return'';
  return'<span class="sort-arrow">'+(sortStates[tabId].dir===-1?'\u25BC':'\u25B2')+'</span>';
}
function thSorted(tabId,key){return(sortStates[tabId]&&sortStates[tabId].key===key)?' sorted':'';}

// --- Data loading ---
function loadData(){
  fetch('/api/ssi/dashboard-data').then(function(r){return r.json();}).then(function(data){
    D=data;
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('time-label').textContent=new Date().toLocaleTimeString('he-IL');
    var s=D.stats||{};
    document.getElementById('footer-text').textContent='QUANTUM Intelligence v4.18.0 | '+(s.total_complexes||0)+' \u05DE\u05EA\u05D7\u05DE\u05D9\u05DD | '+(s.cities||0)+' \u05E2\u05E8\u05D9\u05DD';
    renderNav();renderTab();
  }).catch(function(e){
    console.error(e);
    document.getElementById('loading').innerHTML='<div class="loading-q">Q</div><div style="color:#ff4d6a;font-size:14px;text-align:center">\u05E9\u05D2\u05D9\u05D0\u05D4</div><button class="btn" data-action="refresh" style="margin-top:8px">\u05E0\u05E1\u05D4</button>';
  });
}
function loadListings(){
  fetch('/api/dashboard/listings?limit=500').then(function(r){return r.json();}).then(function(data){
    LD=data;renderNav();renderTab();
  }).catch(function(e){console.error('Listings load error:',e);});
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
  {id:'alerts',l:'\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA'},
  {id:'messaging',l:'\u05D4\u05D5\u05D3\u05E2\u05D5\u05EA'}
];
function renderNav(){
  var h='';
  for(var i=0;i<tabs.length;i++){
    var cnt='';
    if(tabs[i].id==='listings'&&LD)cnt='<span class="cnt-badge">'+LD.total+'</span>';
    h+='<button class="nav-btn'+(tabs[i].id===currentTab?' active':'')+'" data-tab="'+tabs[i].id+'">'+tabs[i].l+cnt+'</button>';
  }
  document.getElementById('nav').innerHTML=h;
}
function switchTab(id){
  currentTab=id;
  if(id==='listings'&&!LD)loadListings();
  renderNav();renderTab();
}
function renderTab(){
  var m=document.getElementById('main');if(!D){m.innerHTML='';return;}
  var s=D.stats||{},dist=D.ssiDistribution||{},topSSI=D.topSSI||[],topIAI=D.topIAI||[],alerts=D.recentAlerts||[],cities=D.cityBreakdown||[],ls=D.listingStats||{};
  if(currentTab==='overview')m.innerHTML=renderOverview(s,dist,topSSI,alerts,cities,ls);
  else if(currentTab==='listings')m.innerHTML=renderListings();
  else if(currentTab==='ssi')m.innerHTML=renderSSITab(s,dist,topSSI);
  else if(currentTab==='opp')m.innerHTML=renderOpp(s,topIAI);
  else if(currentTab==='cities')m.innerHTML=renderCities(s,cities);
  else if(currentTab==='alerts')m.innerHTML=renderAlerts(alerts);
  else if(currentTab==='messaging')m.innerHTML=renderMessaging();
}

function statCard(label,val,sub,color,icon){return'<div class="stat"><div class="stat-icon">'+icon+'</div><div class="stat-label">'+label+'</div><div class="stat-val" style="color:'+color+'">'+(val!=null?val:'-')+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';}
function panelH(title,sub,icon){return'<div class="panel-head">'+(icon?'<span class="panel-head-icon">'+icon+'</span>':'')+'<div><h2 class="panel-title">'+title+'</h2>'+(sub?'<p class="panel-sub">'+sub+'</p>':'')+'</div></div>';}

// ==================== LISTINGS TAB ====================
function renderListings(){
  if(!LD)return'<div class="tab-content"><div class="empty-msg" style="padding:40px">\u05D8\u05D5\u05E2\u05DF \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA...</div></div>';
  var listings=LD.listings||[],cities=LD.cities||[],sources=LD.sources||[];
  var fs=filterStates.listings||{};
  
  // Apply client-side filters
  var filtered=listings.filter(function(l){
    if(fs.city&&(l.complex_city||'')!==fs.city)return false;
    if(fs.source&&(l.source||'')!==fs.source)return false;
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
  
  // Apply sorting
  if(sortStates.listings&&sortStates.listings.key){
    filtered=sortData(filtered,'listings',sortStates.listings.key,sortStates.listings.dir);
  }
  
  var h='<div class="tab-content">';
  // Stats cards
  h+='<div class="grid grid-4">';
  h+=statCard('\u05E1\u05D4\u05F4\u05DB \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA',filtered.length,LD.total+' \u05E1\u05D4\u05F4\u05DB','#06d6a0','\u25A4');
  var urgCnt=filtered.filter(function(l){return l.has_urgent_keywords;}).length;
  h+=statCard('\u05D3\u05D7\u05D5\u05E4\u05D5\u05EA',urgCnt,'\u05DE\u05D9\u05DC\u05D5\u05EA \u05DE\u05E4\u05EA\u05D7','#ff4d6a','!');
  var srcCounts={};filtered.forEach(function(l){srcCounts[l.source||'other']=(srcCounts[l.source||'other']||0)+1;});
  var topSrc=Object.keys(srcCounts).sort(function(a,b){return srcCounts[b]-srcCounts[a];});
  h+=statCard('\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D5\u05EA',topSrc.length,topSrc.slice(0,3).join(', '),'#3b82f6','\u25CE');
  var avgPPM=0,ppmC=0;filtered.forEach(function(l){if(l.price_per_sqm){avgPPM+=parseFloat(l.price_per_sqm);ppmC++;}});
  h+=statCard('\u05DE\u05D7\u05D9\u05E8 \u05DC\u05DE\u05F4\u05E8',ppmC?fmtN(Math.round(avgPPM/ppmC)):'-','\u05DE\u05DE\u05D5\u05E6\u05E2 \u05E4\u05E2\u05D9\u05DC\u05D5\u05EA','#ffc233','\u20AA');
  h+='</div>';
  
  // Filters
  h+='<div class="panel">';
  h+='<div class="filter-row">';
  h+='<span class="filter-label">\u05E2\u05D9\u05E8:</span><select data-filter="listings-city"><option value="">\u05DB\u05DC</option>';
  cities.forEach(function(c){h+='<option value="'+c+'"'+(fs.city===c?' selected':'')+'>'+c+'</option>';});
  h+='</select>';
  h+='<span class="filter-label">\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D4:</span><select data-filter="listings-source"><option value="">\u05DB\u05DC</option>';
  sources.forEach(function(s){h+='<option value="'+s+'"'+(fs.source===s?' selected':'')+'>'+(PLAT[s]?PLAT[s].name:s)+'</option>';});
  h+='</select>';
  h+='<span class="filter-label">\u05D7\u05D3\u05E8\u05D9\u05DD:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minRooms" value="'+(fs.minRooms||'')+'" style="width:55px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxRooms" value="'+(fs.maxRooms||'')+'" style="width:55px">';
  h+='<span class="filter-label">\u05DE\u05D7\u05D9\u05E8:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minPrice" value="'+(fs.minPrice||'')+'" step="100000" style="width:80px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxPrice" value="'+(fs.maxPrice||'')+'" step="100000" style="width:80px">';
  h+='<span class="filter-label">\u05E9\u05D8\u05D7:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minArea" value="'+(fs.minArea||'')+'" style="width:55px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxArea" value="'+(fs.maxArea||'')+'" style="width:55px">';
  h+='<span class="filter-label">\u05E7\u05D5\u05DE\u05D4:</span>';
  h+='<input type="number" placeholder="\u05DE\u05D9\u05DF" data-filter="listings-minFloor" value="'+(fs.minFloor||'')+'" style="width:45px">';
  h+='-<input type="number" placeholder="\u05DE\u05E7\u05E1" data-filter="listings-maxFloor" value="'+(fs.maxFloor||'')+'" style="width:45px">';
  h+='<span class="filter-label">\u05DE\u05EA\u05D7\u05DD:</span>';
  h+='<input type="text" placeholder="\u05D7\u05D9\u05E4\u05D5\u05E9..." data-filter="listings-complex" value="'+(fs.complex||'')+'" style="width:100px">';
  h+='</div>';
  
  // Table
  h+='<div class="overflow-x"><table><thead><tr>';
  var cols=[
    {k:'source',l:'\u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D4',c:true},
    {k:'complex_city',l:'\u05E2\u05D9\u05E8'},
    {k:'complex_name',l:'\u05DE\u05EA\u05D7\u05DD'},
    {k:'address',l:'\u05DB\u05EA\u05D5\u05D1\u05EA'},
    {k:'rooms',l:'\u05D7\u05D3\u05E8\u05D9\u05DD',c:true},
    {k:'area_sqm',l:'\u05E9\u05D8\u05D7 (\u05DE\u05F4\u05E8)',c:true},
    {k:'floor',l:'\u05E7\u05D5\u05DE\u05D4',c:true},
    {k:'asking_price',l:'\u05DE\u05D7\u05D9\u05E8',c:true},
    {k:'price_per_sqm',l:'\u05DE\u05D7\u05D9\u05E8/\u05DE\u05F4\u05E8',c:true},
    {k:'ssi_score',l:'SSI',c:true},
    {k:'days_on_market',l:'\u05D9\u05DE\u05D9\u05DD',c:true},
    {k:'_msg',l:'\u05E4\u05E2\u05D5\u05DC\u05D4',c:true}
  ];
  for(var i=0;i<cols.length;i++){
    var col=cols[i];
    h+='<th class="'+(col.c?'c ':'')+thSorted('listings',col.k)+'" data-sort-tab="listings" data-sort-key="'+col.k+'">'+sortArrow('listings',col.k)+col.l+'</th>';
  }
  h+='</tr></thead><tbody>';
  
  if(!filtered.length){h+='<tr><td colspan="'+cols.length+'" class="empty-msg">\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D5 \u05DE\u05D5\u05D3\u05E2\u05D5\u05EA</td></tr>';}
  else{
    for(var i=0;i<filtered.length;i++){
      var l=filtered[i];
      h+='<tr>';
      h+='<td class="c">'+srcBadge(l.source)+'</td>';
      h+='<td class="nw">'+(l.complex_city||'-')+'</td>';
      h+='<td class="f6">'+cut(l.complex_name,25)+'</td>';
      h+='<td class="sm">'+cut(l.address,30)+'</td>';
      h+='<td class="c">'+(l.rooms||'-')+'</td>';
      h+='<td class="c">'+(l.area_sqm?fmtN(l.area_sqm):'-')+'</td>';
      h+='<td class="c">'+(l.floor!=null?l.floor:'-')+'</td>';
      h+='<td class="c nw fw" style="color:#06d6a0">'+(l.asking_price?'\u20AA'+fmtP(l.asking_price):'-')+'</td>';
      h+='<td class="c nw">'+(l.price_per_sqm?fmtN(Math.round(parseFloat(l.price_per_sqm))):'-')+'</td>';
      h+='<td class="c nw">'+(l.ssi_score?'<span class="badge-ssi '+ssiCls(l.ssi_score)+'">'+l.ssi_score+'</span>':'<span class="dim">-</span>')+'</td>';
      h+='<td class="c">'+(l.days_on_market||'-')+'</td>';
      h+='<td class="c">'+msgLink(l.source,l.url)+'</td>';
      h+='</tr>';
    }
  }
  h+='</tbody></table></div></div></div>';
  return h;
}

// ==================== OVERVIEW TAB ====================
function renderOverview(s,dist,topSSI,alerts,cities,ls){
  var h='<div class="tab-content"><div class="grid grid-6">';
  h+=statCard('\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD',s.total_complexes,s.cities+' \u05E2\u05E8\u05D9\u05DD','#06d6a0','Q');
  h+=statCard('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA',s.opportunities,s.excellent+' \u05DE\u05E6\u05D5\u05D9\u05E0\u05D5\u05EA (70+)','#ffc233','\u2605');
  h+=statCard('\u05DE\u05D5\u05DB\u05E8\u05D9\u05DD \u05DC\u05D7\u05D5\u05E6\u05D9\u05DD',s.stressed_sellers,s.high_stress+' \u05D1\u05E8\u05DE\u05D4 \u05D2\u05D1\u05D5\u05D4\u05D4','#ff4d6a','!');
  h+=statCard('\u05DE\u05D5\u05D3\u05E2\u05D5\u05EA',ls.active||'0',(ls.urgent||'0')+' \u05D3\u05D7\u05D5\u05E4\u05D5\u05EA','#22c55e','\u25A4');
  h+=statCard('\u05DB\u05D9\u05E0\u05D5\u05E1\u05D9\u05DD',(D.konesStats||{}).total||'0','\u05E0\u05DB\u05E1\u05D9 \u05DB\u05D9\u05E0\u05D5\u05E1','#9f7aea','\u2696');
  h+=statCard('IAI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_iai||'-','','#3b82f6','\u25B3');
  h+='</div>';

  var goldOpp=topSSI.filter(function(x){return x.iai_score>=40;}).slice(0,5);
  if(goldOpp.length>0){
    h+='<div class="panel panel-gold">'+panelH('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05D6\u05D4\u05D1','IAI + \u05DE\u05D5\u05DB\u05E8 \u05DC\u05D7\u05D5\u05E5','\u25C6');
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c'+thSorted('ov-gold','enhanced_ssi_score')+'" data-sort-tab="ov-gold" data-sort-key="enhanced_ssi_score">'+sortArrow('ov-gold','enhanced_ssi_score')+'SSI</th>';
    h+='<th class="c'+thSorted('ov-gold','iai_score')+'" data-sort-tab="ov-gold" data-sort-key="iai_score">'+sortArrow('ov-gold','iai_score')+'IAI</th>';
    h+='<th'+thSorted('ov-gold','name')+' data-sort-tab="ov-gold" data-sort-key="name">'+sortArrow('ov-gold','name')+'\u05DE\u05EA\u05D7\u05DD</th>';
    h+='<th'+thSorted('ov-gold','city')+' data-sort-tab="ov-gold" data-sort-key="city">'+sortArrow('ov-gold','city')+'\u05E2\u05D9\u05E8</th>';
    h+='<th>\u05D2\u05D5\u05E8\u05DE\u05D9\u05DD</th></tr></thead><tbody>';
    for(var i=0;i<goldOpp.length;i++){
      var r=goldOpp[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(' | ');
      h+='<tr><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td>';
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
  var ct=cities.slice(0,10),mx=1;
  for(var i=0;i<ct.length;i++){if(+ct[i].opportunities>mx)mx=+ct[i].opportunities;}
  h+='<div class="bar-chart">';for(var i=0;i<ct.length;i++){var pct=Math.round((+ct[i].opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+ct[i].city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:#06d6a0"></div></div><span class="bar-val">'+ct[i].opportunities+'</span></div>';}
  h+='</div></div></div></div>';
  return h;
}

// ==================== SSI TAB ====================
function renderSSITab(s,dist,topSSI){
  var h='<div class="tab-content"><div class="grid grid-4">';
  h+=statCard('\u05DC\u05D7\u05E5 \u05D2\u05D1\u05D5\u05D4',+(dist.high||0)+ +(dist.critical||0),'','#ff4d6a','!');
  h+=statCard('\u05DC\u05D7\u05E5 \u05D1\u05D9\u05E0\u05D5\u05E0\u05D9',dist.medium||'0','','#ff8c42','\u25B2');
  h+=statCard('\u05DC\u05D7\u05E5 \u05E0\u05DE\u05D5\u05DA',dist.low||'0','','#ffc233','\u25B3');
  h+=statCard('SSI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_ssi||'-','','#06d6a0','\u25CE');
  h+='</div><div class="panel">'+panelH('\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD \u05E2\u05DD \u05E1\u05D9\u05DE\u05E0\u05D9 \u05DE\u05E6\u05D5\u05E7\u05D4','','\u26A1');
  if(!topSSI.length){h+='<div class="empty-msg">\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D5</div>';}
  else{
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c" data-sort-tab="ssi" data-sort-key="_idx">'+sortArrow('ssi','_idx')+'#</th>';
    h+='<th class="c'+thSorted('ssi','enhanced_ssi_score')+'" data-sort-tab="ssi" data-sort-key="enhanced_ssi_score">'+sortArrow('ssi','enhanced_ssi_score')+'SSI</th>';
    h+='<th'+thSorted('ssi','name')+' data-sort-tab="ssi" data-sort-key="name">'+sortArrow('ssi','name')+'\u05DE\u05EA\u05D7\u05DD</th>';
    h+='<th'+thSorted('ssi','city')+' data-sort-tab="ssi" data-sort-key="city">'+sortArrow('ssi','city')+'\u05E2\u05D9\u05E8</th>';
    h+='<th class="c'+thSorted('ssi','iai_score')+'" data-sort-tab="ssi" data-sort-key="iai_score">'+sortArrow('ssi','iai_score')+'IAI</th>';
    h+='<th'+thSorted('ssi','status')+' data-sort-tab="ssi" data-sort-key="status">'+sortArrow('ssi','status')+'\u05E1\u05D8\u05D8\u05D5\u05E1</th>';
    h+='<th>\u05D2\u05D5\u05E8\u05DE\u05D9\u05DD</th></tr></thead><tbody>';
    var sorted=topSSI.map(function(r,i){r._idx=i+1;return r;});
    if(sortStates.ssi&&sortStates.ssi.key)sorted=sortData(sorted,'ssi',sortStates.ssi.key,sortStates.ssi.dir);
    for(var i=0;i<sorted.length;i++){
      var r=sorted[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(' | ');
      h+='<tr><td class="c xs dim">'+r._idx+'</td><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td><td class="f6">'+cut(r.name||r.addresses,42)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td><td class="xs muted">'+(f||'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';return h;
}

// ==================== OPPORTUNITIES TAB ====================
function renderOpp(s,topIAI){
  var h='<div class="tab-content"><div class="grid grid-3">';
  h+=statCard('\u05E1\u05D4\u05F4\u05DB \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA',s.opportunities,'IAI 30+','#ffc233','\u2605');
  h+=statCard('\u05DE\u05E6\u05D5\u05D9\u05E0\u05D5\u05EA',s.excellent,'IAI 70+','#22c55e','\u25C6');
  h+=statCard('IAI \u05DE\u05DE\u05D5\u05E6\u05E2',s.avg_iai||'-','','#06d6a0','\u25B3');
  h+='</div><div class="panel">'+panelH('\u05D8\u05D5\u05E4 \u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA','','\u2605');
  h+='<div class="overflow-x"><table><thead><tr>';
  h+='<th class="c" data-sort-tab="opp" data-sort-key="_idx">'+sortArrow('opp','_idx')+'#</th>';
  h+='<th class="c'+thSorted('opp','iai_score')+'" data-sort-tab="opp" data-sort-key="iai_score">'+sortArrow('opp','iai_score')+'IAI</th>';
  h+='<th'+thSorted('opp','name')+' data-sort-tab="opp" data-sort-key="name">'+sortArrow('opp','name')+'\u05DE\u05EA\u05D7\u05DD</th>';
  h+='<th'+thSorted('opp','city')+' data-sort-tab="opp" data-sort-key="city">'+sortArrow('opp','city')+'\u05E2\u05D9\u05E8</th>';
  h+='<th class="c'+thSorted('opp','enhanced_ssi_score')+'" data-sort-tab="opp" data-sort-key="enhanced_ssi_score">'+sortArrow('opp','enhanced_ssi_score')+'SSI</th>';
  h+='<th'+thSorted('opp','developer')+' data-sort-tab="opp" data-sort-key="developer">'+sortArrow('opp','developer')+'\u05D9\u05D6\u05DD</th>';
  h+='<th'+thSorted('opp','status')+' data-sort-tab="opp" data-sort-key="status">'+sortArrow('opp','status')+'\u05E1\u05D8\u05D8\u05D5\u05E1</th>';
  h+='</tr></thead><tbody>';
  var sorted=topIAI.map(function(r,i){r._idx=i+1;return r;});
  if(sortStates.opp&&sortStates.opp.key)sorted=sortData(sorted,'opp',sortStates.opp.key,sortStates.opp.dir);
  for(var i=0;i<sorted.length;i++){
    var r=sorted[i];
    h+='<tr><td class="c xs dim">'+r._idx+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="f6">'+cut(r.name||r.addresses,45)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+(r.enhanced_ssi_score?'<span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span>':'<span class="dim">-</span>')+'</td><td class="sm muted nw">'+cut(r.developer,20)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td></tr>';
  }
  h+='</tbody></table></div></div></div>';return h;
}

// ==================== CITIES TAB ====================
function renderCities(s,cities){
  var h='<div class="tab-content"><div class="panel">'+panelH('\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA \u05DC\u05E4\u05D9 \u05E2\u05E8\u05D9\u05DD',(s.cities||0)+' \u05E2\u05E8\u05D9\u05DD','\u25A3');
  var t10=cities.slice(0,10),mx=1;
  for(var i=0;i<t10.length;i++){if(+t10[i].total>mx)mx=+t10[i].total;}
  h+='<div class="bar-chart">';for(var i=0;i<t10.length;i++){var c=t10[i],p=Math.round((+c.opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+c.city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+p+'%;background:#06d6a0"></div></div><span class="bar-val">'+c.opportunities+'/'+c.total+'</span></div>';}
  h+='</div></div>';
  h+='<div class="panel"><div class="overflow-x"><table><thead><tr>';
  h+='<th'+thSorted('cities','city')+' data-sort-tab="cities" data-sort-key="city">'+sortArrow('cities','city')+'\u05E2\u05D9\u05E8</th>';
  h+='<th class="c'+thSorted('cities','total')+'" data-sort-tab="cities" data-sort-key="total">'+sortArrow('cities','total')+'\u05DE\u05EA\u05D7\u05DE\u05D9\u05DD</th>';
  h+='<th class="c'+thSorted('cities','opportunities')+'" data-sort-tab="cities" data-sort-key="opportunities">'+sortArrow('cities','opportunities')+'\u05D4\u05D6\u05D3\u05DE\u05E0\u05D5\u05D9\u05D5\u05EA</th>';
  h+='<th class="c'+thSorted('cities','stressed')+'" data-sort-tab="cities" data-sort-key="stressed">'+sortArrow('cities','stressed')+'\u05DC\u05D7\u05D5\u05E6\u05D9\u05DD</th>';
  h+='<th class="c'+thSorted('cities','avg_iai')+'" data-sort-tab="cities" data-sort-key="avg_iai">'+sortArrow('cities','avg_iai')+'IAI \u05DE\u05DE\u05D5\u05E6\u05E2</th>';
  h+='</tr></thead><tbody>';
  var sorted=cities.slice();
  if(sortStates.cities&&sortStates.cities.key)sorted=sortData(sorted,'cities',sortStates.cities.key,sortStates.cities.dir);
  for(var i=0;i<sorted.length;i++){
    var c=sorted[i];
    h+='<tr><td class="fw">'+c.city+'</td><td class="c">'+c.total+'</td><td class="c" style="color:#06d6a0;font-weight:700">'+c.opportunities+'</td><td class="c">'+(+c.stressed>0?'<span style="color:#ff4d6a;font-weight:700">'+c.stressed+'</span>':'<span class="dim">0</span>')+'</td><td class="c" style="color:'+(+c.avg_iai>=50?'#22c55e':'#8899b4')+'">'+( c.avg_iai||'-')+'</td></tr>';
  }
  h+='</tbody></table></div></div></div>';return h;
}

// ==================== ALERTS TAB ====================
function renderAlerts(alerts){
  var h='<div class="tab-content"><div class="panel">'+panelH('\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA','','\u25CF');
  if(!alerts.length){h+='<div class="empty-msg">\u05D0\u05D9\u05DF \u05D4\u05EA\u05E8\u05D0\u05D5\u05EA</div>';}
  else{
    h+='<div class="overflow-x"><table><thead><tr>';
    h+='<th class="c">'+' '+'</th>';
    h+='<th'+thSorted('alerts','title')+' data-sort-tab="alerts" data-sort-key="title">'+sortArrow('alerts','title')+'\u05DB\u05D5\u05EA\u05E8\u05EA</th>';
    h+='<th'+thSorted('alerts','complex_name')+' data-sort-tab="alerts" data-sort-key="complex_name">'+sortArrow('alerts','complex_name')+'\u05DE\u05EA\u05D7\u05DD</th>';
    h+='<th'+thSorted('alerts','city')+' data-sort-tab="alerts" data-sort-key="city">'+sortArrow('alerts','city')+'\u05E2\u05D9\u05E8</th>';
    h+='<th'+thSorted('alerts','alert_type')+' data-sort-tab="alerts" data-sort-key="alert_type">'+sortArrow('alerts','alert_type')+'\u05E1\u05D5\u05D2</th>';
    h+='<th'+thSorted('alerts','created_at')+' data-sort-tab="alerts" data-sort-key="created_at">'+sortArrow('alerts','created_at')+'\u05EA\u05D0\u05E8\u05D9\u05DA</th>';
    h+='</tr></thead><tbody>';
    var sorted=alerts.slice();
    if(sortStates.alerts&&sortStates.alerts.key)sorted=sortData(sorted,'alerts',sortStates.alerts.key,sortStates.alerts.dir);
    for(var i=0;i<sorted.length;i++){
      var a=sorted[i];
      h+='<tr><td class="c">'+dotH(a.severity)+'</td><td class="sm f6">'+cut(a.title,55)+'</td><td class="sm muted nw">'+(a.complex_name||'-')+'</td><td class="sm nw">'+(a.city||'-')+'</td><td class="xs dim nw">'+(a.alert_type||'-')+'</td><td class="xs dim nw">'+(a.created_at?fmtD(a.created_at):'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';return h;
}

// ==================== MESSAGING TAB ====================
function renderMessaging(){
  var h='<div class="tab-content"><div class="panel">'+panelH('\u05DE\u05E2\u05E8\u05DB\u05EA \u05D4\u05D5\u05D3\u05E2\u05D5\u05EA','','\u2709');
  h+='<div style="padding:20px;text-align:center;color:#8899b4">';
  h+='<p style="font-size:14px;margin-bottom:12px">\u05DE\u05E2\u05E8\u05DB\u05EA \u05D4\u05D4\u05D5\u05D3\u05E2\u05D5\u05EA \u05D6\u05DE\u05D9\u05E0\u05D4 \u05D1-API</p>';
  h+='<p style="font-size:12px;color:#4a5e80">GET /api/messaging/stats | POST /api/messaging/send</p>';
  h+='<a href="/api/chat/" class="btn btn-chat" style="display:inline-block;margin-top:12px">\u05E4\u05EA\u05D7 Chat AI</a>';
  h+='</div></div></div>';return h;
}

// ==================== EVENT DELEGATION ====================
document.addEventListener('click', function(e) {
  var tb=e.target.closest('[data-tab]');
  if(tb){switchTab(tb.getAttribute('data-tab'));return;}
  var ac=e.target.closest('[data-action]');
  if(ac){var a=ac.getAttribute('data-action');if(a==='ssi')runSSI();else if(a==='refresh'){loadData();if(LD)loadListings();}}
  // Sortable columns
  var sh=e.target.closest('[data-sort-tab]');
  if(sh){
    var tabId=sh.getAttribute('data-sort-tab'),key=sh.getAttribute('data-sort-key');
    if(key==='_msg')return;
    sortData([],tabId,key);
    renderTab();
  }
});
document.addEventListener('change',function(e){
  var f=e.target.closest('[data-filter]');
  if(f){
    var parts=f.getAttribute('data-filter').split('-');
    var tab=parts[0],field=parts.slice(1).join('');
    if(!filterStates[tab])filterStates[tab]={};
    filterStates[tab][field]=f.value;
    renderTab();
  }
});
document.addEventListener('input',function(e){
  var f=e.target.closest('[data-filter]');
  if(f&&f.tagName==='INPUT'){
    var parts=f.getAttribute('data-filter').split('-');
    var tab=parts[0],field=parts.slice(1).join('');
    if(!filterStates[tab])filterStates[tab]={};
    filterStates[tab][field]=f.value;
    clearTimeout(f._debounce);
    f._debounce=setTimeout(function(){renderTab();},400);
  }
});

loadData();
</script>
</body>
</html>`);
});

module.exports = router;