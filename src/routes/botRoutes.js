/**
 * QUANTUM WhatsApp Bot - INFORU Webservice Webhook
 * 
 * INFORU calls this endpoint at each step of the bot conversation.
 * We receive the current conversation context, process it with Claude AI,
 * and return an array of actions for the bot to execute.
 * 
 * Architecture:
 *   INFORU Bot (WhatsApp) --> POST /api/bot/webservice --> Claude AI --> actions[]
 *   INFORU Callback (lead saved) --> POST /api/bot/callback --> DB lead insert
 */

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

// ─── QUANTUM Bot Identity ────────────────────────────────────────────────────

const QUANTUM_SYSTEM_PROMPT = `אתה QUANTUM - עוזר חכם של משרד תיווך בוטיק המתמחה בפינוי-בינוי והתחדשות עירונית בישראל.

האישיות שלך:
- חכם ואנליטי, אבל חם ואישי - כמו האדם החכם ביותר שהלקוח אי-פעם פגש
- קצר ולעניין - ב-WhatsApp אנשים לא קוראים פסקאות ארוכות
- תמיד בעברית
- אף פעם לא מזכיר "מערכת", "אלגוריתם", "פלטפורמה" - אתה משרד תיווך אנושי

המטרה בשיחה:
1. להבין מי הלקוח - קונה או מוכר
2. לאסוף את הפרטים הנחוצים בצורה טבעית ונעימה
3. להכין ליד איכותי לנציג שיחזור אליו

חוקים:
- הודעות קצרות (עד 3 שורות)
- שאלה אחת בכל פעם
- להיות ישיר - אל תסחב
- אל תבטיח מחירים או הבטחות ספציפיות - רק תאמר שנציג יחזור עם פרטים`;

// ─── Conversation Stage Manager ─────────────────────────────────────────────

function getConversationStage(parameters) {
  const params = {};
  (parameters || []).forEach(p => { params[p.name] = p.value; });
  return params;
}

function buildConversationHistory(parameters, currentInput) {
  const params = getConversationStage(parameters);
  const history = [];

  // Reconstruct conversation context from saved parameters
  if (params.user_type) {
    if (params.user_type === 'seller') {
      history.push({ role: 'assistant', content: 'שלום! מ-QUANTUM. קצר ולעניין - יש לך נכס שתרצה למכור או להשכיר?' });
      history.push({ role: 'user', content: 'מכירה' });
    } else if (params.user_type === 'buyer') {
      history.push({ role: 'assistant', content: 'שלום! מ-QUANTUM. קצר ולעניין - מחפש לקנות נכס, או שיש לך נכס למכירה?' });
      history.push({ role: 'user', content: 'קנייה' });
    }
  }

  if (params.city) {
    history.push({ role: 'assistant', content: 'מעולה. באיזה עיר / אזור?' });
    history.push({ role: 'user', content: params.city });
  }

  if (params.property_type) {
    history.push({ role: 'assistant', content: 'מה סוג הנכס?' });
    history.push({ role: 'user', content: params.property_type });
  }

  if (params.budget) {
    history.push({ role: 'assistant', content: 'מה התקציב שלך בערך?' });
    history.push({ role: 'user', content: params.budget });
  }

  if (params.name) {
    history.push({ role: 'assistant', content: 'ואיך אפשר לפנות אליך?' });
    history.push({ role: 'user', content: params.name });
  }

  // Add current input
  if (currentInput) {
    history.push({ role: 'user', content: currentInput });
  }

  return { params, history };
}

// ─── Claude Decision Engine ──────────────────────────────────────────────────

async function getClaudeResponse(parameters, currentInput, sender) {
  const { params, history } = buildConversationHistory(parameters, currentInput);

  // Determine what we still need to collect
  const collected = {
    user_type: !!params.user_type,
    city: !!params.city,
    property_type: !!params.property_type,
    name: !!params.name,
    phone_confirmed: !!params.phone_confirmed,
    // buyer-specific
    budget: params.user_type === 'buyer' ? !!params.budget : true,
    timeline: params.user_type === 'buyer' ? !!params.timeline : true,
    // seller-specific
    rooms: params.user_type === 'seller' ? !!params.rooms : true,
  };

  const allCollected = Object.values(collected).every(Boolean);

  // Build context message for Claude
  const contextMsg = `מצב השיחה הנוכחי:
${JSON.stringify(params, null, 2)}

קלט נוכחי מהמשתמש: "${currentInput || '(התחלת שיחה)'}"
מזהה משתמש: ${sender}

${allCollected ? 'כל הפרטים הנאספו. צור הודעת סיום חמה ואמור שנציג יחזור תוך 24 שעות.' : 
  `עדיין צריך לאסוף: ${Object.entries(collected).filter(([,v]) => !v).map(([k]) => k).join(', ')}`}

ענה עם JSON בפורמט:
{
  "message": "ההודעה לשלוח למשתמש",
  "set_parameters": { "param_name": "param_value" },
  "is_complete": true/false,
  "needs_input": true/false
}

חוקים לפרמטרים:
- user_type: "seller" | "buyer"  
- city: שם העיר
- property_type: סוג הנכס
- rooms: מספר חדרים (למוכרים)
- budget: תקציב (לקונים)
- timeline: מתי רוצה לסגור (לקונים)
- name: שם הלקוח`;

  const messages = history.length > 0 ? history : [{ role: 'user', content: contextMsg }];
  
  // Add the context as system context if we have history
  const finalMessages = history.length > 0 
    ? [...history.slice(0, -1), { role: 'user', content: contextMsg }]
    : [{ role: 'user', content: contextMsg }];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: QUANTUM_SYSTEM_PROMPT,
    messages: finalMessages
  });

  const text = response.content[0].text;
  
  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    logger.warn('Claude response not JSON, using text directly', { text });
  }

  // Fallback
  return {
    message: text.substring(0, 300),
    set_parameters: {},
    is_complete: false,
    needs_input: true
  };
}

