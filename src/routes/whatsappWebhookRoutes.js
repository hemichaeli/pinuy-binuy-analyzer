/**
 * Enhanced WhatsApp Webhook - Fixed Hebrew & Responses
 * Clean, reliable Hebrew responses
 */

const express = require('express');
const router = express.Router();

// Simple AI call function with better error handling
async function callClaude(systemPrompt, userPrompt) {
  try {
    const axios = require('axios');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 150,  // מקצר יותר למנוע בעיות
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 6000  // timeout קצר יותר
    });
    
    let aiText = response.data.content[0].text;
    
    // ניקוי הטקסט
    aiText = aiText.replace(/[^\u0590-\u05FF\u0020-\u007E\u2000-\u206F\uFEFF\u200B-\u200F\uFE00-\uFE0F\uFFF9-\uFFFC\s\n\r\t!?.,\u05B0-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0591-\u05AF\u05A3-\u05A5\u05A7-\u05A9\u05AB-\u05AC\u05AE\u05B1-\u05B9\u05BB-\u05BC\u05BE\u05C0\u05C3\u05C6\u05C8-\u05CF\u05D0-\u05EA\u05F0-\u05F4\uFB1D-\uFB4F\u2665\u2764\uD83C-\uD83E\uDDE0-\uDDFF\uD83D\uDC00-\uDFFF\uD83E\uDD00-\uDDFF]+/g, '');
    
    // הגבלת אורך
    if (aiText.length > 200) {
      aiText = aiText.substring(0, 200) + '...';
    }
    
    return aiText || 'שלום! אני מ-QUANTUM 👋 איך אוכל לעזור?';
    
  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'שלום! אני מ-QUANTUM 👋 איך אוכל לעזור?';
  }
}

const SALES_SYSTEM_PROMPT = `אתה QUANTUM Sales AI - מתווך נדל"ן מקצועי.

תגיב קצר, ישיר וחם בעברית.

דוגמאות:
- שלום: "שלום! אני מ-QUANTUM 👋 איך קוראים לך?"
- קונה: "מעניין! איזה אזור מחפש ומה התקציב?"
- מוכר: "נשמח לעזור! איפה הנכס ומתי רוצה למכור?"
- יש מתווך: "איך הולך עם המתווך הנוכחי?"

תמיד סיים בשאלה. מקסימום 2-3 שורות.`;

// INFORU webhook receiver - IMPROVED
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const messageData = req.body;
    const phone = messageData.phone || messageData.from || messageData.From;
    const message = messageData.message || messageData.text || messageData.body || messageData.Body;
    
    console.log('📱 Incoming WhatsApp:', { 
      phone: phone?.substring(0, 10) + '***', 
      message: message?.substring(0, 30) + '...',
      fullData: JSON.stringify(messageData).substring(0, 200)
    });
    
    if (!phone || !message) {
      console.log('❌ Missing phone or message:', { phone, message });
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    // Clean phone number
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    console.log('🧠 AI Response generated:', aiResponse.substring(0, 50) + '...');
    
    // Send response via INFORU with proper encoding
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    const sendResult = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: cleanPhone,
        SenderName: "QUANTUM"
      }
    }, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${auth}`
      },
      timeout: 8000
    });
    
    console.log('✅ WhatsApp response sent:', {
      phone: cleanPhone.substring(0, 10) + '***',
      status: sendResult.data.StatusId,
      description: sendResult.data.StatusDescription
    });
    
    // Save to database (simple version)
    try {
      const pool = require('../db/pool');
      await pool.query(`
        INSERT INTO leads (source, phone, raw_data, status, created_at) 
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT DO NOTHING
      `, ['whatsapp_webhook', cleanPhone, JSON.stringify({
        last_message: message,
        last_response: aiResponse,
        timestamp: new Date().toISOString()
      }), 'active']);
    } catch (dbError) {
      console.log('DB save error (non-critical):', dbError.message);
    }
    
    res.json({ 
      success: true, 
      processed: true,
      aiResponse: aiResponse.substring(0, 50) + '...',
      inforuStatus: sendResult.data.StatusId
    });
    
  } catch (error) {
    console.error('❌ WhatsApp webhook error:', error.message);
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

// Manual trigger - IMPROVED  
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('🔧 Manual trigger:', { phone: phone.substring(0, 10) + '***', message: message.substring(0, 30) + '...' });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { 
        Message: aiResponse, 
        Phone: phone.replace(/[^0-9]/g, ''),
        SenderName: "QUANTUM"
      }
    }, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${auth}`
      }
    });
    
    res.json({ 
      success: true, 
      aiResponse, 
      inforuResult: result.data,
      senderName: "QUANTUM"
    });
    
  } catch (error) {
    console.error('Manual trigger error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stats endpoint with real data
router.get('/whatsapp/stats', async (req, res) => {
  try {
    let stats = {
      total_leads: 0,
      leads_today: 0,
      sellers: 0,
      buyers: 0,
      high_confidence: 0
    };
    
    try {
      const pool = require('../db/pool');
      const totalResult = await pool.query("SELECT COUNT(*) FROM leads WHERE source = 'whatsapp_webhook'");
      const todayResult = await pool.query("SELECT COUNT(*) FROM leads WHERE source = 'whatsapp_webhook' AND created_at::date = CURRENT_DATE");
      
      stats.total_leads = parseInt(totalResult.rows[0].count);
      stats.leads_today = parseInt(todayResult.rows[0].count);
    } catch (dbError) {
      console.log('Stats DB error:', dbError.message);
    }
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      note: 'WhatsApp Bot Active - Hebrew Optimized'
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;