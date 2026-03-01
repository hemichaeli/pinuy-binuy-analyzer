/**
 * Simple WhatsApp Webhook - With QUANTUM Sender Name
 * Basic functionality with proper branding
 */

const express = require('express');
const router = express.Router();

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
- אין מתווך: "מעולה! יש לך יתרון - תוכל לבחור את הטובים ביותר"
- יש מתווך: "איך אתה מרגיש עם ההתקדמות?"
- לא מרוצה ממתווך: "יש לנו גישה לקונים/נכסים שאחרים לא מכירים"

היה קצר, ישיר ומקצועי.`;

// INFORU webhook receiver - WITH QUANTUM BRANDING
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const messageData = req.body;
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    console.log('📱 WhatsApp message:', { phone, message: message.substring(0, 50) });
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    // Send response via INFORU with QUANTUM sender name
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        SenderName: "QUANTUM"  // 🎯 שליחה בשם QUANTUM!
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    console.log('✅ WhatsApp response sent to', phone, 'from QUANTUM');
    res.json({ success: true, processed: true });
    
  } catch (error) {
    console.error('❌ WhatsApp webhook error:', error.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Manual trigger for testing - WITH QUANTUM BRANDING
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('🔧 Manual trigger:', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        SenderName: "QUANTUM"  // 🎯 שליחה בשם QUANTUM!
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
      senderName: "QUANTUM"  // מראה שנשלח בשם QUANTUM
    });
    
  } catch (error) {
    console.error('Manual trigger error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Simple stats endpoint
router.get('/whatsapp/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats: {
        total_leads: 0,
        leads_today: 0,
        sellers: 0,
        buyers: 0,
        high_confidence: 0
      },
      note: 'Basic stats - advanced analytics coming soon',
      senderName: 'QUANTUM'
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;