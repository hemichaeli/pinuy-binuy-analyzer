/**
 * Simple WhatsApp Stats API - Fixed Version
 * Returns basic lead statistics without complex dashboard
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const pool = require('../db/pool');

// Simple stats API endpoint
router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as leads_today,
        COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
        COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers,
        COUNT(*) FILTER (WHERE raw_data->>'confidence' >= '8') as high_confidence
      FROM leads 
      WHERE source = 'whatsapp_webhook'
    `);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats: stats.rows[0]
    });
  } catch (error) {
    logger.error('Stats error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Simple dashboard page (basic HTML)
router.get('/whatsapp-dashboard', async (req, res) => {
  try {
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
        COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
        COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers
      FROM leads 
      WHERE source = 'whatsapp_webhook'
    `);
    
    const stats = statsResult.rows[0];
    
    const simpleHTML = `
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>QUANTUM WhatsApp Stats</title>
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
        .card { background: white; padding: 20px; margin: 10px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
        .number { font-size: 2em; font-weight: bold; color: #667eea; }
        .label { color: #666; margin-top: 10px; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; color: #333; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 QUANTUM WhatsApp Bot Stats</h1>
        
        <div class="card">
            <div class="number">${stats.total || 0}</div>
            <div class="label">סה"כ Leads</div>
        </div>
        
        <div class="card">
            <div class="number">${stats.today || 0}</div>
            <div class="label">Leads היום</div>
        </div>
        
        <div class="card">
            <div class="number">${stats.sellers || 0}</div>
            <div class="label">מוכרים</div>
        </div>
        
        <div class="card">
            <div class="number">${stats.buyers || 0}</div>
            <div class="label">קונים</div>
        </div>
        
        <script>
            // Auto refresh every 30 seconds
            setTimeout(() => location.reload(), 30000);
        </script>
    </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(simpleHTML);
    
  } catch (error) {
    logger.error('Dashboard error', { error: error.message });
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

module.exports = router;