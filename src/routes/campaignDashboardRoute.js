/**
 * QUANTUM Campaign Dashboard Route
 * Serves the campaign management UI at /campaigns
 */
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM | ניהול קמפיינים</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #111118;
      --border: #1e1e2e;
      --accent: #6366f1;
      --accent2: #22d3ee;
      --green: #10b981;
      --red: #ef4444;
      --yellow: #f59e0b;
      --text: #e2e8f0;
      --muted: #64748b;
      --wa: #25D366;
      --call: #6366f1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; direction: rtl; min-height: 100vh; }

    /* ── Header ── */
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 20px; font-weight: 700; letter-spacing: 2px; background: linear-gradient(135deg,#6366f1,#22d3ee); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .header-actions { display: flex; gap: 10px; }

    /* ── Layout ── */
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .grid-2 { display: grid; grid-template-columns: 380px 1fr; gap: 24px; align-items: start; }
    @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

    /* ── Cards ── */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .card-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .card-title { font-size: 15px; font-weight: 600; color: var(--text); }
    .card-body { padding: 20px; }

    /* ── Form ── */
    .form-group { margin-bottom: 16px; }
    .form-label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
    .form-input { width: 100%; background: #0d0d16; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 14px; direction: rtl; }
    .form-input:focus { outline: none; border-color: var(--accent); }
    textarea.form-input { resize: vertical; min-height: 80px; }

    /* ── Mode Toggle ── */
    .mode-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 16px; }
    .mode-btn { padding: 12px 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; transition: all .2s; display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .mode-btn .icon { font-size: 20px; }
    .mode-btn .label { font-size: 12px; }
    .mode-btn .sublabel { font-size: 10px; color: var(--muted); font-weight: 400; }
    .mode-btn.wa { background: rgba(37,211,102,.08); color: var(--wa); }
    .mode-btn.call { background: rgba(99,102,241,.08); color: var(--accent); }
    .mode-btn.active.wa { background: rgba(37,211,102,.25); border: 2px solid var(--wa); color: var(--wa); }
    .mode-btn.active.call { background: rgba(99,102,241,.25); border: 2px solid var(--accent); color: var(--accent); }

    /* ── Wait time slider ── */
    .wait-row { display: flex; align-items: center; gap: 12px; }
    .wait-label { font-size: 13px; color: var(--text); min-width: 80px; font-weight: 600; }
    input[type=range] { flex: 1; accent-color: var(--accent); }
    .wait-value { background: rgba(99,102,241,.15); color: var(--accent); padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 700; min-width: 70px; text-align: center; }
    #wa-wait-group { transition: opacity .3s; }
    #wa-wait-group.hidden { opacity: .3; pointer-events: none; }

    /* ── Buttons ── */
    .btn { padding: 10px 18px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary { background: linear-gradient(135deg,#6366f1,#818cf8); color: #fff; }
    .btn-primary:hover { opacity: .9; transform: translateY(-1px); }
    .btn-green { background: rgba(16,185,129,.15); color: var(--green); border: 1px solid rgba(16,185,129,.3); }
    .btn-green:hover { background: rgba(16,185,129,.25); }
    .btn-red { background: rgba(239,68,68,.1); color: var(--red); border: 1px solid rgba(239,68,68,.2); }
    .btn-red:hover { background: rgba(239,68,68,.2); }
    .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
    .btn-ghost:hover { color: var(--text); border-color: var(--muted); }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .btn-full { width: 100%; justify-content: center; }

    /* ── Campaign List ── */
    .campaign-item { border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: all .2s; }
    .campaign-item:hover { border-color: var(--accent); background: rgba(99,102,241,.04); }
    .campaign-item.selected { border-color: var(--accent); background: rgba(99,102,241,.08); }
    .camp-row { display: flex; align-items: center; justify-content: space-between; }
    .camp-name { font-weight: 600; font-size: 14px; }
    .camp-meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 10px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge-wa { background: rgba(37,211,102,.15); color: var(--wa); }
    .badge-call { background: rgba(99,102,241,.15); color: var(--accent); }
    .badge-active { background: rgba(16,185,129,.15); color: var(--green); }
    .badge-draft { background: rgba(100,116,139,.15); color: var(--muted); }
    .badge-paused { background: rgba(245,158,11,.15); color: var(--yellow); }

    /* ── Stats ── */
    .stats-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-bottom: 20px; }
    .stat-box { background: #0d0d16; border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: center; }
    .stat-num { font-size: 24px; font-weight: 700; }
    .stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* ── Lead Add ── */
    .lead-input-row { display: flex; gap: 8px; }
    .leads-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .leads-table th { text-align: right; padding: 8px 10px; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 500; font-size: 11px; }
    .leads-table td { padding: 8px 10px; border-bottom: 1px solid rgba(30,30,46,.5); }
    .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 5px; }

    /* ── Flow diagram ── */
    .flow-diagram { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #0d0d16; border-radius: 8px; margin-bottom: 16px; font-size: 12px; flex-wrap: wrap; }
    .flow-step { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 6px; font-weight: 600; }
    .flow-step.wa { background: rgba(37,211,102,.12); color: var(--wa); }
    .flow-step.wait { background: rgba(245,158,11,.1); color: var(--yellow); font-weight: 400; }
    .flow-step.call { background: rgba(99,102,241,.12); color: var(--accent); }
    .flow-arrow { color: var(--muted); }

    /* ── Toast ── */
    #toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1e1e2e; border: 1px solid var(--border); padding: 12px 20px; border-radius: 8px; font-size: 13px; z-index: 9999; opacity: 0; transition: opacity .3s; pointer-events: none; }
    #toast.show { opacity: 1; }

    .empty-state { text-align: center; padding: 40px 20px; color: var(--muted); }
    .empty-state .icon { font-size: 36px; margin-bottom: 10px; }
  </style>
</head>
<body>

<div class="header">
  <div class="logo">QUANTUM</div>
  <div style="color:var(--muted);font-size:13px">ניהול קמפיינים | רן מ-QUANTUM</div>
  <div class="header-actions">
    <a href="/dashboard" class="btn btn-ghost btn-sm">← דשבורד</a>
  </div>
</div>

<div class="container">
  <div class="grid-2">

    <!-- LEFT: Create / Edit Campaign -->
    <div>
      <div class="card">
        <div class="card-header">
          <span class="card-title" id="form-title">➕ קמפיין חדש</span>
          <button class="btn btn-ghost btn-sm" id="btn-reset" onclick="resetForm()" style="display:none">איפוס</button>
        </div>
        <div class="card-body">

          <!-- Mode Toggle -->
          <div class="form-label">אופן הפעולה</div>
          <div class="mode-toggle">
            <button class="mode-btn wa active" id="btn-mode-wa" onclick="setMode('wa_then_call')">
              <span class="icon">💬→📞</span>
              <span class="label">WA ואז שיחה</span>
              <span class="sublabel">ממתין למענה לפני חיוג</span>
            </button>
            <button class="mode-btn call" id="btn-mode-call" onclick="setMode('call_only')">
              <span class="icon">📞</span>
              <span class="label">שיחה ישירה</span>
              <span class="sublabel">מתקשר מיד</span>
            </button>
          </div>

          <!-- Flow diagram (dynamic) -->
          <div class="flow-diagram" id="flow-diagram">
            <div class="flow-step wa">💬 שלח WA</div>
            <div class="flow-arrow">→</div>
            <div class="flow-step wait" id="flow-wait">⏱ ממתין 60 דק'</div>
            <div class="flow-arrow">→</div>
            <div class="flow-step call">📞 שיחת רן</div>
          </div>

          <input type="hidden" id="edit-id" value="">
          <input type="hidden" id="mode-value" value="wa_then_call">

          <div class="form-group">
            <label class="form-label">שם הקמפיין</label>
            <input class="form-input" id="camp-name" placeholder="למשל: לידים פינוי-בינוי מרץ">
          </div>

          <!-- WA wait time (shown only in wa_then_call mode) -->
          <div class="form-group" id="wa-wait-group">
            <label class="form-label">זמן המתנה לפני שיחה</label>
            <div class="wait-row">
              <input type="range" min="5" max="1440" step="5" value="60" id="wa-wait-slider" oninput="updateWaitLabel(this.value)">
              <div class="wait-value" id="wait-display">60 דק'</div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">שם הנציג (לשיחה)</label>
            <input class="form-input" id="agent-name" value="רן" placeholder="רן">
          </div>

          <div class="form-group">
            <label class="form-label">הודעת WA ראשונה (אופציונלי)</label>
            <textarea class="form-input" id="wa-message" placeholder="השאר ריק להודעה ברירת מחדל של רן..."></textarea>
            <div style="font-size:11px;color:var(--muted);margin-top:4px">ניתן להשתמש ב-{{name}} לשם הלקוח</div>
          </div>

          <div class="form-group">
            <label class="form-label">הערות (פנימי)</label>
            <input class="form-input" id="camp-notes" placeholder="הערות...">
          </div>

          <button class="btn btn-primary btn-full" onclick="saveCampaign()">
            <span id="save-btn-text">✓ צור קמפיין</span>
          </button>
        </div>
      </div>
    </div>

    <!-- RIGHT: Campaign List + Detail -->
    <div>
      <!-- Campaign List -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span class="card-title">קמפיינים</span>
          <span style="font-size:12px;color:var(--muted)" id="camp-count">טוען...</span>
        </div>
        <div class="card-body" style="padding:12px">
          <div id="campaigns-list">
            <div class="empty-state"><div class="icon">📋</div>טוען קמפיינים...</div>
          </div>
        </div>
      </div>

      <!-- Campaign Detail (hidden until selected) -->
      <div class="card" id="camp-detail" style="display:none">
        <div class="card-header">
          <span class="card-title" id="detail-name">פרטי קמפיין</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="editCampaign()">✏️ ערוך</button>
            <button class="btn btn-sm" id="btn-toggle-status" onclick="toggleStatus()">⏸ השהה</button>
          </div>
        </div>
        <div class="card-body">

          <!-- Stats -->
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-num" id="stat-total" style="color:var(--text)">0</div>
              <div class="stat-label">סה"כ לידים</div>
            </div>
            <div class="stat-box">
              <div class="stat-num" id="stat-wa" style="color:var(--wa)">0</div>
              <div class="stat-label">WA נשלח</div>
            </div>
            <div class="stat-box">
              <div class="stat-num" id="stat-calls" style="color:var(--accent)">0</div>
              <div class="stat-label">שיחות</div>
            </div>
          </div>

          <!-- Add leads -->
          <div style="margin-bottom:16px">
            <div class="form-label">הוסף לידים לקמפיין</div>
            <div class="lead-input-row">
              <input class="form-input" id="lead-phone" placeholder="מספר טלפון" style="flex:1" onkeydown="if(event.key==='Enter')addLead()">
              <input class="form-input" id="lead-name" placeholder="שם (אופציונלי)" style="flex:1.2" onkeydown="if(event.key==='Enter')addLead()">
              <button class="btn btn-ghost btn-sm" onclick="addLead()">הוסף</button>
            </div>
            <div style="margin-top:8px">
              <textarea class="form-input" id="bulk-phones" placeholder="הדבק מספרים בכמות (שורה לכל מספר)" style="min-height:60px"></textarea>
              <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addBulkLeads()">📋 הוסף בכמות</button>
            </div>
          </div>

          <!-- Launch -->
          <button class="btn btn-green btn-full" style="margin-bottom:16px" onclick="launchCampaign()" id="btn-launch">
            🚀 הפעל קמפיין
          </button>

          <!-- Leads table -->
          <div style="max-height:300px;overflow-y:auto">
            <table class="leads-table">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>טלפון</th>
                  <th>סטטוס</th>
                  <th>עודכן</th>
                </tr>
              </thead>
              <tbody id="leads-tbody">
                <tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">אין לידים עדיין</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const BASE = '';
let campaigns = [];
let selectedId = null;
let selectedCampaign = null;

// ── Mode Toggle ────────────────────────────────────────────────
function setMode(mode) {
  document.getElementById('mode-value').value = mode;
  document.getElementById('btn-mode-wa').classList.toggle('active', mode === 'wa_then_call');
  document.getElementById('btn-mode-call').classList.toggle('active', mode === 'call_only');
  const waGroup = document.getElementById('wa-wait-group');
  waGroup.classList.toggle('hidden', mode === 'call_only');
  updateFlowDiagram(mode);
}

function updateFlowDiagram(mode) {
  const diag = document.getElementById('flow-diagram');
  const wait = parseInt(document.getElementById('wa-wait-slider').value);
  if (mode === 'call_only') {
    diag.innerHTML = \`<div class="flow-step call">📞 שיחת רן — מיידית</div>\`;
  } else {
    const waitText = wait >= 60 ? (wait/60).toFixed(wait%60===0?0:1)+' שע\\'' : wait+' דק\\'';
    diag.innerHTML = \`
      <div class="flow-step wa">💬 שלח WA</div>
      <div class="flow-arrow">→</div>
      <div class="flow-step wait" id="flow-wait">⏱ ממתין \${waitText}</div>
      <div class="flow-arrow" id="flow-arrow2">→</div>
      <div class="flow-step call">📞 שיחת רן</div>
    \`;
  }
}

function updateWaitLabel(val) {
  const v = parseInt(val);
  let txt;
  if (v < 60) txt = v + ' דק\\'';
  else if (v === 60) txt = 'שעה';
  else if (v < 1440) txt = (v/60).toFixed(v%60===0?0:1) + ' שע\\'';
  else txt = '24 שע\\'';
  document.getElementById('wait-display').textContent = txt;
  updateFlowDiagram(document.getElementById('mode-value').value);
}

// ── Save Campaign ──────────────────────────────────────────────
async function saveCampaign() {
  const id = document.getElementById('edit-id').value;
  const payload = {
    name: document.getElementById('camp-name').value.trim(),
    mode: document.getElementById('mode-value').value,
    wa_wait_minutes: parseInt(document.getElementById('wa-wait-slider').value),
    agent_name: document.getElementById('agent-name').value.trim() || 'רן',
    wa_message: document.getElementById('wa-message').value.trim() || null,
    notes: document.getElementById('camp-notes').value.trim() || null
  };
  if (!payload.name) { toast('חובה להזין שם לקמפיין', 'error'); return; }

  const url = id ? \`/api/campaigns/\${id}\` : '/api/campaigns';
  const method = id ? 'PATCH' : 'POST';

  try {
    const res = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.success) {
      toast(id ? '✓ קמפיין עודכן' : '✓ קמפיין נוצר');
      resetForm();
      loadCampaigns();
      if (id) selectCampaign(parseInt(id));
    } else { toast('שגיאה: ' + (data.error||''), 'error'); }
  } catch(e) { toast('שגיאת רשת', 'error'); }
}

// ── Load Campaigns ─────────────────────────────────────────────
async function loadCampaigns() {
  try {
    const res = await fetch('/api/campaigns');
    const data = await res.json();
    campaigns = data.campaigns || [];
    document.getElementById('camp-count').textContent = campaigns.length + ' קמפיינים';
    renderList();
    if (selectedId) selectCampaign(selectedId);
  } catch(e) {}
}

function renderList() {
  const el = document.getElementById('campaigns-list');
  if (!campaigns.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📋</div>אין קמפיינים עדיין<br><small>צור קמפיין ראשון בטופס משמאל</small></div>';
    return;
  }
  el.innerHTML = campaigns.map(c => {
    const modeBadge = c.mode === 'wa_then_call'
      ? '<span class="badge badge-wa">💬→📞 WA+שיחה</span>'
      : '<span class="badge badge-call">📞 שיחה ישירה</span>';
    const statusBadge = c.status === 'active'
      ? '<span class="badge badge-active">● פעיל</span>'
      : c.status === 'paused'
      ? '<span class="badge badge-paused">⏸ מושהה</span>'
      : '<span class="badge badge-draft">◌ טיוטה</span>';
    const sel = selectedId === c.id ? ' selected' : '';
    return \`<div class="campaign-item\${sel}" onclick="selectCampaign(\${c.id})">
      <div class="camp-row">
        <span class="camp-name">\${c.name}</span>
        <span>\${statusBadge}</span>
      </div>
      <div class="camp-meta">
        \${modeBadge}
        <span>👤 \${parseInt(c.total_leads)||0} לידים</span>
        <span>💬 \${parseInt(c.wa_sent)||0} WA</span>
        <span>📞 \${parseInt(c.calls_made)||0} שיחות</span>
      </div>
    </div>\`;
  }).join('');
}

// ── Select Campaign ────────────────────────────────────────────
async function selectCampaign(id) {
  selectedId = id;
  renderList();
  try {
    const res = await fetch(\`/api/campaigns/\${id}\`);
    const data = await res.json();
    selectedCampaign = data.campaign;
    showDetail(data.campaign, data.leads || []);
  } catch(e) {}
}

function showDetail(camp, leads) {
  document.getElementById('camp-detail').style.display = 'block';
  document.getElementById('detail-name').textContent = camp.name;

  const statsRes = leads;
  document.getElementById('stat-total').textContent = leads.length;
  document.getElementById('stat-wa').textContent = leads.filter(l=>['wa_sent','wa_replied'].includes(l.status)).length;
  document.getElementById('stat-calls').textContent = leads.filter(l=>['call_initiated','call_done'].includes(l.status)).length;

  const toggleBtn = document.getElementById('btn-toggle-status');
  if (camp.status === 'active') {
    toggleBtn.textContent = '⏸ השהה';
    toggleBtn.className = 'btn btn-sm btn-ghost';
  } else {
    toggleBtn.textContent = '▶ הפעל';
    toggleBtn.className = 'btn btn-sm btn-green';
  }

  const statusColors = {
    pending: '#64748b', wa_sent: '#f59e0b', wa_replied: '#22d3ee',
    call_queued: '#a78bfa', call_initiated: '#6366f1', call_done: '#10b981', failed: '#ef4444', opted_out: '#64748b'
  };
  const statusLabels = {
    pending: 'ממתין', wa_sent: 'WA נשלח', wa_replied: 'ענה ב-WA',
    call_queued: 'בתור לשיחה', call_initiated: 'שיחה יזומה', call_done: 'שיחה הסתיימה', failed: 'נכשל', opted_out: 'הסיר'
  };
  const tbody = document.getElementById('leads-tbody');
  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">הוסף לידים כדי להתחיל</td></tr>';
    return;
  }
  tbody.innerHTML = leads.map(l => {
    const col = statusColors[l.status] || '#64748b';
    const lbl = statusLabels[l.status] || l.status;
    const updated = l.updated_at ? new Date(l.updated_at).toLocaleString('he-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    return \`<tr>
      <td>\${l.name || '—'}</td>
      <td style="direction:ltr">\${l.phone}</td>
      <td><span class="status-dot" style="background:\${col}"></span>\${lbl}</td>
      <td style="color:var(--muted);font-size:11px">\${updated}</td>
    </tr>\`;
  }).join('');
}

// ── Add Leads ──────────────────────────────────────────────────
async function addLead() {
  if (!selectedId) { toast('בחר קמפיין קודם', 'error'); return; }
  const phone = document.getElementById('lead-phone').value.trim();
  if (!phone) { toast('הזן מספר טלפון', 'error'); return; }
  const name = document.getElementById('lead-name').value.trim();
  await submitLeads([{ phone, name }]);
  document.getElementById('lead-phone').value = '';
  document.getElementById('lead-name').value = '';
}

async function addBulkLeads() {
  if (!selectedId) { toast('בחר קמפיין קודם', 'error'); return; }
  const raw = document.getElementById('bulk-phones').value.trim();
  if (!raw) return;
  const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);
  const leads = lines.map(l => {
    const parts = l.split(/[,\\t]+/);
    return { phone: parts[0].trim(), name: parts[1]?.trim() || null };
  });
  await submitLeads(leads);
  document.getElementById('bulk-phones').value = '';
}

async function submitLeads(leads) {
  try {
    const res = await fetch(\`/api/campaigns/\${selectedId}/leads\`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ leads })
    });
    const data = await res.json();
    if (data.success) { toast(\`✓ נוספו \${data.inserted} לידים\`); selectCampaign(selectedId); }
    else toast('שגיאה: ' + (data.error||''), 'error');
  } catch(e) { toast('שגיאת רשת', 'error'); }
}

// ── Launch ─────────────────────────────────────────────────────
async function launchCampaign() {
  if (!selectedId) return;
  const camp = campaigns.find(c=>c.id===selectedId);
  const msg = camp?.mode === 'wa_then_call'
    ? \`להפעיל קמפיין "\${camp?.name}"?\\nישלח WA לכל הלידים הממתינים.\`
    : \`להפעיל קמפיין "\${camp?.name}"?\\nיחויגו שיחות ישירות לכל הלידים.\`;
  if (!confirm(msg)) return;
  try {
    document.getElementById('btn-launch').textContent = '⏳ מפעיל...';
    const res = await fetch(\`/api/campaigns/\${selectedId}/launch\`, { method:'POST' });
    const data = await res.json();
    if (data.success) {
      toast(\`✓ \${data.message}\`);
      setTimeout(() => selectCampaign(selectedId), 1000);
    } else toast('שגיאה: ' + (data.error||''), 'error');
    document.getElementById('btn-launch').textContent = '🚀 הפעל קמפיין';
  } catch(e) { toast('שגיאת רשת', 'error'); document.getElementById('btn-launch').textContent = '🚀 הפעל קמפיין'; }
}

// ── Status Toggle ──────────────────────────────────────────────
async function toggleStatus() {
  if (!selectedCampaign) return;
  const newStatus = selectedCampaign.status === 'active' ? 'paused' : 'active';
  try {
    const res = await fetch(\`/api/campaigns/\${selectedId}\`, {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) { toast(newStatus === 'paused' ? '⏸ הקמפיין הושהה' : '▶ הקמפיין הופעל'); loadCampaigns(); }
  } catch(e) {}
}

// ── Edit ───────────────────────────────────────────────────────
function editCampaign() {
  if (!selectedCampaign) return;
  const c = selectedCampaign;
  document.getElementById('edit-id').value = c.id;
  document.getElementById('camp-name').value = c.name;
  document.getElementById('agent-name').value = c.agent_name;
  document.getElementById('wa-message').value = c.wa_message || '';
  document.getElementById('camp-notes').value = c.notes || '';
  document.getElementById('wa-wait-slider').value = c.wa_wait_minutes;
  updateWaitLabel(c.wa_wait_minutes);
  setMode(c.mode);
  document.getElementById('form-title').textContent = '✏️ עריכת קמפיין';
  document.getElementById('save-btn-text').textContent = '✓ שמור שינויים';
  document.getElementById('btn-reset').style.display = 'inline-flex';
  window.scrollTo({top:0,behavior:'smooth'});
}

function resetForm() {
  document.getElementById('edit-id').value = '';
  document.getElementById('camp-name').value = '';
  document.getElementById('agent-name').value = 'רן';
  document.getElementById('wa-message').value = '';
  document.getElementById('camp-notes').value = '';
  document.getElementById('wa-wait-slider').value = 60;
  updateWaitLabel(60);
  setMode('wa_then_call');
  document.getElementById('form-title').textContent = '➕ קמפיין חדש';
  document.getElementById('save-btn-text').textContent = '✓ צור קמפיין';
  document.getElementById('btn-reset').style.display = 'none';
}

// ── Toast ──────────────────────────────────────────────────────
function toast(msg, type='success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = type === 'error' ? 'rgba(239,68,68,.4)' : 'rgba(99,102,241,.4)';
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), 3000);
}

// ── Init ───────────────────────────────────────────────────────
loadCampaigns();
setInterval(loadCampaigns, 30000);
</script>
</body>
</html>`);
});

module.exports = router;
