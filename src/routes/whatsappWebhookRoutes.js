/**
 * INFORU WhatsApp Webhook Handler
 * Handles incoming WhatsApp messages and forwards them to the AI bot
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

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

התנהג בצורה חמה, מקצועית וחכמה. המטרה שלך היא:
1. לזהות אם הלקוח קונה או מוכר
2. לגלות מה המצב עם התיווך הנוכחי  
3. להוביל לפגישה עם מומחה QUANTUM

תגובות לפי סיטואציות:
- פתיחה: "שלום! אני מ-QUANTUM 👋 איך קוראים לך?"
- אין מתווך: "מעולה! יש לך יתרון - תוכל לבחור את הטובים ביותר"
- יש מתווך: "איך אתה מרגיש עם ההתקדמות?"
- לא מרוצה ממתווך: "יש לנו גישה לקונים/נכסים שאחרים לא מכירים"

היה קצר, ישיר ומקצועי.`;

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
    
    // Send response via INFORU - WORKING CREDENTIALS
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
    
    logger.info('✅ WhatsApp AI response sent', { phone, response: aiResponse.substring(0, 100) });
    
    res.json({ success: true, processed: true });
    
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
    
    // Send via INFORU - WORKING CREDENTIALS  
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
      inforuResult: result.data 
    });
    
  } catch (error) {
    logger.error('Manual trigger error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;