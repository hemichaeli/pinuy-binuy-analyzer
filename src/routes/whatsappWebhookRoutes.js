/**
 * INFORU WhatsApp Webhook Handler with Lead Management
 * Handles incoming WhatsApp messages, AI responses, and lead tracking
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const pool = require('../db/pool');

// Import the bot logic
async function callClaude(systemPrompt, userPrompt) {
  const axios = require('axios');
  
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 12000
  });
  
  return response.data.content[0].text;
}

const SALES_SYSTEM_PROMPT = `אתה QUANTUM Sales AI - המתווך הדיגיטלי החכם ביותר בישראל.
נציג מכירות מבריק שמשלב AI עם חוכמת מכירות.

מטרות שלך בכל שיחה:
1. 🏠 לזהות אם הלקוח קונה או מוכר
2. 📍 לקבל עיר ואזור מעניין
3. 💰 לזהות טווח תקציב/מחיר
4. ⏰ לקבל ציר זמן (דחוף/רגיל)
5. 📞 לקבל שם וליד לפגישה

תגובות לפי שלבים:
- פתיחה: "שלום! אני מ-QUANTUM 👋 איך קוראים לך?"
- אחרי שם: "נעים [שם]! מחפש לקנות או למכור נכס?"
- לקונה: "איזה אזור מעניין? מה התקציב?" 
- למוכר: "איזה נכס יש לך? איזה מחיר מצפה?"
- סגירה: "בוא נקבע פגישה! מתי נוח לך?"

היה חם, מקצועי ויעיל. אסוף מידע ליד איכותי.`;

// Lead Management Functions
async function createOrUpdateLead(phone, message, aiResponse) {
  try {
    // Check if lead exists
    const existingLead = await pool.query(
      'SELECT * FROM leads WHERE phone = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1',
      [phone, 'whatsapp_bot']
    );

    let leadData = {
      phone,
      source: 'whatsapp_bot',
      raw_data: { 
        conversation_history: [
          { timestamp: new Date(), user_message: message, ai_response: aiResponse }
        ]
      }
    };

    // Extract lead intelligence from conversation
    const intelligence = extractLeadIntelligence(message);
    leadData = { ...leadData, ...intelligence };

    if (existingLead.rows.length > 0) {
      // Update existing lead
      const lead = existingLead.rows[0];
      const updatedHistory = [
        ...(lead.raw_data?.conversation_history || []),
        { timestamp: new Date(), user_message: message, ai_response: aiResponse }
      ];

      await pool.query(
        `UPDATE leads SET 
         name = COALESCE($1, name),
         city = COALESCE($2, city), 
         user_type = COALESCE($3, user_type),
         budget = COALESCE($4, budget),
         timeline = COALESCE($5, timeline),
         raw_data = $6,
         updated_at = NOW()
         WHERE id = $7`,
        [
          intelligence.name, intelligence.city, intelligence.user_type, 
          intelligence.budget, intelligence.timeline,
          JSON.stringify({ ...lead.raw_data, conversation_history: updatedHistory }),
          lead.id
        ]
      );
      
      logger.info('📝 Updated WhatsApp lead', { leadId: lead.id, phone });
      return lead.id;
    } else {
      // Create new lead
      const result = await pool.query(
        `INSERT INTO leads (phone, name, city, user_type, budget, timeline, raw_data, source, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING id`,
        [
          phone, intelligence.name, intelligence.city, intelligence.user_type,
          intelligence.budget, intelligence.timeline, JSON.stringify(leadData.raw_data),
          'whatsapp_bot', 'new'
        ]
      );

      const leadId = result.rows[0].id;
      logger.info('🆕 Created new WhatsApp lead', { leadId, phone });
      
      // Create Trello card for hot leads
      if (isHotLead(intelligence, message)) {
        await createTrelloCard(leadId, intelligence, phone);
      }
      
      return leadId;
    }
  } catch (error) {
    logger.error('❌ Lead management error', { error: error.message, phone });
  }
}

// AI-powered lead intelligence extraction
function extractLeadIntelligence(message) {
  const intelligence = {};
  
  // Name extraction
  const namePatterns = [
    /(?:שמי|קוראים לי|אני|השם שלי|זה)\s+([א-ת]+)/,
    /^([א-ת]+)$/,
  ];
  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match) {
      intelligence.name = match[1].trim();
      break;
    }
  }

  // User type detection
  if (message.match(/מוכר|למכור|יש לי דירה|יש לי נכס|רוצה למכור/)) {
    intelligence.user_type = 'seller';
  } else if (message.match(/קונה|לקנות|מחפש דירה|מחפש נכס|רוצה לקנות/)) {
    intelligence.user_type = 'buyer';
  } else if (message.match(/השקעה|משקיע|השקעות|פינוי בינוי|רווחים/)) {
    intelligence.user_type = 'investor';
  }

  // City extraction
  const cities = ['תל אביב', 'רמת גן', 'גבעתיים', 'בת ים', 'חולון', 'ראשון לציון', 'פתח תקווה', 'הרצליה', 'כפר סבא', 'רעננה'];
  for (const city of cities) {
    if (message.includes(city)) {
      intelligence.city = city;
      break;
    }
  }

  // Budget/Price extraction
  const budgetPatterns = [
    /(\d+)\s*מיליון/,
    /(\d+)M/,
    /(\d+,?\d*)\s*₪/,
    /תקציב\s+של\s+(\d+)/
  ];
  for (const pattern of budgetPatterns) {
    const match = message.match(pattern);
    if (match) {
      intelligence.budget = match[1] + (message.includes('מיליון') ? 'M' : 'K');
      break;
    }
  }

  // Timeline detection
  if (message.match(/דחוף|מהיר|עכשיו|בחודש הקרוב|מיד/)) {
    intelligence.timeline = 'urgent';
  } else if (message.match(/זמן|לא ממהר|חודשים|שנה/)) {
    intelligence.timeline = 'flexible';
  }

  return intelligence;
}

// Hot lead detection
function isHotLead(intelligence, message) {
  const hotSignals = [
    intelligence.user_type === 'investor' && intelligence.budget,
    intelligence.user_type === 'seller' && intelligence.city,
    intelligence.timeline === 'urgent',
    message.includes('מיליון') || message.includes('פינוי בינוי'),
    intelligence.budget && (intelligence.budget.includes('M') || parseInt(intelligence.budget) > 2)
  ];
  
  return hotSignals.filter(Boolean).length >= 2;
}

// Create Trello card for hot leads
async function createTrelloCard(leadId, intelligence, phone) {
  try {
    const axios = require('axios');
    
    const cardTitle = `🔥 WhatsApp Lead: ${intelligence.name || phone} - ${intelligence.user_type || 'Contact'}`;
    const cardDesc = `📱 **מקור:** WhatsApp Bot
🏠 **סוג:** ${intelligence.user_type || 'לא זוהה'}
📍 **עיר:** ${intelligence.city || 'לא צוין'}
💰 **תקציב:** ${intelligence.budget || 'לא צוין'}
⏰ **ציר זמן:** ${intelligence.timeline || 'לא צוין'}
📞 **טלפון:** ${phone}

🎯 **Lead ID:** ${leadId}
🤖 **נוצר:** WhatsApp AI Bot`;

    const response = await axios.post('https://api.trello.com/1/cards', {
      name: cardTitle,
      desc: cardDesc,
      idList: process.env.TRELLO_LEADS_LIST_ID || process.env.TRELLO_LIST_ID,
      key: process.env.TRELLO_API_KEY,
      token: process.env.TRELLO_TOKEN
    });

    // Update lead with Trello info
    await pool.query(
      'UPDATE leads SET notes = $1 WHERE id = $2',
      [`Trello Card: ${response.data.shortUrl}`, leadId]
    );

    logger.info('🎴 Trello card created for hot lead', { leadId, cardUrl: response.data.shortUrl });
  } catch (error) {
    logger.error('❌ Trello card creation failed', { error: error.message, leadId });
  }
}

// INFORU webhook receiver
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    logger.info('📥 Received WhatsApp webhook', { body: req.body });
    
    const messageData = req.body;
    
    // Extract message details
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      logger.warn('Invalid webhook data', { phone, message });
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    logger.info('Processing WhatsApp message', { phone, message: message.substring(0, 50) });
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    // Save/Update lead
    await createOrUpdateLead(phone, message, aiResponse);
    
    // Send response via INFORU
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: {
        Message: aiResponse,
        Phone: phone
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    logger.info('✅ WhatsApp AI response sent + Lead saved', { phone, response: aiResponse.substring(0, 100) });
    
    res.json({ success: true, processed: true, leadTracked: true });
    
  } catch (error) {
    logger.error('❌ WhatsApp webhook error', { error: error.message });
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Manual trigger for testing
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    logger.info('Manual trigger', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    // Save/Update lead
    const leadId = await createOrUpdateLead(phone, message, aiResponse);
    
    // Send via INFORU
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: {
        Message: aiResponse,
        Phone: phone
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    res.json({ 
      success: true, 
      aiResponse, 
      inforuResult: result.data,
      leadId: leadId
    });
    
  } catch (error) {
    logger.error('Manual trigger error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
