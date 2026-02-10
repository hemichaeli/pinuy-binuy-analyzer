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
const notificationService = require('../services/notificationService');

// Lazy load services with better error reporting
function getCommitteeTracker() {
  try {
    return require('../services/committeeTracker');
  } catch (e) {
    logger.warn('Committee tracker not available', { error: e.message });
    return null;
  }
}

function getClaudeOrchestrator() {
  try {
    return require('../services/claudeOrchestrator');
  } catch (e) {
    logger.error('Claude orchestrator failed to load', { error: e.message, stack: e.stack });
    return null;
  }
}

// POST /api/scan/unified - Unified Perplexity + Claude scan (Phase 4.3)
router.post('/unified', async (req, res) => {
  try {
    const orchestrator = getClaudeOrchestrator();
    if (!orchestrator) {
      return res.status(501).json({ error: 'Claude orchestrator not available - check logs' });
    }

    const { city, limit, complexId, staleOnly } = req.body;

    if (complexId) {
      try {
        const result = await orchestrator.scanComplexUnified(parseInt(complexId));
        return res.json({ message: 'Unified scan complete', result });
      } catch (scanErr) {
        logger.error('Unified single scan failed', { error: scanErr.message, stack: scanErr.stack });
        return res.status(500).json({ error: scanErr.message });
      }
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('unified_ai', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;

    res.json({
      message: 'Unified AI scan triggered (Perplexity + Claude)',
      scan_id: scanId,
      note: 'Claude will validate and consolidate data from multiple sources',
      claude_configured: orchestrator.isClaudeConfigured()
    });

    (async () => {
      try {
        logger.info('Starting unified scan', { limit, city, staleOnly });
        const results = await orchestrator.scanAllUnified({
          city: city || null,
          limit: limit ? parseInt(limit) : 20,
          staleOnly: staleOnly !== false
        });

        logger.info('Unified scan complete, recalculating scores', { results: results.total });
        await calculateAllSSI();
        await calculateAllIAI();

        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.changes,
            `Unified AI: ${results.succeeded}/${results.total} ok, ${results.changes} changes, sources: Perplexity+Claude`, scanId]
        );

        if (results.changes > 0 && notificationService.isConfigured()) {
          await notificationService.sendPendingAlerts();
        }
      } catch (err) {
        logger.error('Unified scan failed', { error: err.message, stack: err.stack });
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    logger.error('Error triggering unified scan', { error: err.message, stack: err.stack });
    res.status(500).json({ error: `Failed to trigger unified scan: ${err.message}` });
  }
});

// GET /api/scan/unified/status - Check Claude orchestrator status
router.get('/unified/status', (req, res) => {
  try {
    const orchestrator = getClaudeOrchestrator();
    res.json({
      available: !!orchestrator,
      claude_configured: orchestrator?.isClaudeConfigured() || false,
      perplexity_configured: !!process.env.PERPLEXITY_API_KEY,
      anthropic_key: process.env.ANTHROPIC_API_KEY ? '(set)' : '(not set)',
      claude_key: process.env.CLAUDE_API_KEY ? '(set)' : '(not set)'
    });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

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

        try { await calculateAllSSI(); } catch (e) { logger.warn('SSI failed', { error: e.message }); }
        await calculateAllIAI();

        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_transactions = $2, new_listings = $3, summary = $4
          WHERE id = $5`,
          [results.scanned, results.totalNewTransactions, results.totalNewListings,
            `Perplexity scan: ${results.succeeded}/${results.total} succeeded, ` +
            `${results.totalNewTransactions} new tx, ${results.totalNewListings} new listings.`, scanId]
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
    const { city, limit, complexId, staleOnly } = req.body;
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
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false
        });
        await calculateAllIAI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_transactions = $2, summary = $3 WHERE id = $4`,
          [results.total, results.totalNew || 0,
            `Nadlan: ${results.succeeded}/${results.total} ok, ${results.totalNew || 0} new tx`, scanId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger nadlan scan' });
  }
});

// POST /api/scan/yad2
router.post('/yad2', async (req, res) => {
  try {
    const { city, limit, complexId, staleOnly } = req.body;
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
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false
        });
        await calculateAllSSI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_listings = $2, updated_listings = $3, summary = $4 WHERE id = $5`,
          [results.total, results.totalNew, results.totalUpdated,
            `yad2: ${results.succeeded}/${results.total} ok, ${results.totalNew} new, ${results.totalUpdated} updated`, scanId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger yad2 scan' });
  }
});

// POST /api/scan/mavat
router.post('/mavat', async (req, res) => {
  try {
    const { city, limit, complexId, staleOnly } = req.body;
    if (complexId) {
      try {
        const result = await mavatScraper.scanComplex(parseInt(complexId));
        return res.json({ message: 'mavat scan complete', result });
      } catch (scanErr) {
        logger.error('Mavat single scan error', { error: scanErr.message });
        return res.status(500).json({ error: scanErr.message });
      }
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('mavat', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'mavat planning scan triggered', scan_id: scanId });

    (async () => {
      try {
        const results = await mavatScraper.scanAll({
          city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false
        });
        await calculateAllIAI();
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.statusChanges,
            `mavat: ${results.succeeded}/${results.total} ok, ${results.statusChanges} status changes`, scanId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger mavat scan' });
  }
});

// POST /api/scan/committee
router.post('/committee', async (req, res) => {
  try {
    const tracker = getCommitteeTracker();
    if (!tracker) {
      return res.status(501).json({ error: 'Committee tracker not available' });
    }

    const { city, limit, complexId, staleOnly } = req.body;

    if (complexId) {
      const result = await tracker.trackComplex(parseInt(complexId));
      return res.json({ message: 'Committee tracking complete', result });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('committee', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;

    res.json({
      message: 'Committee approval tracking triggered',
      scan_id: scanId
    });

    (async () => {
      try {
        const results = await tracker.trackAll({
          city: city || null,
          limit: limit ? parseInt(limit) : null,
          staleOnly: staleOnly !== false
        });

        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.newApprovals,
            `Committee: ${results.scanned}/${results.total}, ${results.newApprovals} approvals`, scanId]
        );

        if (results.newApprovals > 0 && notificationService.isConfigured()) {
          await notificationService.sendPendingAlerts();
        }
      } catch (err) {
        await pool.query(
          `UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`,
          [err.message, scanId]
        );
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger committee scan' });
  }
});

// GET /api/scan/committee/summary
router.get('/committee/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL) as local_approved,
        COUNT(*) FILTER (WHERE district_committee_date IS NOT NULL) as district_approved,
        COUNT(*) FILTER (WHERE status = 'deposited' AND local_committee_date IS NULL) as awaiting_local,
        COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL AND district_committee_date IS NULL) as awaiting_district
      FROM complexes
      WHERE status NOT IN ('unknown', 'construction')
    `);
    res.json({
      localApproved: parseInt(result.rows[0].local_approved),
      districtApproved: parseInt(result.rows[0].district_approved),
      awaitingLocal: parseInt(result.rows[0].awaiting_local),
      awaitingDistrict: parseInt(result.rows[0].awaiting_district)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch committee summary' });
  }
});

// POST /api/scan/weekly
router.post('/weekly', async (req, res) => {
  try {
    const { runWeeklyScan } = require('../jobs/weeklyScanner');
    const { forceAll } = req.body;
    res.json({
      message: 'Weekly scan triggered',
      forceAll: !!forceAll
    });
    (async () => {
      try {
        await runWeeklyScan({ forceAll: !!forceAll });
      } catch (err) {
        logger.error('Weekly scan failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger weekly scan' });
  }
});

// POST /api/scan/benchmark
router.post('/benchmark', async (req, res) => {
  try {
    const { city, limit, complexId, force } = req.body;
    if (complexId) {
      const result = await calculateBenchmark(parseInt(complexId));
      return res.json({ message: 'Benchmark calculated', result });
    }
    res.json({ message: 'Benchmark calculation triggered' });
    (async () => {
      try {
        await calculateAllBenchmarks({ city, limit: limit ? parseInt(limit) : null, force: !!force });
        await calculateAllIAI();
      } catch (err) { logger.error('Benchmark failed', { error: err.message }); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger benchmark' });
  }
});

// POST /api/scan/notifications
router.post('/notifications', async (req, res) => {
  try {
    if (!notificationService.isConfigured()) {
      return res.json({ message: 'Notifications not configured' });
    }
    const { type } = req.body;
    if (type === 'digest') {
      const result = await notificationService.sendWeeklyDigest(null);
      return res.json({ message: 'Weekly digest sent', result });
    }
    const result = await notificationService.sendPendingAlerts();
    res.json({ message: 'Alerts sent', result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// GET /api/scan/notifications/status
router.get('/notifications/status', (req, res) => {
  res.json({
    configured: notificationService.isConfigured(),
    provider: notificationService.getProvider(),
    recipients: notificationService.NOTIFICATION_EMAILS
  });
});

// POST /api/scan/complex/:id
router.post('/complex/:id', async (req, res) => {
  try {
    const complexId = parseInt(req.params.id);
    const complexCheck = await pool.query('SELECT id, name, city FROM complexes WHERE id = $1', [complexId]);
    if (complexCheck.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const result = await scanComplex(complexId);
    const iai = await calculateIAI(complexId);

    res.json({
      scan_result: result,
      iai_score: iai?.iai_score || null,
      message: `Scanned ${complexCheck.rows[0].name}`
    });
  } catch (err) {
    res.status(500).json({ error: `Scan failed: ${err.message}` });
  }
});

// POST /api/scan/ssi
router.post('/ssi', async (req, res) => {
  try {
    const results = await calculateAllSSI();
    res.json({ message: 'SSI recalculation complete', results });
  } catch (err) {
    res.status(500).json({ error: `SSI failed: ${err.message}` });
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
