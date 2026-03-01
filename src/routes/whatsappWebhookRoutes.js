/**
 * QUANTUM WhatsApp Bot - CORRECT Credentials v3.0
 * Using the correct QUANTUM business account credentials
 */

const express = require('express');
const router = express.Router();

// CORRECT QUANTUM Business Account Credentials
const QUANTUM_USERNAME = 'QUANTUM';
const QUANTUM_TOKEN = '95452ace-07cf-48be-8671-a197c15d3c17';

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

// INFORU webhook receiver - CORRECT QUANTUM CREDENTIALS
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const messageData = req.body;
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    console.log('📱 QUANTUM WhatsApp message:', { phone, message: message.substring(0, 50) });
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    // Send response via INFORU with CORRECT QUANTUM credentials
    const axios = require('axios');
    const auth = Buffer.from(`${QUANTUM_USERNAME}:${QUANTUM_TOKEN}`).toString('base64');
    
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
    
    console.log('✅ QUANTUM response sent to', phone, 'status:', result.data.StatusId);
    
    // Handle InactiveChat error specifically
    if (result.data.StatusId === -270) {
      console.error('❌ InactiveChat error - phone number not authorized for QUANTUM account');
      return res.status(403).json({ 
        error: 'InactiveChat', 
        message: 'Phone number not authorized for QUANTUM account',
        solution: 'Contact INFORU to authorize this phone number for QUANTUM account' 
      });
    }
    
    res.json({ success: true, processed: true, quantumStatus: result.data.StatusId });
    
  } catch (error) {
    console.error('❌ QUANTUM webhook error:', error.message);
    
    // Check if it's an InactiveChat error
    if (error.response?.data?.StatusId === -270) {
      return res.status(403).json({ 
        error: 'InactiveChat', 
        message: 'Phone number not authorized for QUANTUM account',
        solution: 'Contact INFORU to authorize this phone number for QUANTUM account' 
      });
    }
    
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

// Manual trigger for testing - CORRECT QUANTUM CREDENTIALS
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('🔧 QUANTUM Manual trigger:', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    const auth = Buffer.from(`${QUANTUM_USERNAME}:${QUANTUM_TOKEN}`).toString('base64');
    
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
    
    // Handle different response statuses
    if (result.data.StatusId === -270) {
      return res.status(403).json({
        error: 'InactiveChat',
        message: 'Phone number not authorized for QUANTUM account', 
        solution: 'Contact INFORU to authorize this phone number',
        quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
        inforuResponse: result.data
      });
    }
    
    res.json({ 
      success: true, 
      aiResponse, 
      inforuResult: result.data,
      quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
      note: result.data.StatusId === 1 ? 'Successfully sent with QUANTUM credentials' : 'Check StatusId for issues'
    });
    
  } catch (error) {
    console.error('QUANTUM Manual trigger error:', error.message);
    res.status(500).json({ 
      error: error.message,
      quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
      note: 'Using correct QUANTUM credentials as requested'
    });
  }
});

// Stats endpoint - QUANTUM VERSION
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
      credentials: {
        username: QUANTUM_USERNAME,
        token: `${QUANTUM_TOKEN.substring(0, 8)}...`,
        note: 'Using CORRECT QUANTUM credentials as requested'
      },
      warnings: [
        'InactiveChat error (-270) expected for unauthorized phone numbers',
        'Contact INFORU to authorize phone numbers for QUANTUM account'
      ]
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;