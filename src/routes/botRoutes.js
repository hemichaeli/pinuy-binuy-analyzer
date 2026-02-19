/**
 * QUANTUM WhatsApp Bot - INFORU Webservice Webhook
 * Uses axios (already in package.json) to call Claude API directly
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { Pool } = require('pg');
const { logger } = require('../services/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// ─── Claude API Call ─────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt) {
  const response = await axios.post(CLAUDE_API_URL, {
    model: CLAUDE_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 10000
  });

  return response.data.content[0].text;
}

// ─── QUANTUM Bot Personality ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `אתה QUANTUM - נציג של משרד תיווך בוטיק המתמחה בפינוי-בינוי והתחדשות עירונית בישראל.

האישיות שלך:
- חכם, חם, ישיר - כמו האדם החכם ביותר שהלקוח אי-פעם פגש
- קצר ולעניין - ב-WhatsApp כל הודעה עד 2-3 שורות
- תמיד בעברית
- לא מזכיר "מערכת", "אלגוריתם", "פלטפורמה"

מטרת השיחה:
- להבין מי הלקוח (קונה או מוכר)
- לאסוף פרטים בצורה טבעית
- להכין ליד לנציג שיחזור תוך 24 שעות

מה לאסוף לפי סוג לקוח:
מוכר: עיר, סוג נכס, מספר חדרים, שם
קונה: עיר מבוקשת, סוג נכס, תקציב, ציר זמן, שם

חוקים:
- שאלה אחת בכל פעם
- הודעות קצרות (עד 3 שורות)
- לא לבטיח מחירים ספציפיים`;

// ─── Conversation Logic ──────────────────────────────────────────────────────

function parseParams(parameters) {
  const params = {};
  (parameters || []).forEach(p => { params[p.name] = p.value; });
  return params;
}

function getMissingFields(params) {
  if (!params.user_type) return ['user_type'];
  const missing = [];
  if (!params.city) missing.push('city');
  if (!params.property_type) missing.push('property_type');
  if (!params.name) missing.push('name');
  if (params.user_type === 'seller' && !params.rooms) missing.push('rooms');
  if (params.user_type === 'buyer' && !params.budget) missing.push('budget');
  if (params.user_type === 'buyer' && !params.timeline) missing.push('timeline');
  return missing;
}

async function getClaudeDecision(parameters, currentInput) {
  const params = parseParams(parameters);
  const missing = getMissingFields(params);
  const isComplete = missing.length === 0;

  const userPrompt = `מצב השיחה:
נאסף: ${JSON.stringify(params)}
קלט נוכחי: "${currentInput || '(התחלת שיחה)'}"
חסר: ${missing.join(', ') || 'אין - הכל נאסף'}

${isComplete
  ? 'כל הפרטים נאספו. שלח הודעת סיום חמה - תודה ונציג QUANTUM יחזור תוך 24 שעות.'
  : `שאל רק על: "${missing[0]}"
מיפוי שאלות:
- user_type: "שלום! אני מ-QUANTUM. יש לך נכס למכירה, או שאתה מחפש לקנות?"
- city: שאל באיזה עיר/אזור
- property_type: שאל על סוג הנכס
- rooms: שאל כמה חדרים
- budget: שאל על תקציב בערך
- timeline: שאל מתי רוצה לסגור
- name: "ואיך אפשר לפנות אליך?"`
}

ענה אך ורק ב-JSON:
{
  "message": "ההודעה",
  "save": { "param_name": "value" },
  "done": ${isComplete}
}

כלל save: שמור רק מה שהמשתמש ענה בקלט הנוכחי.
- user_type: "seller" אם מכירה, "buyer" אם קנייה`;

  const text = await callClaude(SYSTEM_PROMPT, userPrompt);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    logger.warn('Claude non-JSON', { text: text.substring(0, 200) });
  }

  return { message: text.substring(0, 250), save: {}, done: false };
}

// ─── Build INFORU Actions ────────────────────────────────────────────────────

function buildActions(decision) {
  const actions = [];

  if (decision.save) {
    Object.entries(decision.save).forEach(([name, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        actions.push({ type: 'SetParameter', name, value: String(value) });
      }
    });
  }

  if (decision.message) {
    actions.push({ type: 'SendMessage', text: decision.message });
  }

  if (decision.done) {
    actions.push({ type: 'SetParameter', name: 'conversation_complete', value: 'true' });
    actions.push({ type: 'Return', value: 'complete' });
  } else {
    actions.push({ type: 'InputText' });
  }

  return actions;
}

// ─── Save Lead ───────────────────────────────────────────────────────────────

async function saveLeadToDB(callbackData) {
  const { chat, fields, parameters } = callbackData;
  const params = parseParams(parameters);
  const rawPhone = (chat?.sender || '').replace(/\D/g, '').slice(-10);

  try {
    await pool.query(`
      INSERT INTO leads (source, phone, name, city, property_type, user_type, budget, timeline, rooms, raw_data, status, created_at)
      VALUES ('whatsapp_bot', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'new', NOW())
    `, [rawPhone, params.name || fields?.name || null, params.city || null, params.property_type || null,
        params.user_type || null, params.budget || null, params.timeline || null, params.rooms || null,
        JSON.stringify(callbackData)]);
    logger.info('Bot lead saved', { phone: rawPhone, type: params.user_type });
  } catch (err) {
    try {
      await pool.query(`
        INSERT INTO website_leads (source, phone, name, user_type, form_data, status, created_at)
        VALUES ('whatsapp_bot', $1, $2, $3, $4, 'new', NOW())
      `, [rawPhone, params.name || null, params.user_type || 'unknown', JSON.stringify({ ...params, raw: callbackData })]);
    } catch (err2) {
      logger.error('Failed to save bot lead', { error: err2.message });
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/bot/webservice
 * Called by INFORU at every WhatsApp conversation step
 */
