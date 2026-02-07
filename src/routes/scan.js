const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// POST /api/scan/run - Trigger a manual scan
router.post('/run', async (req, res) => {
  try {
    const { type } = req.body;
    const scanType = type || 'manual';
    
    // Check if a scan is already running
    const running = await pool.query(
      "SELECT id FROM scan_logs WHERE status = 'running' AND started_at > NOW() - INTERVAL '1 hour'"
    );
    
    if (running.rows.length > 0) {
      return res.status(409).json({
        error: 'A scan is already running',
        scan_id: running.rows[0].id
      });
    }
    
    // Create scan log entry
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ($1, 'running') RETURNING *`,
      [scanType]
    );
    
    const scanId = scanLog.rows[0].id;
    
    // For now, mark as completed immediately (scrapers will be added in Phase 2-4)
    await pool.query(
      `UPDATE scan_logs SET 
        status = 'completed',
        completed_at = NOW(),
        summary = 'Scan infrastructure ready. Scrapers pending implementation (Phase 2-4).'
      WHERE id = $1`,
      [scanId]
    );
    
    logger.info(`Scan ${scanId} triggered (type: ${scanType})`);
    
    res.json({
      message: 'Scan triggered successfully',
      scan_id: scanId,
      type: scanType,
      note: 'Scrapers will be connected in Phase 2-4. Infrastructure is ready.'
    });
  } catch (err) {
    logger.error('Error triggering scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// GET /api/scan/results - Latest scan results
router.get('/results', async (req, res) => {
  try {
    const { limit } = req.query;
    const limitVal = Math.min(parseInt(limit) || 10, 50);
    
    const results = await pool.query(
      `SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT $1`,
      [limitVal]
    );
    
    res.json({
      scans: results.rows,
      total: results.rows.length
    });
  } catch (err) {
    logger.error('Error fetching scan results', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch scan results' });
  }
});

// GET /api/scan/:id - Specific scan details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM scan_logs WHERE id = $1',
      [parseInt(id)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('Error fetching scan', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch scan' });
  }
});

module.exports = router;
