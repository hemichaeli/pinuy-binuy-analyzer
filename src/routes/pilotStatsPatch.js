/**
 * Pilot Stats Patch
 * 1. Intercepts GET /api/stats — augments with pilotWaSent + pilotReplied
 * 2. Intercepts GET / (dashboard HTML) — reads file, injects pilot card, sends modified HTML
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const fs = require('fs');
const path = require('path');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];

const DASHBOARD_PATH = path.join(__dirname, '../public/dashboard.html');

const PILOT_CARD_HTML = `
            <div id="pilot-stat-card" class="stat-card" style="cursor:pointer;border-color:rgba(245,158,11,0.4);" onclick="if(window.switchTab)switchTab('ads')">
                <div class="stat-number" style="color:#f59e0b;"><span class="stat-val" data-stat="pilotWaSent">...</span></div>
                <div class="stat-label">📤 פיילוט — נשלח</div>
                <div class="stat-hint"><span class="stat-val" data-stat="pilotReplied">0</span> ענו עד כה</div>
                <div class="stat-change" style="background:rgba(245,158,11,0.1);color:#f59e0b;border-color:rgba(245,158,11,0.3);">פיילוט משקיעים</div>
            </div>`;

// ── 1. Serve modified dashboard HTML ─────────────────────────────────────────
router.get('/', (req, res, next) => {
  try {
    let html = fs.readFileSync(DASHBOARD_PATH, 'utf8');

    // Inject pilot card after the kones stat card (before closing </div> of stats-grid)
    const anchor = 'נכסים בכינוס</div>\n            </div>\n        </div>';
    if (html.includes(anchor) && !html.includes('pilot-stat-card')) {
      html = html.replace(
        anchor,
        'נכסים בכינוס</div>\n            </div>' + PILOT_CARD_HTML + '\n        </div>'
      );
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    // Fall through to original route if something goes wrong
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
