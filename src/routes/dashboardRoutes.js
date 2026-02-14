/**
 * Dashboard Routes - v4.14.1
 * Vanilla JS dashboard served from /api/dashboard/
 * JS served separately from /api/dashboard/app.js for Brave compatibility
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// Helper: format numbers
function fmtNum(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('he-IL');
}

// =====================================================
// Dashboard Data Endpoint (internal)
// =====================================================
async function getDashboardData() {
  const [stats, cities, topIAI, topSSI, alerts, lastScan] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as total_complexes,
        COUNT(*) FILTER (WHERE iai_score >= 50) as opportunities,
        COUNT(DISTINCT city) as cities,
        ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0)) as avg_iai
      FROM complexes
    `),
    pool.query(`
      SELECT c.city, COUNT(*) as total,
        COUNT(*) FILTER (WHERE c.iai_score >= 50) as opportunities,
        COUNT(*) FILTER (WHERE c.iai_score >= 70) as excellent,
        ROUND(AVG(c.iai_score) FILTER (WHERE c.iai_score > 0)) as avg_iai,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active AND l.ssi_score >= 40) as stressed
      FROM complexes c
      LEFT JOIN listings l ON c.id = l.complex_id
      GROUP BY c.city ORDER BY opportunities DESC, total DESC
    `),
    pool.query(`
      SELECT id, name, city, status, iai_score, developer, planned_units
      FROM complexes WHERE iai_score > 0
      ORDER BY iai_score DESC LIMIT 10
    `),
    pool.query(`
      SELECT l.id, l.address, l.asking_price, l.ssi_score, l.days_on_market,
        l.total_price_drop_percent, l.rooms, l.area_sqm,
        c.name as complex_name, c.city
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = TRUE AND l.ssi_score > 0
      ORDER BY l.ssi_score DESC LIMIT 10
    `),
    pool.query(`
      SELECT a.*, c.name as complex_name, c.city
      FROM alerts a JOIN complexes c ON a.complex_id = c.id
      ORDER BY a.created_at DESC LIMIT 15
    `),
    pool.query(`SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT 1`)
  ]);

  const s = stats.rows[0] || {};
  const listingCount = await pool.query('SELECT COUNT(*) as c FROM listings WHERE is_active = TRUE');
  const txCount = await pool.query('SELECT COUNT(*) as c FROM transactions');

  return {
    stats: {
      complexes: s.total_complexes || 0,
      opportunities: s.opportunities || 0,
      cities: s.cities || 0,
      avgIai: s.avg_iai || 0,
      listings: listingCount.rows[0]?.c || 0,
      transactions: txCount.rows[0]?.c || 0
    },
    cityBreakdown: cities.rows,
    topIAI: topIAI.rows,
    topSSI: topSSI.rows,
    alerts: alerts.rows,
    lastScan: lastScan.rows[0] || null
  };
}

// =====================================================
// CSS (inline in HTML - never blocked)
// =====================================================
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#080d19;color:#c8d6e5;direction:rtl;min-height:100vh;overflow-x:hidden}
.wrap{max-width:900px;margin:0 auto;padding:12px}
.hdr{text-align:center;padding:20px 0 12px}
.hdr h1{font-size:22px;background:linear-gradient(135deg,#06d6a0,#9f7aea);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;font-weight:800}
.hdr p{font-size:11px;color:#4a5e80}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.stat{background:linear-gradient(135deg,#0d1320,#141d2e);border:1px solid #1a2744;border-radius:12px;padding:12px;text-align:center}
.stat-v{font-size:22px;font-weight:800;color:#06d6a0}
.stat-l{font-size:10px;color:#4a5e80;margin-top:2px}
.nav{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:12px;-webkit-overflow-scrolling:touch}
.nav-btn{padding:8px 14px;border-radius:20px;font-size:12px;font-weight:600;background:#141d2e;color:#8899b4;border:1px solid #1a2744;cursor:pointer;white-space:nowrap;transition:all .2s}
.nav-btn.active{background:linear-gradient(135deg,rgba(6,214,160,.15),rgba(159,122,234,.15));color:#06d6a0;border-color:rgba(6,214,160,.4)}
.panel{background:#0d1320;border:1px solid #1a2744;border-radius:12px;padding:16px;margin-bottom:12px}
.panel-gold{border-color:rgba(255,194,51,.25);background:linear-gradient(135deg,rgba(255,194,51,.03),#0d1320)}
.panel-h{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1a2744}
.panel-icon{font-size:20px}
.panel-t{font-size:14px;font-weight:700;color:#e2e8f0}
.panel-st{font-size:11px;color:#4a5e80}
table{width:100%;border-collapse:collapse;font-size:12px}
thead{background:#141d2e}
th{padding:8px 6px;text-align:right;font-weight:600;color:#8899b4;font-size:11px;border-bottom:1px solid #1a2744}
td{padding:7px 6px;border-bottom:1px solid rgba(26,39,68,.5);color:#c8d6e5}
.c{text-align:center}
.fw{font-weight:600;color:#e2e8f0}
.bar-chart{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.bar-row{display:flex;align-items:center;gap:8px;font-size:11px}
.bar-label{min-width:70px;text-align:right;color:#8899b4}
.bar-track{flex:1;height:18px;background:#141d2e;border-radius:9px;overflow:hidden}
.bar-fill{height:100%;border-radius:9px;transition:width .3s}
.bar-val{min-width:45px;text-align:left;color:#e2e8f0;font-weight:600}
.badge-ssi{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700}
.ssi-high{background:rgba(255,77,106,.15);color:#ff4d6a}
.ssi-med{background:rgba(255,140,66,.15);color:#ff8c42}
.ssi-low{background:rgba(6,214,160,.1);color:#06d6a0}
.btn{display:inline-block;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;background:#141d2e;border:1px solid #1a2744;cursor:pointer;text-decoration:none;transition:all .2s;color:#8899b4;text-align:center}
.btn:hover{border-color:rgba(6,214,160,.4);color:#06d6a0}
.btn-sm{padding:4px 10px;font-size:10px;border-radius:6px}
.btn-green{background:linear-gradient(135deg,rgba(6,214,160,.15),rgba(6,214,160,.05));color:#06d6a0;border-color:rgba(6,214,160,.3)}
.btn-green:hover{background:rgba(6,214,160,.2)}
.empty-msg{color:#4a5e80;padding:20px;text-align:center;font-size:13px}
.overflow-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab-content{animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#06d6a0;color:#080d19;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
.toast.show{opacity:1}
.dim{color:#4a5e80}
.muted{color:#6b7fa3}
.xs{font-size:10px}
.filter-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-label{font-size:10px;color:#4a5e80;font-weight:600}
.filter-input{background:#141d2e;border:1px solid #1a2744;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:12px;min-width:80px}
.filter-input:focus{border-color:rgba(6,214,160,.4);outline:none}
.msg-card{background:#0d1320;border:1px solid #1a2744;border-radius:12px;padding:16px;margin-bottom:12px;transition:border-color .2s}
.msg-card:hover{border-color:rgba(6,214,160,.3)}
.msg-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.msg-card-addr{font-size:14px;font-weight:700;color:#e2e8f0}
.msg-card-city{font-size:11px;color:#8899b4}
.msg-card-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.msg-card-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:#8899b4}
.msg-card-row span{display:flex;align-items:center;gap:4px}
.msg-card-actions{display:flex;gap:8px;flex-wrap:wrap}
.msg-template{background:#141d2e;border:1px solid #1a2744;border-radius:8px;padding:12px;font-size:12px;color:#e2e8f0;line-height:1.6;margin-top:8px;white-space:pre-wrap;display:none}
.msg-template.visible{display:block}
`;

// =====================================================
// JS (served from /api/dashboard/app.js)
// =====================================================
const JS = `"use strict";
(function(){

var D=null,currentTab="overview",aggRunning=false,msgData=null;

function $(id){return document.getElementById(id);}
function cut(s,n){return s&&s.length>n?s.substring(0,n)+"...":s||"";}
function fmtPrice(v){if(!v)return"-";var n=+v;if(n>=1000000)return (n/1000000).toFixed(2)+"M \\u20aa";if(n>=1000)return Math.round(n/1000)+"K \\u20aa";return n+" \\u20aa";}
function showToast(msg){var t=$("toast");if(!t)return;t.textContent=msg;t.className="toast show";setTimeout(function(){t.className="toast";},2500);}
function ssiCls(s){return s>=50?"ssi-high":s>=30?"ssi-med":"ssi-low";}
function iaiH(v){if(!v)return"";return '<span style="font-size:10px;padding:2px 6px;border-radius:10px;background:'+(v>=70?'rgba(34,197,94,.15);color:#22c55e':v>=50?'rgba(6,214,160,.1);color:#06d6a0':'rgba(255,194,51,.1);color:#ffc233')+'">IAI '+v+"</span>";}
function panelH(t,st,icon){return '<div class="panel-h"><span class="panel-icon">'+(icon||"")+'</span><div><div class="panel-t">'+t+"</div>"+(st?'<div class="panel-st">'+st+"</div>":"")+"</div></div>";}
var defaultTpl="\\u05e9\\u05dc\\u05d5\\u05dd \\u05e8\\u05d1,\\n\\u05e8\\u05d0\\u05d9\\u05ea\\u05d9 \\u05d0\\u05ea \\u05d4\\u05de\\u05d5\\u05d3\\u05e2\\u05d4 \\u05e9\\u05dc\\u05db\\u05dd \\u05d1{platform} \\u05e2\\u05d1\\u05d5\\u05e8 \\u05d4\\u05e0\\u05db\\u05e1 \\u05d1{address}.\\n\\u05d0\\u05e0\\u05d9 \\u05de\\u05ea\\u05e2\\u05e0\\u05d9\\u05d9\\u05df \\u05d1\\u05e8\\u05db\\u05d9\\u05e9\\u05ea \\u05d3\\u05d9\\u05e8\\u05d5\\u05ea \\u05d1\\u05e4\\u05e8\\u05d5\\u05d9\\u05e7\\u05d8\\u05d9 \\u05e4\\u05d9\\u05e0\\u05d5\\u05d9-\\u05d1\\u05d9\\u05e0\\u05d5\\u05d9 \\u05d5\\u05d0\\u05e9\\u05de\\u05d7 \\u05dc\\u05e9\\u05de\\u05d5\\u05e2 \\u05e4\\u05e8\\u05d8\\u05d9\\u05dd \\u05e0\\u05d5\\u05e1\\u05e4\\u05d9\\u05dd.\\n\\u05de\\u05ea\\u05d9 \\u05e0\\u05d5\\u05d7 \\u05dc\\u05db\\u05dd \\u05dc\\u05e9\\u05d5\\u05d7\\u05d7?\\n\\u05ea\\u05d5\\u05d3\\u05d4";
function copyText(txt){if(navigator.clipboard){navigator.clipboard.writeText(txt).then(function(){showToast("\\u05d4\\u05d5\\u05d3\\u05e2\\u05d4 \\u05d4\\u05d5\\u05e2\\u05ea\\u05e7\\u05d4 \\u05dc\\u05dc\\u05d5\\u05d7");});} else{var ta=document.createElement("textarea");ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);showToast("\\u05d4\\u05d5\\u05d3\\u05e2\\u05d4 \\u05d4\\u05d5\\u05e2\\u05ea\\u05e7\\u05d4 \\u05dc\\u05dc\\u05d5\\u05d7");}}

function init(){
  fetch("/api/dashboard-json")
    .then(function(r){return r.json();})
    .then(function(data){
      D={stats:{complexes:0,opportunities:0,cities:0,avgIai:0,listings:0,transactions:0},cityBreakdown:[],topIAI:[],topSSI:[],alerts:[],lastScan:null};
      try{
        var dd=data;
        var opps=dd.top_opportunities||[];
        var stressed=dd.top_stressed_sellers||[];
        D.topIAI=opps;D.topSSI=stressed;D.alerts=dd.recent_alerts||[];D.lastScan=dd.last_scan;
        D.stats.opportunities=opps.length;
        fetch("/api/dashboard/data").then(function(r2){return r2.json();}).then(function(full){
          D=full;render();
        }).catch(function(){render();});
      }catch(e){render();}
    })
    .catch(function(err){
      console.error("Dashboard load error:",err);
      document.getElementById("app").innerHTML='<div style="text-align:center;padding:40px;color:#ff4d6a"><h2>Error loading dashboard</h2><p>'+err.message+"</p></div>";
    });
}

function render(){
  var s=D.stats,cities=D.cityBreakdown||[];
  var app=$("app");if(!app)return;
  var h='<div class="hdr"><h1>QUANTUM Dashboard</h1><p>v4.14.1 | '+s.complexes+' \\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd | '+s.listings+' \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea | '+s.transactions+' \\u05e2\\u05e1\\u05e7\\u05d0\\u05d5\\u05ea</p></div>';
  h+='<div class="stats">';
  h+='<div class="stat"><div class="stat-v">'+s.complexes+'</div><div class="stat-l">\\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd</div></div>';
  h+='<div class="stat"><div class="stat-v" style="color:#9f7aea">'+s.opportunities+'</div><div class="stat-l">\\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea</div></div>';
  h+='<div class="stat"><div class="stat-v" style="color:#ffc233">'+s.avgIai+'</div><div class="stat-l">IAI \\u05de\\u05de\\u05d5\\u05e6\\u05e2</div></div>';
  h+='</div>';
  h+='<div class="nav" id="nav-bar"></div>';
  h+='<div id="main-content"></div>';
  h+='<div id="toast" class="toast"></div>';
  app.innerHTML=h;
  var tabs=[
    {id:"overview",l:"\\u05e1\\u05e7\\u05d9\\u05e8\\u05d4"},
    {id:"sellers",l:"\\u05de\\u05d5\\u05db\\u05e8\\u05d9\\u05dd \\u05dc\\u05d7\\u05d5\\u05e6\\u05d9\\u05dd"},
    {id:"opps",l:"\\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea"},
    {id:"msg",l:"\\u05d4\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea"},
    {id:"cities",l:"\\u05e2\\u05e8\\u05d9\\u05dd"},
    {id:"alerts",l:"\\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea"}
  ];
  var nav=$("nav-bar");
  for(var i=0;i<tabs.length;i++){
    var b=document.createElement("button");
    b.className="nav-btn"+(tabs[i].id===currentTab?" active":"");
    b.textContent=tabs[i].l;
    b.setAttribute("data-tab",tabs[i].id);
    (function(tab){
      b.addEventListener("click",function(e){
        e.preventDefault();currentTab=tab;
        var allB=nav.querySelectorAll(".nav-btn");
        for(var j=0;j<allB.length;j++){allB[j].className="nav-btn"+(allB[j].getAttribute("data-tab")===tab?" active":"");}
        showTab();
      });
    })(tabs[i].id);
    nav.appendChild(b);
  }
  showTab();
}

function showTab(){
  var m=$("main-content");if(!m)return;
  if(currentTab==="overview"){m.innerHTML=renderOverview();}
  else if(currentTab==="sellers"){m.innerHTML=renderSellers();}
  else if(currentTab==="opps"){m.innerHTML=renderOpps();}
  else if(currentTab==="msg"){m.innerHTML=renderMsgTab();bindMsgTab();}
  else if(currentTab==="cities"){m.innerHTML=renderCities(D.stats,D.cityBreakdown||[]);}
  else if(currentTab==="alerts"){m.innerHTML=renderAlerts();}
}

function renderOverview(){
  var s=D.stats,topIAI=D.topIAI||[],topSSI=D.topSSI||[],alerts=D.alerts||[];
  var h='<div class="tab-content">';
  // Alerts
  h+='<div class="panel">'+panelH("\\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea \\u05d0\\u05d7\\u05e8\\u05d5\\u05e0\\u05d5\\u05ea",alerts.length+" \\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea","\\u26a1");
  if(!alerts.length){h+='<div class="empty-msg">\\u05d0\\u05d9\\u05df \\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05de\\u05ea\\u05d7\\u05dd</th><th>\\u05e2\\u05d9\\u05e8</th><th>\\u05e1\\u05d5\\u05d2</th><th>\\u05ea\\u05d0\\u05e8\\u05d9\\u05da</th></tr></thead><tbody>';
    for(var i=0;i<Math.min(alerts.length,5);i++){var a=alerts[i];h+='<tr><td class="fw">'+cut(a.complex_name,25)+"</td><td>"+cut(a.city,12)+"</td><td>"+cut(a.type||a.alert_type,15)+"</td><td>"+cut(a.created_at?a.created_at.substring(0,10):"",10)+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div>";
  // Top IAI
  h+='<div class="panel">'+panelH("Top 10 \\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea",s.opportunities+" \\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd \\u05e2\\u05dd IAI \\u05d2\\u05d1\\u05d5\\u05d4","\\u2b50");
  if(!topIAI.length){h+='<div class="empty-msg">\\u05dc\\u05d0 \\u05e0\\u05de\\u05e6\\u05d0\\u05d5 \\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05de\\u05ea\\u05d7\\u05dd</th><th>\\u05e2\\u05d9\\u05e8</th><th class="c">IAI</th><th>\\u05e1\\u05d8\\u05d8\\u05d5\\u05e1</th><th>\\u05d9\\u05d6\\u05dd</th></tr></thead><tbody>';
    for(var i=0;i<topIAI.length;i++){var o=topIAI[i];h+='<tr><td class="fw">'+cut(o.name,25)+"</td><td>"+cut(o.city,12)+'</td><td class="c">'+iaiH(o.iai_score)+"</td><td>"+cut(o.status,12)+"</td><td>"+cut(o.developer,15)+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div>";
  // Top SSI
  h+='<div class="panel">'+panelH("\\u05de\\u05d5\\u05db\\u05e8\\u05d9\\u05dd \\u05dc\\u05d7\\u05d5\\u05e6\\u05d9\\u05dd","Top 10 \\u05dc\\u05e4\\u05d9 SSI","\\ud83d\\udea8");
  if(!topSSI.length){h+='<div class="empty-msg">\\u05dc\\u05d0 \\u05e0\\u05de\\u05e6\\u05d0\\u05d5</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05db\\u05ea\\u05d5\\u05d1\\u05ea</th><th>\\u05e2\\u05d9\\u05e8</th><th class="c">SSI</th><th class="c">\\u05de\\u05d7\\u05d9\\u05e8</th><th class="c">\\u05d9\\u05de\\u05d9\\u05dd</th></tr></thead><tbody>';
    for(var i=0;i<topSSI.length;i++){var ss=topSSI[i];h+='<tr><td class="fw">'+cut(ss.address||ss.complex_name,25)+"</td><td>"+cut(ss.city,12)+'</td><td class="c"><span class="badge-ssi '+ssiCls(ss.ssi_score)+'">'+ss.ssi_score+'</span></td><td class="c">'+fmtPrice(ss.asking_price)+'</td><td class="c">'+(ss.days_on_market||"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

function renderSellers(){
  var topSSI=D.topSSI||[];
  var h='<div class="tab-content"><div class="panel">'+panelH("\\u05de\\u05d5\\u05db\\u05e8\\u05d9\\u05dd \\u05dc\\u05d7\\u05d5\\u05e6\\u05d9\\u05dd","\\u05de\\u05de\\u05d5\\u05d9\\u05e0\\u05d9\\u05dd \\u05dc\\u05e4\\u05d9 SSI","\\ud83d\\udea8");
  if(!topSSI.length){h+='<div class="empty-msg">\\u05dc\\u05d0 \\u05e0\\u05de\\u05e6\\u05d0\\u05d5 \\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05db\\u05ea\\u05d5\\u05d1\\u05ea</th><th>\\u05de\\u05ea\\u05d7\\u05dd</th><th>\\u05e2\\u05d9\\u05e8</th><th class="c">SSI</th><th class="c">\\u05de\\u05d7\\u05d9\\u05e8</th><th class="c">\\u05d9\\u05de\\u05d9\\u05dd</th><th class="c">\\u05d9\\u05e8\\u05d9\\u05d3\\u05d4</th></tr></thead><tbody>';
    for(var i=0;i<topSSI.length;i++){var s=topSSI[i];var dropPct=s.total_price_drop_percent?Math.round(+s.total_price_drop_percent)+"%":"";h+='<tr><td class="fw">'+cut(s.address,20)+"</td><td>"+cut(s.complex_name,18)+"</td><td>"+cut(s.city,10)+'</td><td class="c"><span class="badge-ssi '+ssiCls(s.ssi_score)+'">'+s.ssi_score+'</span></td><td class="c">'+fmtPrice(s.asking_price)+'</td><td class="c">'+(s.days_on_market||"-")+'</td><td class="c" style="color:#ff4d6a">'+(dropPct||"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

function renderOpps(){
  var topIAI=D.topIAI||[];
  var h='<div class="tab-content"><div class="panel">'+panelH("\\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea \\u05d4\\u05e9\\u05e7\\u05e2\\u05d4","\\u05de\\u05de\\u05d5\\u05d9\\u05e0\\u05d9\\u05dd \\u05dc\\u05e4\\u05d9 IAI","\\u2b50");
  if(!topIAI.length){h+='<div class="empty-msg">\\u05dc\\u05d0 \\u05e0\\u05de\\u05e6\\u05d0\\u05d5 \\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05de\\u05ea\\u05d7\\u05dd</th><th>\\u05e2\\u05d9\\u05e8</th><th class="c">IAI</th><th>\\u05e1\\u05d8\\u05d8\\u05d5\\u05e1</th><th>\\u05d9\\u05d6\\u05dd</th><th class="c">\\u05d9\\u05d7\\u05d3\\u05d5\\u05ea</th></tr></thead><tbody>';
    for(var i=0;i<topIAI.length;i++){var o=topIAI[i];h+='<tr><td class="fw">'+cut(o.name,22)+"</td><td>"+cut(o.city,10)+'</td><td class="c">'+iaiH(o.iai_score)+"</td><td>"+cut(o.status,12)+"</td><td>"+cut(o.developer,15)+'</td><td class="c">'+(o.planned_units||"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

var msgFilterOpts=null;

function renderMsgTab(){
  var h='<div class="tab-content">';
  h+='<div class="panel panel-gold">'+panelH("\\u05d7\\u05d9\\u05e4\\u05d5\\u05e9 \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea \\u05d5\\u05e9\\u05dc\\u05d9\\u05d7\\u05ea \\u05d4\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea","\\u05e1\\u05e0\\u05df \\u05dc\\u05e4\\u05d9 \\u05e2\\u05d9\\u05e8, \\u05d7\\u05d3\\u05e8\\u05d9\\u05dd, \\u05e9\\u05d8\\u05d7, \\u05de\\u05d7\\u05d9\\u05e8, \\u05d9\\u05de\\u05d9\\u05dd \\u05d1\\u05e9\\u05d5\\u05e7 \\u05d5\\u05e2\\u05d5\\u05d3","\\u2709");
  h+='<div id="msg-filters-area"><div class="empty-msg">\\u05d8\\u05d5\\u05e2\\u05df \\u05e4\\u05d9\\u05dc\\u05d8\\u05e8\\u05d9\\u05dd...</div></div>';
  h+="</div>";
  h+='<div class="panel">'+panelH("\\u05ea\\u05d1\\u05e0\\u05d9\\u05ea \\u05d4\\u05d5\\u05d3\\u05e2\\u05d4","\\u05e0\\u05d9\\u05ea\\u05df \\u05dc\\u05e2\\u05e8\\u05d5\\u05da | \\u05de\\u05e9\\u05ea\\u05e0\\u05d9\\u05dd: {platform} {address} {price} {rooms} {area}","\\u270e");
  h+='<textarea id="msg-tpl" class="filter-input" style="width:100%;min-height:80px;resize:vertical;line-height:1.6" dir="rtl">'+defaultTpl+"</textarea></div>";
  h+='<div id="msg-results"><div class="empty-msg">\\u05d4\\u05d2\\u05d3\\u05e8 \\u05e4\\u05d9\\u05dc\\u05d8\\u05e8\\u05d9\\u05dd \\u05d5\\u05dc\\u05d7\\u05e5 "\\u05d7\\u05e4\\u05e9 \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea"</div></div>';
  h+="</div>";return h;
}

function bindMsgTab(){
  setTimeout(function(){
    if(!msgFilterOpts){
      fetch("/api/listings/filter-options")
        .then(function(r){return r.json();})
        .then(function(opts){
          msgFilterOpts=opts;
          renderMsgFilters(opts);
        })
        .catch(function(){renderMsgFilters(null);});
    } else {
      renderMsgFilters(msgFilterOpts);
    }
  },100);
}

function renderMsgFilters(opts){
  var area=$("msg-filters-area");
  if(!area)return;
  var cities=(opts&&opts.cities)||[];
  var h='<div class="filter-bar" style="flex-wrap:wrap;gap:8px">';
  h+='<div class="filter-group"><span class="filter-label">\\u05e2\\u05d9\\u05e8</span><select id="msg-city" class="filter-input"><option value="">\\u05d4\\u05db\\u05dc</option>';
  for(var i=0;i<cities.length;i++){h+='<option value="'+cities[i].city+'">'+cities[i].city+" ("+cities[i].count+")</option>";}
  h+="</select></div>";
  h+='<div class="filter-group"><span class="filter-label">\\u05d7\\u05d3\\u05e8\\u05d9\\u05dd</span><div style="display:flex;gap:4px"><select id="msg-min-rooms" class="filter-input" style="width:65px"><option value="">\\u05de-</option><option value="2">2</option><option value="2.5">2.5</option><option value="3">3</option><option value="3.5">3.5</option><option value="4">4</option><option value="5">5</option></select><select id="msg-max-rooms" class="filter-input" style="width:65px"><option value="">\\u05e2\\u05d3</option><option value="3">3</option><option value="3.5">3.5</option><option value="4">4</option><option value="4.5">4.5</option><option value="5">5</option><option value="6">6+</option></select></div></div>';
  h+='<div class="filter-group"><span class="filter-label">\\u05e9\\u05d8\\u05d7 (\\u05de\\"\\u05e8)</span><div style="display:flex;gap:4px"><input id="msg-min-area" class="filter-input" type="number" placeholder="\\u05de-" style="width:60px"><input id="msg-max-area" class="filter-input" type="number" placeholder="\\u05e2\\u05d3" style="width:60px"></div></div>';
  h+='<div class="filter-group"><span class="filter-label">\\u05de\\u05d7\\u05d9\\u05e8</span><div style="display:flex;gap:4px"><select id="msg-min-price" class="filter-input" style="width:80px"><option value="">\\u05de-</option><option value="500000">500K</option><option value="1000000">1M</option><option value="1500000">1.5M</option><option value="2000000">2M</option></select><select id="msg-max-price" class="filter-input" style="width:80px"><option value="">\\u05e2\\u05d3</option><option value="1500000">1.5M</option><option value="2000000">2M</option><option value="2500000">2.5M</option><option value="3000000">3M</option><option value="4000000">4M</option><option value="5000000">5M</option></select></div></div>';
  h+='<div class="filter-group"><span class="filter-label">SSI \\u05de\\u05d9\\u05e0\\u05d9\\u05de\\u05dc\\u05d9</span><select id="msg-ssi" class="filter-input"><option value="">\\u05dc\\u05dc\\u05d0</option><option value="10">10+</option><option value="20">20+</option><option value="30">30+</option><option value="40">40+</option><option value="50">50+</option></select></div>';
  h+='<div class="filter-group"><span class="filter-label">\\u05e4\\u05d5\\u05e8\\u05e1\\u05dd \\u05dc\\u05e4\\u05e0\\u05d9</span><select id="msg-days" class="filter-input"><option value="">\\u05d4\\u05db\\u05dc</option><option value="1">\\u05d9\\u05d5\\u05dd+</option><option value="2">\\u05d9\\u05d5\\u05de\\u05d9\\u05d9\\u05dd+</option><option value="3">3 \\u05d9\\u05de\\u05d9\\u05dd+</option><option value="7">\\u05e9\\u05d1\\u05d5\\u05e2+</option><option value="14">\\u05e9\\u05d1\\u05d5\\u05e2\\u05d9\\u05d9\\u05dd+</option><option value="30">\\u05d7\\u05d5\\u05d3\\u05e9+</option></select></div>';
  h+='<div class="filter-group"><span class="filter-label">\\u05de\\u05d9\\u05d5\\u05df</span><select id="msg-sort" class="filter-input"><option value="ssi">SSI (\\u05d2\\u05d1\\u05d5\\u05d4)</option><option value="price">\\u05de\\u05d7\\u05d9\\u05e8 (\\u05e0\\u05de\\u05d5\\u05da)</option><option value="rooms">\\u05d7\\u05d3\\u05e8\\u05d9\\u05dd</option><option value="area">\\u05e9\\u05d8\\u05d7</option><option value="days">\\u05d9\\u05de\\u05d9\\u05dd \\u05d1\\u05e9\\u05d5\\u05e7</option><option value="date">\\u05ea\\u05d0\\u05e8\\u05d9\\u05da \\u05e4\\u05e8\\u05e1\\u05d5\\u05dd</option></select></div>';
  h+='<div class="filter-group"><span class="filter-label">&nbsp;</span><button id="msg-search" class="btn btn-green" style="padding:8px 24px">\\u05d7\\u05e4\\u05e9 \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea</button></div>';
  h+="</div>";
  area.innerHTML=h;
  var sb=$("msg-search");
  if(sb){sb.addEventListener("click",function(e){e.preventDefault();searchSellers();});}
}

function searchSellers(){
  var p=[];
  var city=$("msg-city")?$("msg-city").value:"";
  if(city)p.push("city="+encodeURIComponent(city));
  var minR=$("msg-min-rooms")?$("msg-min-rooms").value:"";
  if(minR)p.push("min_rooms="+minR);
  var maxR=$("msg-max-rooms")?$("msg-max-rooms").value:"";
  if(maxR)p.push("max_rooms="+maxR);
  var minA=$("msg-min-area")?$("msg-min-area").value:"";
  if(minA)p.push("min_area="+minA);
  var maxA=$("msg-max-area")?$("msg-max-area").value:"";
  if(maxA)p.push("max_area="+maxA);
  var minP=$("msg-min-price")?$("msg-min-price").value:"";
  if(minP)p.push("min_price="+minP);
  var maxP=$("msg-max-price")?$("msg-max-price").value:"";
  if(maxP)p.push("max_price="+maxP);
  var ssi=$("msg-ssi")?$("msg-ssi").value:"";
  if(ssi)p.push("min_ssi="+ssi);
  var days=$("msg-days")?$("msg-days").value:"";
  if(days)p.push("min_days_on_market="+days);
  var sort=$("msg-sort")?$("msg-sort").value:"ssi";
  p.push("sort_by="+sort);
  var sortOrd=(sort==="price")?"asc":"desc";
  p.push("sort_order="+sortOrd);
  p.push("limit=50");

  var container=$("msg-results");
  if(!container)return;
  container.innerHTML='<div class="empty-msg">\\u05d8\\u05d5\\u05e2\\u05df \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea...</div>';

  fetch("/api/listings/search?"+p.join("&"))
    .then(function(r){return r.json();})
    .then(function(data){
      var sellers=data.listings||[];
      msgData=sellers;
      var totalStr=data.total?" (\\u05de\\u05ea\\u05d5\\u05da "+data.total+" \\u05e1\\u05d4\\"\\u05db)":"";
      renderMsgResults(sellers,container,totalStr);
    })
    .catch(function(e){
      console.error(e);
      container.innerHTML='<div class="empty-msg" style="color:#ff4d6a">\\u05e9\\u05d2\\u05d9\\u05d0\\u05d4 \\u05d1\\u05d8\\u05e2\\u05d9\\u05e0\\u05ea \\u05e0\\u05ea\\u05d5\\u05e0\\u05d9\\u05dd</div>';
    });
}

function renderMsgResults(sellers,container,totalStr){
  if(!sellers.length){container.innerHTML='<div class="empty-msg">\\u05dc\\u05d0 \\u05e0\\u05de\\u05e6\\u05d0\\u05d5 \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea \\u05d1\\u05e4\\u05d9\\u05dc\\u05d8\\u05e8\\u05d9\\u05dd \\u05e9\\u05e0\\u05d1\\u05d7\\u05e8\\u05d5</div>';return;}
  var h='<div class="panel">'+panelH("\\u05e0\\u05de\\u05e6\\u05d0\\u05d5 "+sellers.length+" \\u05de\\u05d5\\u05d3\\u05e2\\u05d5\\u05ea"+(totalStr||""),"","\\u26a1")+"</div>";
  for(var i=0;i<sellers.length;i++){
    var s=sellers[i];
    var dropPct=s.total_price_drop_percent?Math.round(+s.total_price_drop_percent)+"%":"";
    h+='<div class="msg-card" id="mc-'+i+'">';
    h+='<div class="msg-card-top"><div><div class="msg-card-addr">'+cut(s.address,50)+'</div><div class="msg-card-city">'+(s.complex_name||"")+" | "+(s.city||"-")+"</div></div>";
    h+='<div class="msg-card-badges"><span class="badge-ssi '+ssiCls(s.ssi_score)+'">SSI '+s.ssi_score+"</span>";
    if(s.iai_score)h+=" "+iaiH(s.iai_score);
    h+="</div></div>";
    h+='<div class="msg-card-row">';
    h+='<span>\\u05de\\u05d7\\u05d9\\u05e8: <b style="color:#e2e8f0">'+fmtPrice(s.asking_price)+"</b></span>";
    if(s.original_price&&+s.original_price>+s.asking_price)h+='<span>\\u05de\\u05e7\\u05d5\\u05e8\\u05d9: <s style="color:#4a5e80">'+fmtPrice(s.original_price)+"</s></span>";
    if(dropPct)h+='<span style="color:#ff4d6a">\\u05d9\\u05e8\\u05d9\\u05d3\\u05d4: '+dropPct+"</span>";
    h+="<span>\\u05d7\\u05d3\\u05e8\\u05d9\\u05dd: "+(s.rooms||"-")+"</span>";
    h+="<span>\\u05e9\\u05d8\\u05d7: "+(s.area_sqm?Math.round(+s.area_sqm)+'\\u05de\\"\\u05e8':"-")+"</span>";
    if(s.price_changes>0)h+='<span style="color:#ff8c42">'+s.price_changes+" \\u05d4\\u05d5\\u05e8\\u05d3\\u05d5\\u05ea \\u05de\\u05d7\\u05d9\\u05e8</span>";
    h+="</div>";
    if(s.strategy)h+='<div class="xs muted" style="margin-bottom:8px">\\u05d0\\u05e1\\u05d8\\u05e8\\u05d8\\u05d2\\u05d9\\u05d4: '+s.strategy+(s.potential_discount?" | \\u05d4\\u05e0\\u05d7\\u05d4 \\u05e4\\u05d5\\u05d8\\u05e0\\u05e6\\u05d9\\u05d0\\u05dc\\u05d9\\u05ea: "+s.potential_discount:"")+"</div>";
    h+='<div class="msg-card-actions">';
    if(s.url)h+='<a href="'+s.url+'" target="_blank" rel="noopener" class="btn btn-sm" style="color:#06d6a0">\\u05e4\\u05ea\\u05d7 \\u05d1\\u05d9\\u05d3 2</a>';
    h+='<button class="btn btn-sm btn-act" data-act="copy" data-i="'+i+'" style="color:#9f7aea">\\u05d4\\u05e2\\u05ea\\u05e7 \\u05d4\\u05d5\\u05d3\\u05e2\\u05d4</button>';
    h+='<button class="btn btn-sm btn-act" data-act="show" data-i="'+i+'" style="color:#ffc233">\\u05d4\\u05e6\\u05d2 \\u05d4\\u05d5\\u05d3\\u05e2\\u05d4</button>';
    h+="</div>";
    h+='<div class="msg-template" id="mp-'+i+'"></div>';
    h+="</div>";
  }
  container.innerHTML=h;
  setTimeout(function(){
    var btns=container.querySelectorAll(".btn-act");
    for(var j=0;j<btns.length;j++){
      (function(btn){
        btn.addEventListener("click",function(e){
          e.preventDefault();
          var act=btn.getAttribute("data-act");
          var idx=parseInt(btn.getAttribute("data-i"),10);
          if(!msgData||!msgData[idx])return;
          var msg=buildMsg(msgData[idx]);
          if(act==="copy"){copyText(msg);}
          else if(act==="show"){
            var pv=$("mp-"+idx);
            if(pv){
              if(pv.className.indexOf("visible")>=0){pv.className="msg-template";}
              else{pv.textContent=msg;pv.className="msg-template visible";}
            }
          }
        });
      })(btns[j]);
    }
  },100);
}

function buildMsg(seller){
  var tplEl=$("msg-tpl");
  var tpl=tplEl?tplEl.value:defaultTpl;
  var platform=seller.source==="yad2"?"\\u05d9\\u05d3 2":"\\u05d4\\u05e4\\u05dc\\u05d8\\u05e4\\u05d5\\u05e8\\u05de\\u05d4";
  var addr=seller.address||seller.city||"";
  return tpl.replace("{platform}",platform).replace("{address}",addr).replace("{price}",fmtPrice(seller.asking_price)).replace("{rooms}",seller.rooms||"").replace("{area}",seller.area_sqm?Math.round(+seller.area_sqm)+"":"");
}

function renderCities(s,cities){
  var h='<div class="tab-content"><div class="panel">'+panelH("\\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea \\u05dc\\u05e4\\u05d9 \\u05e2\\u05e8\\u05d9\\u05dd",(s.cities||0)+" \\u05e2\\u05e8\\u05d9\\u05dd \\u05e4\\u05e2\\u05d9\\u05dc\\u05d5\\u05ea","\\u25a3");
  var t10=cities.slice(0,10),mx=1;for(var i=0;i<t10.length;i++){if(+t10[i].total>mx)mx=+t10[i].total;}
  h+='<div class="bar-chart">';for(var i=0;i<t10.length;i++){var c=t10[i],pctO=Math.round((+c.opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+c.city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pctO+'%;background:#06d6a0"></div></div><span class="bar-val">'+c.opportunities+"/"+c.total+"</span></div>";}
  h+="</div></div>";
  h+='<div class="panel"><div class="overflow-x"><table><thead><tr><th>\\u05e2\\u05d9\\u05e8</th><th class="c">\\u05de\\u05ea\\u05d7\\u05de\\u05d9\\u05dd</th><th class="c">\\u05d4\\u05d6\\u05d3\\u05de\\u05e0\\u05d5\\u05d9\\u05d5\\u05ea</th><th class="c">\\u05dc\\u05d7\\u05d5\\u05e6\\u05d9\\u05dd</th><th class="c">IAI \\u05de\\u05de\\u05d5\\u05e6\\u05e2</th></tr></thead><tbody>';
  for(var i=0;i<cities.length;i++){var c=cities[i];h+='<tr><td class="fw">'+c.city+'</td><td class="c">'+c.total+'</td><td class="c" style="color:#06d6a0;font-weight:700">'+c.opportunities+'</td><td class="c">'+(+c.stressed>0?'<span style="color:#ff4d6a;font-weight:700">'+c.stressed+"</span>":'<span class="dim">0</span>')+'</td><td class="c" style="color:'+(+c.avg_iai>=50?"#22c55e":"#8899b4")+'\">'+(c.avg_iai||"-")+"</td></tr>";}
  h+="</tbody></table></div></div></div>";return h;
}

function renderAlerts(){
  var alerts=D.alerts||[];
  var h='<div class="tab-content"><div class="panel">'+panelH("\\u05db\\u05dc \\u05d4\\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea",alerts.length+" \\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea \\u05d0\\u05d7\\u05e8\\u05d5\\u05e0\\u05d5\\u05ea","\\ud83d\\udd14");
  if(!alerts.length){h+='<div class="empty-msg">\\u05d0\\u05d9\\u05df \\u05d4\\u05ea\\u05e8\\u05d0\\u05d5\\u05ea</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th>\\u05de\\u05ea\\u05d7\\u05dd</th><th>\\u05e2\\u05d9\\u05e8</th><th>\\u05e1\\u05d5\\u05d2</th><th>\\u05e4\\u05e8\\u05d8\\u05d9\\u05dd</th><th>\\u05ea\\u05d0\\u05e8\\u05d9\\u05da</th></tr></thead><tbody>';
    for(var i=0;i<alerts.length;i++){var a=alerts[i];h+='<tr><td class="fw">'+cut(a.complex_name,22)+"</td><td>"+cut(a.city,10)+"</td><td>"+cut(a.type||a.alert_type,12)+"</td><td>"+cut(a.details||a.message||"",30)+"</td><td>"+cut(a.created_at?a.created_at.substring(0,10):"",10)+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

document.addEventListener("DOMContentLoaded",init);

})();`;

// =====================================================
// Routes
// =====================================================

// GET /api/dashboard/ - HTML page
router.get('/', async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QUANTUM Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap" id="app">
  <div style="text-align:center;padding:40px">
    <div style="font-size:24px;color:#06d6a0;margin-bottom:8px">QUANTUM</div>
    <div style="color:#4a5e80;font-size:13px">Loading dashboard...</div>
  </div>
</div>
<script src="/api/dashboard/app.js"></script>
</body>
</html>`);
  } catch (err) {
    logger.error('Dashboard HTML error', { error: err.message });
    res.status(500).send('Dashboard error');
  }
});

// GET /api/dashboard/app.js - JavaScript file
router.get('/app.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(JS);
});

// GET /api/dashboard/data - Full dashboard data endpoint
router.get('/data', async (req, res) => {
  try {
    const data = await getDashboardData();
    res.json(data);
  } catch (err) {
    logger.error('Dashboard data error', { error: err.message });
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

module.exports = router;
