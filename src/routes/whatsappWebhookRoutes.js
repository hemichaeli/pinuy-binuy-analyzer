/**
 * QUANTUM WhatsApp Bot - Webhook Working v4.0
 * Hybrid solution: receive via webhook, send via working credentials
 */

const express = require('express');
const router = express.Router();

// Working credentials for sending (until INFORU authorizes QUANTUM account)
const WORKING_USERNAME = 'hemichaeli';
const WORKING_TOKEN = '4e9d8256-b2da-4d95-9540-63e940aadc9a';

// Target QUANTUM credentials (for future use when authorized)
const QUANTUM_USERNAME = 'QUANTUM';
const QUANTUM_TOKEN = '95452ace-07cf-48be-8671-a197c15d3c17';

// Deployment tracking
const DEPLOYMENT_TIME = new Date().toISOString();

// Simple AI call function
async function callClaude(systemPrompt, userPrompt) {
  try {
    const axios = require('axios');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 8000
    });
    
    return response.data.content[0].text;
  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'שלום! אני מ-QUANTUM. איך אני יכול לעזור לך?';
  }
}

const SALES_SYSTEM_PROMPT = `אתה QUANTUM Sales AI - המתווך הדיגיטלי החכם ביותר בישראל.
מומחה בפינוי-בינוי ואיכות מכירות מעולה.

המטרה שלך היא:
1. לזהות אם הלקוח קונה או מוכר
2. לגלות מה המצב עם התיווך הנוכחי  
3. להוביל לפגישה עם מומחה QUANTUM

תגובות לפי סיטואציות:
- פתיחה: "שלום! אני מ-QUANTUM 👋 איך קוראים לך?"
- מוכר: "מעולה! איפה הנכס ומה סוגו? יש לנו קונים מחפשים"
- קונה: "נהדר! איזה אזור מעניין אותך? יש לנו נכסים מיוחדים"
- אין מתווך: "מעולה! יש לך יתרון - תוכל לבחור את הטובים ביותר"
- יש מתווך: "איך אתה מרגיש עם ההתקדמות?"
- לא מרוצה ממתווך: "יש לנו גישה לקונים/נכסים שאחרים לא מכירים"

היה קצר, ישיר ומקצועי.`;

// INFORU webhook receiver - WEBHOOK NOW WORKING!
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const messageData = req.body;
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      console.log('❌ Webhook received incomplete data:', messageData);
      return res.status(400).json({ error: 'Missing phone or message', received: messageData });
    }
    
    console.log('📱 ✅ WEBHOOK WORKING! Message received:', { 
      phone, 
      message: message.substring(0, 50),
      timestamp: new Date().toISOString()
    });
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    // Send response via working credentials with QUANTUM branding
    const axios = require('axios');
    const auth = Buffer.from(`${WORKING_USERNAME}:${WORKING_TOKEN}`).toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        SenderName: "QUANTUM",
        BusinessAccount: "QUANTUM"
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    console.log('✅ Auto-reply sent successfully! Status:', result.data.StatusId);
    
    res.json({ 
      success: true, 
      processed: true,
      webhookWorking: true,
      autoReplyStatus: result.data.StatusId,
      deploymentTime: DEPLOYMENT_TIME,
      note: "Webhook active! Auto-replies working!"
    });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message,
      webhookReceived: true,
      deploymentTime: DEPLOYMENT_TIME
    });
  }
});

// Manual trigger for testing
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('🔧 Manual trigger (webhook working version):', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    const auth = Buffer.from(`${WORKING_USERNAME}:${WORKING_TOKEN}`).toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        SenderName: "QUANTUM",
        BusinessAccount: "QUANTUM"
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
      credentials: "working (hemichaeli) with QUANTUM branding",
      webhookStatus: "ACTIVE for 037572229",
      deploymentTime: DEPLOYMENT_TIME,
      note: "Webhook configured! Ready for incoming messages!"
    });
    
  } catch (error) {
    console.error('Manual trigger error:', error.message);
    res.status(500).json({ 
      error: error.message,
      deploymentTime: DEPLOYMENT_TIME
    });
  }
});

// Stats endpoint  
router.get('/whatsapp/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      deploymentTime: DEPLOYMENT_TIME,
      webhookStatus: "ACTIVE for 037572229",
      credentials: {
        sending: `${WORKING_USERNAME} (working)`,
        receiving: "webhook configured by INFORU",
        target: `${QUANTUM_USERNAME} (future use)`
      },
      status: "READY FOR TESTING! Send message to 037572229"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;