/**
 * QUANTUM Campaign Dashboard — UI Route
 * Hebrew RTL dashboard for managing outreach campaigns
 * Modes: WA→Call | Call Only
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM | קמפיינים</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
      direction: rtl;
    }
    .topbar {
      background: linear-gradient(135deg, #0d1117 0%, #161b27 100%);
      border-bottom: 1px solid #1e3a5f;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo { color: #4fc3f7; font-size: 20px; font-weight: 700; letter-spacing: 1px; }
    .logo span { color: #fff; }
    .nav-links a {
      color: #90a4ae; text-decoration: none; margin-left: 20px;
      font-size: 13px; transition: color 0.2s;
    }
    .nav-links a:hover, .nav-links a.active { color: #4fc3f7; }

    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; color: #fff; margin-bottom: 4px; }
    .subtitle { color: #78909c; font-size: 13px; margin-bottom: 24px; }

    /* Stats bar */
    .stats-row { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card {
      background: #0d1117; border: 1px solid #1e3a5f;
      border-radius: 8px; padding: 14px 20px; flex: 1; min-width: 130px;
    }
    .stat-card .num { font-size: 26px; font-weight: 700; color: #4fc3f7; }
    .stat-card .lbl { font-size: 11px; color: #78909c; margin-top: 2px; }

    /* Main layout */
    .grid { display: grid; grid-template-columns: 380px 1fr; gap: 20px; }

    /* Panel */
    .panel {
      background: #0d1117; border: 1px solid #1e3a5f;
      border-radius: 10px; overflow: hidden;
    }
    .panel-header {
      padding: 14px 18px; border-bottom: 1px solid #1e3a5f;
      display: flex; align-items: center; justify-content: space-between;
    }
    .panel-header h2 { font-size: 14px; color: #e0e0e0; }
    .panel-body { padding: 18px; }

    /* Form */
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 12px; color: #90a4ae; margin-bottom: 5px; }
    input[type=text], input[type=number], textarea, select {
      width: 100%; background: #161b27; border: 1px solid #2a4a6b;
      border-radius: 6px; padding: 9px 12px; color: #e0e0e0; font-size: 13px;
      direction: rtl; transition: border 0.2s;
    }
    input:focus, textarea:focus, select:focus { outline: none; border-color: #4fc3f7; }
    textarea { resize: vertical; min-height: 80px; }

    /* Mode toggle */
    .mode-toggle { display: flex; gap: 0; border: 1px solid #2a4a6b; border-radius: 8px; overflow: hidden; }
    .mode-btn {
      flex: 1; padding: 10px 8px; cursor: pointer; font-size: 12px; font-weight: 600;
      text-align: center; background: #161b27; color: #78909c; border: none;
      transition: all 0.2s;
    }
    .mode-btn.active { background: #1a3a5c; color: #4fc3f7; }
    .mode-btn:hover:not(.active) { background: #1e2530; color: #b0bec5; }

    .wa-wait-row { display: flex; align-items: center; gap: 8px; }
    .wa-wait-row input { width: 80px; flex-shrink: 0; }
    .wa-wait-row span { font-size: 12px; color: #78909c; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 18px; border-radius: 6px; border: none;
      font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
    }
    .btn-primary { background: #1565c0; color: #fff; }
    .btn-primary:hover { background: #1976d2; }
    .btn-success { background: #1b5e20; color: #a5d6a7; border: 1px solid #2e7d32; }
    .btn-success:hover { background: #2e7d32; }
    .btn-danger { background: #3c1414; color: #ef9a9a; border: 1px solid #7f1616; font-size: 11px; padding: 6px 10px; }
    .btn-danger:hover { background: #7f1616; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .btn-outline { background: transparent; border: 1px solid #2a4a6b; color: #90a4ae; }
    .btn-outline:hover { border-color: #4fc3f7; color: #4fc3f7; }
    .btn-full { width: 100%; justify-content: center; }

    /* Campaign list */
    .campaign-item {
      border: 1px solid #1e3a5f; border-radius: 8px;
      margin-bottom: 10px; overflow: hidden;
    }
    .campaign-item:hover { border-color: #2a5a8f; }
    .camp-header {
      padding: 12px 14px; cursor: pointer;
      display: flex; align-items: center; justify-content: space-between;
    }
    .camp-title { font-size: 14px; font-weight: 600; color: #e0e0e0; }
    .camp-meta { font-size: 11px; color: #78909c; margin-top: 2px; }
    .status-badge {
      font-size: 10px; padding: 3px 8px; border-radius: 10px; font-weight: 600;
    }
    .s-draft    { background: #263238; color: #90a4ae; }
    .s-active   { background: #1b5e20; color: #a5d6a7; }
    .s-paused   { background: #3e2723; color: #ffab91; }
    .s-completed{ background: #1a237e; color: #9fa8da; }

    .camp-body { padding: 14px; border-top: 1px solid #1e3a5f; display: none; }
    .camp-body.open { display: block; }
    .camp-stats { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .cs { background: #161b27; border-radius: 6px; padding: 8px 12px; text-align: center; flex: 1; min-width: 70px; }
    .cs .n { font-size: 18px; font-weight: 700; color: #4fc3f7; }
    .cs .l { font-size: 10px; color: #78909c; }
    .camp-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* Leads import */
    .leads-import { border-top: 1px solid #1e3a5f; margin-top: 14px; padding-top: 14px; }
    .leads-import label { font-size: 12px; color: #90a4ae; margin-bottom: 5px; }
    .leads-import textarea { min-height: 70px; font-family: monospace; font-size: 11px; }
    .hint { font-size: 10px; color: #546e7a; margin-top: 4px; }

    /* Mode icon */
    .mode-icon { font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
    .wa-call .mode-icon::before { content: '💬→📞'; }
    .call-only .mode-icon::before { content: '📞'; }

    .empty-state {
      text-align: center; padding: 40px 20px; color: #546e7a; font-size: 13px;
    }
    .empty-state .icon { font-size: 36px; margin-bottom: 10px; }

    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1b5e20; color: #a5d6a7; border: 1px solid #2e7d32;
      padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
      opacity: 0; transition: opacity 0.3s; z-index: 999; pointer-events: none;
    }
    .toast.error { background: #3c1414; color: #ef9a9a; border-color: #7f1616; }
    .toast.show { opacity: 1; }

    .loading { text-align: center; padding: 30px; color: #546e7a; }
    .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #1e3a5f; border-top-color: #4fc3f7; border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
    }
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
  <h1>ניהול קמפיינים</h1>
  <p class="subtitle">שלח WA ואם אין מענה — רן יתקשר אוטומטית | או שיחה ישירה</p>

  <div class="stats-row" id="statsRow">
    <div class="stat-card"><div class="num" id="statTotal">-</div><div class="lbl">קמפיינים</div></div>
    <div class="stat-card"><div class="num" id="statActive">-</div><div class="lbl">פעילים</div></div>
    <div class="stat-card"><div class="num" id="statWaSent">-</div><div class="lbl">WA נשלחו</div></div>
    <div class="stat-card"><div class="num" id="statCalls">-</div><div class="lbl">שיחות יזומו</div></div>
    <div class="stat-card"><div class="num" id="statReplied">-</div><div class="lbl">מענו</div></div>
  </div>

  <div class="grid">

    <!-- ── Create Campaign ─────────────────────────── -->
    <div class="panel">
      <div class="panel-header">
        <h2>קמפיין חדש</h2>
      </div>
      <div class="panel-body">
        <div class="form-group">
          <label>שם הקמפיין</label>
          <input type="text" id="newName" placeholder="למשל: בת ים מרץ 2026">
        </div>

        <div class="form-group">
          <label>מצב פנייה ראשונית</label>
          <div class="mode-toggle">
            <button class="mode-btn active" id="modeWaCall" onclick="setMode('wa_then_call')">
              💬 → 📞  WA ואז שיחה
            </button>
            <button class="mode-btn" id="modeCallOnly" onclick="setMode('call_only')">
              📞 שיחה ישירה
            </button>
          </div>
        </div>

        <div class="form-group" id="waWaitGroup">
          <label>המתן לפני שיחה</label>
          <div class="wa-wait-row">
            <input type="number" id="newWaWait" value="60" min="5" max="1440">
            <span>דקות ללא מענה WA → רן מתקשר</span>
          </div>
        </div>

        <div class="form-group">
          <label>שם הסוכן</label>
          <input type="text" id="newAgent" value="רן" placeholder="רן">
        </div>

        <div class="form-group" id="waMessageGroup">
          <label>הודעת WA (אופציונלי)</label>
          <textarea id="newWaMessage" placeholder="שלום {{name}}! אני רן מ-QUANTUM...&#10;&#10;השאר ריק לשימוש בהודעה ברירת מחדל"></textarea>
          <div class="hint">{{name}} יוחלף בשם הליד</div>
        </div>

        <div class="form-group">
          <label>הערות פנימיות</label>
          <input type="text" id="newNotes" placeholder="אופציונלי">
        </div>

        <button class="btn btn-primary btn-full" onclick="createCampaign()">
          ✚ צור קמפיין
        </button>
      </div>
    </div>

    <!-- ── Campaign List ────────────────────────────── -->
    <div class="panel">
      <div class="panel-header">
        <h2>קמפיינים</h2>
        <button class="btn btn-outline btn-sm" onclick="loadCampaigns()">↻ רענן</button>
      </div>
      <div class="panel-body" id="campaignList">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>

  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  const API = '/api/campaigns';
  let selectedMode = 'wa_then_call';

  function setMode(mode) {
    selectedMode = mode;
    document.getElementById('modeWaCall').classList.toggle('active', mode === 'wa_then_call');
    document.getElementById('modeCallOnly').classList.toggle('active', mode === 'call_only');
    document.getElementById('waWaitGroup').style.display = mode === 'wa_then_call' ? '' : 'none';
    document.getElementById('waMessageGroup').style.display = mode === 'wa_then_call' ? '' : 'none';
  }

  function showToast(msg, type='success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + type + ' show';
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  async function api(url, method='GET', body=null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    return r.json();
  }

  async function loadCampaigns() {
    const el = document.getElementById('campaignList');
    el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const data = await api(API);
      const campaigns = data.campaigns || [];

      // Update stats
      let waSent = 0, calls = 0, replied = 0, active = 0;
      campaigns.forEach(c => {
        waSent  += parseInt(c.wa_sent || 0);
        calls   += parseInt(c.calls_made || 0);
        replied += parseInt(c.wa_replied || 0);
        if (c.status === 'active') active++;
      });
      document.getElementById('statTotal').textContent   = campaigns.length;
      document.getElementById('statActive').textContent  = active;
      document.getElementById('statWaSent').textContent  = waSent;
      document.getElementById('statCalls').textContent   = calls;
      document.getElementById('statReplied').textContent = replied;

      if (!campaigns.length) {
        el.innerHTML = '<div class="empty-state"><div class="icon">📋</div>אין קמפיינים עדיין. צור את הראשון!</div>';
        return;
      }

      el.innerHTML = campaigns.map(c => {
        const modeLabel = c.mode === 'wa_then_call'
          ? \`💬→📞 WA ואז שיחה (${c.wa_wait_minutes} דק')\`
          : '📞 שיחה ישירה';
        return \`
          <div class="campaign-item" id="camp-\${c.id}">
            <div class="camp-header" onclick="toggleCamp(\${c.id})">
              <div>
                <div class="camp-title">\${c.name}</div>
                <div class="camp-meta">\${modeLabel} | סוכן: \${c.agent_name}</div>
              </div>
              <span class="status-badge s-\${c.status}">\${statusLabel(c.status)}</span>
            </div>
            <div class="camp-body" id="body-\${c.id}">
              <div class="camp-stats">
                <div class="cs"><div class="n">\${c.total_leads||0}</div><div class="l">ליידים</div></div>
                <div class="cs"><div class="n">\${c.wa_sent||0}</div><div class="l">WA נשלח</div></div>
                <div class="cs"><div class="n">\${c.wa_replied||0}</div><div class="l">מענו</div></div>
                <div class="cs"><div class="n">\${c.calls_made||0}</div><div class="l">שיחות</div></div>
              </div>
              <div class="camp-actions">
                \${c.status === 'draft' || c.status === 'paused'
                  ? \`<button class="btn btn-success btn-sm" onclick="launchCampaign(\${c.id}, '\${c.name}')">▶ הפעל</button>\`
                  : ''}
                \${c.status === 'active'
                  ? \`<button class="btn btn-outline btn-sm" onclick="pauseCampaign(\${c.id})">⏸ השהה</button>\`
                  : ''}
                <button class="btn btn-outline btn-sm" onclick="openAddLeads(\${c.id})">+ הוסף ליידים</button>
                <button class="btn btn-danger" onclick="deleteCampaign(\${c.id}, '\${c.name}')">🗑</button>
              </div>
              <div class="leads-import" id="leadsForm-\${c.id}" style="display:none">
                <label>הוסף מספרים (שורה לכל מספר, או: מספר,שם)</label>
                <textarea id="leadsText-\${c.id}" placeholder="0521234567\\n0537654321,אורן לוי\\n0509876543,רחל כהן"></textarea>
                <div class="hint">פורמט: מספר בלבד, או מספר,שם</div>
                <div style="display:flex;gap:8px;margin-top:8px">
                  <button class="btn btn-primary btn-sm" onclick="addLeads(\${c.id})">שמור ליידים</button>
                  <button class="btn btn-outline btn-sm" onclick="closeLeads(\${c.id})">ביטול</button>
                </div>
              </div>
            </div>
          </div>\`;
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="empty-state">שגיאת טעינה</div>';
    }
  }

  function statusLabel(s) {
    return { draft: 'טיוטה', active: 'פעיל', paused: 'מושהה', completed: 'הסתיים' }[s] || s;
  }

  function toggleCamp(id) {
    const body = document.getElementById('body-' + id);
    body.classList.toggle('open');
  }

  async function createCampaign() {
    const name = document.getElementById('newName').value.trim();
    if (!name) { showToast('חסר שם קמפיין', 'error'); return; }
    const body = {
      name,
      mode: selectedMode,
      wa_wait_minutes: parseInt(document.getElementById('newWaWait').value) || 60,
      agent_name: document.getElementById('newAgent').value || 'רן',
      wa_message: document.getElementById('newWaMessage').value || null,
      notes: document.getElementById('newNotes').value || null
    };
    const data = await api(API, 'POST', body);
    if (data.success) {
      showToast('קמפיין נוצר בהצלחה!');
      document.getElementById('newName').value = '';
      document.getElementById('newNotes').value = '';
      document.getElementById('newWaMessage').value = '';
      loadCampaigns();
    } else { showToast(data.error || 'שגיאה', 'error'); }
  }

  async function launchCampaign(id, name) {
    if (!confirm(\`להפעיל את הקמפיין "\${name}"?\`)) return;
    const data = await api(\`\${API}/\${id}/launch\`, 'POST');
    if (data.success) {
      showToast(data.message || 'הקמפיין הופעל!');
      loadCampaigns();
    } else { showToast(data.error || 'שגיאה', 'error'); }
  }

  async function pauseCampaign(id) {
    const data = await api(\`\${API}/\${id}/pause\`, 'POST');
    if (data.success) { showToast('הקמפיין הושהה'); loadCampaigns(); }
    else { showToast(data.error || 'שגיאה', 'error'); }
  }

  async function deleteCampaign(id, name) {
    if (!confirm(\`למחוק את "\${name}"? הפעולה לא ניתנת לביטול.\`)) return;
    const data = await api(\`\${API}/\${id}\`, 'DELETE');
    if (data.success) { showToast('נמחק'); loadCampaigns(); }
    else { showToast(data.error || 'שגיאה', 'error'); }
  }

  function openAddLeads(id) {
    document.getElementById('leadsForm-' + id).style.display = '';
    document.getElementById('body-' + id).classList.add('open');
  }
  function closeLeads(id) {
    document.getElementById('leadsForm-' + id).style.display = 'none';
  }

  async function addLeads(id) {
    const raw = document.getElementById('leadsText-' + id).value.trim();
    if (!raw) { showToast('אין מספרים', 'error'); return; }
    const leads = raw.split('\\n').map(line => {
      line = line.trim();
      if (!line) return null;
      const parts = line.split(',');
      return { phone: parts[0].trim(), name: parts[1] ? parts[1].trim() : null, source: 'manual' };
    }).filter(Boolean);
    if (!leads.length) { showToast('לא נמצאו מספרים תקינים', 'error'); return; }
    const data = await api(\`\${API}/\${id}/leads\`, 'POST', { leads });
    if (data.success) {
      showToast(\`\${data.inserted} ליידים נוספו\`);
      document.getElementById('leadsText-' + id).value = '';
      closeLeads(id);
      loadCampaigns();
    } else { showToast(data.error || 'שגיאה', 'error'); }
  }

  // Init
  loadCampaigns();
  setInterval(loadCampaigns, 30000); // auto-refresh every 30s
</script>
</body>
</html>`);
});

module.exports = router;
