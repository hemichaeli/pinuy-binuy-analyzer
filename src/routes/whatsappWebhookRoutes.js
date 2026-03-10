/**
 * QUANTUM WhatsApp Bot - v6.3
 * Full conversation tracking + enhanced AI + lead management + auto-handoff
 * v6.2: First message no longer says "אני מ-QUANTUM" - they already know.
 * v6.3: Fixed model name (claude-sonnet-4-6) + fixed updateLead raw_data double-assignment bug
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEPLOYMENT_TIME = new Date().toISOString();

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function getWebhookUrl() {
  const domain = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'pinuy-binuy-analyzer-production-ab85.up.railway.app';
  return `https://${domain}/api/whatsapp/webhook`;
}

function parseInforuWebhook(body) {
  if (body.Data && Array.isArray(body.Data) && body.Data.length > 0) {
    const item = body.Data[0];
    return {
      phone: item.Value || item.Phone || null,
      message: item.Message || item.Keyword || item.Text || null,
      network: item.Network || 'Unknown',
      channel: item.Channel || 'Unknown',
      shortCode: item.ShortCode || null,
      sessionId: item.MoSessionId || null,
      customerParam: item.CustomerParam || null,
      additionalInfo: item.AdditionalInfo ? (typeof item.AdditionalInfo === 'string' ? JSON.parse(item.AdditionalInfo) : item.AdditionalInfo) : null,
      customerId: body.CustomerId || null,
      projectId: body.ProjectId || null,
      raw: body
    };
  }
  return {
    phone: body.phone || body.from || body.Phone || null,
    message: body.message || body.text || body.body || body.Message || null,
    network: 'Direct',
    channel: 'Direct',
    raw: body
  };
}

function shouldHandoff(message, history, leadInfo) {
  const messageCount = history.length;
  if (message.match(/רוצה לדבר עם אדם|תעביר אותי לאדם|אני רוצה אדם|לדבר עם מישהו|אנשי|מוקד|מתווך אמיתי/i)) {
    return { should: true, reason: 'explicit_request', urgency: 'high' };
  }
  if (message.match(/לא מבין|לא עוזר|לא עונה|מה קורה|די|מספיק|תפסיק/i)) {
    return { should: true, reason: 'frustration', urgency: 'high' };
  }
  if (message.match(/עורך דין|משפטי|חוזה|מיסים|היטל השבחה|מע"מ|רישוי/i)) {
    return { should: true, reason: 'complex_legal', urgency: 'normal' };
  }
  if (messageCount >= 8) {
    const userMessages = history.filter(m => m.sender === 'user').map(m => m.message);
    const lastThree = userMessages.slice(-3);
    const similarityCount = lastThree.filter((msg, idx) =>
      lastThree.some((other, otherIdx) =>
        idx !== otherIdx &&
        msg.length > 10 &&
        other.length > 10 &&
        (msg.includes(other.substring(0, 20)) || other.includes(msg.substring(0, 20)))
      )
    ).length;
    if (similarityCount >= 2) {
      return { should: true, reason: 'stuck_in_loop', urgency: 'normal' };
    }
  }
  if (messageCount >= 10 && leadInfo.stage !== 'scheduling') {
    return { should: true, reason: 'long_conversation', urgency: 'normal' };
  }
  return { should: false };
}

async function requestHandoff(leadId, reason, urgency, phone, name) {
  try {
    await pool.query(`
      UPDATE leads 
      SET 
        status = 'pending_handoff',
        raw_data = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(raw_data, '{}'::jsonb),
              '{handoff_requested}', 'true'
            ),
            '{handoff_reason}', $1
          ),
          '{handoff_urgency}', $2
        ),
        updated_at = NOW()
      WHERE id = $3
    `, [JSON.stringify(reason), JSON.stringify(urgency), leadId]);

    const handoffMessage = `${name ? name + ', ' : ''}אני מעביר אותך למומחה שלנו שיוכל לעזור לך יותר טוב.\n\nהוא יחזור אליך תוך ${urgency === 'high' ? '30 דקות' : 'שעה-שעתיים'}. תודה על הסבלנות! 🙏`;

    const auth = getBasicAuth();
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: {
        Message: handoffMessage,
        Phone: phone,
        Settings: { CustomerMessageId: `handoff_${Date.now()}`, CustomerParameter: 'QUANTUM_AUTO_HANDOFF' }
      }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 15000,
      validateStatus: () => true
    });

    await pool.query(
      `INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at) VALUES ($1, 'bot', $2, $3, NOW())`,
      [leadId, handoffMessage, JSON.stringify({ type: 'auto_handoff', reason, urgency })]
    );

    console.log(`[HANDOFF] Auto-handoff triggered for lead ${leadId}: ${reason} (${urgency})`);
    return true;
  } catch (error) {
    console.error('[HANDOFF] Error:', error.message);
    return false;
  }
}

async function callClaudeWithContext(conversationHistory, currentMessage, leadInfo) {
  try {
    let contextSummary = '';
    if (conversationHistory.length > 0) {
      const lastFew = conversationHistory.slice(-4);
      contextSummary = lastFew.map(msg =>
        `${msg.sender === 'user' ? 'לקוח' : 'אתה'}: ${msg.message}`
      ).join('\n');
    }

    const systemPrompt = buildEnhancedPrompt(leadInfo, contextSummary);

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',   // ← updated model name
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: currentMessage }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 10000
    });

    return response.data.content[0].text;
  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'שלום! במה אפשר לעזור?';
  }
}

function buildEnhancedPrompt(leadInfo, conversationContext) {
  const stage = leadInfo?.stage || 'greeting';
  const name = leadInfo?.name || null;
  const userType = leadInfo?.user_type || null;
  const isFirstMessage = !conversationContext;

  let basePrompt = `אתה נציג QUANTUM - משרד תיווך בוטיק המתמחה בפינוי-בינוי.

## זהות QUANTUM
- מתווכים בוטיק עם מומחיות בפינוי-בינוי
- "מח חד, הבנה עמוקה, גישה לנכסים סודיים"
- כל לקוח מרגיש כמו "בן יחיד"
- לא פלטפורמה טכנולוגית - אנשים אמיתיים עם יתרון טכנולוגי

## הסגנון שלך
- חד אבל חם - חכם אבל לא יהיר
- ישיר אבל אכפתי
- קצר - לא יותר מ-2-3 משפטים
- אמוג'י במינון - רק 👋 לפתיחה הראשונה או ✨ לנקודות חשובות
- עברית טבעית - לא פורמלית מדי

## חוק ברזל #1 - הפתיחה
❌ לעולם אל תאמר "אני מ-QUANTUM" / "שלום, אני מ-QUANTUM" / "היי, QUANTUM כאן"
✓ הם פנו אליך - הם יודעים מי אתה. קפוץ ישר לעניין.
✓ פתיחה אידיאלית: שאלה אחת ממוקדת שמראה שאתה מבין מה הם צריכים.`;

  if (stage === 'greeting') {
    if (isFirstMessage) {
      basePrompt += `

### שלב: פגישה ראשונה
המטרה: להבין מהר מה הם צריכים ולהראות שאתה הבן אדם הנכון.
1. אל תציג את עצמך - הם יודעים עם מי הם מדברים
2. שאל שאלה אחת פתוחה שמזמינה אותם לספר
3. אם הם כבר כתבו מה הם רוצים - הגב ישירות לזה
דוגמה טובה: "ספר לי - קונה או מוכר, ומה מחפש?"
דוגמה רעה: "שלום! אני מ-QUANTUM. איך אני יכול לעזור לך?"`;
    } else {
      basePrompt += `

### שלב: פתיחה (המשך)
1. שאל את השם (אם אין)
2. זהה מהר: קונה או מוכר?
3. המשך ישר לשאלות הנכונות`;
    }
  } else if (stage === 'info_gathering') {
    basePrompt += `

### שלב: איסוף מידע
${userType === 'buyer' ? `
**קונה:**
- איזה אזור מעניין?
- באיזה תקציב?
- יש מתווך כבר?
- למה לא מצא עדיין? (חשוב!)
` : userType === 'seller' ? `
**מוכר:**
- איפה הנכס ומה הסוג?
- למה רוצה למכור? (דחיפות!)
- יש מתווך כבר?
- מה לא עובד עם המתווך הנוכחי?
` : `
- קודם כל: קונה או מוכר?
`}`;
  } else if (stage === 'scheduling') {
    basePrompt += `

### שלב: קביעת פגישה
- "בוא נקבע שיחת היכרות קצרה"
- שאל מתי נוח - היום? מחר?
- אל תהיה לחוץ - תן ללקוח להחליט`;
  }

  if (conversationContext) {
    basePrompt += `

## השיחה עד כה:
${conversationContext}

המשך את השיחה באופן טבעי בהתאם למה שכבר נאמר.`;
  }

  if (name) {
    basePrompt += `\n\nשם הלקוח: ${name} - השתמש בשם מדי פעם.`;
  }

  basePrompt += `

## חוקי זהב
❌ לעולם אל תאמר "אני מ-QUANTUM" - בשום שלב בשיחה
❌ לעולם אל תשאל את אותה שאלה פעמיים
❌ אל תהיה דוחף - תן ללקוח לנשום
❌ אל תדבר יותר מדי - שאל, הקשב, המשך
✓ היה אנושי - לא סקריפט
✓ התאם את עצמך ללקוח - יש כאלה שרוצים עסקי, יש שרוצים יותר חברותי
✓ אם הלקוח לא מעוניין - בסדר! "אם תשנה דעתך, אני כאן"

תן תשובה אחת קצרה, ממוקדת, טבעית.`;

  return basePrompt;
}

async function getOrCreateLead(phone) {
  try {
    let result = await pool.query(
      `SELECT * FROM leads WHERE phone = $1 AND source = 'whatsapp_bot' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (result.rows.length > 0) return result.rows[0];
    result = await pool.query(
      `INSERT INTO leads (phone, source, status, raw_data, created_at, updated_at)
       VALUES ($1, 'whatsapp_bot', 'new', '{}', NOW(), NOW()) RETURNING *`,
      [phone]
    );
    return result.rows[0];
  } catch (error) {
    console.error('DB error (getOrCreateLead):', error.message);
    return null;
  }
}

async function getConversationHistory(leadId) {
  try {
    const result = await pool.query(
      `SELECT sender, message, created_at FROM whatsapp_conversations WHERE lead_id = $1 ORDER BY created_at ASC`,
      [leadId]
    );
    return result.rows;
  } catch (error) {
    console.error('DB error (getConversationHistory):', error.message);
    return [];
  }
}

async function saveMessage(leadId, sender, message, aiMetadata = null) {
  try {
    await pool.query(
      `INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [leadId, sender, message, aiMetadata ? JSON.stringify(aiMetadata) : null]
    );
  } catch (error) {
    console.error('DB error (saveMessage):', error.message);
  }
}

async function updateLead(leadId, updates) {
  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.name)      { fields.push(`name = $${idx++}`);      values.push(updates.name); }
    if (updates.user_type) { fields.push(`user_type = $${idx++}`); values.push(updates.user_type); }
    if (updates.status)    { fields.push(`status = $${idx++}`);    values.push(updates.status); }

    // Build a single nested raw_data update to avoid duplicate column assignment
    const now = new Date().toISOString();
    if (updates.stage) {
      fields.push(`raw_data = jsonb_set(jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{stage}', $${idx++}), '{last_contact}', $${idx++})`);
      values.push(JSON.stringify(updates.stage));
      values.push(JSON.stringify(now));
    } else {
      fields.push(`raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{last_contact}', $${idx++})`);
      values.push(JSON.stringify(now));
    }

    fields.push(`updated_at = NOW()`);
    values.push(leadId);

    await pool.query(`UPDATE leads SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  } catch (error) {
    console.error('DB error (updateLead):', error.message);
  }
}

function extractInsights(message, history) {
  const insights = {};
  const nameMatch = message.match(/שמי ([\u0590-\u05FF]+)|קוראים לי ([\u0590-\u05FF]+)|אני ([\u0590-\u05FF]+)/);
  if (nameMatch) insights.name = nameMatch[1] || nameMatch[2] || nameMatch[3];
  if (message.match(/רוצה לקנות|מחפש דירה|קונה|מעוניין לקנות/)) insights.user_type = 'buyer';
  else if (message.match(/רוצה למכור|יש לי דירה|מוכר|למכירה/)) insights.user_type = 'seller';
  if (history.length === 0) insights.stage = 'greeting';
  else if (history.length < 4) insights.stage = 'info_gathering';
  else if (message.match(/פגישה|שיחה|נדבר|מתי נוח/)) insights.stage = 'scheduling';
  else insights.stage = 'info_gathering';
  return insights;
}

// ============================================
// WEBHOOK VERIFICATION (GET)
// ============================================
router.get('/whatsapp/webhook', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'QUANTUM WhatsApp Webhook - Active',
    version: '6.3',
    features: ['conversation_tracking', 'context_awareness', 'lead_management', 'auto_handoff', 'smart_first_response'],
    webhookUrl: getWebhookUrl(),
    whatsappNumber: '037572229',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// INFORU WEBHOOK RECEIVER (POST)
// ============================================
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    console.log('=== WEBHOOK RECEIVED ===');
    const parsed = parseInforuWebhook(req.body);
    if (!parsed.phone || !parsed.message) {
      return res.status(200).json({ received: true, processed: false, reason: 'Missing phone or message' });
    }
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') {
      return res.json({ received: true, processed: false, reason: `Network: ${parsed.network}` });
    }
    const lead = await getOrCreateLead(parsed.phone);
    if (!lead) throw new Error('Failed to get/create lead');
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', parsed.message);
    const insights = extractInsights(parsed.message, history);
    const leadInfo = {
      id: lead.id,
      name: insights.name || lead.name,
      user_type: insights.user_type || lead.user_type,
      stage: insights.stage,
      status: lead.status
    };
    const handoffCheck = shouldHandoff(parsed.message, history, leadInfo);
    if (handoffCheck.should) {
      console.log(`[AUTO-HANDOFF] Triggered: ${handoffCheck.reason}`);
      await requestHandoff(lead.id, handoffCheck.reason, handoffCheck.urgency, parsed.phone, leadInfo.name);
      return res.json({ success: true, processed: true, handoff: true, reason: handoffCheck.reason, urgency: handoffCheck.urgency, leadId: lead.id });
    }
    const aiResponse = await callClaudeWithContext(history, parsed.message, leadInfo);
    await saveMessage(lead.id, 'bot', aiResponse, { model: 'claude-sonnet-4-6', stage: insights.stage });
    await updateLead(lead.id, insights);
    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: {
        Message: aiResponse,
        Phone: parsed.phone,
        Settings: { CustomerMessageId: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, CustomerParameter: 'QUANTUM_BOT_V6_3' }
      }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 15000,
      validateStatus: () => true
    });
    res.json({ success: result.data.StatusId === 1, processed: true, leadId: lead.id, insights, conversationLength: history.length + 2, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('✗ Webhook error:', error.message);
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

router.get('/whatsapp/conversations', async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `
      SELECT l.id, l.phone, l.name, l.user_type, l.status,
        l.raw_data->>'stage' as stage, l.created_at,
        COUNT(wc.id) as message_count, MAX(wc.created_at) as last_message_at
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'`;
    const params = [];
    let n = 1;
    if (search) { query += ` AND (l.phone ILIKE $${n} OR COALESCE(l.name,'') ILIKE $${n})`; params.push('%' + search + '%'); n++; }
    if (status) { query += ` AND l.status = $${n}`; params.push(status); n++; }
    query += ` GROUP BY l.id ORDER BY MAX(wc.created_at) DESC NULLS LAST LIMIT 50`;
    const result = await pool.query(query, params);
    res.json({ success: true, conversations: result.rows, data: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp/conversations/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    const messagesResult = await pool.query(
      `SELECT sender, message, ai_metadata, created_at FROM whatsapp_conversations WHERE lead_id = $1 ORDER BY created_at ASC`,
      [leadId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, lead: leadResult.rows[0], messages: messagesResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp/conversations/:identifier/messages', async (req, res) => {
  try {
    const { identifier } = req.params;
    let leadId;
    if (/^\d{1,8}$/.test(identifier)) {
      leadId = parseInt(identifier);
    } else {
      const byPhone = await pool.query(
        `SELECT id FROM leads WHERE phone = $1 AND source = 'whatsapp_bot' ORDER BY created_at DESC LIMIT 1`,
        [identifier]
      );
      if (!byPhone.rows.length) return res.status(404).json({ success: false, error: 'Lead not found' });
      leadId = byPhone.rows[0].id;
    }
    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    const msgResult = await pool.query(
      `SELECT sender, message, ai_metadata, created_at FROM whatsapp_conversations WHERE lead_id = $1 ORDER BY created_at ASC`,
      [leadId]
    );
    if (!leadResult.rows.length) return res.status(404).json({ success: false, error: 'Lead not found' });
    const lead = leadResult.rows[0];
    const data = msgResult.rows.map(m => ({
      direction: m.sender === 'bot' ? 'outgoing' : 'incoming',
      message: m.message,
      message_content: m.message,
      created_at: m.created_at
    }));
    res.json({ success: true, conversation: { display_name: lead.name || lead.phone, phone: lead.phone, city: lead.city || null, address: null }, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/whatsapp/setup-guide', (req, res) => {
  const webhookUrl = getWebhookUrl();
  res.type('text/html').send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><title>QUANTUM WhatsApp v6.3</title></head>
<body style="font-family:system-ui;max-width:900px;margin:40px auto;padding:20px">
  <h1 style="color:#2563eb">🚀 QUANTUM WhatsApp Bot v6.3</h1>
  <div style="background:#ecfdf5;border-right:4px solid #10b981;padding:15px">
    <strong>✓ Active!</strong> Smart first response, auto-handoff, conversation tracking.
  </div>
  <p><strong>Webhook:</strong> <code>${webhookUrl}</code></p>
  <ul>
    <li>✓ Smart first response (no "אני מ-QUANTUM")</li>
    <li>✓ Model: claude-sonnet-4-6</li>
    <li>✓ Auto-handoff detection</li>
    <li>✓ Analytics dashboard</li>
  </ul>
</body>
</html>
  `);
});

router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    const lead = await getOrCreateLead(phone);
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', message);
    const insights = extractInsights(message, history);
    const leadInfo = { id: lead.id, name: insights.name || lead.name, user_type: insights.user_type || lead.user_type, stage: insights.stage };
    const aiResponse = await callClaudeWithContext(history, message, leadInfo);
    await saveMessage(lead.id, 'bot', aiResponse);
    await updateLead(lead.id, insights);
    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: aiResponse, Phone: phone, Settings: { CustomerMessageId: `trigger_${Date.now()}` } }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 15000,
      validateStatus: () => true
    });
    res.json({ success: result.data.StatusId === 1, aiResponse, leadId: lead.id, insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'new' THEN l.id END) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'pending_handoff' THEN l.id END) as pending_handoff,
        COUNT(wc.id) as total_messages
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
    `);
    res.json({
      success: true,
      version: '6.3',
      timestamp: new Date().toISOString(),
      webhookUrl: getWebhookUrl(),
      stats: stats.rows[0],
      features: ['Smart first response', 'Conversation tracking', 'Context-aware AI', 'Lead management', 'Auto-handoff']
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
