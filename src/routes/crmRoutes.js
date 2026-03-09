const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');
const { logger } = require('../services/logger');

// ===================== ZOHO OAUTH =====================

/**
 * GET /api/crm/oauth/callback
 * Zoho redirects here with ?code=... after user authorizes
 * Exchanges the code for a refresh token and displays it
 */
router.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.type('text/html').send(`
      <html dir="rtl" lang="he">
      <head><meta charset="UTF-8"><title>Zoho OAuth Error</title>
      <style>body{font-family:Arial;background:#0a0a0f;color:#f87171;padding:40px;text-align:center}</style>
      </head><body>
      <h1>❌ שגיאה בהרשאה</h1>
      <p>${error}</p>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).type('text/html').send(`
      <html dir="rtl" lang="he">
      <head><meta charset="UTF-8"><title>No Code</title>
      <style>body{font-family:Arial;background:#0a0a0f;color:#fbbf24;padding:40px;text-align:center}</style>
      </head><body>
      <h1>⚠️ לא התקבל קוד הרשאה</h1>
      </body></html>
    `);
  }

  try {
    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const redirectUri = `https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback`;

    const tokenRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
      params: {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }
    });

    const { refresh_token, access_token, error: tokenError } = tokenRes.data;

    if (tokenError || !refresh_token) {
      logger.error('[Zoho OAuth] Token exchange failed:', tokenRes.data);
      return res.type('text/html').send(`
        <html dir="rtl" lang="he">
        <head><meta charset="UTF-8"><title>Token Error</title>
        <style>body{font-family:Arial;background:#0a0a0f;color:#f87171;padding:40px}</style>
        </head><body>
        <h1>❌ שגיאה בקבלת Refresh Token</h1>
        <pre style="background:#1e293b;padding:16px;border-radius:8px;color:#e2e8f0">${JSON.stringify(tokenRes.data, null, 2)}</pre>
        </body></html>
      `);
    }

    logger.info('[Zoho OAuth] Refresh token obtained successfully');

    res.type('text/html').send(`
      <html dir="rtl" lang="he">
      <head>
        <meta charset="UTF-8">
        <title>QUANTUM - Zoho OAuth הצלחה</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'Segoe UI',Arial,sans-serif;background:#0a0a0f;color:#e2e8f0;direction:rtl;padding:40px;min-height:100vh}
          .card{max-width:680px;margin:0 auto;background:#111827;border:1px solid #065f46;border-radius:16px;padding:32px}
          h1{color:#34d399;font-size:24px;margin-bottom:8px}
          .sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
          .token-box{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:16px;margin:16px 0}
          .token-label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
          .token-val{font-family:monospace;font-size:13px;color:#60a5fa;word-break:break-all;background:#0a0a0f;padding:10px;border-radius:6px}
          .step{background:#1e3a5f22;border:1px solid #1e3a5f;border-radius:8px;padding:14px;margin:10px 0}
          .step-num{color:#60a5fa;font-weight:bold;font-size:13px}
          code{background:#1e293b;padding:3px 8px;border-radius:4px;font-family:monospace;font-size:12px;color:#fbbf24}
          .warn{background:#291500;border:1px solid #7c2d12;border-radius:8px;padding:12px;margin-top:16px;font-size:13px;color:#fca5a5}
        </style>
      </head>
      <body>
        <div class="card">
          <h1>✅ Zoho OAuth הצלחה!</h1>
          <div class="sub">ה-Refresh Token נוצר בהצלחה. עקוב אחר השלבים הבאים:</div>

          <div class="token-box">
            <div class="token-label">🔑 Refresh Token (שמור אותו!)</div>
            <div class="token-val">${refresh_token}</div>
          </div>

          <div class="step">
            <div class="step-num">שלב 1: הגדר ב-Railway</div>
            <div style="margin-top:8px;font-size:13px;color:#94a3b8">
              העתק את ה-Refresh Token למעלה והגדר ב-Railway:<br>
              <code>ZOHO_REFRESH_TOKEN = ${refresh_token.substring(0, 20)}...</code>
            </div>
          </div>

          <div class="step">
            <div class="step-num">שלב 2: בדיקה</div>
            <div style="margin-top:8px;font-size:13px;color:#94a3b8">
              לאחר הגדרת המשתנה, בדוק עם:<br>
              <code>GET /api/crm/zoho/status</code>
            </div>
          </div>

          <div class="warn">
            ⚠️ אל תסגור את החלון הזה עד שתעתיק את ה-Refresh Token!
          </div>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    logger.error('[Zoho OAuth] Callback error:', err.message);
    res.status(500).type('text/html').send(`
      <html dir="rtl"><head><meta charset="UTF-8"><style>body{font-family:Arial;background:#0a0a0f;color:#f87171;padding:40px}</style></head>
      <body><h1>❌ שגיאה</h1><p>${err.message}</p></body></html>
    `);
  }
});

/**
 * GET /api/crm/zoho/auth-url
 * Returns the Zoho OAuth authorization URL
 */
router.get('/zoho/auth-url', (req, res) => {
  const clientId = process.env.ZOHO_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: 'ZOHO_CLIENT_ID not set' });

  const redirectUri = encodeURIComponent(`https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback`);
  const scope = encodeURIComponent('ZohoCRM.modules.ALL,ZohoCRM.settings.ALL');
  const url = `https://accounts.zoho.com/oauth/v2/auth?scope=${scope}&client_id=${clientId}&response_type=code&access_type=offline&redirect_uri=${redirectUri}`;

  res.json({ url, instruction: 'Open this URL in your browser to authorize Zoho CRM access' });
});

/**
 * GET /api/crm/zoho/status
 * Check Zoho CRM connection status
 */
router.get('/zoho/status', async (req, res) => {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    return res.json({ configured: false, missing: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'].filter(k => !process.env[k]) });
  }

  if (!refreshToken) {
    const authUrlRes = await new Promise(r => {
      const clientId = process.env.ZOHO_CLIENT_ID;
      const redirectUri = encodeURIComponent(`https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback`);
      const scope = encodeURIComponent('ZohoCRM.modules.ALL,ZohoCRM.settings.ALL');
      r(`https://accounts.zoho.com/oauth/v2/auth?scope=${scope}&client_id=${clientId}&response_type=code&access_type=offline&redirect_uri=${redirectUri}`);
    });
    return res.json({
      configured: false,
      missing: ['ZOHO_REFRESH_TOKEN'],
      action: 'Visit auth_url to authorize',
      auth_url: authUrlRes
    });
  }

  // Test the refresh token
  try {
    const tokenRes = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
      params: {
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      }
    });

    if (tokenRes.data.access_token) {
      // Test CRM access
      const crmRes = await axios.get('https://www.zohoapis.com/crm/v3/org', {
        headers: { Authorization: `Zoho-oauthtoken ${tokenRes.data.access_token}` }
      });
      res.json({
        configured: true,
        ok: true,
        org: crmRes.data?.org?.[0]?.company_name || 'connected',
        token_valid: true
      });
    } else {
      res.json({ configured: true, ok: false, error: tokenRes.data });
    }
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.response?.data || err.message });
  }
});

// ===================== CALLS =====================

// GET /api/crm/calls
router.get('/calls', async (req, res) => {
  try {
    const { lead_id, limit = 50, offset = 0 } = req.query;
    let q = `SELECT cl.*, l.name as lead_name, l.phone as lead_phone FROM call_logs cl LEFT JOIN leads l ON cl.lead_id = l.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (lead_id) { q += ` AND cl.lead_id = $${pi}`; params.push(lead_id); pi++; }
    q += ` ORDER BY cl.called_at DESC LIMIT $${pi} OFFSET $${pi+1}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await pool.query(q, params);
    const count = await pool.query(`SELECT COUNT(*) FROM call_logs${lead_id ? ' WHERE lead_id = $1' : ''}`, lead_id ? [lead_id] : []);
    res.json({ success: true, calls: rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/calls
router.post('/calls', async (req, res) => {
  try {
    const { lead_id, duration_seconds, notes, outcome, called_by } = req.body;
    if (!lead_id) return res.status(400).json({ success: false, error: 'lead_id required' });
    const { rows } = await pool.query(
      `INSERT INTO call_logs (lead_id, duration_seconds, notes, outcome, called_by, called_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [lead_id, duration_seconds || 0, notes || '', outcome || 'answered', called_by || 'agent']
    );
    await pool.query(`UPDATE leads SET last_contact = NOW(), updated_at = NOW() WHERE id = $1`, [lead_id]).catch(() => {});
    res.json({ success: true, call: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== REMINDERS =====================

// GET /api/crm/reminders
router.get('/reminders', async (req, res) => {
  try {
    const { status = 'pending', lead_id } = req.query;
    let q = `SELECT r.*, l.name as lead_name, l.phone as lead_phone FROM reminders r LEFT JOIN leads l ON r.lead_id = l.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (status !== 'all') { q += ` AND r.status = $${pi}`; params.push(status); pi++; }
    if (lead_id) { q += ` AND r.lead_id = $${pi}`; params.push(lead_id); pi++; }
    q += ` ORDER BY r.due_at ASC`;
    const { rows } = await pool.query(q, params);
    res.json({ success: true, reminders: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/reminders
router.post('/reminders', async (req, res) => {
  try {
    const { lead_id, title, notes, due_at, reminder_type } = req.body;
    if (!lead_id || !title || !due_at) return res.status(400).json({ success: false, error: 'lead_id, title, due_at required' });
    const { rows } = await pool.query(
      `INSERT INTO reminders (lead_id, title, notes, due_at, reminder_type, status, created_at) VALUES ($1,$2,$3,$4,$5,'pending',NOW()) RETURNING *`,
      [lead_id, title, notes || '', due_at, reminder_type || 'follow_up']
    );
    res.json({ success: true, reminder: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/crm/reminders/:id
router.put('/reminders/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE reminders SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    res.json({ success: true, reminder: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== DEALS / PIPELINE =====================

// GET /api/crm/deals
router.get('/deals', async (req, res) => {
  try {
    const { stage, limit = 100 } = req.query;
    let q = `SELECT d.*, l.name as lead_name, l.phone as lead_phone, c.name as complex_name FROM deals d LEFT JOIN leads l ON d.lead_id = l.id LEFT JOIN complexes c ON d.complex_id = c.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (stage) { q += ` AND d.stage = $${pi}`; params.push(stage); pi++; }
    q += ` ORDER BY d.updated_at DESC LIMIT $${pi}`; params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json({ success: true, deals: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/deals
router.post('/deals', async (req, res) => {
  try {
    const { lead_id, complex_id, title, value, stage, notes, expected_close } = req.body;
    if (!lead_id || !title) return res.status(400).json({ success: false, error: 'lead_id, title required' });
    const { rows } = await pool.query(
      `INSERT INTO deals (lead_id, complex_id, title, value, stage, notes, expected_close, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING *`,
      [lead_id, complex_id || null, title, value || 0, stage || 'prospect', notes || '', expected_close || null]
    );
    res.json({ success: true, deal: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/crm/deals/:id/stage
router.put('/deals/:id/stage', async (req, res) => {
  try {
    const { stage, notes } = req.body;
    const validStages = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    if (!validStages.includes(stage)) return res.status(400).json({ success: false, error: `Invalid stage. Valid: ${validStages.join(', ')}` });
    const closed = ['won', 'lost'].includes(stage) ? 'NOW()' : 'NULL';
    const { rows } = await pool.query(
      `UPDATE deals SET stage = $1, notes = COALESCE($2, notes), updated_at = NOW(), closed_at = ${closed} WHERE id = $3 RETURNING *`,
      [stage, notes, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Deal not found' });
    res.json({ success: true, deal: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/crm/deals/:id
router.delete('/deals/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM deals WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/crm/pipeline
router.get('/pipeline', async (req, res) => {
  try {
    const stages = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    const pipeline = {};
    for (const stage of stages) {
      const { rows } = await pool.query(
        `SELECT d.*, l.name as lead_name, l.phone as lead_phone FROM deals d LEFT JOIN leads l ON d.lead_id = l.id WHERE d.stage = $1 ORDER BY d.updated_at DESC`,
        [stage]
      );
      const total_value = rows.reduce((sum, r) => sum + (parseFloat(r.value) || 0), 0);
      pipeline[stage] = { deals: rows, count: rows.length, total_value };
    }
    const summary = {
      total_deals: Object.values(pipeline).reduce((s, p) => s + p.count, 0),
      total_pipeline_value: Object.values(pipeline).reduce((s, p) => s + p.total_value, 0),
      won_value: pipeline.won?.total_value || 0,
      win_rate: pipeline.won?.count > 0
        ? Math.round((pipeline.won.count / (pipeline.won.count + (pipeline.lost?.count || 0))) * 100)
        : 0
    };
    res.json({ success: true, pipeline, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/crm/stats
router.get('/stats', async (req, res) => {
  try {
    const [calls, reminders, deals, leads] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE called_at > NOW() - INTERVAL '7 days') as this_week FROM call_logs`).catch(() => ({ rows: [{ total: 0, this_week: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'pending' AND due_at <= NOW() + INTERVAL '24 hours') as due_soon FROM reminders`).catch(() => ({ rows: [{ total: 0, due_soon: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE stage = 'won') as won, COUNT(*) FILTER (WHERE stage = 'lost') as lost, COALESCE(SUM(value) FILTER (WHERE stage NOT IN ('won','lost')), 0) as pipeline_value FROM deals`).catch(() => ({ rows: [{ total: 0, won: 0, lost: 0, pipeline_value: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'qualified') as qualified FROM leads`).catch(() => ({ rows: [{ total: 0, qualified: 0 }] }))
    ]);
    res.json({
      success: true,
      stats: {
        calls: { total: parseInt(calls.rows[0].total), this_week: parseInt(calls.rows[0].this_week) },
        reminders: { total: parseInt(reminders.rows[0].total), due_soon: parseInt(reminders.rows[0].due_soon) },
        deals: { total: parseInt(deals.rows[0].total), won: parseInt(deals.rows[0].won), lost: parseInt(deals.rows[0].lost), pipeline_value: parseFloat(deals.rows[0].pipeline_value) },
        leads: { total: parseInt(leads.rows[0].total), qualified: parseInt(leads.rows[0].qualified) }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
