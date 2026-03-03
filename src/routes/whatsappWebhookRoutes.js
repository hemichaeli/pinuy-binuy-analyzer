/**
 * QUANTUM WhatsApp Bot - v5.2
 * Unified: All WhatsApp via QUANTUM account (037572229)
 * Added: Webhook verification + setup guide
 */

const express = require('express');
const router = express.Router();

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEPLOYMENT_TIME = new Date().toISOString();

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

// Get webhook URL dynamically
function getWebhookUrl() {
  const domain = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'pinuy-binuy-analyzer-production-ab85.up.railway.app';
  return `https://${domain}/api/whatsapp/webhook`;
}

/**
 * Parse INFORU webhook payload
 * INFORU sends: { Data: [{ Value: "phone", Message: "text", Network: "WhatsApp", ... }], CustomerId, ProjectId }
 */
function parseInforuWebhook(body) {
  // Format 1: INFORU standard webhook
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
  
  // Format 2: Simple format (manual trigger / other)
  return {
    phone: body.phone || body.from || body.Phone || null,
    message: body.message || body.text || body.body || body.Message || null,
    network: 'Direct',
    channel: 'Direct',
    raw: body
  };
}

// Simple AI call function
async function callClaude(systemPrompt, userPrompt) {
  try {
    const axios = require('axios');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
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

// ============================================
// WEBHOOK VERIFICATION (GET) 
// ============================================
router.get('/whatsapp/webhook', (req, res) => {
  console.log('Webhook verification GET request:', req.query);
  res.status(200).json({
    success: true,
    message: 'QUANTUM WhatsApp Webhook - Active',
    webhookUrl: getWebhookUrl(),
    whatsappNumber: '037572229',
    timestamp: new Date().toISOString(),
    verification: 'OK',
    acceptsMethods: ['POST'],
    expectedPayload: {
      Data: [{
        Value: 'phone_number',
        Message: 'message_text',
        Network: 'WhatsApp'
      }]
    }
  });
});

// ============================================
// INFORU WEBHOOK RECEIVER (POST)
// ============================================
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    // Log full payload for debugging
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('========================');
    
    const parsed = parseInforuWebhook(req.body);
    
    if (!parsed.phone || !parsed.message) {
      console.log('Webhook: incomplete data');
      console.log('Parsed phone:', parsed.phone);
      console.log('Parsed message:', parsed.message);
      console.log('Raw body:', JSON.stringify(req.body).substring(0, 500));
      
      return res.status(200).json({ 
        received: true, 
        processed: false, 
        reason: 'Missing phone or message',
        parsedPhone: parsed.phone,
        parsedMessage: parsed.message,
        hint: 'Check INFORU webhook payload format'
      });
    }
    
    console.log('✓ WEBHOOK: Valid message received');
    console.log('  Phone:', parsed.phone);
    console.log('  Message:', parsed.message.substring(0, 100));
    console.log('  Network:', parsed.network);
    
    // Only auto-reply to WhatsApp messages
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') {
      console.log('Webhook: Non-WhatsApp message, skipping:', parsed.network);
      return res.json({ received: true, processed: false, reason: `Network: ${parsed.network}` });
    }
    
    // Generate AI response
    console.log('→ Calling Claude AI...');
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, parsed.message);
    console.log('✓ AI Response:', aiResponse.substring(0, 100));
    
    // Send response via QUANTUM credentials (037572229)
    console.log('→ Sending WhatsApp reply...');
    const axios = require('axios');
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: parsed.phone,
        Settings: {
          CustomerMessageId: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          CustomerParameter: 'QUANTUM_BOT'
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000,
      validateStatus: () => true
    });
    
    const success = result.data.StatusId === 1;
    console.log(success ? '✓ Reply sent successfully' : '✗ Reply failed');
    console.log('  Status:', result.data.StatusId, result.data.StatusDescription);
    
    res.json({ 
      success,
      processed: true,
      incomingPhone: parsed.phone,
      incomingMessage: parsed.message,
      aiResponse: aiResponse,
      autoReplyStatus: result.data.StatusId,
      autoReplyDescription: result.data.StatusDescription,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('✗ Webhook processing error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message,
      webhookReceived: true,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================
// SETUP GUIDE - Complete INFORU instructions
// ============================================
router.get('/whatsapp/setup-guide', (req, res) => {
  const webhookUrl = getWebhookUrl();
  
  res.type('text/html').send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM WhatsApp Webhook - הוראות התקנה</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #2563eb; border-bottom: 3px solid #2563eb; padding-bottom: 10px; }
    h2 { color: #1e40af; margin-top: 30px; }
    .step { background: #eff6ff; border-right: 4px solid #2563eb; padding: 15px; margin: 15px 0; border-radius: 4px; }
    .step-number { color: #2563eb; font-weight: bold; font-size: 18px; }
    code { background: #1e293b; color: #10b981; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
    .url-box { background: #1e293b; color: #10b981; padding: 15px; border-radius: 6px; font-family: 'Courier New', monospace; margin: 15px 0; font-size: 14px; word-break: break-all; }
    .success { background: #ecfdf5; border-right: 4px solid #10b981; color: #065f46; padding: 15px; margin: 15px 0; border-radius: 4px; }
    .warning { background: #fef3c7; border-right: 4px solid #f59e0b; color: #92400e; padding: 15px; margin: 15px 0; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #e5e7eb; padding: 12px; text-align: right; }
    th { background: #f3f4f6; font-weight: bold; }
    .test-section { background: #f9fafb; padding: 20px; border-radius: 6px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 QUANTUM WhatsApp Webhook - מדריך התקנה מלא</h1>
    
    <div class="success">
      <strong>✓ ה-Webhook מוכן ופעיל!</strong><br>
      כעת נשאר רק להגדיר ב-INFORU שישלח הודעות נכנסות ל-URL הזה.
    </div>

    <h2>📋 פרטי ה-Webhook</h2>
    <table>
      <tr><th>פרמטר</th><th>ערך</th></tr>
      <tr><td>Webhook URL</td><td><code>${webhookUrl}</code></td></tr>
      <tr><td>שיטה (Method)</td><td><code>POST</code></td></tr>
      <tr><td>Content-Type</td><td><code>application/json</code></td></tr>
      <tr><td>מספר WhatsApp</td><td><code>037572229</code></td></tr>
      <tr><td>חשבון INFORU</td><td><code>QUANTUM</code></td></tr>
    </table>

    <h2>🔧 שלבי ההתקנה ב-INFORU</h2>
    
    <div class="step">
      <span class="step-number">שלב 1:</span> כניסה לממשק ניהול INFORU<br>
      היכנס ל: <a href="https://www.inforu.co.il" target="_blank">www.inforu.co.il</a><br>
      התחבר עם המשתמש: <code>QUANTUM</code>
    </div>

    <div class="step">
      <span class="step-number">שלב 2:</span> ניווט להגדרות WhatsApp<br>
      מסלול בממשק (בדרך כלל):<br>
      <strong>הגדרות → WhatsApp Business API → Webhooks</strong><br>
      או:<br>
      <strong>Settings → Integrations → Webhooks</strong>
    </div>

    <div class="step">
      <span class="step-number">שלב 3:</span> הוספת Webhook חדש<br>
      לחץ על <strong>"הוסף Webhook"</strong> או <strong>"Add Webhook"</strong><br><br>
      <strong>מלא את הפרטים הבאים:</strong><br>
      • <strong>שם:</strong> QUANTUM Bot<br>
      • <strong>URL:</strong> העתק את הכתובת הזו:<br>
      <div class="url-box">${webhookUrl}</div>
      • <strong>Method:</strong> POST<br>
      • <strong>סוג אירוע:</strong> Incoming Message / הודעה נכנסת<br>
      • <strong>ערוץ:</strong> WhatsApp<br>
      • <strong>מספר:</strong> 037572229 (אם יש אפשרות לבחור)
    </div>

    <div class="step">
      <span class="step-number">שלב 4:</span> בדיקת החיבור<br>
      ב-INFORU יש בדרך כלל כפתור <strong>"בדיקה"</strong> או <strong>"Test"</strong><br>
      לחץ עליו - אתה אמור לקבל תשובה: <code>{"success": true, "verification": "OK"}</code>
    </div>

    <div class="step">
      <span class="step-number">שלב 5:</span> שמירה והפעלה<br>
      לחץ על <strong>"שמור"</strong> ו-<strong>"הפעל"</strong><br>
      ודא שה-Webhook מופעל (Status: Active)
    </div>

    <h2>🧪 בדיקה ידנית</h2>
    <div class="test-section">
      <strong>אפשרות 1: שליחת הודעה ל-WhatsApp</strong><br>
      שלח הודעה WhatsApp ל: <code>037572229</code><br>
      הבוט אמור להגיב תוך מספר שניות.<br><br>

      <strong>אפשרות 2: Trigger ידני דרך API</strong><br>
      <code>curl -X POST ${webhookUrl.replace('/webhook', '/trigger')} \\<br>
  -H "Content-Type: application/json" \\<br>
  -d '{"phone": "972501234567", "message": "היי"}'</code>
    </div>

    <h2>📊 מעקב וניטור</h2>
    <p>
      <strong>סטטוס ה-Webhook:</strong> <a href="${webhookUrl.replace('/webhook', '/stats')}" target="_blank">${webhookUrl.replace('/webhook', '/stats')}</a><br>
      <strong>Dashboard:</strong> <a href="/api/whatsapp-dashboard" target="_blank">/api/whatsapp-dashboard</a>
    </p>

    <h2>🔍 פורמט ה-Payload מ-INFORU</h2>
    <div class="warning">
      <strong>חשוב:</strong> INFORU שולח את הנתונים בפורמט הבא:
    </div>
    <pre style="background: #1e293b; color: #10b981; padding: 15px; border-radius: 6px; overflow-x: auto; direction: ltr; text-align: left;">
{
  "Data": [{
    "Value": "972501234567",     // מספר הטלפון
    "Message": "היי",             // ההודעה
    "Network": "WhatsApp",        // הרשת
    "Channel": "WA_037572229",    // הערוץ
    "MoSessionId": "...",         // מזהה סשן
    "CustomerParam": "..."        // פרמטרים נוספים
  }],
  "CustomerId": 12345,
  "ProjectId": 67890
}</pre>

    <h2>❓ פתרון בעיות</h2>
    <table>
      <tr><th>בעיה</th><th>פתרון</th></tr>
      <tr>
        <td>הבוט לא מגיב</td>
        <td>1. בדוק שה-Webhook active ב-INFORU<br>2. בדוק Logs ב-Railway<br>3. נסה trigger ידני</td>
      </tr>
      <tr>
        <td>שגיאת 404</td>
        <td>וודא שה-URL נכון (צריך להיות <code>/api/whatsapp/webhook</code>)</td>
      </tr>
      <tr>
        <td>שגיאת אימות</td>
        <td>בדוק שמשתני הסביבה <code>INFORU_USERNAME</code> ו-<code>INFORU_PASSWORD</code> מוגדרים ב-Railway</td>
      </tr>
      <tr>
        <td>התשובה לא נשלחת</td>
        <td>בדוק שה-Claude API key תקין ב-Railway (<code>ANTHROPIC_API_KEY</code>)</td>
      </tr>
    </table>

    <div class="success">
      <strong>✓ הכל מוכן!</strong><br>
      אחרי ההגדרה ב-INFORU, כל הודעה שתישלח ל-037572229 תיענה אוטומטית על ידי הבוט.
    </div>

    <p style="text-align: center; margin-top: 40px; color: #6b7280;">
      <strong>QUANTUM</strong> | WhatsApp Bot v5.2 | ${new Date().toISOString()}
    </p>
  </div>
</body>
</html>
  `);
});

// Manual trigger for testing
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('Manual trigger:', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
    const axios = require('axios');
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        Settings: {
          CustomerMessageId: `trigger_${Date.now()}`,
          CustomerParameter: 'QUANTUM_TRIGGER'
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000,
      validateStatus: () => true
    });
    
    res.json({ 
      success: result.data.StatusId === 1, 
      aiResponse, 
      inforuResult: result.data,
      credentials: 'QUANTUM (env vars)',
      whatsappNumber: '037572229',
      deploymentTime: DEPLOYMENT_TIME
    });
    
  } catch (error) {
    console.error('Manual trigger error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stats endpoint  
router.get('/whatsapp/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      deploymentTime: DEPLOYMENT_TIME,
      webhookUrl: getWebhookUrl(),
      setupGuideUrl: getWebhookUrl().replace('/webhook', '/setup-guide'),
      whatsappNumber: '037572229',
      credentials: {
        source: 'env vars (INFORU_USERNAME/INFORU_PASSWORD)',
        account: process.env.INFORU_USERNAME || 'NOT SET'
      },
      webhookFormat: 'INFORU standard (Data array with Value/Message/Network)',
      status: 'ACTIVE',
      nextSteps: [
        `1. Configure webhook in INFORU dashboard`,
        `2. Set webhook URL to: ${getWebhookUrl()}`,
        `3. Test by sending WhatsApp message to 037572229`,
        `4. View setup guide at: ${getWebhookUrl().replace('/webhook', '/setup-guide')}`
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
