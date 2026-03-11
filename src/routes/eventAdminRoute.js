/**
 * QUANTUM Event Admin UI — v1.3
 * login screen visible by default; no nested template literals
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { logger } = require('../services/logger');

const EXPECTED_AUTH = process.env.EVENT_BASIC_AUTH || 'Basic UVVBTlRVTTpkZDRhN2U5YS0xOWYyLTQzYjktOTM2Yy01YmQ0OTRlZWRjNWM=';

function apiAuth(req, res, next) {
  if ((req.headers['authorization'] || '') === EXPECTED_AUTH) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

router.post('/:id/attendees', apiAuth, async (req, res) => {
  try {
    const { station_id, name, phone, unit_number, floor, building_name, compound_name } = req.body;
    if (!station_id || !name) return res.status(400).json({ success: false, error: 'station_id and name required' });
    const { rows: st } = await pool.query('SELECT id FROM event_stations WHERE id=$1 AND event_id=$2', [station_id, req.params.id]);
    if (!st.length) return res.status(404).json({ success: false, error: 'Station not found' });
    const { rows } = await pool.query(
      'INSERT INTO event_attendees (station_id,name,phone,unit_number,floor,building_name,compound_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [station_id, name, phone, unit_number, floor, building_name, compound_name]
    );
    res.json({ success: true, attendee: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/admin', (req, res) => {
  const BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';
  const CSS = `
:root{--bg:#07090f;--bg1:#0c0f1a;--bg2:#111827;--bg3:#1a2435;--border:#1e3a5f;--border2:#2a4a6b;--text:#e2e8f0;--text2:#94a3b8;--text3:#475569;--blue:#3b82f6;--blue-dark:#1d4ed8;--blue-glow:rgba(59,130,246,.2);--green:#10b981;--green-dark:#064e3b;--red:#ef4444;--red-dark:#7f1d1d;--amber:#f59e0b;--amber-dark:#78350f;--cyan:#06b6d4;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Heebo',sans-serif;background:var(--bg);color:var(--text);direction:rtl;min-height:100vh}
#loginScreen{position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;align-items:center;justify-content:center}
.lc{background:var(--bg1);border:1px solid var(--border2);border-radius:14px;padding:32px 28px;width:92%;max-width:360px;text-align:center}
.ll{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;color:var(--cyan);letter-spacing:3px;margin-bottom:6px}
.ls{font-size:11px;color:var(--text3);margin-bottom:24px}
.lf{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;text-align:right}
.lf label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}
.lf input{background:var(--bg2);border:1px solid var(--border2);border-radius:7px;padding:10px 12px;color:var(--text);font-size:13px;width:100%}
.lf input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-glow)}
.lb2{width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:700;cursor:pointer;margin-top:4px}
.lb2:hover{background:var(--blue-dark)}
.le{color:#f87171;font-size:12px;margin-top:10px;min-height:18px}
#appShell{display:none;grid-template-rows:52px 1fr;height:100vh;overflow:hidden}
.topbar{background:var(--bg1);border-bottom:1px solid var(--border);padding:0 22px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--cyan);letter-spacing:2px}
.logo span{color:var(--text3);font-size:10px;margin-right:8px;font-weight:400;letter-spacing:0}
.main{display:grid;grid-template-columns:290px 1fr;overflow:hidden}
.sidebar{background:var(--bg1);border-left:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column}
.content{overflow-y:auto}
.sidebar-hd{padding:13px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.slbl{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1.5px}
.ev-item{padding:12px 16px;border-bottom:1px solid rgba(30,58,95,.35);cursor:pointer;transition:background .12s}
.ev-item:hover{background:var(--bg2)}
.ev-item.active{background:var(--bg3);border-right:2px solid var(--blue)}
.ev-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.ev-meta{font-size:10px;color:var(--text3);font-family:'IBM Plex Mono',monospace}
.ev-pills{display:flex;gap:3px;margin-top:5px;flex-wrap:wrap}
.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:9px;font-weight:700;letter-spacing:.3px}
.pg{background:rgba(71,85,105,.2);color:#94a3b8;border:1px solid rgba(71,85,105,.3)}
.pb{background:rgba(59,130,246,.15);color:#60a5fa;border:1px solid rgba(59,130,246,.25)}
.pgr{background:rgba(16,185,129,.12);color:#34d399;border:1px solid rgba(16,185,129,.25)}
.pr{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.25)}
.pa{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
.empty{padding:24px 16px;text-align:center;color:var(--text3);font-size:12px;line-height:1.6}
.panel{padding:22px;max-width:940px}
.ph{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.pt{font-size:17px;font-weight:700;color:var(--text)}
.pm{font-size:11px;color:var(--text3);font-family:'IBM Plex Mono',monospace;margin-top:3px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:18px}
.sc{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center}
.sn{font-size:24px;font-weight:900;font-family:'IBM Plex Mono',monospace;color:var(--cyan)}
.sl{font-size:9px;color:var(--text3);margin-top:2px;text-transform:uppercase;letter-spacing:.8px}
.card{background:var(--bg1);border:1px solid var(--border);border-radius:9px;margin-bottom:14px}
.ch{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.ct{font-size:12px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ca{display:flex;gap:6px;flex-wrap:wrap}
.cb{padding:16px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Heebo',sans-serif;transition:all .12s;text-decoration:none;white-space:nowrap}
.bp{background:var(--blue);color:#fff}.bp:hover{background:var(--blue-dark)}
.bg2{background:transparent;color:var(--text2);border:1px solid var(--border2)}.bg2:hover{background:var(--bg3)}
.bs{background:var(--green-dark);color:#a7f3d0;border:1px solid var(--green)}.bs:hover{background:#047857}
.ba{background:var(--amber-dark);color:#fde68a;border:1px solid var(--amber)}.ba:hover{background:#92400e}
.bsm{padding:5px 10px;font-size:11px;border-radius:5px}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fi{display:flex;flex-direction:column;gap:4px}
.fi.s2{grid-column:span 2}
label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}
input,select{background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;color:var(--text);font-size:12px;font-family:'Heebo',sans-serif;width:100%}
input:focus,select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-glow)}
select option{background:var(--bg2)}
table{width:100%;border-collapse:collapse;font-size:11px}
th{background:var(--bg2);color:var(--text3);padding:8px 10px;text-align:right;border-bottom:1px solid var(--border);font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid rgba(30,58,95,.25);vertical-align:middle}
tr:last-child td{border:none}
tr:hover td{background:rgba(30,58,95,.12)}
.mono{font-family:'IBM Plex Mono',monospace;font-size:10px}
.lb3{display:flex;gap:7px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:7px 10px;margin-bottom:12px}
.lb3 code{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--cyan);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;align-items:center;justify-content:center}
.overlay.open{display:flex}
.modal{background:var(--bg1);border:1px solid var(--border2);border-radius:11px;padding:22px;width:92%;max-width:490px;max-height:90vh;overflow-y:auto}
.mt{font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px}
.ma{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);padding:9px 18px;border-radius:7px;font-size:12px;font-weight:600;opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none;min-width:200px;text-align:center}
.toast.show{opacity:1}
.tok{background:#064e3b;color:#a7f3d0;border:1px solid var(--green)}
.terr{background:var(--red-dark);color:#fca5a5;border:1px solid var(--red)}
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:40px;text-align:center}`;

  const JS = `
var BASE='${BASE}',SS_KEY='q_ev_a',AUTH='';
var curEvId=null,curSid=null;
var TYPES={signing:'חתימות',survey:'מדידות',appraisal:'שמאות',other:'אחר'};
var ROLES={lawyer:'עורך דין',surveyor:'מודד',appraiser:'שמאי',other:'אחר'};
var SLBL={pending:'ממתין',confirmed:'אישר',cancelled:'ביטל',arrived:'הגיע',no_show:'לא הגיע',rescheduled:'תיאם'};
var SCLS={pending:'pg',confirmed:'pgr',cancelled:'pr',arrived:'pb',no_show:'pr',rescheduled:'pa'};
function e(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fD(d){if(!d)return'';return new Date(d).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function toast(m,t){var el=document.getElementById('toast');el.textContent=m;el.className='toast show '+(t==='err'?'terr':'tok');setTimeout(function(){el.classList.remove('show');},3500);}
function openM(id){document.getElementById('m-'+id).classList.add('open');}
function closeM(id){document.getElementById('m-'+id).classList.remove('open');}
document.querySelectorAll('.overlay').forEach(function(o){o.addEventListener('click',function(ev){if(ev.target===o)o.classList.remove('open');});});
function showLogin(){document.getElementById('loginScreen').style.display='flex';document.getElementById('appShell').style.display='none';}
function showApp(){document.getElementById('loginScreen').style.display='none';document.getElementById('appShell').style.display='grid';}
async function apiCall(method,path,body){
  var opts={method:method,headers:{'Content-Type':'application/json','Authorization':AUTH}};
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch(BASE+'/events'+path,opts);
  if(r.status===401){AUTH='';try{sessionStorage.removeItem(SS_KEY);}catch(x){}showLogin();throw new Error('401');}
  return r.json();
}
document.getElementById('loginBtn').addEventListener('click',doLogin);
document.getElementById('lp').addEventListener('keydown',function(ev){if(ev.key==='Enter')doLogin();});
async function doLogin(){
  var u=document.getElementById('lu').value.trim();
  var p=document.getElementById('lp').value;
  var h='Basic '+btoa(u+':'+p);
  var errEl=document.getElementById('loginErr');
  errEl.textContent='בודק...';
  try{
    var r=await fetch(BASE+'/events/',{headers:{'Authorization':h}});
    if(r.status===401){errEl.textContent='שם משתמש או סיסמה שגויים';return;}
    AUTH=h;try{sessionStorage.setItem(SS_KEY,AUTH);}catch(x){}
    errEl.textContent='';showApp();loadEvents();
  }catch(x){errEl.textContent='שגיאת רשת';}
}
document.getElementById('btnLogout').addEventListener('click',function(){AUTH='';try{sessionStorage.removeItem(SS_KEY);}catch(x){}showLogin();});
document.getElementById('btnNewEvent').addEventListener('click',function(){openM('ne');});
document.getElementById('btnRefresh').addEventListener('click',loadEvents);
['ne','ns','sl','aa','nt'].forEach(function(id){document.getElementById(id+'-x').addEventListener('click',function(){closeM(id);});});
document.getElementById('ne-ok').addEventListener('click',createEvent);
document.getElementById('ns-ok').addEventListener('click',addStation);
document.getElementById('sl-ok').addEventListener('click',genSlots);
document.getElementById('aa-ok').addEventListener('click',addAttendee);
document.getElementById('nt-ok').addEventListener('click',sendNotify);
['sl-s','sl-e','sl-d'].forEach(function(id){document.getElementById(id).addEventListener('input',calcSlots);});
async function loadEvents(){
  var el=document.getElementById('evList');
  el.innerHTML='<div class="empty">טוען...</div>';
  try{
    var d=await apiCall('GET','/');
    if(!d.success||!d.events||!d.events.length){el.innerHTML='<div class="empty">אין כנסים.<br>לחץ + כנס חדש</div>';return;}
    var html='';
    d.events.forEach(function(ev){
      html+='<div class="ev-item" id="ei-'+ev.id+'" data-id="'+ev.id+'">';
      html+='<div class="ev-title">'+e(ev.title)+'</div>';
      html+='<div class="ev-meta">'+fD(ev.event_date)+'</div>';
      html+='<div class="ev-pills"><span class="pill pb">'+(TYPES[ev.event_type]||ev.event_type)+'</span>';
      if(ev.attendee_count)html+='<span class="pill pg">'+ev.attendee_count+' דיירים</span>';
      if(ev.confirmed_count)html+='<span class="pill pgr">'+ev.confirmed_count+' אישרו</span>';
      html+='</div></div>';
    });
    el.innerHTML=html;
    el.querySelectorAll('.ev-item').forEach(function(item){item.addEventListener('click',function(){loadEvent(parseInt(item.dataset.id));});});
  }catch(x){if(x.message!=='401')el.innerHTML='<div class="empty">שגיאה</div>';}
}
async function loadEvent(id){
  curEvId=id;
  document.querySelectorAll('.ev-item').forEach(function(el){el.classList.remove('active');});
  var ei=document.getElementById('ei-'+id);if(ei)ei.classList.add('active');
  var mc=document.getElementById('mc');
  mc.innerHTML='<div class="welcome"><div style="color:var(--text3);font-size:12px">טוען...</div></div>';
  try{
    var d=await apiCall('GET','/'+id);
    if(!d.success){mc.innerHTML='<div class="panel"><p style="color:red">'+e(d.error)+'</p></div>';return;}
    var ev=d.event,ta=0,co=0,ar=0,ns=0,fs=0;
    (ev.stations||[]).forEach(function(s){
      (s.attendees||[]).forEach(function(a){ta++;if(a.status==='confirmed')co++;if(a.status==='arrived')ar++;if(a.status==='no_show')ns++;});
      fs+=(s.slots||[]).filter(function(sl){return sl.status==='free';}).length;
    });
    var stH='';
    (ev.stations||[]).forEach(function(st){
      var fc=(st.slots||[]).filter(function(sl){return sl.status==='free';}).length;
      var pl=BASE+'/events/pro/'+st.token;
      var atR='';
      (st.attendees||[]).forEach(function(a){
        var tm=a.start_time?fD(a.start_time).split(' ')[1]:'-';
        atR+='<tr><td class="mono">'+e(tm)+'</td><td><strong>'+e(a.name)+'</strong></td>';
        atR+='<td style="color:var(--text3)">'+(a.unit_number?'ד'+a.unit_number+(a.floor?'/ק'+a.floor:''):'-')+'</td>';
        atR+='<td style="color:var(--text3);font-size:10px">'+e(a.building_name||'-')+'</td>';
        atR+='<td class="mono" style="direction:ltr">'+e(a.phone||'-')+'</td>';
        atR+='<td><span class="pill '+(SCLS[a.status]||'pg')+'">'+(SLBL[a.status]||a.status)+'</span></td>';
        atR+='<td>'+(a.wa_sent_at?'<span style="color:var(--green)">✓</span>':'')+'</td></tr>';
      });
      stH+='<div class="card"><div class="ch"><div class="ct">';
      stH+='<span>עמדה '+(st.station_number||'?')+'</span>';
      stH+='<span class="pill pb">'+(ROLES[st.pro_role]||st.pro_role)+'</span>';
      stH+='<strong>'+e(st.pro_name)+'</strong>';
      if(st.pro_phone)stH+='<span class="pill pg mono">'+e(st.pro_phone)+'</span>';
      stH+='<span class="pill '+(fc?'pgr':'pr')+'">'+fc+' פנויים / '+(st.slots||[]).length+' סהכ</span>';
      stH+='</div><div class="ca">';
      stH+='<button class="btn bg2 bsm" data-sid="'+st.id+'" data-name="'+e(st.pro_name)+'" data-act="slots">⏱ slots</button>';
      stH+='<button class="btn bg2 bsm" data-sid="'+st.id+'" data-act="att">＋ דייר</button>';
      stH+='<button class="btn ba bsm" data-eid="'+ev.id+'" data-sid="'+st.id+'" data-act="assign">⚡ חלק</button>';
      stH+='</div></div><div class="cb">';
      stH+='<div class="lb3"><code>'+e(pl)+'</code>';
      stH+='<button class="btn bg2 bsm" data-link="'+e(pl)+'" data-act="copy">📋</button>';
      stH+='<a href="'+e(pl)+'" target="_blank" class="btn bg2 bsm">↗</a></div>';
      stH+=atR?'<div style="overflow-x:auto"><table><thead><tr><th>שעה</th><th>שם</th><th>דירה</th><th>בניין</th><th>טלפון</th><th>סטטוס</th><th>WA</th></tr></thead><tbody>'+atR+'</tbody></table></div>'
              :'<p style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">אין דיירים — הוסף ידנית</p>';
      stH+='</div></div>';
    });
    if(!stH)stH='<p style="font-size:11px;color:var(--text3);padding:4px 0">אין עמדות — הוסף עמדה</p>';
    var html='<div class="panel"><div class="ph"><div>';
    html+='<div class="pt">'+e(ev.title)+'</div>';
    html+='<div class="pm">'+fD(ev.event_date)+(ev.location?' | 📍 '+e(ev.location):'')+(ev.compound_name?' | '+e(ev.compound_name):'')+'</div>';
    html+='</div><div style="display:flex;gap:6px;flex-wrap:wrap">';
    html+='<button class="btn bg2 bsm" data-act="addst">＋ עמדה</button>';
    html+='<button class="btn bs bsm" data-act="notify">📱 WA</button>';
    html+='<button class="btn bg2 bsm" data-act="refresh" data-eid="'+ev.id+'">↻</button>';
    html+='</div></div><div class="stats">';
    html+='<div class="sc"><div class="sn">'+ta+'</div><div class="sl">דיירים</div></div>';
    html+='<div class="sc"><div class="sn" style="color:#34d399">'+co+'</div><div class="sl">אישרו</div></div>';
    html+='<div class="sc"><div class="sn" style="color:var(--cyan)">'+ar+'</div><div class="sl">הגיעו</div></div>';
    html+='<div class="sc"><div class="sn" style="color:#f87171">'+ns+'</div><div class="sl">לא הגיעו</div></div>';
    html+='<div class="sc"><div class="sn" style="color:#fbbf24">'+fs+'</div><div class="sl">slots פנויים</div></div>';
    html+='</div><div class="sh"><span class="slbl">עמדות ('+(ev.stations||[]).length+')</span></div>';
    html+=stH+'</div>';
    mc.innerHTML=html;
    mc.querySelectorAll('[data-act]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var act=btn.dataset.act;
        if(act==='slots'){curSid=parseInt(btn.dataset.sid);document.getElementById('slName').textContent=btn.dataset.name;openM('sl');}
        else if(act==='att'){curSid=parseInt(btn.dataset.sid);openM('aa');}
        else if(act==='assign'){doAssign(parseInt(btn.dataset.eid),parseInt(btn.dataset.sid));}
        else if(act==='copy'){navigator.clipboard.writeText(btn.dataset.link).then(function(){toast('✅ קישור הועתק');}).catch(function(){toast('שגיאה','err');});}
        else if(act==='addst'){openM('ns');}
        else if(act==='notify'){openM('nt');}
        else if(act==='refresh'){loadEvent(parseInt(btn.dataset.eid));}
      });
    });
  }catch(x){if(x.message!=='401')mc.innerHTML='<div class="panel"><p style="color:red">'+e(x.message)+'</p></div>';}
}
async function createEvent(){
  var t=document.getElementById('ne-t').value.trim(),dt=document.getElementById('ne-d').value;
  if(!t||!dt){toast('חובה: שם + תאריך','err');return;}
  var d=await apiCall('POST','/',{title:t,event_type:document.getElementById('ne-tp').value,event_date:new Date(dt).toISOString(),location:document.getElementById('ne-l').value,compound_name:document.getElementById('ne-c').value,notes:document.getElementById('ne-n').value});
  if(d.success){toast('✅ כנס נוצר!');closeM('ne');await loadEvents();loadEvent(d.event.id);}else toast(d.error,'err');
}
async function addStation(){
  if(!curEvId)return;
  var n=document.getElementById('ns-n').value.trim();
  if(!n){toast('חובה: שם','err');return;}
  var d=await apiCall('POST','/'+curEvId+'/stations',{pro_name:n,pro_role:document.getElementById('ns-r').value,station_number:parseInt(document.getElementById('ns-num').value)||1,pro_phone:document.getElementById('ns-p').value,pro_email:document.getElementById('ns-e').value});
  if(d.success){toast('✅ עמדה נוספה!');closeM('ns');loadEvent(curEvId);loadEvents();}else toast(d.error,'err');
}
function calcSlots(){
  var s=document.getElementById('sl-s').value,en=document.getElementById('sl-e').value,dur=parseInt(document.getElementById('sl-d').value)||15;
  if(s&&en){var cnt=Math.floor((new Date(en)-new Date(s))/60000/dur);document.getElementById('sl-calc').textContent=cnt>0?'← '+cnt+' slots':'שעות לא תקינות';}
}
async function genSlots(){
  if(!curEvId||!curSid)return;
  var s=document.getElementById('sl-s').value,en=document.getElementById('sl-e').value,dur=parseInt(document.getElementById('sl-d').value)||15;
  if(!s||!en){toast('חובה: שעות','err');return;}
  var d=await apiCall('POST','/'+curEvId+'/stations/'+curSid+'/slots',{start_time:new Date(s).toISOString(),end_time:new Date(en).toISOString(),slot_duration_minutes:dur});
  if(d.success){toast('✅ נוצרו '+d.count+' slots');closeM('sl');loadEvent(curEvId);}else toast(d.error,'err');
}
async function addAttendee(){
  var name=document.getElementById('aa-n').value.trim();
  if(!name){toast('חובה: שם','err');return;}
  var d=await apiCall('POST','/'+curEvId+'/attendees',{station_id:curSid,name:name,phone:document.getElementById('aa-p').value,unit_number:document.getElementById('aa-u').value,floor:document.getElementById('aa-f').value,building_name:document.getElementById('aa-b').value});
  if(d.success){toast('✅ דייר נוסף!');closeM('aa');loadEvent(curEvId);}else toast(d.error,'err');
}
async function doAssign(eid,sid){
  if(!confirm('לחלק דיירים אוטומטית ל-slots?'))return;
  var d=await apiCall('POST','/'+eid+'/stations/'+sid+'/assign');
  if(d.success)toast('✅ חולקו '+d.assigned+' דיירים');else toast(d.error,'err');
  loadEvent(eid);
}
async function sendNotify(){
  if(!curEvId)return;
  var d=await apiCall('POST','/'+curEvId+'/notify',{target:document.getElementById('nt-t').value});
  if(d.success){toast('📱 '+d.wa_sent+' נשלחו');closeM('nt');}else toast(d.error,'err');
}
try{AUTH=sessionStorage.getItem(SS_KEY)||'';}catch(x){AUTH='';}
if(AUTH){fetch(BASE+'/events/',{headers:{'Authorization':AUTH}}).then(function(r){if(r.status===401){AUTH='';showLogin();}else{showApp();loadEvents();}}).catch(function(){showLogin();});}
else{showLogin();}`;

  res.type('html').send('<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QUANTUM | ניהול כנסים</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Heebo:wght@300;400;500;700;900&display=swap" rel="stylesheet"><style>' + CSS + '</style></head><body>' +
'<div id="loginScreen"><div class="lc"><div class="ll">QUANTUM</div><div class="ls">ניהול כנסים ואירועים</div><div class="lf"><label>שם משתמש</label><input id="lu" value="QUANTUM" autocomplete="username"></div><div class="lf"><label>סיסמה</label><input id="lp" type="password" autocomplete="current-password"></div><button class="lb2" id="loginBtn">כניסה</button><div class="le" id="loginErr"></div></div></div>' +
'<div id="appShell"><div class="topbar"><div class="logo">QUANTUM <span>| ניהול כנסים</span></div><div style="display:flex;gap:7px;align-items:center"><button class="btn bp bsm" id="btnNewEvent">＋ כנס חדש</button><button class="btn bg2 bsm" id="btnLogout" style="padding:5px 8px">התנתק</button></div></div>' +
'<div class="main"><div class="sidebar"><div class="sidebar-hd"><span class="slbl">כנסים</span><button class="btn bg2 bsm" id="btnRefresh" style="padding:4px 8px">↻</button></div><div id="evList"><div class="empty">טוען...</div></div></div>' +
'<div class="content" id="mc"><div class="welcome"><div style="font-size:44px;opacity:.25">📋</div><div style="font-size:16px;font-weight:700;color:var(--text2)">בחר כנס מהרשימה</div></div></div></div></div>' +
'<div class="toast" id="toast"></div>' +
'<div class="overlay" id="m-ne"><div class="modal"><div class="mt">📅 כנס חדש</div><div class="fg"><div class="fi s2"><label>שם הכנס</label><input id="ne-t" placeholder="חתימות פינוי-בינוי — הרצל 12"></div><div class="fi"><label>סוג</label><select id="ne-tp"><option value="signing">חתימות</option><option value="survey">מדידות</option><option value="appraisal">שמאות</option><option value="other">אחר</option></select></div><div class="fi"><label>תאריך ושעה</label><input type="datetime-local" id="ne-d"></div><div class="fi s2"><label>מיקום</label><input id="ne-l" placeholder="כתובת מלאה"></div><div class="fi"><label>מתחם</label><input id="ne-c" placeholder="מתחם X"></div><div class="fi"><label>הערות</label><input id="ne-n"></div></div><div class="ma"><button class="btn bg2" id="ne-x">ביטול</button><button class="btn bp" id="ne-ok">✓ צור</button></div></div></div>' +
'<div class="overlay" id="m-ns"><div class="modal"><div class="mt">👤 הוסף עמדה</div><div class="fg"><div class="fi s2"><label>שם איש מקצוע</label><input id="ns-n" placeholder="עוד ישראל ישראלי"></div><div class="fi"><label>תפקיד</label><select id="ns-r"><option value="lawyer">עורך דין</option><option value="surveyor">מודד</option><option value="appraiser">שמאי</option><option value="other">אחר</option></select></div><div class="fi"><label>מספר עמדה</label><input type="number" id="ns-num" min="1" placeholder="1"></div><div class="fi"><label>טלפון</label><input id="ns-p" placeholder="05X-XXXXXXX"></div><div class="fi"><label>אימייל</label><input id="ns-e" type="email"></div></div><div class="ma"><button class="btn bg2" id="ns-x">ביטול</button><button class="btn bp" id="ns-ok">✓ הוסף</button></div></div></div>' +
'<div class="overlay" id="m-sl"><div class="modal"><div class="mt">⏱ slots — <span id="slName"></span></div><div class="fg"><div class="fi"><label>שעת התחלה</label><input type="datetime-local" id="sl-s"></div><div class="fi"><label>שעת סיום</label><input type="datetime-local" id="sl-e"></div><div class="fi"><label>משך (דקות)</label><input type="number" id="sl-d" value="15" min="5" max="120"></div><div class="fi"><div id="sl-calc" style="color:var(--cyan);font-size:11px;align-self:flex-end;padding-bottom:10px"></div></div></div><div class="ma"><button class="btn bg2" id="sl-x">ביטול</button><button class="btn bp" id="sl-ok">✓ צור slots</button></div></div></div>' +
'<div class="overlay" id="m-aa"><div class="modal"><div class="mt">🏠 הוסף דייר ידנית</div><div class="fg"><div class="fi s2"><label>שם מלא</label><input id="aa-n" placeholder="ישראל ישראלי"></div><div class="fi"><label>טלפון</label><input id="aa-p" placeholder="05X-XXXXXXX"></div><div class="fi"><label>דירה</label><input id="aa-u" placeholder="12"></div><div class="fi"><label>קומה</label><input id="aa-f" placeholder="3"></div><div class="fi"><label>בניין</label><input id="aa-b" placeholder="בניין א"></div></div><div class="ma"><button class="btn bg2" id="aa-x">ביטול</button><button class="btn bp" id="aa-ok">✓ הוסף</button></div></div></div>' +
'<div class="overlay" id="m-nt"><div class="modal"><div class="mt">📱 שליחת WhatsApp</div><p style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.6">שלח הודעת WA לדיירים ו/או אנשי מקצוע.</p><div class="fi"><label>שלח ל</label><select id="nt-t"><option value="attendees">דיירים בלבד</option><option value="pros">אנשי מקצוע בלבד</option><option value="all">כולם</option></select></div><div class="ma"><button class="btn bg2" id="nt-x">ביטול</button><button class="btn bs" id="nt-ok">📤 שלח</button></div></div></div>' +
'<script>' + JS + '</script></body></html>');
});

module.exports = router;
