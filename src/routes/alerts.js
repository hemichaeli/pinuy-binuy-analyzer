const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// GET /api/alerts - List alerts
router.get('/', async (req, res) => {
  try {
    const { unread_only, type, severity, limit } = req.query;
    const limitVal = Math.min(parseInt(limit) || 50, 200);
    
    let query = `
      SELECT 
        a.*,
        c.name as complex_name,
        c.city,
        c.slug as complex_slug
      FROM alerts a
      JOIN complexes c ON a.complex_id = c.id
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

// PUT /api/alerts/read-all - Mark all alerts as read
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
