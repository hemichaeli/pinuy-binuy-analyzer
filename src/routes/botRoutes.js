/**
 * QUANTUM WhatsApp Bot - INFORU Webservice Webhook
 * Uses axios (already in package.json) to call Claude API directly
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const { logger } = require('../services/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

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

const SYSTEM_PROMPT = `אתה QUANTUM Bot - נציג חכם ואישי של QUANTUM, משרד התיווך המוביל בפינוי-בינוי בישראל.

תכונות אישיות:
- חכם בריליאנטי - יודע דברים שאחרים לא יודעים
- חם ואישי - כל לקוח הוא "בן יחיד"
- בעל תובנות עמוקות - רואה הזדמנויות לפני כולם
- מקצועי ומנוסה - מבין את השוק ואת הלקוח

QUANTUM זה משרד תיווך בוטיק, לא טכנולוגיה. אתה בן אדם מיומן, לא מערכת.

מטרה: לזהות סוג משתמש (קונה/מוכר) ולאסוף מידע בסיסי להתאמת שירות.

מידע חובה:
- שם  
- עיר/אזור
- סוג נכס (דירה/בית/מסחרי)
- תפקיד (קונה/מוכר)
- מוכר: כמה חדרים
- קונה: תקציב, לוח זמנים

טון: עברית זורמת, חם אך מקצועי, ביטחון, תובנות קצרות.

הימנע: ביטויים רובוטיים, שפה פורמלית, שאלות מרובות, הסברים ארוכים.

Flow שיחה:
1. פתיחה חמה: "שלום! אני מ-QUANTUM 👋"
2. זיהוי תפקיד: "איך קוראים לך? איפה אתה מחפש/מוכר?"
3. סוג משתמש: מעוניין לקנות/מוכר/בודק אפשרויות
4. פרטים ספציפיים לפי תפקיד
5. חיבור למתווך: "יש לי את האדם הנכון"

דוגמאות תובנות:
- "פינוי-בינוי זה השקעה חכמה"
- "באזור הזה יש הזדמנויות שרק אנחנו יודעים עליהן"
- "לקונים החכמים יש יתרון"

חזור עם JSON:
{
  "message": "התשובה לשלוח",
  "save": { "param_name": "value" },
  "done": boolean (true רק אם כל המידע החובה נאסף)
}

שמור רק פרמטרים שנאספו:
- user_type: "seller" או "buyer" אם זוהה
- name, city, property_type, budget, timeline, rooms לפי הצורך

זכור: אתה QUANTUM - החכם ביותר, הכי אישי, והכי טוב בשוק.`;

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

  const userPrompt = `מצב הנתונים:
נאספו: ${JSON.stringify(params)}
קלט נוכחי: "${currentInput || '(התחלת שיחה)'}"
חסר: ${missing.join(', ') || 'אין - הכל נאסף'}

${isComplete
  ? 'כל הפרטים נאספו. שלח הודעת סיום והכן העברה לנציג QUANTUM ישיר תוך 24 שעות.'
  : `שאל רק על: "${missing[0]}"
מיקום שאלות:
- user_type: "שלום! אני מ-QUANTUM. יש לך נכס למכירה, או שאתה מחפש לקנות?"
- city: שאל איזה עיר/אזור מעניין
- property_type: שאל על סוג הנכס
- rooms: שאל כמה חדרים
- budget: שאל מה התקציב  
- timeline: שאל מתי מתכנן לקנות
- name: "ואיך אפשר לקרוא לך?"`
}

ענה רק ב-JSON:
{
  "message": "ההודעה",
  "save": { "param_name": "value" },
  "done": ${isComplete}
}

שמור רק ערך אם נתקבל בקלט הנוכחי, אל תמציא.
- user_type: "seller" אם מוכר, "buyer" אם קונה`;

  const text = await callClaude(SYSTEM_PROMPT, userPrompt);
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    logger.warn('Claude non-JSON', { text: text.substring(0, 200) });
  }
  return { message: text.substring(0, 250), save: {}, done: false };
}

function buildActions(decision) {
  const actions = [];
  if (decision.save) {
    Object.entries(decision.save).forEach(([name, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        actions.push({ type: 'SetParameter', name, value: String(value) });
      }
    });
  }
  if (decision.message) actions.push({ type: 'SendMessage', text: decision.message });
  if (decision.done) {
    actions.push({ type: 'SetParameter', name: 'conversation_complete', value: 'true' });
    actions.push({ type: 'Return', value: 'complete' });
  } else {
    actions.push({ type: 'InputText' });
  }
  return actions;
}

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

/**
 * Adds the Quantum member to a card -> triggers native Trello bell notification
 */
