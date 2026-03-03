const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ============================================================
// SYSTEM RELIABILITY FIXES for QUANTUM v4.37.0
// Table: scan_logs (NOT "scans")
// ============================================================

// POST /api/scan-fixes/fix-stuck - Fix ALL stuck scans (running > 2 hours)
router.post('/fix-stuck', async (req, res) => {
  try {
    logger.info('[ScanFix] Fixing all stuck scans (running > 2 hours)...');
    
    const result = await pool.query(`
      UPDATE scan_logs 
      SET status = 'failed', 
          completed_at = NOW(), 
          errors = 'Scan stuck - auto-fixed by system reliability monitor',
          summary = 'Auto-failed: Scan was stuck in running state'
      WHERE status = 'running' 
        AND started_at < NOW() - INTERVAL '2 hours'
      RETURNING id, scan_type, started_at, complexes_scanned
    `);
    
    if (result.rowCount > 0) {
      const fixed = result.rows.map(r => `#${r.id} (${r.scan_type}, started ${r.started_at})`);
      logger.info(`[ScanFix] Fixed ${result.rowCount} stuck scans: ${fixed.join(', ')}`);
      res.json({ 
        success: true, 
        fixed: result.rowCount,
        scans: result.rows,
        message: `Fixed ${result.rowCount} stuck scan(s)`
      });
    } else {
      res.json({ 
        success: true, 
        fixed: 0,
        message: 'No stuck scans found (all scans either completed or < 2 hours old)'
      });
    }
  } catch (error) {
    logger.error('[ScanFix] Error fixing stuck scans:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/scan-fixes/fix-scan/:id - Fix a specific stuck scan by ID
router.post('/fix-scan/:id', async (req, res) => {
  const scanId = parseInt(req.params.id);
  try {
    logger.info(`[ScanFix] Fixing scan #${scanId}...`);
    
    const result = await pool.query(`
      UPDATE scan_logs 
      SET status = 'failed', 
          completed_at = NOW(), 
          errors = 'Manually fixed via scan-fixes API',
          summary = 'Auto-failed: Manually triggered fix'
      WHERE id = $1 AND status = 'running'
      RETURNING *
    `, [scanId]);
    
    if (result.rowCount > 0) {
      res.json({ success: true, message: `Scan #${scanId} fixed`, scan: result.rows[0] });
    } else {
      const check = await pool.query('SELECT id, status FROM scan_logs WHERE id = $1', [scanId]);
      res.json({ 
        success: true, 
        message: check.rows.length > 0 
          ? `Scan #${scanId} status is already '${check.rows[0].status}'` 
          : `Scan #${scanId} not found`
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/scan-fixes/status - System scan health
router.get('/status', async (req, res) => {
  try {
    const stuck = await pool.query(`
      SELECT id, scan_type, started_at, complexes_scanned 
      FROM scan_logs 
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
      ORDER BY started_at
    `);
    const recent = await pool.query(`
      SELECT id, scan_type, status, started_at, completed_at, complexes_scanned
      FROM scan_logs ORDER BY started_at DESC LIMIT 5
    `);
    const counts = await pool.query(`
      SELECT status, COUNT(*) as cnt FROM scan_logs GROUP BY status ORDER BY cnt DESC
    `);
    
    res.json({
      stuck_scans: stuck.rows,
      stuck_count: stuck.rowCount,
      recent_scans: recent.rows,
      scan_counts: counts.rows,
      healthy: stuck.rowCount === 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/scan-fixes/verify-widen - Check if widen migration ran
router.get('/verify-widen', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns 
      WHERE table_name = 'complexes' 
        AND column_name IN ('name', 'city', 'neighborhood', 'developer', 'slug', 'address')
      ORDER BY column_name
    `);
    
    const allText = result.rows.every(r => r.data_type === 'text');
    
    res.json({
      success: true,
      widen_applied: allText,
      columns: result.rows,
      message: allText 
        ? 'All columns are TEXT - widen migration applied successfully' 
        : 'Some columns still have VARCHAR limits - migration may not have run'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
