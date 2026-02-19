const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { logger } = require('../services/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── QUANTUM Bot Personality ────────────────────────────────────────────────

const QUANTUM_SYSTEM_PROMPT = `אתה QUANTUM - נציג של משרד תיווך בוטיק המתמחה בפינוי-בינוי והתחדשות עירונית בישראל.

האישיות שלך:
- חכם, חם, ישיר - כמו האדם החכם ביותר שהלקוח אי-פעם פגש
- קצר ולעניין - ב-WhatsApp כל הודעה עד 2-3 שורות
- תמיד בעברית
- לא מזכיר "מערכת", "אלגוריתם", "פלטפורמה" - אתה משרד תיווך אנושי ואישי

מטרת השיחה:
- להבין מי הלקוח (קונה או מוכר)
- לאסוף פרטים בצורה טבעית ונעימה
- להכין ליד איכותי לנציג שיחזור אליו תוך 24 שעות

מה לאסוף לפי סוג לקוח:
מוכר: עיר, סוג נכס, מספר חדרים, שם
קונה: עיר מבוקשת, סוג נכס, תקציב, ציר זמן, שם

חוקים:
- שאלה אחת בכל פעם
- הודעות קצרות (עד 3 שורות)
- להיות ישיר ולא לסחוב
- לא לבטיח מחירים ספציפיים
- כשיש את כל הפרטים - לסיים בחמימות ולציין שנציג יחזור תוך 24 שעות`;

// ─── Stage Manager ───────────────────────────────────────────────────────────

function parseParams(parameters) {
  const params = {};
  (parameters || []).forEach(p => { params[p.name] = p.value; });
  return params;
}

function checkMissingFields(params) {
  const missing = [];
  if (!params.user_type) return ['user_type'];
  if (!params.city) missing.push('city');
  if (!params.property_type) missing.push('property_type');
  if (!params.name) missing.push('name');
  
  if (params.user_type === 'seller') {
    if (!params.rooms) missing.push('rooms');
  } else if (params.user_type === 'buyer') {
    if (!params.budget) missing.push('budget');
    if (!params.timeline) missing.push('timeline');
  }
  return missing;
}

// ─── Claude AI Engine ────────────────────────────────────────────────────────

async function getClaudeDecision(parameters, currentInput) {
  const params = parseParams(parameters);
  const missing = checkMissingFields(params);
  const isComplete = missing.length === 0;

  const prompt = `מצב השיחה הנוכחי:
נאסף עד כה: ${JSON.stringify(params)}
קלט נוכחי מהמשתמש: "${currentInput || '(התחלת שיחה)'}"
שדות שחסרים עדיין: ${missing.join(', ') || 'אין - הכל נאסף'}
שיחה הושלמה: ${isComplete}

הנחיות:
${isComplete ? 
  'כל הפרטים נאספו. שלח הודעת סיום חמה ומקצועית - תודה, ציין שנציג QUANTUM יחזור תוך 24 שעות, וסיים.' :
  `השדה הבא לאיסוף הוא: "${missing[0]}". שאל שאלה טבעית ואחת בלבד.
  
מיפוי שדות לשאלות:
- user_type: "שלום! אני מ-QUANTUM. תגיד לי - יש לך נכס שתרצה למכור, או שאתה מחפש לקנות?"
- city: שאל באיזה עיר/אזור (בהתאם לסוג לקוח)
- property_type: שאל על סוג הנכס (דירה, קרקע, בניין וכו')
- rooms: שאל כמה חדרים
- budget: שאל על תקציב בערך
- timeline: שאל מתי רוצה לסגור / מה הציר זמן
- name: "ואיך אפשר לפנות אליך?"`
}

ענה אך ורק ב-JSON:
{
  "message": "ההודעה לשלוח",
  "save": { "שם_פרמטר": "ערך" },
  "done": ${isComplete}
}

כללי save - שמור פרמטרים שהמשתמש ענה עליהם בקלט הנוכחי:
- user_type: "seller" אם ענה מכירה/למכור/מוכר, "buyer" אם ענה קנייה/לקנות/מחפש
- כל שדה אחר - שמור כמחרוזת פשוטה`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: QUANTUM_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    logger.warn('Claude non-JSON response', { text: text.substring(0, 200) });
  }

  return { message: text.substring(0, 250), save: {}, done: false };
}

// ─── Build INFORU Actions ────────────────────────────────────────────────────

function buildActions(decision) {
  const actions = [];

  // Save any parameters
  if (decision.save) {
    Object.entries(decision.save).forEach(([name, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        actions.push({ type: 'SetParameter', name, value: String(value) });
      }
    });
  }

  // Send the message
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

// ─── Save Lead to DB ────────────────────────────────────────────────────────

async function saveLeadToDB(callbackData) {
  const { lead, chat, fields, parameters } = callbackData;
  const params = parseParams(parameters);

  try {
    // Extract phone from sender (INFORU sender is usually the phone number)
    const rawPhone = chat?.sender || '';
    const phone = rawPhone.replace(/\D/g, '').slice(-10);

    await pool.query(`
      INSERT INTO leads (
        source, phone, name, city, property_type,
        user_type, budget, timeline, rooms,
        raw_data, status, created_at
      ) VALUES (
        'whatsapp_bot', $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, 'new', NOW()
      )
    `, [
      phone,
      params.name || fields?.name || null,
      params.city || null,
      params.property_type || null,
      params.user_type || null,
      params.budget || null,
      params.timeline || null,
      params.rooms || null,
      JSON.stringify(callbackData)
    ]);

    logger.info('WhatsApp bot lead saved', { phone, name: params.name, type: params.user_type });
  } catch (err) {
    // Fallback: try website_leads table if leads doesn't exist
    try {
      const rawPhone = chat?.sender || '';
      const phone = rawPhone.replace(/\D/g, '').slice(-10);
      
      await pool.query(`
        INSERT INTO website_leads (
          source, phone, name, user_type,
          form_data, status, created_at
        ) VALUES (
          'whatsapp_bot', $1, $2, $3, $4, 'new', NOW()
        )
      `, [
        phone,
        params.name || fields?.name || null,
        params.user_type || 'unknown',
        JSON.stringify({ ...params, raw: callbackData })
      ]);
      
      logger.info('WhatsApp bot lead saved to website_leads (fallback)', { phone });
    } catch (err2) {
      logger.error('Failed to save bot lead to DB', { error: err2.message });
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/bot/webservice
 * INFORU calls this at every step of the WhatsApp conversation
 */
router.post('/webservice', async (req, res) => {
  // Must respond within 5 seconds (INFORU hard limit)
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.warn('Bot webservice timeout - sending hold message');
      res.json({
        actions: [
          { type: 'SendMessage', text: 'רגע...' },
          { type: 'InputText' }
        ]
      });
    }
  }, 4500);

  try {
    const { campaign, chat, parameters, value } = req.body;
    const currentInput = value?.string || null;
    const sender = chat?.sender || 'unknown';

    logger.info('Bot webservice', {
      sender,
      campaignId: campaign?.id,
      input: currentInput,
      paramsCount: (parameters || []).length
    });

    const decision = await getClaudeDecision(parameters, currentInput);
    const actions = buildActions(decision);

    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json({ actions });
    }

  } catch (err) {
    clearTimeout(timeout);
    logger.error('Bot webservice error', { error: err.message });

    if (!res.headersSent) {
      res.json({
        actions: [
          { type: 'SendMessage', text: 'משהו השתבש. אנחנו נחזור אליך בהקדם.' },
          { type: 'Return', value: 'error' }
        ]
      });
    }
  }
});

/**
 * POST /api/bot/callback
 * INFORU calls this when a lead is finalized (end of conversation)
 */
router.post('/callback', async (req, res) => {
  res.json({ status: 'ok' }); // Respond immediately, process async
  
  try {
    logger.info('Bot callback received', { leadId: req.body?.lead?.id });
    await saveLeadToDB(req.body);
  } catch (err) {
    logger.error('Bot callback processing error', { error: err.message });
  }
});

/**
 * GET /api/bot/health
 */
router.get('/health', (req, res) => {
  const base = process.env.SERVER_URL || 'https://pinuy-binuy-analyzer-production.up.railway.app';
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
 * POST /api/bot/test
 * Simulate a conversation step without INFORU
 */
router.post('/test', async (req, res) => {
  try {
    const { parameters = [], input = null } = req.body;
    const decision = await getClaudeDecision(parameters, input);
    const actions = buildActions(decision);
    res.json({ decision, actions, next_params: [...parameters, ...Object.entries(decision.save || {}).map(([name, value]) => ({ name, value }))] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
