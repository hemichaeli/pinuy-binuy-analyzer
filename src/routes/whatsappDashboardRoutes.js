/**
 * Simple WhatsApp Dashboard - Production Safe
 * Basic HTML dashboard without complex dependencies
 */

const express = require('express');
const router = express.Router();

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
      note: 'Basic stats - coming soon with database integration'
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Simple dashboard page
router.get('/whatsapp-dashboard', async (req, res) => {
  try {
    const simpleHTML = `
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>QUANTUM WhatsApp Bot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: 'Segoe UI', Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto;
            background: rgba(255,255,255,0.95);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        h1 { 
            text-align: center; 
            color: #333; 
            margin-bottom: 30px;
            font-size: 2.5em;
        }
        .status {
            text-align: center;
            padding: 20px;
            background: #e8f4fd;
            border-radius: 15px;
            margin-bottom: 20px;
            border-left: 5px solid #2196f3;
        }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-top: 30px;
        }
        .feature {
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            text-align: center;
        }
        .feature h3 {
            color: #667eea;
            margin-bottom: 10px;
        }
        .coming-soon {
            color: #28a745;
            font-weight: bold;
        }
        .refresh-btn {
            display: block;
            margin: 30px auto;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 25px;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .refresh-btn:hover {
            background: #5a67d8;
            transform: translateY(-2px);
        }
        .version {
            text-align: center;
            color: #666;
            margin-top: 20px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 QUANTUM WhatsApp Bot</h1>
        
        <div class="status">
            <h3>📊 מצב המערכת</h3>
            <p><strong>סטטוס:</strong> פעיל ומוכן לקבלת הודעות</p>
            <p><strong>זמן עדכון:</strong> ${new Date().toLocaleString('he-IL')}</p>
        </div>

        <div class="features">
            <div class="feature">
                <h3>🧠 AI Responses</h3>
                <p>מערכת מענה חכמה בעברית</p>
                <span class="coming-soon">✅ פעיל</span>
            </div>
            
            <div class="feature">
                <h3>📱 WhatsApp Integration</h3>
                <p>חיבור ישיר ל-INFORU</p>
                <span class="coming-soon">✅ פעיל</span>
            </div>
            
            <div class="feature">
                <h3>📊 Lead Management</h3>
                <p>ניהול ומעקב לידים</p>
                <span class="coming-soon">🔄 בפיתוח</span>
            </div>
            
            <div class="feature">
                <h3>📈 Analytics</h3>
                <p>דו"חות וסטטיסטיקות</p>
                <span class="coming-soon">🔄 בפיתוח</span>
            </div>
        </div>

        <button class="refresh-btn" onclick="location.reload()">🔄 רענון</button>
        
        <div class="version">
            QUANTUM WhatsApp Bot v1.0 | ${new Date().toISOString()}
        </div>
        
        <script>
            // Auto refresh every 2 minutes
            setTimeout(() => location.reload(), 120000);
            console.log('QUANTUM WhatsApp Bot Dashboard Loaded');
        </script>
    </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(simpleHTML);
    
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).send(`
      <html dir="rtl">
        <head><meta charset="UTF-8"><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>🚨 שגיאה</h1>
          <p>לא ניתן להציג את הדאשבורד כרגע</p>
          <p>שגיאה: ${error.message}</p>
          <button onclick="location.reload()">נסה שוב</button>
        </body>
      </html>
    `);
  }
});

module.exports = router;