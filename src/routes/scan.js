const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { scanComplex, scanAll } = require('../services/perplexityService');
const { calculateIAI, calculateAllIAI } = require('../services/iaiCalculator');

// POST /api/scan/run - Trigger a scan
router.post('/run', async (req, res) => {
  try {
    const { type, city, status, limit, complexId, staleOnly } = req.body;
    const scanType = type || 'perplexity';

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

    // Respond immediately, run scan in background
    res.json({
      message: 'Scan triggered successfully',
      scan_id: scanId,
      type: scanType,
      note: complexId
        ? `Scanning single complex ${complexId}`
        : `Scanning complexes${city ? ` in ${city}` : ''}${limit ? ` (limit: ${limit})` : ''}`
    });

    // Run scan in background
    (async () => {
      try {
        let results;

        if (complexId) {
          // Single complex scan
          const result = await scanComplex(parseInt(complexId));
          results = {
            total: 1, scanned: 1,
            succeeded: result.status === 'success' ? 1 : 0,
            failed: result.status === 'error' ? 1 : 0,
            totalNewTransactions: result.transactions || 0,
            totalNewListings: result.listings || 0,
            details: [result]
          };
        } else {
          // Batch scan
          results = await scanAll({
            city: city || null,
            status: status || null,
            limit: limit ? parseInt(limit) : null,
            staleOnly: staleOnly !== false
          });
        }

        // Recalculate IAI scores after data collection
        logger.info('Recalculating IAI scores...');
        await calculateAllIAI();

        // Update scan log
        await pool.query(
          `UPDATE scan_logs SET 
            status = 'completed',
            completed_at = NOW(),
            complexes_scanned = $1,
            new_transactions = $2,
            new_listings = $3,
            summary = $4
          WHERE id = $5`,
          [
            results.scanned,
            results.totalNewTransactions,
            results.totalNewListings,
            `Perplexity scan: ${results.succeeded}/${results.total} succeeded, ` +
            `${results.totalNewTransactions} new transactions, ${results.totalNewListings} new listings. ` +
            `${results.failed} failed.`,
            scanId
          ]
        );

        logger.info(`Scan ${scanId} completed`, { results: { ...results, details: undefined } });
      } catch (err) {
        logger.error(`Scan ${scanId} failed`, { error: err.message, stack: err.stack });
        await pool.query(
          `UPDATE scan_logs SET 
            status = 'failed',
            completed_at = NOW(),
            errors = $1
          WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();

  } catch (err) {
    logger.error('Error triggering scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// POST /api/scan/complex/:id - Scan a single complex (synchronous)
router.post('/complex/:id', async (req, res) => {
  try {
    const complexId = parseInt(req.params.id);

    const complexCheck = await pool.query('SELECT id, name, city FROM complexes WHERE id = $1', [complexId]);
    if (complexCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    logger.info(`Starting single complex scan: ${complexCheck.rows[0].name}`);

    const result = await scanComplex(complexId);

    // Recalculate IAI for this complex
    const iai = await calculateIAI(complexId);

    res.json({
      scan_result: result,
      iai_score: iai ? iai.iai_score : null,
      message: `Scanned ${complexCheck.rows[0].name}: ${result.transactions} transactions, ${result.listings} listings found`
    });
  } catch (err) {
    logger.error('Error scanning complex', { error: err.message, complexId: req.params.id });
    res.status(500).json({ error: `Scan failed: ${err.message}` });
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
