/**
 * WhatsApp Bot Dashboard - Real-time Lead Analytics
 * Displays lead statistics, conversion rates, and bot performance
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const pool = require('../db/pool');

// Dashboard main page
router.get('/whatsapp-bot-dashboard', async (req, res) => {
  try {
    // Get comprehensive stats
    const stats = await getComprehensiveStats();
    const recentLeads = await getRecentLeads();
    const performanceMetrics = await getPerformanceMetrics();
    
    const dashboardHTML = generateDashboardHTML(stats, recentLeads, performanceMetrics);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(dashboardHTML);
  } catch (error) {
    logger.error('Dashboard error', { error: error.message });
    res.status(500).send(`<h1>Dashboard Error</h1><p>${error.message}</p>`);
  }
});

// API endpoint for dashboard data (for real-time updates)
router.get('/whatsapp-bot-dashboard/api/stats', async (req, res) => {
  try {
    const stats = await getComprehensiveStats();
    const recentLeads = await getRecentLeads();
    const performanceMetrics = await getPerformanceMetrics();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      recentLeads,
      performanceMetrics
    });
  } catch (error) {
    logger.error('Dashboard API error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Comprehensive stats function
async function getComprehensiveStats() {
  const statsQuery = await pool.query(`
    SELECT 
      COUNT(*) as total_leads,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as leads_today,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as leads_this_week,
      COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
      COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers,
      COUNT(*) FILTER (WHERE status = 'initial') as stage_initial,
      COUNT(*) FILTER (WHERE status = 'qualifying') as stage_qualifying,
      COUNT(*) FILTER (WHERE status = 'presenting') as stage_presenting,
      COUNT(*) FILTER (WHERE status = 'closing') as stage_closing,
      COUNT(*) FILTER (WHERE raw_data->>'confidence' >= '8') as high_confidence,
      COUNT(*) FILTER (WHERE raw_data->>'confidence' BETWEEN '5' AND '7') as medium_confidence,
      COUNT(*) FILTER (WHERE raw_data->>'confidence' < '5') as low_confidence,
      COUNT(*) FILTER (WHERE raw_data->>'language' = 'hebrew') as hebrew_speakers,
      COUNT(*) FILTER (WHERE raw_data->>'language' = 'english') as english_speakers,
      COUNT(*) FILTER (WHERE raw_data->>'language' = 'arabic') as arabic_speakers,
      COUNT(*) FILTER (WHERE raw_data->>'brokerStatus' = 'no_broker') as no_broker,
      COUNT(*) FILTER (WHERE raw_data->>'brokerStatus' = 'has_broker') as has_broker,
      COUNT(*) FILTER (WHERE raw_data->>'satisfaction' = 'low') as unsatisfied_with_broker
    FROM leads 
    WHERE source = 'whatsapp_webhook'
  `);
  
  return statsQuery.rows[0];
}

// Recent leads function
async function getRecentLeads(limit = 20) {
  const recentQuery = await pool.query(`
    SELECT 
      id, phone, user_type, status, 
      raw_data->>'confidence' as confidence,
      raw_data->>'language' as language,
      raw_data->>'brokerStatus' as broker_status,
      raw_data->>'last_message' as last_message,
      created_at, updated_at
    FROM leads 
    WHERE source = 'whatsapp_webhook'
    ORDER BY updated_at DESC 
    LIMIT $1
  `, [limit]);
  
  return recentQuery.rows;
}

// Performance metrics function
async function getPerformanceMetrics() {
  const hourlyQuery = await pool.query(`
    SELECT 
      DATE_TRUNC('hour', created_at) as hour,
      COUNT(*) as leads_count,
      AVG(CAST(raw_data->>'confidence' AS INTEGER)) as avg_confidence
    FROM leads 
    WHERE source = 'whatsapp_webhook' 
      AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY hour
    ORDER BY hour
  `);
  
  return {
    hourlyStats: hourlyQuery.rows,
    conversionRate: 0.85, // Placeholder - calculate based on actual conversions
    avgResponseTime: '2.3s', // Placeholder
    botUptime: '99.9%' // Placeholder
  };
}

// Generate HTML dashboard
function generateDashboardHTML(stats, recentLeads, performanceMetrics) {
  return `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QUANTUM WhatsApp Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
        body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); padding: 20px; border-radius: 20px; margin-bottom: 30px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.1); }
        .header h1 { color: #2d3748; font-size: 2.5em; margin-bottom: 10px; }
        .header .subtitle { color: #4a5568; font-size: 1.2em; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); padding: 25px; border-radius: 20px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.1); transition: transform 0.3s ease; }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-card .number { font-size: 3em; font-weight: bold; margin-bottom: 10px; }
        .stat-card .label { color: #4a5568; font-size: 1.1em; }
        .recent-leads { background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); padding: 30px; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.1); }
        .recent-leads h2 { color: #2d3748; margin-bottom: 20px; font-size: 1.8em; }
        .lead-item { background: #f7fafc; padding: 15px; border-radius: 10px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .lead-info { flex: 1; }
        .lead-phone { font-weight: bold; color: #2d3748; }
        .lead-type { color: #4a5568; margin-top: 5px; }
        .lead-confidence { padding: 5px 12px; border-radius: 20px; color: white; font-size: 0.9em; font-weight: bold; }
        .confidence-high { background: #48bb78; }
        .confidence-medium { background: #ed8936; }
        .confidence-low { background: #f56565; }
        .refresh-btn { position: fixed; bottom: 30px; right: 30px; background: #667eea; color: white; border: none; padding: 15px 25px; border-radius: 50px; font-size: 1.1em; cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.2); transition: all 0.3s ease; }
        .refresh-btn:hover { background: #5a67d8; transform: scale(1.05); }
        .metrics-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
        .metric-card { background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); padding: 20px; border-radius: 15px; }
        .progress-bar { background: #e2e8f0; border-radius: 10px; height: 10px; margin-top: 10px; overflow: hidden; }
        .progress-fill { height: 100%; border-radius: 10px; transition: width 0.5s ease; }
        
        /* Color scheme for different stats */
        .total-leads .number { color: #667eea; }
        .today-leads .number { color: #48bb78; }
        .high-confidence .number { color: #38a169; }
        .sellers .number { color: #d69e2e; }
        .buyers .number { color: #3182ce; }
        .auto-refresh { font-size: 0.9em; color: #718096; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>🤖 QUANTUM WhatsApp Bot Dashboard</h1>
            <div class="subtitle">מעקב בזמן אמת אחר ביצועי הבוט ו-leads</div>
            <div class="auto-refresh">עדכון אוטומטי כל 30 שניות</div>
        </div>

        <!-- Key Stats Grid -->
        <div class="stats-grid">
            <div class="stat-card total-leads">
                <div class="number">${stats.total_leads || 0}</div>
                <div class="label">סה"כ Leads</div>
            </div>
            
            <div class="stat-card today-leads">
                <div class="number">${stats.leads_today || 0}</div>
                <div class="label">Leads היום</div>
            </div>
            
            <div class="stat-card high-confidence">
                <div class="number">${stats.high_confidence || 0}</div>
                <div class="label">Leads חמים (8+)</div>
            </div>
            
            <div class="stat-card sellers">
                <div class="number">${stats.sellers || 0}</div>
                <div class="label">מוכרים</div>
            </div>
            
            <div class="stat-card buyers">
                <div class="number">${stats.buyers || 0}</div>
                <div class="label">קונים</div>
            </div>
        </div>

        <!-- Performance Metrics -->
        <div class="metrics-row">
            <div class="metric-card">
                <h3>📊 שלבי מכירה</h3>
                <div style="margin-top: 15px;">
                    <div>מוקדם: ${stats.stage_initial || 0}</div>
                    <div>הכרות: ${stats.stage_qualifying || 0}</div>  
                    <div>מצגת: ${stats.stage_presenting || 0}</div>
                    <div>סגירה: ${stats.stage_closing || 0}</div>
                </div>
            </div>
            
            <div class="metric-card">
                <h3>🌍 שפות</h3>
                <div style="margin-top: 15px;">
                    <div>עברית: ${stats.hebrew_speakers || 0}</div>
                    <div>אנגלית: ${stats.english_speakers || 0}</div>
                    <div>ערבית: ${stats.arabic_speakers || 0}</div>
                </div>
            </div>
        </div>

        <!-- Recent Leads -->
        <div class="recent-leads">
            <h2>📱 Leads אחרונים</h2>
            <div id="leads-list">
                ${recentLeads.map(lead => `
                    <div class="lead-item">
                        <div class="lead-info">
                            <div class="lead-phone">${lead.phone}</div>
                            <div class="lead-type">${getLeadTypeHebrew(lead.user_type)} | ${lead.language || 'עברית'} | ${getTimeAgo(lead.updated_at)}</div>
                        </div>
                        <div class="lead-confidence ${getConfidenceClass(lead.confidence)}">${lead.confidence || 5}/10</div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <button class="refresh-btn" onclick="refreshDashboard()">🔄 רענון</button>
    </div>

    <script>
        // Auto-refresh every 30 seconds
        setInterval(refreshDashboard, 30000);
        
        async function refreshDashboard() {
            try {
                console.log('Refreshing dashboard...');
                const response = await fetch('/api/whatsapp-bot-dashboard/api/stats');
                const data = await response.json();
                
                if (data.success) {
                    // Update stats
                    updateStats(data.stats);
                    updateRecentLeads(data.recentLeads);
                    
                    // Visual feedback
                    const btn = document.querySelector('.refresh-btn');
                    const originalText = btn.textContent;
                    btn.textContent = '✅ עודכן';
                    setTimeout(() => btn.textContent = originalText, 1500);
                }
            } catch (error) {
                console.error('Refresh failed:', error);
                const btn = document.querySelector('.refresh-btn');
                btn.textContent = '❌ שגיאה';
                setTimeout(() => btn.textContent = '🔄 רענון', 2000);
            }
        }
        
        function updateStats(stats) {
            document.querySelector('.total-leads .number').textContent = stats.total_leads || 0;
            document.querySelector('.today-leads .number').textContent = stats.leads_today || 0;
            document.querySelector('.high-confidence .number').textContent = stats.high_confidence || 0;
            document.querySelector('.sellers .number').textContent = stats.sellers || 0;
            document.querySelector('.buyers .number').textContent = stats.buyers || 0;
        }
        
        function updateRecentLeads(leads) {
            const container = document.getElementById('leads-list');
            container.innerHTML = leads.map(lead => \`
                <div class="lead-item">
                    <div class="lead-info">
                        <div class="lead-phone">\${lead.phone}</div>
                        <div class="lead-type">\${getLeadTypeHebrew(lead.user_type)} | \${lead.language || 'עברית'} | \${getTimeAgo(lead.updated_at)}</div>
                    </div>
                    <div class="lead-confidence \${getConfidenceClass(lead.confidence)}">\${lead.confidence || 5}/10</div>
                </div>
            \`).join('');
        }
        
        function getLeadTypeHebrew(type) {
            return type === 'seller' ? 'מוכר' : type === 'buyer' ? 'קונה' : 'לא ידוע';
        }
        
        function getConfidenceClass(confidence) {
            const conf = parseInt(confidence) || 5;
            return conf >= 8 ? 'confidence-high' : conf >= 5 ? 'confidence-medium' : 'confidence-low';
        }
        
        function getTimeAgo(dateString) {
            const now = new Date();
            const date = new Date(dateString);
            const diff = now - date;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            
            if (days > 0) return \`לפני \${days} ימים\`;
            if (hours > 0) return \`לפני \${hours} שעות\`;
            return \`לפני \${minutes} דקות\`;
        }
        
        console.log('QUANTUM Dashboard loaded 🚀');
    </script>
</body>
</html>`;
}

function getLeadTypeHebrew(type) {
  return type === 'seller' ? 'מוכר' : type === 'buyer' ? 'קונה' : 'לא ידוע';
}

function getConfidenceClass(confidence) {
  const conf = parseInt(confidence) || 5;
  return conf >= 8 ? 'confidence-high' : conf >= 5 ? 'confidence-medium' : 'confidence-low';
}

function getTimeAgo(dateString) {
  const now = new Date();
  const date = new Date(dateString);
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `לפני ${days} ימים`;
  if (hours > 0) return `לפני ${hours} שעות`;
  return `לפני ${minutes} דקות`;
}

module.exports = router;