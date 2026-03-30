const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// GET /api/alerts - List alerts (including system alerts without complex_id)
router.get('/', async (req, res) => {
  try {
    const { unread_only, type, severity, limit } = req.query;
    const limitVal = Math.min(parseInt(limit) || 50, 200);
    
    let query = `
      SELECT
        a.*,
        c.name as complex_name,
        c.city,
        c.slug as complex_slug,
        c.accurate_price_sqm as complex_avg_price_sqm,
        c.city_avg_price_sqm as complex_city_price_sqm,
        l.asking_price as listing_price,
        l.area_sqm as listing_size_sqm,
        l.rooms as listing_rooms,
        l.address as listing_address,
        l.url as listing_url,
        l.source as listing_source,
        l.phone as listing_phone,
        CASE WHEN l.asking_price > 0 AND c.accurate_price_sqm > 0 AND l.area_sqm > 0
          THEN ROUND((c.accurate_price_sqm * l.area_sqm) - l.asking_price)
          ELSE NULL END as premium_market_amount,
        CASE WHEN l.asking_price > 0 AND c.accurate_price_sqm > 0 AND l.area_sqm > 0
          THEN ROUND(((c.accurate_price_sqm * l.area_sqm - l.asking_price) / l.asking_price) * 100, 1)
          ELSE NULL END as premium_market_pct
      FROM alerts a
      LEFT JOIN complexes c ON a.complex_id = c.id
      LEFT JOIN listings l ON a.listing_id = l.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    if (unread_only === 'true') {
      query += ' AND a.is_read = FALSE';
    }
    if (type) {
      paramCount++;
      query += ` AND a.alert_type = $${paramCount}`;
      params.push(type);
    }
    if (severity) {
      paramCount++;
      query += ` AND a.severity = $${paramCount}`;
      params.push(severity);
    }
    
    query += ' ORDER BY a.created_at DESC';
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limitVal);
    
    const result = await pool.query(query, params);
    
    // Unread count
    const unreadCount = await pool.query(
      'SELECT COUNT(*) FROM alerts WHERE is_read = FALSE'
    );
    
    res.json({
      alerts: result.rows,
      unread_count: parseInt(unreadCount.rows[0].count),
      total: result.rows.length
    });
  } catch (err) {
    logger.error('Error fetching alerts', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// PUT /api/alerts/:id/read - Mark alert as read
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE alerts SET is_read = TRUE WHERE id = $1',
      [parseInt(id)]
    );
    res.json({ message: 'Alert marked as read' });
  } catch (err) {
    logger.error('Error updating alert', { error: err.message });
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// POST /api/alerts/mark-all-read - Mark all alerts as read
router.post('/mark-all-read', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE alerts SET is_read = TRUE WHERE is_read = FALSE'
    );
    res.json({ message: `${result.rowCount} alerts marked as read` });
  } catch (err) {
    logger.error('Error updating alerts', { error: err.message });
    res.status(500).json({ error: 'Failed to update alerts' });
  }
});

// PUT /api/alerts/read-all - Mark all alerts as read (legacy)
router.put('/read-all', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE alerts SET is_read = TRUE WHERE is_read = FALSE'
    );
    res.json({ message: `${result.rowCount} alerts marked as read` });
  } catch (err) {
    logger.error('Error updating alerts', { error: err.message });
    res.status(500).json({ error: 'Failed to update alerts' });
  }
});

module.exports = router;
