/**
 * QUANTUM Dashboard v4.14.0 - Split HTML/JS for Brave compatibility
 * HTML served from /api/dashboard/
 * JS served from /api/dashboard/app.js (separate endpoint, no inline script)
 * All event binding via createElement + addEventListener
 */

const express = require('express');
const router = express.Router();

// ===== CSS (served inline in HTML - CSS is never blocked) =====
const CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Assistant',sans-serif;background:#080c14;color:#e2e8f0;direction:rtl;-webkit-tap-highlight-color:transparent}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:#080c14}
::-webkit-scrollbar-thumb{background:#1a2744;border-radius:3px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.header{border-bottom:1px solid #1a2744;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;background:#080c14;position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:10px}
.header-logo{display:flex;align-items:center;gap:14px}
.logo-q{width:36px;height:36px;background:linear-gradient(135deg,#06d6a0,#3b82f6);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#000;font-family:'DM Serif Display',serif}
.header-title{font-size:16px;font-weight:800;letter-spacing:3px;font-family:'DM Serif Display',serif}
.header-sub{font-size:9px;color:#4a5e80;margin-right:10px;letter-spacing:1px}
.header-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{padding:8px 16px;background:transparent;border:1px solid #243352;border-radius:7px;color:#e2e8f0;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap;display:inline-block;touch-action:manipulation}
.btn:active{opacity:.7}
.btn-chat{color:#9f7aea;font-weight:700}
.btn-ssi{color:#06d6a0;font-weight:700}
.btn-ssi.loading{color:#4a5e80;cursor:default}
.btn-green{background:#06d6a0;color:#000;border-color:#06d6a0;font-weight:700}
.btn-green:active{background:#05b88a}
.btn-sm{padding:5px 10px;font-size:10px}
.time-label{font-size:10px;color:#4a5e80}
.nav{padding:0 20px;border-bottom:1px solid #1a2744;display:flex;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-btn{padding:12px 16px;background:none;border:none;border-bottom:2px solid transparent;color:#4a5e80;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap;touch-action:manipulation}
.nav-btn:active{opacity:.7}
.nav-btn.active{border-bottom-color:#06d6a0;color:#06d6a0;font-weight:700}
.main{padding:20px;max-width:1360px;margin:0 auto}
.grid{display:grid;gap:14px;margin-bottom:24px}
.grid-6{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.grid-2{grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
@media(max-width:768px){.grid-2{grid-template-columns:1fr}.grid-6{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}.header{padding:10px 14px}.nav{padding:0 14px}.main{padding:14px}.stat{padding:14px 16px}.stat-val{font-size:26px}}
.stat{background:#0f1623;border:1px solid #1a2744;border-radius:14px;padding:18px 22px;position:relative;overflow:hidden}
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
.nw{white-space:nowrap}.fw{font-weight:700}.f6{font-weight:600}.dim{color:#4a5e80}.muted{color:#8899b4}.sm{font-size:11px}.xs{font-size:10px}
.empty-msg{color:#4a5e80;padding:20px;text-align:center;font-size:13px}
.badge-ssi{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.badge-critical{background:rgba(255,77,106,.12);color:#ff4d6a}
.badge-high{background:rgba(255,140,66,.12);color:#ff8c42}
.badge-med{background:rgba(255,194,51,.12);color:#ffc233}
.badge-low{background:rgba(34,197,94,.08);color:#22c55e}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot-red{background:#ff4d6a}.dot-orange{background:#ff8c42}.dot-green{background:#22c55e}
.bar-chart{display:flex;flex-direction:column;gap:6px;padding:4px 0}
.bar-row{display:flex;align-items:center;gap:8px}
.bar-label{width:70px;font-size:10px;color:#8899b4;text-align:left;flex-shrink:0}
.bar-track{flex:1;height:14px;background:#141d2e;border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:0 3px 3px 0;transition:width .5s ease}
.bar-val{font-size:10px;color:#8899b4;width:28px;text-align:center;flex-shrink:0}
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
.filter-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;align-items:flex-end}
.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-label{font-size:10px;color:#4a5e80;letter-spacing:1px;text-transform:uppercase}
.filter-input{background:#141d2e;border:1px solid #1a2744;border-radius:6px;padding:8px 12px;color:#e2e8f0;font-size:12px;font-family:inherit;min-width:100px}
.filter-input:focus{outline:none;border-color:#06d6a0}
select.filter-input{cursor:pointer}
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
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#06d6a0;color:#000;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}`;

// ===== JavaScript (served as separate file) =====
const JS = `(function(){
"use strict";
var D=null,currentTab="overview",aggRunning=false,msgData=null;
var defaultTpl="שלום רב,\\nראיתי את המודעה שלכם ב{platform} עבור הנכס ב{address}.\\nאני מתעניין ברכישת דירות בפרויקטי פינוי-בינוי ואשמח לשמוע פרטים נוספים.\\nמתי נוח לכם לשוחח?\\nתודה";

function $(id){return document.getElementById(id);}
function ssiCls(sc){if(!sc&&sc!==0)return"";return sc>=80?"badge-critical":sc>=60?"badge-high":sc>=40?"badge-med":"badge-low";}
function ssiLbl(sc){if(!sc&&sc!==0)return"-";return sc+" "+(sc>=80?"קריטי":sc>=60?"גבוה":sc>=40?"בינוני":"נמוך");}
function iaiH(sc){if(!sc&&sc!==0)return'<span class="dim">-</span>';var c=sc>=70?"#22c55e":sc>=50?"#06d6a0":sc>=30?"#ffc233":"#4a5e80";return'<span style="color:'+c+';font-weight:700;font-size:13px">'+sc+"</span>";}
function dotH(sev){var c=sev==="high"||sev==="critical"?"dot-red":sev==="medium"?"dot-orange":"dot-green";return'<span class="dot '+c+'"></span>';}
function cut(s,n){return s?(s.length>n?s.substring(0,n)+"...":s):"-";}
function fmtD(d){try{return new Date(d).toLocaleDateString("he-IL");}catch(e){return"-";}}
function pf(v){try{return Array.isArray(v)?v:(typeof v==="string"?JSON.parse(v||"[]"):[]);}catch(e){return[];}}
function fmtPrice(p){if(!p)return"-";var n=Math.round(+p);if(n>=1000000)return(n/1000000).toFixed(1)+"M";if(n>=1000)return Math.round(n/1000)+"K";return n+"";}

function showToast(msg){var t=$("toast");if(!t)return;t.textContent=msg;t.className="toast show";setTimeout(function(){t.className="toast";},2500);}

function copyText(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){showToast("הודעה הועתקה!");}).catch(function(){fallbackCopy(text);});
  }else{fallbackCopy(text);}
}
function fallbackCopy(text){
  var ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;opacity:0;top:0;left:0";document.body.appendChild(ta);ta.focus();ta.select();
  try{document.execCommand("copy");showToast("הודעה הועתקה!");}catch(e){showToast("שגיאה בהעתקה");}
  document.body.removeChild(ta);
}

function loadData(){
  fetch("/api/ssi/dashboard-data")
    .then(function(r){return r.json();})
    .then(function(data){
      D=data;
      $("loading").className="loading-screen hidden";
      $("app").className="";
      $("time-label").textContent=new Date().toLocaleTimeString("he-IL");
      var s=D.stats||{};
      $("footer-text").textContent="QUANTUM v4.14.0 | "+(s.total_complexes||0)+" מתחמים | "+(s.cities||0)+" ערים";
      buildNav();
      renderTab();
    })
    .catch(function(e){
      console.error("Load error:",e);
      $("loading").innerHTML='<div class="loading-q">Q</div><div style="color:#ff4d6a;font-size:14px;text-align:center">שגיאה בטעינת נתונים</div>';
      var rb=document.createElement("button");rb.className="btn";rb.textContent="נסה שוב";rb.style.marginTop="8px";
      rb.addEventListener("click",function(){location.reload();});
      $("loading").appendChild(rb);
    });
}

// Build nav with direct binding
function buildNav(){
  var nav=$("nav");
  nav.innerHTML="";
  var tabs=[
    {id:"overview",l:"סקירה"},
    {id:"ssi",l:"מוכרים לחוצים"},
    {id:"opp",l:"הזדמנויות"},
    {id:"msg",l:"הודעות"},
    {id:"cities",l:"ערים"},
    {id:"alerts",l:"התראות"}
  ];
  for(var i=0;i<tabs.length;i++){
    var b=document.createElement("button");
    b.className="nav-btn"+(tabs[i].id===currentTab?" active":"");
    b.textContent=tabs[i].l;
    (function(tid){
      b.addEventListener("click",function(e){
        e.preventDefault();
        currentTab=tid;
        buildNav();
        renderTab();
      });
    })(tabs[i].id);
    nav.appendChild(b);
  }
}

function renderTab(){
  var m=$("main");
  if(!D){m.innerHTML="";return;}
  var s=D.stats||{},dist=D.ssiDistribution||{},topSSI=D.topSSI||[],topIAI=D.topIAI||[],alerts=D.recentAlerts||[],cities=D.cityBreakdown||[],ls=D.listingStats||{};
  if(currentTab==="overview")m.innerHTML=renderOverview(s,dist,topSSI,alerts,cities,ls);
  else if(currentTab==="ssi")m.innerHTML=renderSSITab(s,dist,topSSI);
  else if(currentTab==="opp")m.innerHTML=renderOpp(s,topIAI);
  else if(currentTab==="msg"){m.innerHTML=renderMsgTab();bindMsgTab();}
  else if(currentTab==="cities")m.innerHTML=renderCities(s,cities);
  else if(currentTab==="alerts")m.innerHTML=renderAlerts(alerts);
}

function statCard(l,v,s,c,i){return'<div class="stat"><div class="stat-icon">'+i+'</div><div class="stat-label">'+l+'</div><div class="stat-val" style="color:'+c+'">'+(v!=null?v:"-")+"</div>"+(s?'<div class="stat-sub">'+s+"</div>":"")+"</div>";}
function panelH(t,s,i){return'<div class="panel-head">'+(i?'<span class="panel-head-icon">'+i+"</span>":"")+'<div><h2 class="panel-title">'+t+"</h2>"+(s?'<p class="panel-sub">'+s+"</p>":"")+"</div></div>";}

function renderOverview(s,dist,topSSI,alerts,cities,ls){
  var h='<div class="tab-content"><div class="grid grid-6">';
  h+=statCard("מתחמים",s.total_complexes,s.cities+" ערים","#06d6a0","Q");
  h+=statCard("הזדמנויות",s.opportunities,s.excellent+" מצוינות (70+)","#ffc233","★");
  h+=statCard("מוכרים לחוצים",s.stressed_sellers,s.high_stress+" ברמה גבוהה","#ff4d6a","!");
  h+=statCard("מודעות",ls.active||"0",(ls.urgent||"0")+" דחופות","#22c55e","▤");
  h+=statCard("כינוסים",(D.konesStats||{}).total||"0","נכסי כינוס","#9f7aea","⚖");
  h+=statCard("IAI ממוצע",s.avg_iai||"-","אינדקס אטרקטיביות","#3b82f6","△");
  h+="</div>";
  var goldOpp=topSSI.filter(function(x){return x.iai_score>=40;}).slice(0,5);
  if(goldOpp.length>0){
    h+='<div class="panel panel-gold">'+panelH("הזדמנויות זהב","IAI גבוה + מוכר לחוץ","◆");
    h+='<div class="overflow-x"><table><thead><tr><th class="c">SSI</th><th class="c">IAI</th><th>מתחם</th><th>עיר</th><th>גורמי לחץ</th></tr></thead><tbody>';
    for(var i=0;i<goldOpp.length;i++){var r=goldOpp[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(" | ");h+='<tr><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="fw">'+cut(r.name||r.addresses,40)+'</td><td class="nw">'+(r.city||"-")+'</td><td class="xs muted">'+(f||"-")+"</td></tr>";}
    h+="</tbody></table></div></div>";
  }
  h+='<div class="grid grid-2">';
  h+='<div class="panel">'+panelH("התפלגות SSI","סימני מצוקה","◉")+'<div class="pie-legend">';
  var di=[{l:"גבוה (60+)",v:+(dist.high||0)+ +(dist.critical||0),c:"#ff4d6a"},{l:"בינוני (40-59)",v:+(dist.medium||0),c:"#ff8c42"},{l:"נמוך (20-39)",v:+(dist.low||0),c:"#ffc233"},{l:"מזערי (<20)",v:+(dist.minimal||0),c:"#4a5e80"}];
  for(var i=0;i<di.length;i++){h+='<div class="pie-row"><div class="pie-info"><div class="pie-dot" style="background:'+di[i].c+'"></div><span class="sm muted">'+di[i].l+'</span></div><span style="font-weight:700;color:'+di[i].c+';font-size:14px">'+di[i].v+"</span></div>";}
  h+="</div></div>";
  h+='<div class="panel">'+panelH("הזדמנויות לפי עיר","טופ 10","▣");
  var ct=cities.slice(0,10),mx=1;for(var i=0;i<ct.length;i++){if(+ct[i].opportunities>mx)mx=+ct[i].opportunities;}
  h+='<div class="bar-chart">';for(var i=0;i<ct.length;i++){var pct=Math.round((+ct[i].opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+ct[i].city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:#06d6a0"></div></div><span class="bar-val">'+ct[i].opportunities+"</span></div>";}
  h+="</div></div></div>";
  h+='<div class="panel">'+panelH("התראות אחרונות",alerts.length+" התראות","●");
  if(!alerts.length){h+='<div class="empty-msg">אין התראות</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c"></th><th>כותרת</th><th>עיר</th><th>סוג</th><th>תאריך</th></tr></thead><tbody>';
    var sh=alerts.slice(0,6);for(var i=0;i<sh.length;i++){h+='<tr><td class="c">'+dotH(sh[i].severity)+'</td><td class="sm f6">'+cut(sh[i].title,55)+'</td><td class="sm muted nw">'+(sh[i].city||"-")+'</td><td class="xs dim nw">'+(sh[i].alert_type||"-")+'</td><td class="xs dim nw">'+(sh[i].created_at?fmtD(sh[i].created_at):"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

function renderSSITab(s,dist,topSSI){
  var h='<div class="tab-content"><div class="grid grid-4">';
  h+=statCard("לחץ גבוה",+(dist.high||0)+ +(dist.critical||0),"","#ff4d6a","!");
  h+=statCard("לחץ בינוני",dist.medium||"0","","#ff8c42","▲");
  h+=statCard("לחץ נמוך",dist.low||"0","","#ffc233","△");
  h+=statCard("SSI ממוצע",s.avg_ssi||"-","","#06d6a0","◎");
  h+='</div><div class="panel">'+panelH("מתחמים עם סימני מצוקה","ממוינים לפי SSI","⚡");
  if(!topSSI.length){h+='<div class="empty-msg">לא נמצאו מתחמים</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c">#</th><th class="c">SSI</th><th>מתחם</th><th>עיר</th><th class="c">IAI</th><th>סטטוס</th><th>גורמים</th></tr></thead><tbody>';
    for(var i=0;i<topSSI.length;i++){var r=topSSI[i],f=pf(r.ssi_enhancement_factors).slice(0,2).join(" | ");h+='<tr><td class="c xs dim">'+(i+1)+'</td><td class="c nw"><span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+'</span></td><td class="f6">'+cut(r.name||r.addresses,42)+'</td><td class="nw">'+(r.city||"-")+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="xs dim nw">'+(r.status||"-")+'</td><td class="xs muted">'+(f||"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

function renderOpp(s,topIAI){
  var h='<div class="tab-content"><div class="grid grid-3">';
  h+=statCard("סה״כ הזדמנויות",s.opportunities,"IAI 30+","#ffc233","★");
  h+=statCard("מצוינות",s.excellent,"IAI 70+","#22c55e","◆");
  h+=statCard("IAI ממוצע",s.avg_iai||"-","","#06d6a0","△");
  h+='</div><div class="panel">'+panelH("טופ הזדמנויות","ממוינות לפי IAI","★");
  h+='<div class="overflow-x"><table><thead><tr><th class="c">#</th><th class="c">IAI</th><th>מתחם</th><th>עיר</th><th class="c">SSI</th><th>יזם</th><th>סטטוס</th></tr></thead><tbody>';
  for(var i=0;i<topIAI.length;i++){var r=topIAI[i];h+='<tr><td class="c xs dim">'+(i+1)+'</td><td class="c nw">'+iaiH(r.iai_score)+'</td><td class="f6">'+cut(r.name||r.addresses,45)+'</td><td class="nw">'+(r.city||"-")+'</td><td class="c nw">'+(r.enhanced_ssi_score?'<span class="badge-ssi '+ssiCls(r.enhanced_ssi_score)+'">'+ssiLbl(r.enhanced_ssi_score)+"</span>":'<span class="dim">-</span>')+'</td><td class="sm muted nw">'+cut(r.developer,20)+'</td><td class="xs dim nw">'+(r.status||"-")+"</td></tr>";}
  h+="</tbody></table></div></div></div>";return h;
}

/* ===== MESSAGING TAB ===== */
function renderMsgTab(){
  var cities=D.cityBreakdown||[];
  var h='<div class="tab-content">';
  h+='<div class="panel panel-gold">'+panelH("שליחת הודעות למוכרים","סנן מוכרים לחוצים ושלח הודעה מותאמת דרך הפלטפורמה","✉");
  h+='<div class="filter-bar">';
  h+='<div class="filter-group"><span class="filter-label">עיר</span><select id="msg-city" class="filter-input"><option value="">הכל</option>';
  for(var i=0;i<cities.length;i++){h+='<option value="'+cities[i].city+'">'+cities[i].city+" ("+cities[i].total+")</option>";}
  h+="</select></div>";
  h+='<div class="filter-group"><span class="filter-label">SSI מינימלי</span><select id="msg-ssi" class="filter-input"><option value="20">20+</option><option value="30" selected>30+</option><option value="40">40+</option><option value="50">50+</option><option value="60">60+</option></select></div>';
  h+='<div class="filter-group"><span class="filter-label">מחיר מקסימלי</span><select id="msg-price" class="filter-input"><option value="">ללא הגבלה</option><option value="1500000">1.5M</option><option value="2000000">2M</option><option value="2500000">2.5M</option><option value="3000000">3M</option><option value="4000000">4M</option></select></div>';
  h+='<div class="filter-group"><span class="filter-label">&nbsp;</span><button id="msg-search" class="btn btn-green">חפש מוכרים</button></div>';
  h+="</div></div>";
  h+='<div class="panel">'+panelH("תבנית הודעה","ניתן לערוך | משתנים: {platform} {address}","✎");
  h+='<textarea id="msg-tpl" class="filter-input" style="width:100%;min-height:80px;resize:vertical;line-height:1.6" dir="rtl">'+defaultTpl+"</textarea></div>";
  h+='<div id="msg-results"><div class="empty-msg">לחץ \\"חפש מוכרים\\" לטעינת תוצאות</div></div>';
  h+="</div>";return h;
}

function bindMsgTab(){
  setTimeout(function(){
    var sb=$("msg-search");
    if(sb){
      sb.addEventListener("click",function(e){e.preventDefault();searchSellers();});
    }
  },100);
}

function searchSellers(){
  var city=$("msg-city")?$("msg-city").value:"";
  var minSSI=$("msg-ssi")?$("msg-ssi").value:"30";
  var maxPrice=$("msg-price")?$("msg-price").value:"";
  var container=$("msg-results");
  if(!container)return;
  container.innerHTML='<div class="empty-msg">טוען מוכרים לחוצים...</div>';

  fetch("/api/stressed-sellers?min_ssi="+minSSI+"&limit=50")
    .then(function(r){return r.json();})
    .then(function(data){
      var sellers=data.stressed_sellers||[];
      if(city){sellers=sellers.filter(function(s){return s.city===city;});}
      if(maxPrice){sellers=sellers.filter(function(s){return +s.asking_price<=+maxPrice;});}
      msgData=sellers;
      renderMsgResults(sellers,container);
    })
    .catch(function(e){
      console.error(e);
      container.innerHTML='<div class="empty-msg" style="color:#ff4d6a">שגיאה בטעינת נתונים</div>';
    });
}

function renderMsgResults(sellers,container){
  if(!sellers.length){container.innerHTML='<div class="empty-msg">לא נמצאו מוכרים בפילטרים שנבחרו</div>';return;}
  var h='<div class="panel">'+panelH("נמצאו "+sellers.length+" מוכרים","ממוינים לפי SSI","⚡")+"</div>";
  for(var i=0;i<sellers.length;i++){
    var s=sellers[i];
    var dropPct=s.total_price_drop_percent?Math.round(+s.total_price_drop_percent)+"%":"";
    h+='<div class="msg-card" id="mc-'+i+'">';
    h+='<div class="msg-card-top"><div><div class="msg-card-addr">'+cut(s.address,50)+'</div><div class="msg-card-city">'+(s.complex_name||"")+" | "+(s.city||"-")+"</div></div>";
    h+='<div class="msg-card-badges"><span class="badge-ssi '+ssiCls(s.ssi_score)+'">SSI '+s.ssi_score+"</span>";
    if(s.iai_score)h+=" "+iaiH(s.iai_score);
    h+="</div></div>";
    h+='<div class="msg-card-row">';
    h+='<span>מחיר: <b style="color:#e2e8f0">'+fmtPrice(s.asking_price)+"</b></span>";
    if(s.original_price&&+s.original_price>+s.asking_price)h+='<span>מקורי: <s style="color:#4a5e80">'+fmtPrice(s.original_price)+"</s></span>";
    if(dropPct)h+='<span style="color:#ff4d6a">ירידה: '+dropPct+"</span>";
    h+="<span>חדרים: "+(s.rooms||"-")+"</span>";
    h+="<span>שטח: "+(s.area_sqm?Math.round(+s.area_sqm)+'מ\\"ר':"-")+"</span>";
    if(s.price_changes>0)h+='<span style="color:#ff8c42">'+s.price_changes+" הורדות מחיר</span>";
    h+="</div>";
    if(s.strategy)h+='<div class="xs muted" style="margin-bottom:8px">אסטרטגיה: '+s.strategy+(s.potential_discount?" | הנחה פוטנציאלית: "+s.potential_discount:"")+"</div>";
    h+='<div class="msg-card-actions">';
    if(s.url)h+='<a href="'+s.url+'" target="_blank" rel="noopener" class="btn btn-sm" style="color:#06d6a0">פתח ביד2</a>';
    h+='<button class="btn btn-sm btn-act" data-act="copy" data-i="'+i+'" style="color:#9f7aea">העתק הודעה</button>';
    h+='<button class="btn btn-sm btn-act" data-act="show" data-i="'+i+'" style="color:#ffc233">הצג הודעה</button>';
    h+="</div>";
    h+='<div class="msg-template" id="mp-'+i+'"></div>';
    h+="</div>";
  }
  container.innerHTML=h;
  // Direct binding on each action button
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
  var platform=seller.source==="yad2"?"יד2":"הפלטפורמה";
  var addr=seller.address||seller.city||"";
  return tpl.replace("{platform}",platform).replace("{address}",addr).replace("{price}",fmtPrice(seller.asking_price)).replace("{rooms}",seller.rooms||"").replace("{area}",seller.area_sqm?Math.round(+seller.area_sqm)+"":"");
}

function renderCities(s,cities){
  var h='<div class="tab-content"><div class="panel">'+panelH("הזדמנויות לפי ערים",(s.cities||0)+" ערים פעילות","▣");
  var t10=cities.slice(0,10),mx=1;for(var i=0;i<t10.length;i++){if(+t10[i].total>mx)mx=+t10[i].total;}
  h+='<div class="bar-chart">';for(var i=0;i<t10.length;i++){var c=t10[i],pctO=Math.round((+c.opportunities/mx)*100);h+='<div class="bar-row"><span class="bar-label">'+c.city+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pctO+'%;background:#06d6a0"></div></div><span class="bar-val">'+c.opportunities+"/"+c.total+"</span></div>";}
  h+="</div></div>";
  h+='<div class="panel"><div class="overflow-x"><table><thead><tr><th>עיר</th><th class="c">מתחמים</th><th class="c">הזדמנויות</th><th class="c">לחוצים</th><th class="c">IAI ממוצע</th></tr></thead><tbody>';
  for(var i=0;i<cities.length;i++){var c=cities[i];h+='<tr><td class="fw">'+c.city+'</td><td class="c">'+c.total+'</td><td class="c" style="color:#06d6a0;font-weight:700">'+c.opportunities+'</td><td class="c">'+(+c.stressed>0?'<span style="color:#ff4d6a;font-weight:700">'+c.stressed+"</span>":'<span class="dim">0</span>')+'</td><td class="c" style="color:'+(+c.avg_iai>=50?"#22c55e":"#8899b4")+'">'+(c.avg_iai||"-")+"</td></tr>";}
  h+="</tbody></table></div></div></div>";return h;
}

function renderAlerts(alerts){
  var h='<div class="tab-content"><div class="panel">'+panelH("התראות","20 אחרונות","●");
  if(!alerts.length){h+='<div class="empty-msg">אין התראות</div>';}else{
    h+='<div class="overflow-x"><table><thead><tr><th class="c"></th><th>כותרת</th><th>מתחם</th><th>עיר</th><th>סוג</th><th>תאריך</th></tr></thead><tbody>';
    for(var i=0;i<alerts.length;i++){var a=alerts[i];h+='<tr><td class="c">'+dotH(a.severity)+'</td><td class="sm f6">'+cut(a.title,55)+'</td><td class="sm muted nw">'+(a.complex_name||"-")+'</td><td class="sm nw">'+(a.city||"-")+'</td><td class="xs dim nw">'+(a.alert_type||"-")+'</td><td class="xs dim nw">'+(a.created_at?fmtD(a.created_at):"-")+"</td></tr>";}
    h+="</tbody></table></div>";}
  h+="</div></div>";return h;
}

// === INIT ===
// Bind header buttons directly
var ssiBtn=$("btn-ssi");
var refBtn=$("btn-refresh");
if(ssiBtn){
  ssiBtn.addEventListener("click",function(e){
    e.preventDefault();
    if(aggRunning)return;
    aggRunning=true;
    ssiBtn.textContent="...SSI";ssiBtn.classList.add("loading");
    fetch("/api/ssi/batch-aggregate",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"minListings":1,"limit":500}'})
      .then(function(){return new Promise(function(r){setTimeout(r,3000);});})
      .then(function(){loadData();})
      .catch(function(e){console.error(e);})
      .finally(function(){aggRunning=false;ssiBtn.textContent="SSI";ssiBtn.classList.remove("loading");});
  });
}
if(refBtn){
  refBtn.addEventListener("click",function(e){e.preventDefault();loadData();});
}
loadData();
})();`;

// ===== HTML endpoint =====
router.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>QUANTUM Intelligence Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>${CSS}</style>
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
      <button type="button" id="btn-ssi" class="btn btn-ssi">SSI</button>
      <button type="button" id="btn-refresh" class="btn">רענון</button>
      <span id="time-label" class="time-label"></span>
    </div>
  </header>
  <nav class="nav" id="nav"></nav>
  <main class="main" id="main"></main>
  <footer class="footer"><span id="footer-text">QUANTUM v4.14.0</span></footer>
</div>
<div id="toast" class="toast"></div>
<script src="/api/dashboard/app.js"></script>
</body>
</html>`);
});

// ===== JS endpoint (served as external file) =====
router.get('/app.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(JS);
});

module.exports = router;
