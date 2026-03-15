/**
 * QUANTUM Campaign Dashboard — v5.0
 * v5.0: Campaign Flow Engine UI — funnel view, flow settings, Meta template IDs
 */
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => {
  res.type('html').send(getHtml());
});
function getHtml() {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | קמפיינים</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;direction:rtl}
.topbar{background:linear-gradient(135deg,#0d1117,#161b27);border-bottom:1px solid #1e3a5f;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#4fc3f7;font-size:20px;font-weight:700;letter-spacing:1px}
.logo span{color:#fff}
.nav-links a{color:#90a4ae;text-decoration:none;margin-left:20px;font-size:13px}
.nav-links a:hover,.nav-links a.active{color:#4fc3f7}
.container{max-width:1300px;margin:0 auto;padding:24px}
h1{font-size:22px;color:#fff;margin-bottom:4px}
.subtitle{color:#78909c;font-size:13px;margin-bottom:20px}
.tabs{display:flex;border-bottom:2px solid #1e3a5f;margin-bottom:24px}
.tab-btn{padding:11px 22px;cursor:pointer;font-size:13px;font-weight:600;color:#78909c;background:transparent;border:none;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .2s,border-color .2s;position:relative;z-index:1}
.tab-btn:hover{color:#b0bec5}
.tab-btn.active{color:#4fc3f7;border-bottom-color:#4fc3f7}
.tab-pane{display:none}
.tab-pane.active{display:block}
.stats-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat-card{background:#0d1117;border:1px solid #1e3a5f;border-radius:8px;padding:14px 20px;flex:1;min-width:120px}
.stat-card .num{font-size:26px;font-weight:700;color:#4fc3f7}
.stat-card .lbl{font-size:11px;color:#78909c;margin-top:2px}
.panel{background:#0d1117;border:1px solid #1e3a5f;border-radius:10px;overflow:hidden;margin-bottom:20px}
.panel-header{padding:14px 18px;border-bottom:1px solid #1e3a5f;display:flex;align-items:center;justify-content:space-between}
.panel-header h2{font-size:14px;color:#e0e0e0}
.panel-body{padding:18px}
.form-group{margin-bottom:14px}
label{display:block;font-size:12px;color:#90a4ae;margin-bottom:5px}
input[type=text],input[type=number],textarea,select{width:100%;background:#161b27;border:1px solid #2a4a6b;border-radius:6px;padding:9px 12px;color:#e0e0e0;font-size:13px;direction:rtl;transition:border .2s}
input:focus,textarea:focus,select:focus{outline:none;border-color:#4fc3f7}
textarea{resize:vertical;min-height:80px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s}
.btn-primary{background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff}
.btn-primary:hover{background:linear-gradient(135deg,#1976d2,#1565c0)}
.btn-success{background:linear-gradient(135deg,#2e7d32,#1b5e20);color:#fff}
.btn-success:hover{background:linear-gradient(135deg,#388e3c,#2e7d32)}
.btn-danger{background:linear-gradient(135deg,#c62828,#b71c1c);color:#fff}
.btn-danger:hover{background:linear-gradient(135deg,#d32f2f,#c62828)}
.btn-outline{background:transparent;color:#90a4ae;border:1px solid #2a4a6b}
.btn-outline:hover{color:#e0e0e0;border-color:#4fc3f7}
.btn-teal{background:linear-gradient(135deg,#00695c,#004d40);color:#fff}
.btn-teal:hover{background:linear-gradient(135deg,#00796b,#00695c)}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-full{width:100%;justify-content:center}
.btn:disabled{opacity:.5;cursor:not-allowed}
.mode-toggle{display:flex;border:1px solid #2a4a6b;border-radius:8px;overflow:hidden}
.mode-btn{flex:1;padding:8px 14px;background:transparent;border:none;color:#78909c;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
.mode-btn.active{background:#1565c0;color:#fff}
.campaign-item{border:1px solid #1e3a5f;border-radius:8px;margin-bottom:10px;overflow:hidden;transition:border-color .2s}
.campaign-item:hover{border-color:#2a5a8f}
.camp-header{padding:12px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between}
.camp-title{font-size:14px;font-weight:600;color:#e0e0e0}
.camp-meta{font-size:11px;color:#78909c;margin-top:2px}
.camp-body{padding:14px;border-top:1px solid #1e3a5f;display:none}
.camp-body.open{display:block}
.funnel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:14px}
.funnel-cell{background:#0a0f1a;border:1px solid #1e3a5f;border-radius:7px;padding:8px 10px;text-align:center}
.funnel-cell .fn{font-size:20px;font-weight:700;color:#4fc3f7}
.funnel-cell .fl{font-size:10px;color:#78909c;margin-top:2px;line-height:1.3}
.funnel-cell.active-stage{border-color:#4fc3f7}
.funnel-cell.replied-stage{border-color:#4db6ac}
.funnel-cell.danger-stage{border-color:#ef5350}
.funnel-cell.success-stage{border-color:#66bb6a}
.flow-section{background:#0a0f1a;border:1px solid #1e4a3f;border-radius:8px;padding:14px;margin-bottom:14px}
.flow-section-title{font-size:12px;font-weight:700;color:#4db6ac;margin-bottom:10px}
.flow-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.camp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.status-badge{font-size:10px;padding:3px 8px;border-radius:10px;font-weight:600}
.s-draft{background:#263238;color:#90a4ae}
.s-active{background:#1b5e20;color:#a5d6a7}
.s-paused{background:#3e2723;color:#ffab91}
.s-completed{background:#1a237e;color:#9fa8da}
.voice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:8px}
.voice-card{background:#161b27;border:2px solid #2a4a6b;border-radius:8px;padding:12px;cursor:pointer;text-align:center;transition:all .2s;user-select:none}
.voice-card:hover{border-color:#4fc3f7;background:#0d1a2a}
.voice-card.selected{border-color:#4fc3f7;background:#0d2035}
.voice-card .v-icon{font-size:24px;margin-bottom:4px}
.voice-card .v-name{font-size:13px;font-weight:600;color:#e0e0e0}
.voice-card .v-desc{font-size:10px;color:#78909c;margin-top:2px}
.script-editor{background:#0a0f1a;border:1px solid #2a4a6b;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;color:#a8d8a8;direction:ltr;text-align:left;width:100%;resize:vertical;min-height:160px}
.script-vars{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.var-chip{background:#1a3a5c;color:#4fc3f7;border:1px solid #2a5a8f;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;transition:background .2s;user-select:none}
.var-chip:hover{background:#2a5a8f}
.escalation-card{background:linear-gradient(135deg,#0d1117,#0f1e2d);border:1px solid #1e4a3f;border-radius:10px;padding:20px;margin-bottom:24px}
.card-title{font-size:15px;font-weight:700;color:#4db6ac;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.card-sub{font-size:12px;color:#546e7a;margin-bottom:18px}
.escalation-inner{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.escalation-control{flex:1;min-width:260px}
.esc-stat{background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
.esc-stat .n{font-size:22px;font-weight:700;color:#4db6ac}
.esc-stat .l{font-size:10px;color:#78909c;margin-top:2px}
.slider-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.slider-row input[type=range]{flex:1;accent-color:#4db6ac;cursor:pointer}
.slider-val{background:#0a1520;border:1px solid #1e4a3f;border-radius:6px;padding:6px 14px;font-size:16px;font-weight:700;color:#4db6ac;min-width:90px;text-align:center}
.slider-hint{font-size:11px;color:#546e7a;margin-bottom:14px}
.esc-actions{display:flex;gap:8px}
.status-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600}
.pill-active{background:#1b4a3f;color:#4db6ac;border:1px solid #2d7a6a}
.pill-disabled{background:#2a2a2a;color:#78909c;border:1px solid #3a3a3a}
.dot{width:6px;height:6px;border-radius:50%}
.dot-active{background:#4db6ac;animation:pulse 1.5s infinite}
.dot-off{background:#546e7a}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.flow-log-table{width:100%;border-collapse:collapse;font-size:11px}
.flow-log-table th{background:#0a0f1a;color:#78909c;padding:6px 10px;text-align:right;border-bottom:1px solid #1e3a5f}
.flow-log-table td{padding:6px 10px;border-bottom:1px solid #0f1a2a;color:#b0bec5}
.flow-log-table tr:hover td{background:#0d1a2a}
.log-ok{color:#66bb6a}
.log-fail{color:#ef5350}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none}
.toast.error{background:#3c1414;color:#ef9a9a;border-color:#7f1616}
.toast.show{opacity:1}
.loading{text-align:center;padding:30px;color:#546e7a}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid #1e3a5f;border-top-color:#4fc3f7;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-state{text-align:center;padding:40px 20px;color:#546e7a;font-size:13px}
.tag{display:inline-block;background:#0d2035;color:#4fc3f7;border:1px solid #1e4a6b;border-radius:10px;padding:2px 8px;font-size:10px}
.info-box{background:#0a1520;border:1px solid #1e3a5f;border-radius:6px;padding:10px 14px;font-size:11px;color:#78909c;margin-bottom:12px}
.info-box strong{color:#4fc3f7}
@media(max-width:768px){.grid2{grid-template-columns:1fr}.flow-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">QUANTUM <span>|</span> קמפיינים</div>
  <nav class="nav-links">
    <a href="/dashboard">דשבורד</a>
    <a href="/campaigns" class="active">קמפיינים</a>
  </nav>
</div>
<div class="container">
  <h1>מרכז הקמפיינים</h1>
  <p class="subtitle">ניהול מלא — WA, תזכורות, שיחות, תסריטים, קולות</p>
  <div class="tabs" id="tabBar">
    <button class="tab-btn active" data-tab="campaigns">📋 קמפיינים</button>
    <button class="tab-btn" data-tab="builder">🏗️ בניית קמפיין</button>
    <button class="tab-btn" data-tab="wabot">🤖 WA Bot</button>
  </div>

  <!-- TAB 1: Campaign List with Funnel -->
  <div class="tab-pane active" id="tab-campaigns">
    <div class="stats-row">
      <div class="stat-card"><div class="num" id="statTotal">-</div><div class="lbl">קמפיינים</div></div>
      <div class="stat-card"><div class="num" id="statActive">-</div><div class="lbl">פעילים</div></div>
      <div class="stat-card"><div class="num" id="statWaSent">-</div><div class="lbl">WA נשלחו</div></div>
      <div class="stat-card"><div class="num" id="statCalls">-</div><div class="lbl">שיחות</div></div>
      <div class="stat-card"><div class="num" id="statReplied">-</div><div class="lbl">מענו</div></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <h2>📋 רשימת קמפיינים</h2>
        <button class="btn btn-outline btn-sm" id="btnRefreshCamps">🔄 רענן</button>
      </div>
      <div class="panel-body" id="campListBody">
        <div class="loading"><span class="spinner"></span></div>
      </div>
    </div>
  </div>

  <!-- TAB 2: Campaign Builder -->
  <div class="tab-pane" id="tab-builder">
    <div class="grid2">
      <div>
        <div class="panel">
          <div class="panel-header"><h2>⚙️ הגדרות בסיסיות</h2></div>
          <div class="panel-body">
            <div class="form-group">
              <label>שם הקמפיין *</label>
              <input type="text" id="bName" placeholder="למשל: פינוי-בינוי גינדי מרץ 2026">
            </div>
            <div class="form-group">
              <label>Zoho Campaign ID</label>
              <input type="text" id="bZohoId" placeholder="מזהה הקמפיין בזוהו (אופציונלי)">
              <div style="font-size:10px;color:#546e7a;margin-top:3px">שם הקמפיין בזוהו: BOT_campaign_ID</div>
            </div>
            <div class="form-group">
              <label>מצב קמפיין</label>
              <div class="mode-toggle">
                <button class="mode-btn active" id="bModeWa" data-mode="wa_then_call">📱 WA ← שיחה</button>
                <button class="mode-btn" id="bModeCall" data-mode="call_only">📞 שיחה ישירה</button>
              </div>
            </div>
            <div class="form-group">
              <label>שם הסוכן</label>
              <input type="text" id="bAgent" value="רן">
            </div>
            <div class="form-group">
              <label>הערות פנימיות</label>
              <input type="text" id="bNotes" placeholder="אופציונלי">
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>🔄 הגדרות זרימה (Flow)</h2></div>
          <div class="panel-body">
            <div class="info-box">
              <strong>חשוב:</strong> תזכורות WA חייבות להיות תבניות מאושרות מטא. בנה אותן באינפוריו, קבל אישור מטא, ואז הכנס את מספר התבנית כאן.
            </div>
            <div class="flow-section">
              <div class="flow-section-title">📱 תזכורות WhatsApp</div>
              <!-- Initial message (sent by Zoho) — editable only at creation -->
              <div style="display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:end;margin-bottom:12px;background:#0d1a2a;border:1px solid #1e3a5f;border-radius:7px;padding:10px">
                <div style="text-align:center;min-width:60px">
                  <div style="font-size:18px;font-weight:700;color:#78909c">0</div>
                  <div style="font-size:10px;color:#546e7a">הודעה</div>
                  <div style="font-size:9px;color:#37474f">ראשונה</div>
                </div>
                <div class="form-group" style="margin:0">
                  <label>INFORU Template ID — הודעה ראשונה (נשלחת עיי זוהו)</label>
                  <input type="text" id="bInitialInforu" placeholder="מספר תבנית ההודעה הראשונה באינפוריו" style="border-color:#1e3a5f">
                  <div style="font-size:10px;color:#546e7a;margin-top:3px">הודעה זו נשלחת על ידי זוהו בלבד. המזהה שלה יוצג לעיון בלבד בדשבורד.</div>
                </div>
              </div>
              <div class="flow-grid" style="margin-bottom:12px">
                <div class="form-group">
                  <label>מספר תזכורות WA</label>
                  <input type="number" id="bMaxReminders" value="2" min="0" max="5" oninput="renderReminderRows('b')">
                </div>
                <div class="form-group">
                  <label>השהיה בין תזכורות (שעות)</label>
                  <input type="number" id="bReminderDelay" value="24" min="1" max="168">
                </div>
              </div>
              <div id="bReminderRows"></div>
            </div>
            <div class="flow-section">
              <div class="flow-section-title">📞 שיחות טלפון (Vapi)</div>
              <div class="flow-grid">
                <div class="form-group">
                  <label>מקסימום ניסיונות שיחה</label>
                  <input type="number" id="bMaxCalls" value="2" min="0" max="5">
                </div>
                <div class="form-group">
                  <label>השהיה לפני שיחה 1 (שעות)</label>
                  <input type="number" id="bCallDelay" value="48" min="1" max="168">
                </div>
              </div>
              <div class="form-group">
                <label>השהיה בין שיחות (שעות)</label>
                <input type="number" id="bCallRetry" value="24" min="1" max="168">
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-header"><h2>🎙️ קול הסוכן</h2></div>
          <div class="panel-body">
            <div class="voice-grid" id="voiceGrid">
              <div class="voice-card selected" data-voice="oren" data-gender="male" data-provider="vapi">
                <div class="v-icon">👨</div><div class="v-name">אורן</div><div class="v-desc">זכר · עברית</div>
              </div>
              <div class="voice-card" data-voice="ran" data-gender="male" data-provider="vapi">
                <div class="v-icon">👨‍💼</div><div class="v-name">רן</div><div class="v-desc">זכר · ברירת מחדל</div>
              </div>
              <div class="voice-card" data-voice="rachel" data-gender="female" data-provider="vapi">
                <div class="v-icon">👩</div><div class="v-name">רחל</div><div class="v-desc">נקבה · עברית</div>
              </div>
              <div class="voice-card" data-voice="maya" data-gender="female" data-provider="vapi">
                <div class="v-icon">👩‍💼</div><div class="v-name">מאיה</div><div class="v-desc">נקבה · טבעי</div>
              </div>
              <div class="voice-card" data-voice="custom" data-gender="male" data-provider="elevenlabs">
                <div class="v-icon">⚙️</div><div class="v-name">מותאם</div><div class="v-desc">Voice ID ידני</div>
              </div>
            </div>
            <div class="form-group" id="customVoiceGroup" style="display:none;margin-top:12px">
              <label>Voice ID מותאם</label>
              <input type="text" id="bVoiceId" placeholder="ElevenLabs/Vapi voice ID">
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>💬 תסריט WA</h2>
            <button class="btn btn-outline btn-sm" id="btnDefaultWa">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <div class="info-box">הודעת WA <strong>ראשונה</strong> נשלחת ע"י זוהו. השדה כאן הוא לגיבוי / שימוש ידני בלבד.</div>
            <div class="form-group">
              <label>הודעת WA ראשונית (גיבוי)</label>
              <textarea id="bWaMessage" rows="4" placeholder="שלום {{name}}!&#10;אני {{agent_name}} מ-QUANTUM..."></textarea>
              <div class="script-vars">
                <span class="var-chip" data-field="bWaMessage" data-var="{{name}}">{{name}}</span>
                <span class="var-chip" data-field="bWaMessage" data-var="{{agent_name}}">{{agent_name}}</span>
                <span class="var-chip" data-field="bWaMessage" data-var="{{city}}">{{city}}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>📞 תסריט שיחה</h2>
            <button class="btn btn-outline btn-sm" id="btnDefaultScript">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <p style="font-size:11px;color:#546e7a;margin-bottom:10px">מחליף את ה-system prompt של Vapi לקמפיין זה בלבד.</p>
            <textarea class="script-editor" id="bCallScript" rows="8" placeholder="אתה רן, סוכן נדל&quot;ן של QUANTUM..."></textarea>
            <div class="script-vars">
              <span class="var-chip" data-field="bCallScript" data-var="{{name}}">{{name}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{agent_name}}">{{agent_name}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{city}}">{{city}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{campaign_name}}">{{campaign_name}}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="btnCreateCampaign">✚ צור קמפיין</button>
      </div>
    </div>
  </div>

  <!-- TAB 3: WA Bot -->
  <div class="tab-pane" id="tab-wabot">
    <div class="escalation-card">
      <div class="card-title">
        🤖 WA Bot — הסלמה אוטומטית לשיחה
        <span class="status-pill pill-disabled" id="escStatusPill">
          <span class="dot dot-off" id="escDot"></span>
          <span id="escStatusText">טוען...</span>
        </span>
      </div>
      <div class="card-sub">כשלקוח כותב ל-WA Bot ורן לא מקבל מענה — רן מתקשר אוטומטית אחרי X דקות</div>
      <div class="escalation-inner">
        <div class="escalation-control">
          <label style="font-size:12px;color:#90a4ae;margin-bottom:8px;display:block">זמן המתנה לפני שיחה (0 = כבוי)</label>
          <div class="slider-row">
            <input type="range" id="escSlider" min="0" max="240" step="5" value="60">
            <div class="slider-val" id="escSliderVal">60 דק'</div>
          </div>
          <div class="slider-hint" id="escSliderHint">אחרי 60 דקות ללא מענה — רן מתקשר</div>
          <div class="esc-actions">
            <button class="btn btn-teal btn-sm" id="btnSaveEsc">💾 שמור</button>
            <button class="btn btn-outline btn-sm" id="btnRunEsc">▶ הרץ עכשיו</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div class="esc-stat"><div class="n" id="escStatPending">-</div><div class="l">ממתינים</div></div>
          <div class="esc-stat"><div class="n" id="escStatCalled">-</div><div class="l">הועברו לשיחה</div></div>
          <div class="esc-stat"><div class="n" id="escStatTimeout">-</div><div class="l">דקות המתנה</div></div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function() {
  'use strict';
  const API = '/api/campaigns';

  document.getElementById('tabBar').addEventListener('click', function(e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
    btn.classList.add('active');
    var pane = document.getElementById('tab-' + btn.dataset.tab);
    if (pane) pane.classList.add('active');
    if (btn.dataset.tab === 'wabot') loadEscSettings();
  });

  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtDate(d) {
    if (!d) return '-';
    var dt = new Date(d);
    return dt.toLocaleDateString('he-IL') + ' ' + dt.toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'});
  }
  function toast(msg, type) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (type === 'error' ? ' error' : '') + ' show';
    setTimeout(function() { el.classList.remove('show'); }, 3000);
  }
  function apiFetch(url, method, body) {
    var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function(r) { return r.json(); });
  }

  var STAGE_CLASS = {
    initial: '', reminder_1_sent: 'active-stage', reminder_2_sent: 'active-stage',
    call_1_initiated: 'active-stage', call_1_no_answer: 'danger-stage',
    call_2_initiated: 'active-stage', call_2_no_answer: 'danger-stage',
    replied: 'replied-stage', call_answered: 'success-stage',
    converted: 'success-stage', opted_out: 'danger-stage',
    exhausted: 'danger-stage', failed: 'danger-stage'
  };

  function loadCampaigns() {
    apiFetch(API).then(function(d) {
      if (!d.success) return;
      var camps = d.campaigns || [];
      document.getElementById('statTotal').textContent   = camps.length;
      document.getElementById('statActive').textContent  = camps.filter(function(c) { return c.status === 'active'; }).length;
      document.getElementById('statWaSent').textContent  = camps.reduce(function(a, c) { return a + (parseInt(c.wa_sent) || 0); }, 0);
      document.getElementById('statCalls').textContent   = camps.reduce(function(a, c) { return a + (parseInt(c.calls_made) || 0); }, 0);
      document.getElementById('statReplied').textContent = camps.reduce(function(a, c) { return a + (parseInt(c.wa_replied) || 0); }, 0);
      renderCampaigns(camps);
    }).catch(function() {});
  }

  function renderCampaigns(camps) {
    var body = document.getElementById('campListBody');
    if (!camps.length) {
      body.innerHTML = '<div class="empty-state">אין קמפיינים עדיין. לחץ על "🏗️ בניית קמפיין" כדי ליצור את הראשון.</div>';
      return;
    }
    body.innerHTML = camps.map(function(c) {
      var badge = '<span class="status-badge s-' + escHtml(c.status) + '">' + escHtml(c.status) + '</span>';
      var tags = (c.flow_enabled ? ' <span class="tag">🔄 Flow</span>' : '') + (c.zoho_campaign_id ? ' <span class="tag">🔗 זוהו</span>' : '');
      return '<div class="campaign-item" id="camp-' + c.id + '">' +
        '<div class="camp-header" onclick="toggleCamp(' + c.id + ')">' +
          '<div><div class="camp-title">' + escHtml(c.name) + ' ' + badge + tags + '</div>' +
          '<div class="camp-meta">נוצר: ' + fmtDate(c.created_at) + ' | סוכן: ' + escHtml(c.agent_name || 'רן') + ' | מצב: ' + escHtml(c.mode || '') + '</div></div>' +
          '<span style="color:#546e7a;font-size:18px">⌄</span>' +
        '</div>' +
        '<div class="camp-body" id="camp-body-' + c.id + '">' +
          '<div id="camp-funnel-' + c.id + '"><div class="loading"><span class="spinner"></span></div></div>' +
          '<div class="camp-actions">' +
            (c.status === 'active'
              ? '<button class="btn btn-outline btn-sm" onclick="pauseCamp(' + c.id + ')">⏸ השהה</button>'
              : '<button class="btn btn-success btn-sm" onclick="activateCamp(' + c.id + ')">▶ הפעל</button>') +
            '<button class="btn btn-outline btn-sm" onclick="openFlowSettings(' + c.id + ')">⚙️ הגדרות זרימה</button>' +
            '<button class="btn btn-outline btn-sm" onclick="loadFlowLog(' + c.id + ')">📋 לוג</button>' +
            '<button class="btn btn-danger btn-sm" onclick="deleteCamp(' + c.id + ')">🗑 מחק</button>' +
          '</div>' +
          '<div id="camp-flow-settings-' + c.id + '" style="display:none;margin-top:14px"></div>' +
          '<div id="camp-log-' + c.id + '" style="display:none;margin-top:14px"></div>' +
        '</div></div>';
    }).join('');
  }

  window.toggleCamp = function(id) {
    var body = document.getElementById('camp-body-' + id);
    if (!body) return;
    var wasOpen = body.classList.contains('open');
    body.classList.toggle('open');
    if (!wasOpen) loadFunnel(id);
  };

  function loadFunnel(id) {
    var el = document.getElementById('camp-funnel-' + id);
    if (!el) return;
    apiFetch(API + '/' + id + '/funnel').then(function(d) {
      if (!d.success) { el.innerHTML = '<div style="color:#ef5350;font-size:12px">שגיאה בטעינת נתוני זרימה</div>'; return; }
      var f = d.funnel;
      var stages = [
        {key:'initial',label:'ממתין'},{key:'reminder_1_sent',label:'תזכורת 1'},
        {key:'reminder_2_sent',label:'תזכורת 2'},{key:'call_1_initiated',label:'שיחה 1'},
        {key:'call_1_no_answer',label:'ש1 אין מענה'},{key:'call_2_initiated',label:'שיחה 2'},
        {key:'call_2_no_answer',label:'ש2 אין מענה'},{key:'replied',label:'ענה WA ✅'},
        {key:'call_answered',label:'ענה שיחה ✅'},{key:'converted',label:'תואם ✅'},
        {key:'exhausted',label:'מוצה ❌'},{key:'opted_out',label:'הסיר ❌'}
      ];
      var html = '<div style="font-size:11px;color:#78909c;margin-bottom:8px">סה"כ ליידים: <strong style="color:#4fc3f7">' + (f.total || 0) + '</strong></div><div class="funnel-grid">';
      stages.forEach(function(s) {
        var n = f[s.key] || 0;
        if (n === 0 && !['initial','replied','call_answered','converted'].includes(s.key)) return;
        html += '<div class="funnel-cell ' + (STAGE_CLASS[s.key] || '') + '"><div class="fn">' + n + '</div><div class="fl">' + escHtml(s.label) + '</div></div>';
      });
      el.innerHTML = html + '</div>';
    }).catch(function() { el.innerHTML = '<div style="color:#546e7a;font-size:12px">לא ניתן לטעון נתוני זרימה</div>'; });
  }

  // Dynamic reminder rows renderer (prefix = 'b' for builder, 'fs-ID' for flow settings)
  window.renderReminderRows = function(prefix, count, existingTemplates) {
    var n = count != null ? count : parseInt(document.getElementById(prefix + 'MaxReminders').value) || 0;
    var container = document.getElementById(prefix + 'ReminderRows');
    if (!container) return;
    var html = '';
    for (var i = 1; i <= n; i++) {
      var existingVal = (existingTemplates && existingTemplates[i]) ? escHtml(existingTemplates[i]) : '';
      html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:end;margin-bottom:10px;background:#0d1a2a;border:1px solid #1e4a3f;border-radius:7px;padding:10px">' +
        '<div style="text-align:center;min-width:60px">' +
          '<div style="font-size:18px;font-weight:700;color:#4db6ac">' + i + '</div>' +
          '<div style="font-size:10px;color:#546e7a">תזכורת</div>' +
        '</div>' +
        '<div class="form-group" style="margin:0">' +
          '<label>INFORU Template ID <span style="color:#ef5350">*</span></label>' +
          '<input type="text" id="' + prefix + 'ReminderTpl' + i + '" value="' + existingVal + '" placeholder="מספר התבנית באינפוריו" required style="border-color:#1e4a3f"> +
        '</div>' +
      '</div>';
    }
    if (n === 0) html = '<div style="font-size:11px;color:#546e7a;padding:6px 0">אין תזכורות WA — הקמפיין יעבור ישירות לשיחות.</div>';
    container.innerHTML = html;
  };

  window.openFlowSettings = function(id) {
    var el = document.getElementById('camp-flow-settings-' + id);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    el.style.display = 'block';
    apiFetch(API + '/' + id).then(function(d) {
      if (!d.success) { el.innerHTML = '<div style="color:#ef5350">שגיאה</div>'; return; }
      var c = d.campaign;
      var maxR = c.max_wa_reminders != null ? c.max_wa_reminders : 2;
      var tplMap = {};
      if (c.reminder1_template_id) tplMap[1] = c.reminder1_template_id;
      if (c.reminder2_template_id) tplMap[2] = c.reminder2_template_id;
      if (c.reminder3_template_id) tplMap[3] = c.reminder3_template_id;
      if (c.reminder4_template_id) tplMap[4] = c.reminder4_template_id;
      if (c.reminder5_template_id) tplMap[5] = c.reminder5_template_id;
      var initInforuDisplay = c.initial_message_inforu_id
        ? '<div style="display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:center;margin-bottom:12px;background:#0a0f1a;border:1px solid #1e3a5f;border-radius:7px;padding:10px">' +
            '<div style="text-align:center;min-width:60px">' +
              '<div style="font-size:18px;font-weight:700;color:#78909c">0</div>' +
              '<div style="font-size:10px;color:#546e7a">הודעה</div>' +
              '<div style="font-size:9px;color:#37474f">ראשונה</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:11px;color:#78909c;margin-bottom:4px">INFORU Template ID — הודעה ראשונה (נשלחת עיי זוהו)</div>' +
              '<div style="font-size:16px;font-weight:700;color:#4fc3f7;letter-spacing:1px;padding:6px 10px;background:#0d1117;border:1px solid #1e3a5f;border-radius:5px;display:inline-block">' + escHtml(c.initial_message_inforu_id) + '</div>' +
              '<div style="font-size:10px;color:#37474f;margin-top:4px">🔒 לקריאה בלבד — לשינוי יש לעדכן בזוהו</div>' +
            '</div>' +
          '</div>'
        : '<div style="font-size:11px;color:#546e7a;padding:6px 0;margin-bottom:10px">לא הוזן INFORU Template ID להודעה הראשונה</div>';
      el.innerHTML = '<div class="flow-section"><div class="flow-section-title">⚙️ הגדרות זרימה — ' + escHtml(c.name) + '</div>' +
        '<div class="form-group"><label>Zoho Campaign ID</label><input type="text" id="fs-zoho-' + id + '" value="' + escHtml(c.zoho_campaign_id || '') + '" placeholder="מזהה זוהו"></div>' +
        '<div style="font-size:12px;font-weight:700;color:#4db6ac;margin-bottom:8px">📱 תזכורות WhatsApp</div>' +
        initInforuDisplay +
        '<div class="flow-grid" style="margin-bottom:12px">' +
          '<div class="form-group"><label>מספר תזכורות WA</label><input type="number" id="fs-maxr-' + id + '" value="' + maxR + '" min="0" max="5" oninput="renderReminderRows(\'fs-' + id + '-\', null, null)"></div>' +
          '<div class="form-group"><label>השהיה בין תזכורות (שעות)</label><input type="number" id="fs-rdelay-' + id + '" value="' + (c.wa_reminder_delay_hours || 24) + '" min="1" max="168"></div>' +
        '</div>' +
        '<div id="fs-' + id + '-ReminderRows"></div>' +
        '<div class="flow-grid" style="margin-top:12px">' +
          '<div class="form-group"><label>מקסימום ניסיונות שיחה</label><input type="number" id="fs-maxc-' + id + '" value="' + (c.max_call_attempts != null ? c.max_call_attempts : 2) + '" min="0" max="5"></div>' +
          '<div class="form-group"><label>השהיה לפני שיחה 1 (שעות)</label><input type="number" id="fs-cdelay-' + id + '" value="' + (c.call_delay_after_wa_hours || 48) + '" min="1" max="168"></div>' +
        '</div>' +
        '<div class="form-group"><label>השהיה בין שיחות (שעות)</label><input type="number" id="fs-cretry-' + id + '" value="' + (c.call_retry_delay_hours || 24) + '" min="1" max="168"></div>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#90a4ae;margin-bottom:12px">' +
          '<input type="checkbox" id="fs-enabled-' + id + '" ' + (c.flow_enabled !== false ? 'checked' : '') + '> זרימה אוטומטית מופעלת</label>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-success btn-sm" onclick="saveFlowSettings(' + id + ')">💾 שמור</button>' +
          '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'camp-flow-settings-' + id + '\').style.display=\'none\'">✕ סגור</button>' +
        '</div></div>';
      renderReminderRows('fs-' + id + '-', maxR, tplMap);
    }).catch(function() { el.innerHTML = '<div style="color:#ef5350">שגיאת רשת</div>'; });
  };

  window.saveFlowSettings = function(id) {
    var g = function(sfx) { var el = document.getElementById('fs-' + sfx + '-' + id); return el ? el.value : null; };
    var gn = function(sfx) { var v = g(sfx); return (v !== null && v !== '') ? parseInt(v) : null; };
    var chk = document.getElementById('fs-enabled-' + id);
    var maxR = gn('maxr') || 0;
    // Validate: all reminder template IDs must be filled
    var tplIds = {};
    for (var i = 1; i <= maxR; i++) {
      var tplEl = document.getElementById('fs-' + id + '-ReminderTpl' + i);
      var tplVal = tplEl ? tplEl.value.trim() : '';
      if (!tplVal) { toast('יש להזין Template ID לתזכורת ' + i, 'error'); return; }
      tplIds['reminder' + i + '_template_id'] = tplVal;
    }
    var payload = Object.assign({
      zoho_campaign_id: g('zoho') || null,
      max_wa_reminders: maxR,
      wa_reminder_delay_hours: gn('rdelay'),
      max_call_attempts: gn('maxc'),
      call_delay_after_wa_hours: gn('cdelay'),
      call_retry_delay_hours: gn('cretry'),
      flow_enabled: chk ? chk.checked : true
    }, tplIds);
    apiFetch(API + '/' + id + '/flow-settings', 'POST', payload).then(function(d) {
      if (d.success) { toast('הגדרות זרימה נשמרו ✅'); loadCampaigns(); loadFunnel(id); }
      else toast(d.error || 'שגיאה', 'error');
    }).catch(function() { toast('שגיאת רשת', 'error'); });
  };

  window.loadFlowLog = function(id) {
    var el = document.getElementById('camp-log-' + id);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    el.style.display = 'block';
    apiFetch(API + '/' + id + '/flow-log?limit=30').then(function(d) {
      if (!d.success || !d.log.length) { el.innerHTML = '<div style="color:#546e7a;font-size:12px;padding:10px">אין פעולות מתועדות עדיין</div>'; return; }
      var rows = d.log.map(function(l) {
        return '<tr><td>' + fmtDate(l.created_at) + '</td><td>' + escHtml(l.lead_name || l.phone || '') + '</td>' +
          '<td>' + escHtml(l.action) + '</td><td>' + escHtml(l.stage_before || '') + ' → ' + escHtml(l.stage_after || '') + '</td>' +
          '<td class="' + (l.success ? 'log-ok' : 'log-fail') + '">' + (l.success ? '✅' : '❌') + '</td>' +
          '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis">' + escHtml(l.error_message || '') + '</td></tr>';
      }).join('');
      el.innerHTML = '<div style="font-size:12px;font-weight:600;color:#90a4ae;margin-bottom:8px">📋 לוג פעולות</div>' +
        '<div style="overflow-x:auto"><table class="flow-log-table"><thead><tr><th>זמן</th><th>ליד</th><th>פעולה</th><th>שלב</th><th>סטטוס</th><th>שגיאה</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).catch(function() { el.innerHTML = '<div style="color:#ef5350;font-size:12px">שגיאת רשת</div>'; });
  };

  window.pauseCamp = function(id) {
    apiFetch(API + '/' + id + '/pause', 'POST').then(function(d) {
      if (d.success) { toast('קמפיין הושהה'); loadCampaigns(); }
      else toast(d.error || 'שגיאה', 'error');
    });
  };

  window.activateCamp = function(id) {
    apiFetch(API + '/' + id, 'PATCH', { status: 'active' }).then(function(d) {
      if (d.success) { toast('קמפיין הופעל ✅'); loadCampaigns(); }
      else toast(d.error || 'שגיאה', 'error');
    });
  };

  window.deleteCamp = function(id) {
    if (!confirm('למחוק את הקמפיין? הפעולה בלתי הפיכה.')) return;
    apiFetch(API + '/' + id, 'DELETE').then(function(d) {
      if (d.success) { toast('קמפיין נמחק'); loadCampaigns(); }
      else toast(d.error || 'שגיאה', 'error');
    });
  };

  document.getElementById('btnRefreshCamps').addEventListener('click', loadCampaigns);

  var selBuildMode = 'wa_then_call';
  var selVoice = 'oren', selGender = 'male', selProvider = 'vapi';

  document.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selBuildMode = btn.dataset.mode;
    });
  });

  document.getElementById('voiceGrid').addEventListener('click', function(e) {
    var card = e.target.closest('.voice-card');
    if (!card) return;
    document.querySelectorAll('.voice-card').forEach(function(c) { c.classList.remove('selected'); });
    card.classList.add('selected');
    selVoice = card.dataset.voice; selGender = card.dataset.gender; selProvider = card.dataset.provider;
    document.getElementById('customVoiceGroup').style.display = selVoice === 'custom' ? 'block' : 'none';
  });

  document.querySelectorAll('.var-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      var field = document.getElementById(chip.dataset.field);
      if (!field) return;
      var v = chip.dataset.var, start = field.selectionStart, end = field.selectionEnd;
      field.value = field.value.slice(0, start) + v + field.value.slice(end);
      field.focus(); field.selectionStart = field.selectionEnd = start + v.length;
    });
  });

  document.getElementById('btnDefaultWa').addEventListener('click', function() {
    document.getElementById('bWaMessage').value = 'שלום {{name}},\\nאני {{agent_name}} מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\\nיש לנו קונים רציניים לאזור שלך.\\nאשמח לשוחח!';
  });

  document.getElementById('btnDefaultScript').addEventListener('click', function() {
    document.getElementById('bCallScript').value = 'You are {{agent_name}}, a real estate agent at QUANTUM specializing in urban renewal.\\nYou are calling {{name}} to discuss their property.\\nBe professional, friendly, and speak Hebrew.\\nYour goal is to schedule a meeting.';
  });

  // Init builder reminder rows on page load
  renderReminderRows('b');

  document.getElementById('btnCreateCampaign').addEventListener('click', function() {
    var name = document.getElementById('bName').value.trim();
    if (!name) { toast('יש להזין שם לקמפיין', 'error'); return; }
    // Validate reminder template IDs
    var bMaxR2 = parseInt(document.getElementById('bMaxReminders').value) || 0;
    for (var vi = 1; vi <= bMaxR2; vi++) {
      var vEl = document.getElementById('bReminderTpl' + vi);
      if (!vEl || !vEl.value.trim()) { toast('יש להזין Template ID לתזכורת ' + vi, 'error'); return; }
    }
    var voiceId = selVoice === 'custom' ? (document.getElementById('bVoiceId').value.trim() || null) : selVoice;
    var btn = document.getElementById('btnCreateCampaign');
    btn.disabled = true; btn.textContent = 'יוצר...';
    apiFetch(API, 'POST', {
      name: name, mode: selBuildMode,
      agent_name: document.getElementById('bAgent').value.trim() || 'רן',
      wa_message: document.getElementById('bWaMessage').value.trim() || null,
      notes: document.getElementById('bNotes').value.trim() || null,
      voice_gender: selGender, voice_name: voiceId, voice_provider: selProvider,
      call_script: document.getElementById('bCallScript').value.trim() || null
    }).then(function(d) {
      btn.disabled = false; btn.textContent = '✚ צור קמפיין';
      if (!d.success) { toast(d.error || 'שגיאה', 'error'); return; }
      var campId = d.campaign.id;
      var bMaxR = parseInt(document.getElementById('bMaxReminders').value) || 0;
      var bTplIds = {};
      for (var bi = 1; bi <= bMaxR; bi++) {
        var bTplEl = document.getElementById('bReminderTpl' + bi);
        bTplIds['reminder' + bi + '_template_id'] = bTplEl ? bTplEl.value.trim() : null;
      }
      apiFetch(API + '/' + campId + '/flow-settings', 'POST', Object.assign({
        zoho_campaign_id: document.getElementById('bZohoId').value.trim() || null,
        initial_message_inforu_id: document.getElementById('bInitialInforu').value.trim() || null,
        max_wa_reminders: bMaxR,
        wa_reminder_delay_hours: parseInt(document.getElementById('bReminderDelay').value) || 24,
        max_call_attempts: parseInt(document.getElementById('bMaxCalls').value) || 2,
        call_delay_after_wa_hours: parseInt(document.getElementById('bCallDelay').value) || 48,
        call_retry_delay_hours: parseInt(document.getElementById('bCallRetry').value) || 24,
        flow_enabled: true
      }, bTplIds)).then(function() {
        toast('קמפיין נוצר בהצלחה! ✅');
        loadCampaigns();
        document.querySelector('[data-tab="campaigns"]').click();
      });
    }).catch(function() { btn.disabled = false; btn.textContent = '✚ צור קמפיין'; toast('שגיאת רשת', 'error'); });
  });

  document.getElementById('escSlider').addEventListener('input', function() { updateSliderDisplay(parseInt(this.value)); });
  function updateSliderDisplay(v) {
    document.getElementById('escSliderVal').textContent = v === 0 ? 'כבוי' : v + ' דק\\'';
    document.getElementById('escSliderHint').textContent = v === 0 ? 'הסלמה אוטומטית מבוטלת' : 'אחרי ' + v + ' דקות ללא מענה ב-WA — רן מתקשר';
  }
  document.getElementById('btnSaveEsc').addEventListener('click', function() {
    var v = parseInt(document.getElementById('escSlider').value);
    apiFetch(API + '/settings', 'PATCH', { wa_bot_escalation_minutes: v }).then(function(d) {
      if (d.success) { toast(v === 0 ? 'הסלמה בוטלה' : 'נשמר! הסלמה אחרי ' + v + ' דקות'); loadEscSettings(); }
      else toast(d.error || 'שגיאה', 'error');
    });
  });
  document.getElementById('btnRunEsc').addEventListener('click', function() {
    var btn = this; btn.disabled = true; btn.textContent = 'מריץ...';
    apiFetch(API + '/escalation/run', 'POST').then(function(d) {
      var n = (d.result && d.result.called) || 0;
      toast(n > 0 ? 'הועברו ' + n + ' ליידים לשיחה' : 'אין ליידים להסלמה כרגע');
      loadEscSettings(); btn.disabled = false; btn.textContent = '▶ הרץ עכשיו';
    }).catch(function() { toast('שגיאת רשת', 'error'); btn.disabled = false; btn.textContent = '▶ הרץ עכשיו'; });
  });
  function loadEscSettings() {
    apiFetch(API + '/settings').then(function(d) {
      if (!d.success) return;
      var m = parseInt(d.escalation_minutes) || 0;
      document.getElementById('escSlider').value = m;
      updateSliderDisplay(m);
      document.getElementById('escStatPending').textContent = (d.stats && d.stats.pending_escalation != null) ? d.stats.pending_escalation : '-';
      document.getElementById('escStatCalled').textContent  = (d.stats && d.stats.escalated_total  != null) ? d.stats.escalated_total  : '-';
      document.getElementById('escStatTimeout').textContent = m === 0 ? 'כבוי' : m;
      var pill = document.getElementById('escStatusPill'), dot = document.getElementById('escDot'), txt = document.getElementById('escStatusText');
      if (m === 0) { pill.className = 'status-pill pill-disabled'; dot.className = 'dot dot-off'; txt.textContent = 'כבוי'; }
      else { pill.className = 'status-pill pill-active'; dot.className = 'dot dot-active'; txt.textContent = 'פעיל — ' + m + ' דק\\''; }
    }).catch(function() {});
  }

  loadCampaigns();
  setInterval(loadCampaigns, 30000);
})();
</script>
</body>
</html>`;
}
module.exports = router;
