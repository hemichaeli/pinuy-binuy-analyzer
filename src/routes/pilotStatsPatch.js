/**
 * Pilot Stats Patch
 * 1. GET /api/stats — augments with pilotWaSent + pilotReplied
 * 2. GET / (dashboard HTML) — injects:
 *    a) Pilot stat card in main stats grid
 *    b) Pilot status options into existing convStatusFilter dropdown
 *    c) Override of loadConversations to handle pilot filters inline
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const fs = require('fs');
const path = require('path');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];
const DASHBOARD_PATH = path.join(__dirname, '../public/dashboard.html');

// ── Pilot stat card (main stats grid) ────────────────────────────────────────
const PILOT_CARD_HTML = `
            <div id="pilot-stat-card" class="stat-card" style="cursor:pointer;border-color:rgba(245,158,11,0.4);" onclick="if(window.switchTab)switchTab('messages');document.getElementById('convStatusFilter').value='pilot_waiting';loadConversations();">
                <div class="stat-number" style="color:#f59e0b;"><span class="stat-val" data-stat="pilotWaSent">...</span></div>
                <div class="stat-label">📤 פיילוט — נשלח</div>
                <div class="stat-hint"><span class="stat-val" data-stat="pilotReplied">0</span> ענו עד כה</div>
                <div class="stat-change" style="background:rgba(245,158,11,0.1);color:#f59e0b;border-color:rgba(245,158,11,0.3);">פיילוט משקיעים</div>
            </div>`;

// ── Script injection: pilot filter options + loadConversations override ───────
const PILOT_SCRIPT = `
<script>
(function() {
  // Add pilot filter options to existing convStatusFilter select
  function addPilotOptions() {
    var sel = document.getElementById('convStatusFilter');
    if (!sel || sel.querySelector('[value="pilot_all"]')) return;
    var sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '─── פיילוט ───';
    sel.appendChild(sep);
    [
      { value: 'pilot_all',     label: '📤 כל הפיילוט' },
      { value: 'pilot_waiting', label: '⏳ ממתין למענה' },
      { value: 'pilot_replied', label: '✅ ענו' },
      { value: 'pilot_unsent',  label: '🔴 לא נשלח' }
    ].forEach(function(o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
  }

  // Render a pilot contact as a conv-list item
  function renderPilotItem(c) {
    var hasReply   = !!c.last_reply_at;
    var wasSent    = c.message_status === 'נשלחה';
    var dotColor   = hasReply ? '#4ade80' : wasSent ? '#f59e0b' : '#6b7280';
    var statusBadge = hasReply
      ? '<span style="font-size:10px;color:#4ade80;">✅ ענה</span>'
      : wasSent
        ? '<span style="font-size:10px;color:#f59e0b;">⏳ ממתין</span>'
        : '<span style="font-size:10px;color:#6b7280;">🔴 לא נשלח</span>';
    var preview = hasReply && c.last_reply_text
      ? '↩ ' + c.last_reply_text.substring(0, 50)
      : wasSent
        ? 'נשלחה הודעת פנייה'
        : 'טרם נשלחה הודעה';
    var date = c.last_reply_at
      ? new Date(c.last_reply_at).toLocaleDateString('he-IL')
      : c.last_message_sent_at
        ? new Date(c.last_message_sent_at).toLocaleDateString('he-IL')
        : '';
    var name = c.contact_name || c.phone || '';
    var sub  = (c.complex_name || '') + (c.city ? ' — ' + c.city : '');
    var waUrl = 'https://wa.me/972' + (c.phone||'').replace(/^0/,'');
    return '<div class="conv-item" data-convid="pilot_' + c.phone + '" onclick="window.open(\'' + waUrl + '\',\'_blank\')" style="cursor:pointer;">'
      + '<div style="display:flex;align-items:center;gap:7px;justify-content:space-between;">'
      + '<div style="display:flex;align-items:center;gap:5px;flex:1;min-width:0;">'
      + '<div style="width:7px;height:7px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;"></div>'
      + '<div style="font-weight:600;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + name + '</div>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:3px;">' + statusBadge + ' <span style="font-size:12px;">📱</span></div>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:2px 0;">' + preview + '</div>'
      + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">'
      + '<span>' + sub + '</span><span>' + date + '</span>'
      + '</div>'
      + '</div>';
  }

  // Wait for loadConversations to exist, then wrap it
  function wrapLoadConversations() {
    if (typeof window.loadConversations !== 'function') {
      setTimeout(wrapLoadConversations, 200);
      return;
    }
    var _origLoad = window.loadConversations;
    window.loadConversations = async function() {
      var statusFilter = document.getElementById('convStatusFilter');
      var val = statusFilter ? statusFilter.value : '';
      if (!val.startsWith('pilot_')) {
        return _origLoad.apply(this, arguments);
      }

      // Pilot filter — fetch from /api/pilot/contacts
      var container = document.getElementById('conv-list');
      if (!container) return;
      container.innerHTML = '<div class="loading">טוען פיילוט...</div>';
      try {
        var data = await fetch('/api/pilot/contacts').then(function(r){return r.json();});
        var contacts = data.contacts || [];

        if (val === 'pilot_waiting') contacts = contacts.filter(function(c){ return c.message_status === 'נשלחה' && !c.last_reply_at; });
        if (val === 'pilot_replied') contacts = contacts.filter(function(c){ return !!c.last_reply_at; });
        if (val === 'pilot_unsent')  contacts = contacts.filter(function(c){ return c.message_status !== 'נשלחה'; });

        if (!contacts.length) {
          container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);"><div style="font-size:32px;margin-bottom:10px;">📭</div><p>אין תוצאות</p></div>';
          return;
        }
        container.innerHTML = contacts.map(renderPilotItem).join('');
      } catch(e) {
        container.innerHTML = '<div style="padding:20px;color:#fca5a5;">שגיאה: ' + e.message + '</div>';
      }
    };
  }

  document.addEventListener('DOMContentLoaded', function() {
    addPilotOptions();
    wrapLoadConversations();

    // Also add options when messages tab opens (tab might init after DOM ready)
    var _origSwitch = window.switchTab;
    window.switchTab = function(tab) {
      if (_origSwitch) _origSwitch.apply(this, arguments);
      if (tab === 'messages') setTimeout(addPilotOptions, 100);
    };
  });
})();
</script>`;

// ── 1. Serve modified dashboard HTML ─────────────────────────────────────────
router.get('/', (req, res, next) => {
  try {
    let html = fs.readFileSync(DASHBOARD_PATH, 'utf8');

    // a) Inject pilot stat card into stats grid (after kones card)
    const cardAnchor = 'נכסים בכינוס</div>\n            </div>\n        </div>';
    if (html.includes(cardAnchor) && !html.includes('pilot-stat-card')) {
      html = html.replace(
        cardAnchor,
        'נכסים בכינוס</div>\n            </div>' + PILOT_CARD_HTML + '\n        </div>'
      );
    }

    // b) Remove old separate pilot panel if exists
    // (no-op if not present — safe)

    // c) Inject pilot script before </body>
    if (!html.includes('pilot_waiting') && html.includes('</body>')) {
      html = html.replace('</body>', PILOT_SCRIPT + '\n</body>');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    next();
  }
});

// ── 2. Augment /api/stats with pilot data ─────────────────────────────────────
router.get('/api/stats', async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = async function(data) {
    if (data && data.success && data.data) {
      try {
        const { rows } = await pool.query(`
          SELECT
            COUNT(DISTINCT phone) FILTER (WHERE message_status = 'נשלחה') as wa_sent,
            COUNT(DISTINCT phone) FILTER (WHERE last_reply_at IS NOT NULL) as replied
          FROM listings
          WHERE complex_id = ANY($1) AND is_active = TRUE
        `, [PILOT_IDS]);
        data.data.pilotWaSent  = parseInt(rows[0]?.wa_sent)  || 0;
        data.data.pilotReplied = parseInt(rows[0]?.replied)  || 0;
      } catch (e) {
        data.data.pilotWaSent  = 0;
        data.data.pilotReplied = 0;
      }
    }
    return originalJson(data);
  };
  next();
});

module.exports = router;
