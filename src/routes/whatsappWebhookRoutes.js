/**
 * QUANTUM WhatsApp Bot - FORCE UPDATE v3.1  
 * Using QUANTUM credentials (will fail until INFORU authorization)
 */

const express = require('express');
const router = express.Router();

// QUANTUM Business Account Credentials - CORRECT ONES
const QUANTUM_USERNAME = 'QUANTUM';
const QUANTUM_TOKEN = '95452ace-07cf-48be-8671-a197c15d3c17';

// Force timestamp for deployment tracking
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

// Manual trigger for testing - **QUANTUM CREDENTIALS ONLY**
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('🔧 QUANTUM Manual trigger (v3.1):', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    // **USING QUANTUM CREDENTIALS ONLY**
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
    
    // Handle InactiveChat specifically
    if (result.data.StatusId === -270) {
      return res.status(403).json({
        success: false,
        error: 'InactiveChat - Phone not authorized for QUANTUM account',
        message: `כדי שהבוט יעבוד, צריך לפנות לINFORU ולבקש להוסיף את המספר ${phone} לרשימת המספרים המאושרים של חשבון QUANTUM`,
        quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
        deploymentTime: DEPLOYMENT_TIME,
        statusReceived: result.data.StatusId,
        solution: "Contact INFORU to authorize this phone number for QUANTUM account"
      });
    }
    
    res.json({ 
      success: result.data.StatusId === 1,
      aiResponse, 
      inforuResult: result.data,
      quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
      deploymentTime: DEPLOYMENT_TIME,
      note: result.data.StatusId === 1 
        ? 'SUCCESS! Phone authorized for QUANTUM account' 
        : `Failed with StatusId: ${result.data.StatusId}`
    });
    
  } catch (error) {
    console.error('QUANTUM Manual trigger error:', error.message);
    
    // Check if axios error with InactiveChat
    if (error.response?.data?.StatusId === -270) {
      return res.status(403).json({
        success: false,
        error: 'InactiveChat',
        message: 'Phone not authorized for QUANTUM account',
        solution: 'Contact INFORU to authorize this phone number',
        quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
        deploymentTime: DEPLOYMENT_TIME
      });
    }
    
    res.status(500).json({ 
      error: error.message,
      quantumCredentials: `${QUANTUM_USERNAME}:${QUANTUM_TOKEN.substring(0, 8)}...`,
      deploymentTime: DEPLOYMENT_TIME,
      note: 'Using QUANTUM credentials as requested - errors expected until INFORU authorization'
    });
  }
});

// Webhook - **QUANTUM CREDENTIALS ONLY**
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const messageData = req.body;
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    console.log('📱 QUANTUM webhook (v3.1):', { phone, message: message.substring(0, 50) });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    // **USING QUANTUM CREDENTIALS ONLY**
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
    
    console.log('✅ QUANTUM webhook response:', result.data.StatusId);
    res.json({ success: result.data.StatusId === 1, processed: true, quantumStatus: result.data.StatusId });
    
  } catch (error) {
    console.error('❌ QUANTUM webhook error:', error.message);
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

// Stats endpoint
router.get('/whatsapp/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      deploymentTime: DEPLOYMENT_TIME,
      credentials: {
        username: QUANTUM_USERNAME,
        token: `${QUANTUM_TOKEN.substring(0, 8)}...`,
        status: 'QUANTUM credentials ONLY - no fallback'
      },
      warnings: [
        'Using QUANTUM credentials exclusively',
        'InactiveChat errors expected until INFORU authorization',
        'Contact INFORU to authorize phone numbers for QUANTUM account'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;