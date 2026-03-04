const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /api/morning/send - Manually trigger morning report email
router.post('/send', async (req, res) => {
  try {
    const { sendMorningReport } = require('../services/morningReportService');
    const result = await sendMorningReport();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/morning/preview - Preview morning report data (no email sent)
router.get('/preview', async (req, res) => {
  try {
    const [opp, sellers, drops] = await Promise.all([
      pool.query('SELECT id, name, city, iai_score, status, developer, actual_premium, address, plan_stage, signature_percent FROM complexes WHERE iai_score >= 60 ORDER BY iai_score DESC LIMIT 8'),
      pool.query('SELECT l.id, l.address, l.city, l.asking_price, l.ssi_score, l.days_on_market, l.price_changes, l.total_price_drop_percent, c.name as complex_name FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.ssi_score >= 30 ORDER BY l.ssi_score DESC LIMIT 5'),
      pool.query("SELECT l.id, l.address, l.city, l.asking_price, l.price_changes, l.total_price_drop_percent, c.name as complex_name FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.price_changes > 0 AND l.last_seen >= NOW() - INTERVAL '24 hours' AND l.total_price_drop_percent >= 5 ORDER BY l.total_price_drop_percent DESC LIMIT 5")
    ]);
    res.json({
      opportunities: opp.rows,
      stressed_sellers: sellers.rows,
      price_drops_24h: drops.rows,
      generated_at: new Date().toISOString(),
      note: 'Preview only - no email sent. POST /api/morning/send to trigger.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
