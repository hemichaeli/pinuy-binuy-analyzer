/**
 * QUANTUM Dashboard v4.13.3 - Zero-dependency vanilla JS dashboard
 * No React, no Babel, no external CDNs - works in ALL browsers including Brave
 * GET /api/dashboard/ - Full dashboard UI
 */

const express = require('express');
const router = express.Router();

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
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:#080c14}
::-webkit-scrollbar-thumb{background:#1a2744;border-radius:3px}
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
  .grid-2{grid-template-columns:1fr}
  .grid-6{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
  .header{padding:10px 14px}
  .nav{padding:0 14px}
  .main{padding:14px}
  .stat{padding:14px 16px}
  .stat-val{font-size:26px}
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
th{padding:8px 10px;color:#4a5e80;font-weight:600;border-bottom:1px solid #1a2744;font-size:10px;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap;text-align:right}
td{padding:9px 10px;color:#e2e8f0;text-align:right}
th.c,td.c{text-align:center}
tr:hover td{background:#141d2e}
.nw{white-space:nowrap}
.fw{font-weight:700}
.f6{font-weight:600}
.dim{color:#4a5e80}
.muted{color:#8899b4}
.sm{font-size:11px}
.xs{font-size:10px}
.empty-msg{color:#4a5e80;padding:20px;text-align:center;font-size:13px}

.badge-ssi{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.badge-critical{background:rgba(255,77,106,.12);color:#ff4d6a}
.badge-high{background:rgba(255,140,66,.12);color:#ff8c42}
.badge-med{background:rgba(255,194,51,.12);color:#ffc233}
.badge-low{background:rgba(34,197,94,.08);color:#22c55e}

.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot-red{background:#ff4d6a}
.dot-orange{background:#ff8c42}
.dot-green{background:#22c55e}

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

.footer{border-top:1px solid #1a2744;padding:14px 20px;text-align:center;margin-top:24px}
.footer span{font-size:10px;color:#4a5e80}

.overflow-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
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
      <button id="btn-ssi" class="btn btn-ssi" onclick="runSSI()">SSI</button>
      <button class="btn" onclick="loadData()">רענון</button>
      <span id="time-label" class="time-label"></span>
    </div>
  </header>

  <nav class="nav" id="nav"></nav>
  <main class="main" id="main"></main>

  <footer class="footer">
    <span id="footer-text">QUANTUM Intelligence v4.13.3</span>
  </footer>
</div>

<script>
var D=null,currentTab="overview",aggRunning=false;

function ssiCls(sc){
  if(!sc&&sc!==0)return'';
  return sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';
}
function ssiLbl(sc){
  if(!sc&&sc!==0)return'-';
  var t=sc>=80?'קריטי':sc>=60?'גבוה':sc>=40?'בינוני':'נמוך';
  return sc+' '+t;
}
function iaiH(sc){
  if(!sc&&sc!==0)return'<span class="dim">-</span>';
  var c=sc>=70?'#22c55e':sc>=50?'#06d6a0':sc>=30?'#ffc233':'#4a5e80';
  return'<span style="color:'+c+';font-weight:700;font-size:13px">'+sc+'</span>';
}
function dotH(sev){
  var c=sev==='high'||sev==='critical'?'dot-red':sev==='medium'?'dot-orange':'dot-green';
  return'<span class="dot '+c+'"></span>';
}
function cut(s,n){return s?(s.length>n?s.substring(0,n)+'...':s):'-';}
function fmtD(d){try{return new Date(d).toLocaleDateString('he-IL');}catch(e){return'-';}}
function pf(v){return Array.isArray(v)?v:(typeof v==='string'?JSON.parse(v||'[]'):[]);}

function loadData(){
  fetch('/api/ssi/dashboard-data')
    .then(function(r){return r.json();})
    .then(function(data){
      D=data;
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('time-label').textContent=new Date().toLocaleTimeString('he-IL');
      var s=D.stats||{};
      document.getElementById('footer-text').textContent='QUANTUM Intelligence v4.13.3 | '+(s.total_complexes||0)+' מתחמים | '+(s.cities||0)+' ערים';
      renderNav();
      renderTab();
    })
    .catch(function(e){
      console.error(e);
      document.getElementById('loading').innerHTML='<div class="loading-q">Q</div><div style="color:#ff4d6a;font-size:14px;text-align:center;direction:rtl">שגיאה בטעינת נתונים</div><button class="btn" onclick="loadData()" style="margin-top:8px">נסה שוב</button>';
    });
}

function runSSI(){
  if(aggRunning)return;
  aggRunning=true;
  var btn=document.getElementById('btn-ssi');
  btn.textContent='...SSI';
  btn.classList.add('loading');
  fetch('/api/ssi/batch-aggregate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"minListings":1,"limit":500}'})
    .then(function(){return new Promise(function(r){setTimeout(r,3000);});})
    .then(function(){return loadData();})
    .catch(function(e){console.error(e);})
    .finally(function(){
      aggRunning=false;
      btn.textContent='SSI';
      btn.classList.remove('loading');
    });
}

var tabs=[
  {id:'overview',l:'סקירה'},
  {id:'ssi',l:'מוכרים לחוצים'},
  {id:'opp',l:'הזדמנויות'},
  {id:'cities',l:'ערים'},
  {id:'alerts',l:'התראות'}
];

function renderNav(){
  var h='';
  for(var i=0;i<tabs.length;i++){
    h+='<button class="nav-btn'+(tabs[i].id===currentTab?' active':'')+'" onclick="switchTab(\\''+tabs[i].id+'\\')">'+tabs[i].l+'</button>';
  }
  document.getElementById('nav').innerHTML=h;
}

function switchTab(id){currentTab=id;renderNav();renderTab();}

function renderTab(){
  var m=document.getElementById('main');
  if(!D){m.innerHTML='';return;}
  var s=D.stats||{},dist=D.ssiDistribution||{},topSSI=D.topSSI||[],topIAI=D.topIAI||[],alerts=D.recentAlerts||[],cities=D.cityBreakdown||[],ls=D.listingStats||{};

  if(currentTab==='overview')m.innerHTML=renderOverview(s,dist,topSSI,alerts,cities,ls);
  else if(currentTab==='ssi')m.innerHTML=renderSSITab(s,dist,topSSI);
  else if(currentTab==='opp')m.innerHTML=renderOpp(s,topIAI);
  else if(currentTab==='cities')m.innerHTML=renderCities(s,cities);
  else if(currentTab==='alerts')m.innerHTML=renderAlerts(alerts);
}

function statCard(label,val,sub,color,icon){
  return'<div class="stat"><div class="stat-icon">'+icon+'</div><div class="stat-label">'+label+'</div><div class="stat-val" style="color:'+color+'">'+(val!=null?val:'-')+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';
}
function panelH(title,sub,icon){
  return'<div class="panel-head">'+(icon?'<span class="panel-head-icon">'+icon+'</span>':'')+'<div><h2 class="panel-title">'+title+'</h2>'+(sub?'<p class="panel-sub">'+sub+'</p>':'')+'</div></div>';
}

function renderOverview(s,dist,topSSI,alerts,cities,ls){
  var h='<div class="tab-content"><div class="grid grid-6">';
  h+=statCard('מתחמים',s.total_complexes,s.cities+' ערים','#06d6a0','Q');
  h+=statCard('הזדמנויות',s.opportunities,s.excellent+' מצוינות (70+)','#ffc233','★');
  h+=statCard('מוכרים לחוצים',s.stressed_sellers,s.high_stress+' ברמה גבוהה','#ff4d6a','!');
  h+=statCard('מודעות',ls.active||'0',(ls.urgent||'0')+' דחופות','#22c55e','▤');
  h+=statCard('כינוסים',(D.konesStats||{}).total||'0','נכסי כינוס','#9f7aea','⚖');
  h+=statCard('IAI ממוצע',s.avg_iai||'-','אינדקס אטרקטיביות','#3b82f6','△');
  h+='</div>';

  var goldOpp=topSSI.filter(function(x){return x.iai_score>=40;}).slice(0,5);
  if(goldOpp.length>0){
    h+='<div class="panel panel-gold">'+panelH('הזדמנויות זהב','IAI גבוה + מוכר לחוץ','◆');
    h+='<div class="overflow-x"><table><thead><tr><th class="c">SSI</th><th class="c">IAI</th><th>מתחם</th><th>עיר</th><th>גורמי לחץ</th></tr></thead><tbody>';
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
  // SSI Distribution
  h+='<div class="panel">'+panelH('התפלגות SSI','סימני מצוקה','◉')+'<div class="pie-legend">';
  var di=[{l:'גבוה (60+)',v:+(dist.high||0)+ +(dist.critical||0),c:'#ff4d6a'},{l:'בינוני (40-59)',v:+(dist.medium||0),c:'#ff8c42'},{l:'נמוך (20-39)',v:+(dist.low||0),c:'#ffc233'},{l:'מזערי (<20)',v:+(dist.minimal||0),c:'#4a5e80'}];
  for(var i=0;i<di.length;i++){
    h+='<div class="pie-row"><div class="pie-info"><div class="pie-dot" style="background:'+di[i].c+'"></div><span class="sm muted">'+di[i].l+'</span></div><span style="font-weight:700;color:'+di[i].c+';font-size:14px">'+di[i].v+'</span></div>';
  }
  h+='</div></div>';

  // City bar chart
  h+='<div class="panel">'+panelH('הזדמנויות לפי עיר','טופ 10','▣');
  var ct=cities.slice(0,10),mx=1;
  for(var i=0;i<ct.length;i++){if(+ct[i].opportunities>mx)mx=+ct[i].opportunities;}
  h+='<div class="bar-chart">';
  for(var i=0;i<ct.length;i++){
    var pct=Math.round((+ct[i].opportunities/mx)*100);
    h+='<div class="bar-row"><span class="bar-label">'+ct[i].city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:#06d6a0"></div></div><span class="bar-val">'+ct[i].opportunities+'</span></div>';
  }
  h+='</div></div></div>';

  // Alerts
  h+='<div class="panel">'+panelH('התראות אחרונות',alerts.length+' התראות','●');
  if(!alerts.length){h+='<div class="empty-msg">אין התראות</div>';}
  else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c"></th><th>כותרת</th><th>עיר</th><th>סוג</th><th>תאריך</th></tr></thead><tbody>';
    var sh=alerts.slice(0,6);
    for(var i=0;i<sh.length;i++){
      h+='<tr><td class="c">'+dotH(sh[i].severity)+'</td><td class="sm f6">'+cut(sh[i].title,55)+'</td><td class="sm muted nw">'+(sh[i].city||'-')+'</td><td class="xs dim nw">'+(sh[i].alert_type||'-')+'</td><td class="xs dim nw">'+(sh[i].created_at?fmtD(sh[i].created_at):'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';
  return h;
}

function renderSSITab(s,dist,topSSI){
  var h='<div class="tab-content"><div class="grid grid-4">';
  h+=statCard('לחץ גבוה',+(dist.high||0)+ +(dist.critical||0),'','#ff4d6a','!');
  h+=statCard('לחץ בינוני',dist.medium||'0','','#ff8c42','▲');
  h+=statCard('לחץ נמוך',dist.low||'0','','#ffc233','△');
  h+=statCard('SSI ממוצע',s.avg_ssi||'-','','#06d6a0','◎');
  h+='</div><div class="panel">'+panelH('מתחמים עם סימני מצוקה','ממוינים לפי SSI','⚡');
  if(!topSSI.length){h+='<div class="empty-msg">לא נמצאו מתחמים</div>';}
  else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c">#</th><th class="c">SSI</th><th>מתחם</th><th>עיר</th><th class="c">IAI</th><th>סטטוס</th><th>גורמים</th></tr></thead><tbody>';
    for(var i=0;i<topSSI.length;i++){
      var r=topSSI[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(' | ');
      h+='<tr><td class="c xs dim">'+(i+1)+'</td><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td><td class="f6">'+cut(r.name||r.addresses,42)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td><td class="xs muted">'+(f||'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';
  return h;
}

function renderOpp(s,topIAI){
  var h='<div class="tab-content"><div class="grid grid-3">';
  h+=statCard('סה״כ הזדמנויות',s.opportunities,'IAI 30+','#ffc233','★');
  h+=statCard('מצוינות',s.excellent,'IAI 70+','#22c55e','◆');
  h+=statCard('IAI ממוצע',s.avg_iai||'-','','#06d6a0','△');
  h+='</div><div class="panel">'+panelH('טופ הזדמנויות','ממוינות לפי IAI','★');
  h+='<div class="overflow-x"><table><thead><tr><th class="c">#</th><th class="c">IAI</th><th>מתחם</th><th>עיר</th><th class="c">SSI</th><th>יזם</th><th>סטטוס</th></tr></thead><tbody>';
  for(var i=0;i<topIAI.length;i++){
    var r=topIAI[i];
    h+='<tr><td class="c xs dim">'+(i+1)+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="f6">'+cut(r.name||r.addresses,45)+'</td><td class="nw">'+(r.city||'-')+'</td><td class="c nw">'+(r.enhanced_ssi_score?'<span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span>':'<span class="dim">-</span>')+'</td><td class="sm muted nw">'+cut(r.developer,20)+'</td><td class="xs dim nw">'+(r.status||'-')+'</td></tr>';
  }
  h+='</tbody></table></div></div></div>';
  return h;
}

function renderCities(s,cities){
  var h='<div class="tab-content"><div class="panel">'+panelH('הזדמנויות לפי ערים',(s.cities||0)+' ערים פעילות','▣');
  var t10=cities.slice(0,10),mx=1;
  for(var i=0;i<t10.length;i++){if(+t10[i].total>mx)mx=+t10[i].total;}
  h+='<div class="bar-chart">';
  for(var i=0;i<t10.length;i++){
    var c=t10[i],pctO=Math.round((+c.opportunities/mx)*100);
    h+='<div class="bar-row"><span class="bar-label">'+c.city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pctO+'%;background:#06d6a0"></div></div><span class="bar-val">'+c.opportunities+'/'+c.total+'</span></div>';
  }
  h+='</div></div>';

  h+='<div class="panel"><div class="overflow-x"><table><thead><tr><th>עיר</th><th class="c">מתחמים</th><th class="c">הזדמנויות</th><th class="c">לחוצים</th><th class="c">IAI ממוצע</th></tr></thead><tbody>';
  for(var i=0;i<cities.length;i++){
    var c=cities[i];
    h+='<tr><td class="fw">'+c.city+'</td><td class="c">'+c.total+'</td><td class="c" style="color:#06d6a0;font-weight:700">'+c.opportunities+'</td><td class="c">'+(+c.stressed>0?'<span style="color:#ff4d6a;font-weight:700">'+c.stressed+'</span>':'<span class="dim">0</span>')+'</td><td class="c" style="color:'+(+c.avg_iai>=50?'#22c55e':'#8899b4')+'">'+(c.avg_iai||'-')+'</td></tr>';
  }
  h+='</tbody></table></div></div></div>';
  return h;
}

function renderAlerts(alerts){
  var h='<div class="tab-content"><div class="panel">'+panelH('התראות','20 אחרונות','●');
  if(!alerts.length){h+='<div class="empty-msg">אין התראות</div>';}
  else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c"></th><th>כותרת</th><th>מתחם</th><th>עיר</th><th>סוג</th><th>תאריך</th></tr></thead><tbody>';
    for(var i=0;i<alerts.length;i++){
      var a=alerts[i];
      h+='<tr><td class="c">'+dotH(a.severity)+'</td><td class="sm f6">'+cut(a.title,55)+'</td><td class="sm muted nw">'+(a.complex_name||'-')+'</td><td class="sm nw">'+(a.city||'-')+'</td><td class="xs dim nw">'+(a.alert_type||'-')+'</td><td class="xs dim nw">'+(a.created_at?fmtD(a.created_at):'-')+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }
  h+='</div></div>';
  return h;
}

loadData();
</script>
</body>
</html>`);
});

module.exports = router;
