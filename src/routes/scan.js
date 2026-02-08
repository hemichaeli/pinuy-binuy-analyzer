const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { scanComplex, scanAll } = require('../services/perplexityService');
const { calculateIAI, calculateAllIAI } = require('../services/iaiCalculator');
const { calculateSSI, calculateAllSSI } = require('../services/ssiCalculator');
const nadlanScraper = require('../services/nadlanScraper');
const { calculateAllBenchmarks, calculateBenchmark } = require('../services/benchmarkService');
const yad2Scraper = require('../services/yad2Scraper');
const mavatScraper = require('../services/mavatScraper');

// POST /api/scan/run - Trigger a Perplexity scan
router.post('/run', async (req, res) => {
  try {
    const { type, city, status, limit, complexId, staleOnly } = req.body;
    const scanType = type || 'perplexity';

    const running = await pool.query(
      "SELECT id FROM scan_logs WHERE status = 'running' AND started_at > NOW() - INTERVAL '1 hour'"
    );
    if (running.rows.length > 0) {
      return res.status(409).json({ error: 'A scan is already running', scan_id: running.rows[0].id });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ($1, 'running') RETURNING *`, [scanType]
    );
    const scanId = scanLog.rows[0].id;

    res.json({
      message: 'Scan triggered successfully', scan_id: scanId, type: scanType,
      note: complexId
        ? `Scanning single complex ${complexId}`
        : `Scanning complexes${city ? ` in ${city}` : ''}${limit ? ` (limit: ${limit})` : ''}`
    });

    (async () => {
      try {
        let results;
        if (complexId) {
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
          results = await scanAll({
            city: city || null, status: status || null,
            limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false
          });
        }

        logger.info('Calculating SSI scores...');
        try { await calculateAllSSI(); } catch (ssiErr) {
          logger.warn('SSI calculation failed during scan', { error: ssiErr.message });
        }

        logger.info('Recalculating IAI scores...');
        await calculateAllIAI();

        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_transactions = $2, new_listings = $3, summary = $4
          WHERE id = $5`,
          [results.scanned, results.totalNewTransactions, results.totalNewListings,
            `Perplexity scan: ${results.succeeded}/${results.total} succeeded, ` +
            `${results.totalNewTransactions} new tx, ${results.totalNewListings} new listings. ` +
            `${results.failed} failed. SSI + IAI recalculated.`, scanId]
        );
      } catch (err) {
        logger.error(`Scan ${scanId} failed`, { error: err.message });
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    logger.error('Error triggering scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// POST /api/scan/nadlan
router.post('/nadlan', async (req, res) => {
  try {
    const { city, limit, complexId } = req.body;
    if (complexId) {
      const result = await nadlanScraper.scanComplex(parseInt(complexId));
      return res.json({ message: 'Nadlan scan complete', result });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('nadlan', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'Nadlan.gov.il scan triggered', scan_id: scanId });

    (async () => {
      try {
        const results = await nadlanScraper.scanAll({
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: true
        });
        await calculateAllIAI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_transactions = $2, summary = $3 WHERE id = $4`,
          [results.total, results.totalNew || 0,
            `Nadlan: ${results.succeeded}/${results.total} ok, ${results.totalNew || 0} new tx`, scanId]
        );
      } catch (err) {
        logger.error(`Nadlan scan ${scanId} failed`, { error: err.message });
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    logger.error('Error triggering nadlan scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger nadlan scan' });
  }
});

// POST /api/scan/yad2
router.post('/yad2', async (req, res) => {
  try {
    const { city, limit, complexId } = req.body;
    if (complexId) {
      const result = await yad2Scraper.scanComplex(parseInt(complexId));
      return res.json({ message: 'yad2 scan complete', result });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('yad2', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'yad2 listing scan triggered', scan_id: scanId });

    (async () => {
      try {
        const results = await yad2Scraper.scanAll({
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: true
        });
        await calculateAllSSI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_listings = $2, updated_listings = $3, summary = $4 WHERE id = $5`,
          [results.total, results.totalNew, results.totalUpdated,
            `yad2: ${results.succeeded}/${results.total} ok, ${results.totalNew} new, ${results.totalUpdated} updated`, scanId]
        );
      } catch (err) {
        logger.error(`yad2 scan ${scanId} failed`, { error: err.message });
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    logger.error('Error triggering yad2 scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger yad2 scan' });
  }
});

// POST /api/scan/mavat - Trigger planning authority status scan
router.post('/mavat', async (req, res) => {
  try {
    const { city, limit, complexId } = req.body;
    if (complexId) {
      const result = await mavatScraper.scanComplex(parseInt(complexId));
      return res.json({ message: 'mavat scan complete', result });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('mavat', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'mavat planning scan triggered', scan_id: scanId });

    (async () => {
      try {
        const results = await mavatScraper.scanAll({
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: true
        });
        // Recalculate IAI after potential status changes
        await calculateAllIAI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.statusChanges,
            `mavat: ${results.succeeded}/${results.total} ok, ${results.statusChanges} status changes, ${results.committeeUpdates} committee updates`, scanId]
        );
      } catch (err) {
        logger.error(`mavat scan ${scanId} failed`, { error: err.message });
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    logger.error('Error triggering mavat scan', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger mavat scan' });
  }
});

// POST /api/scan/benchmark
router.post('/benchmark', async (req, res) => {
  try {
    const { city, limit, complexId, force } = req.body;
    if (complexId) {
      const result = await calculateBenchmark(parseInt(complexId));
      if (!result) return res.json({ message: 'No benchmark data available', complex_id: complexId });
      return res.json({ message: 'Benchmark calculated', result });
    }

    res.json({ message: 'Benchmark calculation triggered' });
    (async () => {
      try {
        await calculateAllBenchmarks({ city: city || null, limit: limit ? parseInt(limit) : null, force: !!force });
        await calculateAllIAI();
      } catch (err) {
        logger.error('Benchmark batch failed', { error: err.message });
      }
    })();
  } catch (err) {
    logger.error('Error triggering benchmark', { error: err.message });
    res.status(500).json({ error: 'Failed to trigger benchmark calculation' });
  }
});

// POST /api/scan/complex/:id - Full single complex scan
router.post('/complex/:id', async (req, res) => {
  try {
    const complexId = parseInt(req.params.id);
    const complexCheck = await pool.query('SELECT id, name, city FROM complexes WHERE id = $1', [complexId]);
    if (complexCheck.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const result = await scanComplex(complexId);

    const listings = await pool.query('SELECT id FROM listings WHERE complex_id = $1 AND is_active = TRUE', [complexId]);
    const ssiResults = [];
    for (const listing of listings.rows) {
      try { const ssi = await calculateSSI(listing.id); if (ssi) ssiResults.push(ssi); }
      catch (e) { logger.warn(`SSI calc failed for listing ${listing.id}`); }
    }
    const iai = await calculateIAI(complexId);

    res.json({
      scan_result: result,
      iai_score: iai ? iai.iai_score : null,
      ssi_results: ssiResults,
      message: `Scanned ${complexCheck.rows[0].name}: ${result.transactions} tx, ${result.listings} listings, ${ssiResults.length} SSI`
    });
  } catch (err) {
    logger.error('Error scanning complex', { error: err.message });
    res.status(500).json({ error: `Scan failed: ${err.message}` });
  }
});

// POST /api/scan/ssi
router.post('/ssi', async (req, res) => {
  try {
    const results = await calculateAllSSI();
    res.json({ message: 'SSI recalculation complete', results });
  } catch (err) {
    res.status(500).json({ error: `SSI recalculation failed: ${err.message}` });
  }
});

// GET /api/scan/results
router.get('/results', async (req, res) => {
  try {
    const limitVal = Math.min(parseInt(req.query.limit) || 10, 50);
    const results = await pool.query('SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT $1', [limitVal]);
    res.json({ scans: results.rows, total: results.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scan results' });
  }
});

// GET /api/scan/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM scan_logs WHERE id = $1', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scan' });
  }
});

module.exports = router;