router.post('/webservice', async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.json({ actions: [{ type: 'SendMessage', text: 'רגע...' }, { type: 'InputText' }] });
    }
  }, 4500);

  try {
    const { campaign, chat, parameters, value } = req.body;
    logger.info('Bot webservice', { sender: chat?.sender, input: value?.string, params: (parameters || []).length });

    const decision = await getClaudeDecision(parameters, value?.string || null);
    const actions = buildActions(decision);

    clearTimeout(timeout);
    if (!res.headersSent) res.json({ actions });

  } catch (err) {
    clearTimeout(timeout);
    logger.error('Bot webservice error', { error: err.message });
    if (!res.headersSent) {
      res.json({ actions: [{ type: 'SendMessage', text: 'משהו השתבש. נציג יחזור אליך.' }, { type: 'Return', value: 'error' }] });
    }
  }
});

/**
 * POST /api/bot/callback
 * Called by INFORU when a conversation lead is finalized
 */
router.post('/callback', async (req, res) => {
  res.json({ status: 'ok' });
  try {
    logger.info('Bot callback', { leadId: req.body?.lead?.id });
    await saveLeadToDB(req.body);
  } catch (err) {
    logger.error('Bot callback error', { error: err.message });
  }
});

/**
 * GET /api/bot/health
 */
router.get('/health', (req, res) => {
  const base = 'https://pinuy-binuy-analyzer-production.up.railway.app';
  res.json({
    status: 'ok',
    bot: 'QUANTUM WhatsApp Bot v1.0',
    endpoints: {
      webservice: `${base}/api/bot/webservice`,
      callback: `${base}/api/bot/callback`
    },
    config: {
      claude: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
      db: !!process.env.DATABASE_URL ? 'configured' : 'MISSING'
    }
  });
});

/**
 * GET /api/bot/leads - List all bot leads with filters
 */
router.get('/leads', async (req, res) => {
  try {
    const { status, user_type, limit = 100, offset = 0 } = req.query;

    let where = [];
    let params = [];
    let idx = 1;

    // Try leads table first
    let rows = [];
    let total = 0;

    try {
      if (status) { where.push(`status = $${idx++}`); params.push(status); }
      if (user_type) { where.push(`user_type = $${idx++}`); params.push(user_type); }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const countRes = await pool.query(`SELECT COUNT(*) FROM leads ${whereClause}`, params);
      total = parseInt(countRes.rows[0].count);

      const dataRes = await pool.query(
        `SELECT id, source, phone, name, city, property_type, user_type, budget, timeline, rooms,
                status, notes, assigned_to, created_at, updated_at
         FROM leads ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, parseInt(limit), parseInt(offset)]
      );
      rows = dataRes.rows;
    } catch (e) {
      // leads table may not exist yet
      logger.warn('leads table query failed, returning empty', { error: e.message });
    }

    // Stats
    let stats = { total: 0, new: 0, contacted: 0, sellers: 0, buyers: 0 };
    try {
      const statsRes = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'new') as new_leads,
          COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
          COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
          COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers
        FROM leads
      `);
      const s = statsRes.rows[0];
      stats = {
        total: parseInt(s.total),
        new: parseInt(s.new_leads),
        contacted: parseInt(s.contacted),
        sellers: parseInt(s.sellers),
        buyers: parseInt(s.buyers)
      };
    } catch (e) { /* table might not exist */ }

    res.json({ leads: rows, total, stats, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    logger.error('Bot leads list error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/bot/leads/:id/status - Update lead status
 */
router.put('/leads/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, assigned_to } = req.body;
    const valid = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost'];
    if (status && !valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${valid.join(', ')}` });
    }

    const sets = [];
    const params = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); params.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(notes); }
    if (assigned_to !== undefined) { sets.push(`assigned_to = $${idx++}`); params.push(assigned_to); }
    sets.push(`updated_at = NOW()`);
    params.push(parseInt(id));

    const result = await pool.query(
      `UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    logger.error('Bot lead update error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/test
 * Test the bot logic without INFORU
 */
router.post('/test', async (req, res) => {
  try {
    const { parameters = [], input = null } = req.body;
    const decision = await getClaudeDecision(parameters, input);
    const actions = buildActions(decision);
    const nextParams = [
      ...parameters,
      ...Object.entries(decision.save || {}).map(([name, value]) => ({ name, value }))
    ];
    res.json({ decision, actions, next_params: nextParams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