// ─── Build INFORU Actions Array ──────────────────────────────────────────────

function buildActions(claudeResponse) {
  const actions = [];

  // Set any parameters Claude wants to save
  if (claudeResponse.set_parameters) {
    Object.entries(claudeResponse.set_parameters).forEach(([name, value]) => {
      if (value) {
        actions.push({ type: 'SetParameter', name, value: String(value) });
      }
    });
  }

  // Send the message
  if (claudeResponse.message) {
    actions.push({ type: 'SendMessage', text: claudeResponse.message });
  }

  if (claudeResponse.is_complete) {
    // Mark conversation complete - save as lead
    actions.push({ type: 'SetParameter', name: 'conversation_complete', value: 'true' });
    // Return to end the bot flow
    actions.push({ type: 'Return', value: 'complete' });
  } else if (claudeResponse.needs_input) {
    // Wait for user input
    actions.push({ type: 'InputText' });
  }

  return actions;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/bot/webservice
 * Called by INFORU at each conversation step
 */
router.post('/webservice', async (req, res) => {
  // Always respond within 5 seconds (INFORU requirement)
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.json({
        actions: [
          { type: 'SendMessage', text: 'רגע אחד...' },
          { type: 'InputText' }
        ]
      });
    }
  }, 4500);

  try {
    const { campaign, chat, parameters, value } = req.body;
    
    const sender = chat?.sender;
    const currentInput = value?.string;
    
    logger.info('Bot webservice called', {
      sender,
      campaignId: campaign?.id,
      input: currentInput,
      paramCount: (parameters || []).length
    });

    // Get Claude's decision
    const claudeResponse = await getClaudeResponse(parameters, currentInput, sender);
    
    logger.info('Claude response', { claudeResponse, sender });

    const actions = buildActions(claudeResponse);

    clearTimeout(timeout);
    
    if (!res.headersSent) {
      res.json({ actions });
    }

  } catch (err) {
    clearTimeout(timeout);
    logger.error('Bot webservice error', { error: err.message, stack: err.stack });
    
    if (!res.headersSent) {
      res.json({
        actions: [
          { type: 'SendMessage', text: 'אופס, משהו השתבש. מיד חוזרים אליך.' },
          { type: 'Return', value: 'error' }
        ]
      });
    }
  }
});

/**
 * POST /api/bot/callback
 * Called by INFORU when a lead is saved at end of conversation
 */
router.post('/callback', async (req, res) => {
  res.json({ status: 'ok' }); // Respond immediately
  
  try {
    const { lead, campaign, chat, fields, parameters } = req.body;
    
    const params = {};
    (parameters || []).forEach(p => { params[p.name] = p.value; });

    logger.info('Bot lead callback received', { leadId: lead?.id, sender: chat?.sender, params });

    // Save lead to database
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
      ON CONFLICT DO NOTHING
    `, [
      chat?.sender?.replace(/\D/g, '').slice(-10), // phone
      params.name || fields?.name || null,
      params.city || null,
      params.property_type || null,
      params.user_type || null,
      params.budget || null,
      params.timeline || null,
      params.rooms || null,
      JSON.stringify({ lead, campaign, chat, fields, parameters })
    ]);

    logger.info('Bot lead saved to DB', { leadId: lead?.id });

  } catch (err) {
    logger.error('Bot callback error', { error: err.message });
    // Don't throw - we already responded 200
  }
});

/**
 * GET /api/bot/health
 * Quick sanity check
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'QUANTUM WhatsApp Bot',
    webservice_url: `${process.env.SERVER_URL || 'https://pinuy-binuy-analyzer-production.up.railway.app'}/api/bot/webservice`,
    callback_url: `${process.env.SERVER_URL || 'https://pinuy-binuy-analyzer-production.up.railway.app'}/api/bot/callback`,
    claude_configured: !!process.env.ANTHROPIC_API_KEY,
    db_configured: !!process.env.DATABASE_URL
  });
});

/**
 * POST /api/bot/test
 * Test the bot logic without INFORU (dev only)
 */
router.post('/test', async (req, res) => {
  try {
    const { parameters = [], input = null, sender = 'test-user' } = req.body;
    const claudeResponse = await getClaudeResponse(parameters, input, sender);
    const actions = buildActions(claudeResponse);
    res.json({ claudeResponse, actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