async function addMemberToCard(cardId) {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const memberId = process.env.TRELLO_MEMBER_ID;
  if (!key || !token || !memberId) {
    logger.warn('Trello env vars missing - skipping addMember');
    return;
  }
  try {
    await axios.post(
      `https://api.trello.com/1/cards/${cardId}/idMembers`,
      { value: memberId },
      { params: { key, token } }
    );
    logger.info('Member added to card - Trello notification triggered', { cardId });
  } catch (err) {
    logger.error('Failed to add member to card', { error: err.message, cardId });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

router.get('/leads-ui', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/bot-leads.html'));
});

router.get('/health', (req, res) => {
  const base = 'https://pinuy-binuy-analyzer-production.up.railway.app';
  res.json({
    status: 'ok', bot: 'QUANTUM WhatsApp Bot v2.0',
    endpoints: {
      webservice: `${base}/api/bot/webservice`,
      callback: `${base}/api/bot/callback`,
      leads_ui: `${base}/api/bot/leads-ui`,
      trello_webhook: `${base}/api/bot/trello-webhook`
    },
    config: {
      claude: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
      db: !!process.env.DATABASE_URL ? 'configured' : 'MISSING',
      trello: !!process.env.TRELLO_API_KEY ? 'configured' : 'MISSING'
    }
  });
});

/** Trello webhook validation */
router.get('/trello-webhook', (req, res) => res.sendStatus(200));
router.head('/trello-webhook', (req, res) => res.sendStatus(200));

/**
 * Trello webhook - fires on every event in FireFlies board.
 * On createCard: adds member to trigger native Trello bell notification.
 */
router.post('/trello-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { action } = req.body || {};
    if (!action || action.type !== 'createCard') return;

    const cardId = action.data?.card?.id;
    const cardName = action.data?.card?.name;
    const listName = action.data?.list?.name || '';
    const boardName = action.data?.board?.name || '';
    logger.info('New card in FireFlies board', { cardName, cardId, listName });

    if (cardId) await addMemberToCard(cardId);

    // Save as system alert in QUANTUM alerts table
    try {
      await pool.query(`
        INSERT INTO alerts (complex_id, alert_type, severity, title, message, data, is_read, created_at)
        VALUES (NULL, 'system_alert', 'info', $1, $2, $3, FALSE, NOW())
      `, [
        cardName || 'כרטיס חדש ב-Trello',
        'כרטיס חדש נוצר ברשימה: ' + listName + ' (לוח: ' + boardName + ')',
        JSON.stringify({ source: 'trello', card_id: cardId, list: listName, board: boardName })
      ]);
      logger.info('System alert saved for Trello card', { cardName });
    } catch (dbErr) {
      logger.error('Failed to save Trello system alert', { error: dbErr.message });
    }
  } catch (err) {
    logger.error('Trello webhook error', { error: err.message });
  }
});

router.post('/webservice', async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ actions: [{ type: 'SendMessage', text: 'רגע...' }, { type: 'InputText' }] });
  }, 4500);
  try {
    const { chat, parameters, value } = req.body;
    logger.info('Bot webservice', { sender: chat?.sender, input: value?.string, params: (parameters || []).length });
    const decision = await getClaudeDecision(parameters, value?.string || null);
    const actions = buildActions(decision);
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ actions });
  } catch (err) {
    clearTimeout(timeout);
    logger.error('Bot webservice error', { error: err.message });
    if (!res.headersSent) res.json({ actions: [{ type: 'SendMessage', text: 'משהו השתבש. נציג יחזור אליך.' }, { type: 'Return', value: 'error' }] });
  }
});

router.post('/callback', async (req, res) => {
  res.json({ status: 'ok' });
  try {
    logger.info('Bot callback', { leadId: req.body?.lead?.id });
    await saveLeadToDB(req.body);
  } catch (err) {
    logger.error('Bot callback error', { error: err.message });
  }
});

router.get('/leads', async (req, res) => {
  try {
    const { status, user_type, limit = 200, offset = 0 } = req.query;
    let where = [], params = [], idx = 1;
    let rows = [], total = 0;
    try {
      if (status) { where.push(`status = $${idx++}`); params.push(status); }
      if (user_type) { where.push(`user_type = $${idx++}`); params.push(user_type); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      total = parseInt((await pool.query(`SELECT COUNT(*) FROM leads ${w}`, params)).rows[0].count);
      rows = (await pool.query(
        `SELECT id, source, phone, name, city, property_type, user_type, budget, timeline, rooms,
                status, notes, assigned_to, created_at, updated_at
         FROM leads ${w} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, parseInt(limit), parseInt(offset)]
      )).rows;
    } catch (e) { logger.warn('leads table not ready', { error: e.message }); }

    let stats = { total: 0, new: 0, contacted: 0, sellers: 0, buyers: 0 };
    try {
      const s = (await pool.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'new') as new_leads,
          COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
          COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
          COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers
        FROM leads
      `)).rows[0];
      stats = { total: parseInt(s.total), new: parseInt(s.new_leads), contacted: parseInt(s.contacted), sellers: parseInt(s.sellers), buyers: parseInt(s.buyers) };
    } catch (e) { /* ok */ }

    res.json({ leads: rows, total, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/leads/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, assigned_to } = req.body;
    const valid = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost'];
    if (status && !valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const sets = [], params = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); params.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(notes); }
    if (assigned_to !== undefined) { sets.push(`assigned_to = $${idx++}`); params.push(assigned_to); }
    sets.push('updated_at = NOW()');
    params.push(parseInt(id));
    const result = await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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