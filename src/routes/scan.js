const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
// ========== DIRECT JSON APIs ==========
const directApi = require('../services/directApiService');
const { calculateIAI, calculateAllIAI } = require('../services/iaiCalculator');
const { calculateSSI, calculateAllSSI } = require('../services/ssiCalculator');
const nadlanScraper = require('../services/nadlanScraper');
const { calculateAllBenchmarks, calculateBenchmark } = require('../services/benchmarkService');
const yad2Scraper = require('../services/yad2Scraper');
const mavatScraper = require('../services/mavatScraper');
const notificationService = require('../services/notificationService');
// ========== DUAL AI (Anthropic + Perplexity) ==========
const { dualScanComplex, dualScanAll, isClaudeConfigured, isPerplexityConfigured, getAvailableModels, PERPLEXITY_MODEL_SCAN, CLAUDE_MODEL } = require('../services/dualAiService');

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

function getDiscoveryService() {
  try {
    return require('../services/discoveryService');
  } catch (e) {
    logger.warn('Discovery service not available', { error: e.message });
    return null;
  }
}

// ============================================================
// CRITICAL SYSTEM FIXES - Priority 1 Issues
// ============================================================

// POST /api/scan/fix-stuck - Fix stuck scans
router.post('/fix-stuck', async (req, res) => {
  try {
    const { scanId, force } = req.body;
    
    if (scanId) {
      const result = await pool.query(`
        UPDATE scan_logs 
        SET status = 'failed', 
            completed_at = NOW(),
            errors = 'Marked as failed - scan was stuck'
        WHERE id = $1 AND status = 'running'
        RETURNING *
      `, [scanId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Scan not found or not in running state' });
      }
      
      return res.json({ 
        message: `Scan ${scanId} marked as failed`,
        fixed_scan: result.rows[0]
      });
    }
    
    const stuckScans = await pool.query(`
      UPDATE scan_logs 
      SET status = 'failed', 
          completed_at = NOW(),
          errors = 'Auto-failed - scan stuck for > 2 hours'
      WHERE status = 'running' 
        AND started_at < NOW() - INTERVAL '2 hours'
      RETURNING *
    `);
    
    res.json({ 
      message: `Fixed ${stuckScans.rows.length} stuck scans`,
      fixed_scans: stuckScans.rows
    });
  } catch (err) {
    logger.error('Fix stuck scans failed', { error: err.message });
    res.status(500).json({ error: `Failed to fix stuck scans: ${err.message}` });
  }
});

// GET /api/scan/scheduler/status - Debug scheduler status
router.get('/scheduler/status', async (req, res) => {
  try {
    const totalScans = await pool.query('SELECT COUNT(*) as count FROM scan_logs');
    const runningScans = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE status = 'running'");
    const recentScans = await pool.query(`
      SELECT COUNT(*) as count 
      FROM scan_logs 
      WHERE started_at > NOW() - INTERVAL '24 hours'
    `);
    const lastScan = await pool.query(`
      SELECT * FROM scan_logs 
      ORDER BY started_at DESC 
      LIMIT 1
    `);
    
    res.json({
      totalScans: parseInt(totalScans.rows[0].count),
      runningScans: parseInt(runningScans.rows[0].count),
      recentScans: parseInt(recentScans.rows[0].count),
      lastScan: lastScan.rows[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Scheduler status failed', { error: err.message });
    res.status(500).json({ error: `Failed to get scheduler status: ${err.message}` });
  }
});

// GET /api/scan/health - System health check
router.get('/health', async (req, res) => {
  try {
    const health = {
      database: 'unknown',
      scans: 'unknown', 
      notifications: 'unknown',
      ai_services: {
        claude: isClaudeConfigured() ? 'configured' : 'not-configured',
        perplexity: isPerplexityConfigured() ? 'configured' : 'not-configured'
      }
    };
    
    try {
      await pool.query('SELECT 1');
      health.database = 'healthy';
    } catch (e) {
      health.database = 'error';
    }
    
    try {
      const stuck = await pool.query(`
        SELECT COUNT(*) as count 
        FROM scan_logs 
        WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
      `);
      health.scans = stuck.rows[0].count > 0 ? 'stuck-scans-detected' : 'healthy';
    } catch (e) {
      health.scans = 'error';
    }
    
    try {
      health.notifications = notificationService.isConfigured() ? 'configured' : 'not-configured';
    } catch (e) {
      health.notifications = 'error';
    }
    
    const isHealthy = health.database === 'healthy' && 
                      !health.scans.includes('stuck') && 
                      !health.scans.includes('error');
    
    res.status(isHealthy ? 200 : 500).json({
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      ...health
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================
// POST /api/scan/ai - DUAL AI SCAN
// ============================================================
router.post('/ai', async (req, res) => {
  try {
    if (!isPerplexityConfigured() && !isClaudeConfigured()) {
      return res.status(500).json({ error: 'No AI configured. Set PERPLEXITY_API_KEY and/or ANTHROPIC_API_KEY.' });
    }

    const { city, limit, complexId, staleOnly, model } = req.body;
    const perplexityModel = model || PERPLEXITY_MODEL_SCAN;

    if (complexId) {
      try {
        const result = await dualScanComplex(parseInt(complexId), { perplexityModel });
        try { await calculateSSI(parseInt(complexId)); } catch (e) {}
        try { await calculateIAI(parseInt(complexId)); } catch (e) {}
        return res.json({ 
          message: 'Dual AI scan complete', result,
          engines: {
            perplexity: isPerplexityConfigured() ? `active (${perplexityModel})` : 'off',
            claude: isClaudeConfigured() ? `active (${CLAUDE_MODEL})` : 'off'
          }
        });
      } catch (scanErr) {
        logger.error('Dual AI single scan failed', { error: scanErr.message });
        return res.status(500).json({ error: scanErr.message });
      }
    }

    const running = await pool.query(
      "SELECT id FROM scan_logs WHERE status = 'running' AND scan_type LIKE 'dual_ai%' AND started_at > NOW() - INTERVAL '2 hours'"
    );
    if (running.rows.length > 0) {
      return res.status(409).json({ error: 'A dual AI scan is already running', scan_id: running.rows[0].id });
    }

    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, status) VALUES ('dual_ai_research', 'running') RETURNING *`
    );
    const scanId = scanLog.rows[0].id;

    res.json({
      message: 'Dual AI Research scan triggered', scan_id: scanId,
      engines: {
        perplexity: isPerplexityConfigured() ? `active (${perplexityModel})` : 'off',
        claude: isClaudeConfigured() ? `active (${CLAUDE_MODEL})` : 'off'
      },
      mode: 'dual-ai-research'
    });

    (async () => {
      try {
        const results = await dualScanAll({
          city: city || null, limit: limit ? parseInt(limit) : 20,
          staleOnly: staleOnly !== false, perplexityModel
        });
        try { await calculateAllSSI(); } catch (e) { logger.warn('SSI recalc failed', { error: e.message }); }
        try { await calculateAllIAI(); } catch (e) { logger.warn('IAI recalc failed', { error: e.message }); }
        await pool.query(
          `UPDATE scan_logs SET status = 'completed', completed_at = NOW(),
            complexes_scanned = $1, new_transactions = $2, new_listings = $3, summary = $4 WHERE id = $5`,
          [results.scanned, results.totalNewTx, results.totalNewListings,
            `Dual AI: ${results.succeeded}/${results.total} ok, ${results.totalNewTx} tx, ${results.totalNewListings} listings`, scanId]
        );
        if ((results.totalNewTx > 0 || results.totalNewListings > 0) && notificationService.isConfigured()) {
          await notificationService.sendPendingAlerts();
        }
      } catch (err) {
        logger.error('Dual AI scan failed', { error: err.message });
        await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]);
      }
    })();
  } catch (err) {
    logger.error('Error triggering dual AI scan', { error: err.message });
    res.status(500).json({ error: `Failed to trigger dual AI scan: ${err.message}` });
  }
});

// GET /api/scan/ai/status
router.get('/ai/status', (req, res) => {
  const models = getAvailableModels();
  res.json({
    perplexity: { configured: isPerplexityConfigured(), scan_model: PERPLEXITY_MODEL_SCAN, available_models: models.perplexity.models.filter(m => m.id !== 'council') },
    claude: { configured: isClaudeConfigured(), model: CLAUDE_MODEL },
    dual_mode: isClaudeConfigured() && isPerplexityConfigured(),
    mode: (isClaudeConfigured() && isPerplexityConfigured()) ? 'dual-ai' : isClaudeConfigured() ? 'claude-only' : isPerplexityConfigured() ? 'perplexity-only' : 'none'
  });
});

// POST /api/scan/discovery
router.post('/discovery', async (req, res) => {
  try {
    const discovery = getDiscoveryService();
    if (!discovery) return res.status(501).json({ error: 'Discovery service not available' });
    const { region, city, limit } = req.body;

    if (city) {
      const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('discovery_city', 'running') RETURNING *`);
      const scanId = scanLog.rows[0].id;
      res.json({ message: `Discovery scan triggered for ${city}`, scan_id: scanId, target_regions: discovery.TARGET_REGIONS, min_units: discovery.MIN_HOUSING_UNITS });
      (async () => {
        try {
          const result = await discovery.discoverInCity(city);
          const newCount = result?.discovered_complexes?.length || 0;
          let added = 0;
          if (result?.discovered_complexes) {
            for (const complex of result.discovered_complexes) {
              if (complex.existing_units && complex.existing_units < discovery.MIN_HOUSING_UNITS) continue;
              const newId = await discovery.addNewComplex(complex, city, 'discovery-manual');
              if (newId) added++;
            }
          }
          await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, summary = $2 WHERE id = $3`,
            [newCount, `Discovery ${city}: found ${newCount}, added ${added} new complexes`, scanId]);
          if (added > 0) { await calculateAllIAI(); if (notificationService.isConfigured()) await notificationService.sendPendingAlerts(); }
        } catch (err) {
          logger.error(`Discovery failed for ${city}`, { error: err.message });
          await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]);
        }
      })();
      return;
    }

    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('discovery_full', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    const targetCities = region && discovery.TARGET_REGIONS[region] ? discovery.TARGET_REGIONS[region] : discovery.ALL_TARGET_CITIES;
    res.json({ message: region ? `Discovery scan triggered for ${region}` : 'Full discovery scan triggered', scan_id: scanId, cities_to_scan: targetCities.length, region: region || 'all', min_units: discovery.MIN_HOUSING_UNITS });
    (async () => {
      try {
        const results = await discovery.discoverAll({ region: region || null, limit: limit ? parseInt(limit) : null });
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, summary = $2 WHERE id = $3`,
          [results.cities_scanned, `Discovery: ${results.cities_scanned} cities, found ${results.total_discovered}, added ${results.new_added} new`, scanId]);
        if (results.new_added > 0) { await calculateAllIAI(); if (notificationService.isConfigured()) await notificationService.sendPendingAlerts(); }
      } catch (err) {
        logger.error('Discovery scan failed', { error: err.message });
        await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]);
      }
    })();
  } catch (err) {
    logger.error('Error triggering discovery', { error: err.message });
    res.status(500).json({ error: `Failed to trigger discovery: ${err.message}` });
  }
});

// GET /api/scan/discovery/status
router.get('/discovery/status', (req, res) => {
  try {
    const discovery = getDiscoveryService();
    if (!discovery) return res.json({ available: false, error: 'Discovery service not loaded' });
    res.json({ available: true, min_housing_units: discovery.MIN_HOUSING_UNITS, target_regions: discovery.TARGET_REGIONS, total_target_cities: discovery.ALL_TARGET_CITIES.length, direct_api_mode: true });
  } catch (err) { res.json({ available: false, error: err.message }); }
});

// GET /api/scan/discovery/recent
router.get('/discovery/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await pool.query(`SELECT c.*, (SELECT COUNT(*) FROM alerts a WHERE a.complex_id = c.id AND a.alert_type = 'new_complex') as discovery_alerts FROM complexes c WHERE c.discovery_source IS NOT NULL ORDER BY c.created_at DESC LIMIT $1`, [limit]);
    res.json({ discovered_complexes: result.rows, total: result.rows.length });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch discovered complexes' }); }
});

// POST /api/scan/unified
router.post('/unified', async (req, res) => {
  try {
    const orchestrator = getClaudeOrchestrator();
    if (!orchestrator) return res.status(501).json({ error: 'Claude orchestrator not available - check logs' });
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
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('unified_ai', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'Unified AI scan triggered (Claude)', scan_id: scanId, claude_configured: orchestrator.isClaudeConfigured() });
    (async () => {
      try {
        const results = await orchestrator.scanAllUnified({ city: city || null, limit: limit ? parseInt(limit) : 20, staleOnly: staleOnly !== false });
        await calculateAllSSI(); await calculateAllIAI();
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.changes, `Unified AI: ${results.succeeded}/${results.total} ok, ${results.changes} changes`, scanId]);
        if (results.changes > 0 && notificationService.isConfigured()) await notificationService.sendPendingAlerts();
      } catch (err) {
        logger.error('Unified scan failed', { error: err.message, stack: err.stack });
        await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]);
      }
    })();
  } catch (err) {
    logger.error('Error triggering unified scan', { error: err.message, stack: err.stack });
    res.status(500).json({ error: `Failed to trigger unified scan: ${err.message}` });
  }
});

// GET /api/scan/unified/status
router.get('/unified/status', (req, res) => {
  try {
    const orchestrator = getClaudeOrchestrator();
    res.json({ available: !!orchestrator, claude_configured: orchestrator?.isClaudeConfigured() || false, direct_api_mode: true, anthropic_key: process.env.ANTHROPIC_API_KEY ? '(set)' : '(not set)', claude_key: process.env.CLAUDE_API_KEY ? '(set)' : '(not set)' });
  } catch (e) { res.json({ available: false, error: e.message }); }
});

// POST /api/scan/run - Direct API scan
router.post('/run', async (req, res) => {
  try {
    const { type, city, status, limit, complexId, staleOnly } = req.body;
    const scanType = type || 'direct_api';
    const running = await pool.query("SELECT id FROM scan_logs WHERE status = 'running' AND started_at > NOW() - INTERVAL '1 hour'");
    if (running.rows.length > 0) return res.status(409).json({ error: 'A scan is already running', scan_id: running.rows[0].id });
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ($1, 'running') RETURNING *`, [scanType]);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'Direct API scan triggered', scan_id: scanId, type: scanType, mode: 'direct_json_api' });
    (async () => {
      try {
        let results;
        if (complexId) {
          const result = await directApi.scanComplex(parseInt(complexId));
          results = { total: 1, scanned: 1, succeeded: result.status === 'success' ? 1 : 0, failed: result.status === 'error' ? 1 : 0, totalNewTransactions: result.transactions || 0, totalNewListings: result.listings || 0, details: [result] };
        } else {
          results = await directApi.scanAll({ city: city || null, status: status || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false });
        }
        try { await calculateAllSSI(); } catch (e) { logger.warn('SSI failed', { error: e.message }); }
        await calculateAllIAI();
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, new_transactions = $2, new_listings = $3, summary = $4 WHERE id = $5`,
          [results.scanned, results.totalNewTransactions, results.totalNewListings, `DirectAPI: ${results.succeeded}/${results.total} ok, ${results.totalNewTransactions} tx, ${results.totalNewListings} listings`, scanId]);
      } catch (err) {
        logger.error(`Scan ${scanId} failed`, { error: err.message });
        await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]);
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
    if (complexId) { const result = await nadlanScraper.scanComplex(parseInt(complexId)); return res.json({ message: 'Nadlan scan complete', result }); }
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('nadlan', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'Nadlan.gov.il scan triggered', scan_id: scanId });
    (async () => {
      try {
        const results = await nadlanScraper.scanAll({ city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false });
        await calculateAllIAI();
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, new_transactions = $2, summary = $3 WHERE id = $4`,
          [results.total, results.totalNew || 0, `Nadlan: ${results.succeeded}/${results.total} ok, ${results.totalNew || 0} new tx`, scanId]);
      } catch (err) { await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]); }
    })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger nadlan scan' }); }
});

// POST /api/scan/yad2
router.post('/yad2', async (req, res) => {
  try {
    const { city, limit, complexId, staleOnly } = req.body;
    if (complexId) { const result = await yad2Scraper.scanComplex(parseInt(complexId)); return res.json({ message: 'yad2 scan complete', result }); }
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('yad2', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'yad2 listing scan triggered', scan_id: scanId });
    (async () => {
      try {
        const results = await yad2Scraper.scanAll({ city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false });
        await calculateAllSSI();
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, new_listings = $2, updated_listings = $3, summary = $4 WHERE id = $5`,
          [results.total, results.totalNew, results.totalUpdated, `yad2: ${results.succeeded}/${results.total} ok, ${results.totalNew} new, ${results.totalUpdated} updated`, scanId]);
      } catch (err) { await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]); }
    })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger yad2 scan' }); }
});

// POST /api/scan/mavat
router.post('/mavat', async (req, res) => {
  try {
    const { city, limit, complexId, staleOnly } = req.body;
    if (complexId) {
      try { const result = await mavatScraper.scanComplex(parseInt(complexId)); return res.json({ message: 'mavat scan complete', result }); }
      catch (scanErr) { logger.error('Mavat single scan error', { error: scanErr.message }); return res.status(500).json({ error: scanErr.message }); }
    }
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('mavat', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'mavat planning scan triggered', scan_id: scanId });
    (async () => {
      try {
        const results = await mavatScraper.scanAll({ city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false });
        await calculateAllIAI();
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.statusChanges, `mavat: ${results.succeeded}/${results.total} ok, ${results.statusChanges} status changes`, scanId]);
      } catch (err) { await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]); }
    })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger mavat scan' }); }
});

// POST /api/scan/committee
router.post('/committee', async (req, res) => {
  try {
    const tracker = getCommitteeTracker();
    if (!tracker) return res.status(501).json({ error: 'Committee tracker not available' });
    const { city, limit, complexId, staleOnly } = req.body;
    if (complexId) { const result = await tracker.trackComplex(parseInt(complexId)); return res.json({ message: 'Committee tracking complete', result }); }
    const scanLog = await pool.query(`INSERT INTO scan_logs (scan_type, status) VALUES ('committee', 'running') RETURNING *`);
    const scanId = scanLog.rows[0].id;
    res.json({ message: 'Committee approval tracking triggered', scan_id: scanId });
    (async () => {
      try {
        const results = await tracker.trackAll({ city: city || null, limit: limit ? parseInt(limit) : null, staleOnly: staleOnly !== false });
        await pool.query(`UPDATE scan_logs SET status = 'completed', completed_at = NOW(), complexes_scanned = $1, status_changes = $2, summary = $3 WHERE id = $4`,
          [results.total, results.newApprovals, `Committee: ${results.scanned}/${results.total}, ${results.newApprovals} approvals`, scanId]);
        if (results.newApprovals > 0 && notificationService.isConfigured()) await notificationService.sendPendingAlerts();
      } catch (err) { await pool.query(`UPDATE scan_logs SET status = 'failed', completed_at = NOW(), errors = $1 WHERE id = $2`, [err.message, scanId]); }
    })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger committee scan' }); }
});

// GET /api/scan/committee/summary
router.get('/committee/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL) as local_approved,
        COUNT(*) FILTER (WHERE district_committee_date IS NOT NULL) as district_approved,
        COUNT(*) FILTER (WHERE status = 'deposited' AND local_committee_date IS NULL) as awaiting_local,
        COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL AND district_committee_date IS NULL) as awaiting_district
      FROM complexes WHERE status NOT IN ('unknown', 'construction')`);
    res.json({ localApproved: parseInt(result.rows[0].local_approved), districtApproved: parseInt(result.rows[0].district_approved), awaitingLocal: parseInt(result.rows[0].awaiting_local), awaitingDistrict: parseInt(result.rows[0].awaiting_district) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch committee summary' }); }
});

// POST /api/scan/weekly
router.post('/weekly', async (req, res) => {
  try {
    const { runWeeklyScan } = require('../jobs/weeklyScanner');
    const { forceAll, includeDiscovery } = req.body;
    res.json({ message: 'Weekly scan triggered', forceAll: !!forceAll, includeDiscovery: includeDiscovery !== false });
    (async () => { try { await runWeeklyScan({ forceAll: !!forceAll, includeDiscovery: includeDiscovery !== false }); } catch (err) { logger.error('Weekly scan failed', { error: err.message }); } })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger weekly scan' }); }
});

// POST /api/scan/benchmark
router.post('/benchmark', async (req, res) => {
  try {
    const { city, limit, complexId, force } = req.body;
    if (complexId) { const result = await calculateBenchmark(parseInt(complexId)); return res.json({ message: 'Benchmark calculated', result }); }
    res.json({ message: 'Benchmark calculation triggered' });
    (async () => { try { await calculateAllBenchmarks({ city, limit: limit ? parseInt(limit) : null, force: !!force }); await calculateAllIAI(); } catch (err) { logger.error('Benchmark failed', { error: err.message }); } })();
  } catch (err) { res.status(500).json({ error: 'Failed to trigger benchmark' }); }
});

// POST /api/scan/notifications
router.post('/notifications', async (req, res) => {
  try {
    if (!notificationService.isConfigured()) return res.json({ message: 'Notifications not configured' });
    const { type } = req.body;
    if (type === 'digest') { const result = await notificationService.sendWeeklyDigest(null); return res.json({ message: 'Weekly digest sent', result }); }
    const result = await notificationService.sendPendingAlerts();
    res.json({ message: 'Alerts sent', result });
  } catch (err) { res.status(500).json({ error: 'Failed to send notifications' }); }
});

// GET /api/scan/notifications/status
router.get('/notifications/status', (req, res) => {
  try {
    res.json({ configured: notificationService.isConfigured(), provider: notificationService.getProvider(), recipients: notificationService.NOTIFICATION_EMAILS, status: 'operational' });
  } catch (err) {
    logger.error('Notification status failed', { error: err.message });
    res.status(500).json({ configured: false, error: err.message, status: 'error' });
  }
});

// POST /api/scan/complex/:id
router.post('/complex/:id', async (req, res) => {
  try {
    const complexId = parseInt(req.params.id);
    const complexCheck = await pool.query('SELECT id, name, city FROM complexes WHERE id = $1', [complexId]);
    if (complexCheck.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });
    const result = await directApi.scanComplex(complexId);
    const iai = await calculateIAI(complexId);
    res.json({ scan_result: result, iai_score: iai?.iai_score || null, message: `Scanned ${complexCheck.rows[0].name}`, mode: 'direct_json_api' });
  } catch (err) { res.status(500).json({ error: `Scan failed: ${err.message}` }); }
});

// POST /api/scan/ssi
router.post('/ssi', async (req, res) => {
  try { const results = await calculateAllSSI(); res.json({ message: 'SSI recalculation complete', results }); }
  catch (err) { res.status(500).json({ error: `SSI failed: ${err.message}` }); }
});

// GET /api/scan/results
router.get('/results', async (req, res) => {
  try {
    const limitVal = Math.min(parseInt(req.query.limit) || 10, 50);
    const results = await pool.query('SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT $1', [limitVal]);
    res.json({ scans: results.rows, total: results.rows.length });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch scan results' }); }
});

// GET /api/scan/status - Scan system overview
router.get('/status', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as count FROM scan_logs');
    const running = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE status = 'running'");
    const completed = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE status = 'completed'");
    const failed = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE status = 'failed'");
    const recent24h = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE started_at > NOW() - INTERVAL '24 hours'");
    const recent7d = await pool.query("SELECT COUNT(*) as count FROM scan_logs WHERE started_at > NOW() - INTERVAL '7 days'");
    const lastScan = await pool.query('SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT 1');
    const lastSuccess = await pool.query("SELECT * FROM scan_logs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1");
    res.json({
      totalScans: parseInt(total.rows[0].count), running: parseInt(running.rows[0].count),
      completed: parseInt(completed.rows[0].count), failed: parseInt(failed.rows[0].count),
      last24h: parseInt(recent24h.rows[0].count), last7d: parseInt(recent7d.rows[0].count),
      lastScan: lastScan.rows[0] || null, lastSuccess: lastSuccess.rows[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Scan status failed', { error: err.message });
    res.status(500).json({ error: `Failed to get scan status: ${err.message}` });
  }
});

// GET /api/scan/morning-report - Daily morning briefing
router.get('/morning-report', async (req, res) => {
  try {
    const recentScans = await pool.query(`
      SELECT id, scan_type, status, started_at, completed_at, 
             complexes_scanned, new_transactions, new_listings, updated_listings, 
             status_changes, errors, summary
      FROM scan_logs WHERE started_at > NOW() - INTERVAL '24 hours' ORDER BY started_at DESC
    `);

    const complexStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE iai_score IS NOT NULL AND iai_score > 0) as with_iai,
        COUNT(*) FILTER (WHERE iai_score >= 70) as high_iai,
        ROUND(AVG(NULLIF(iai_score, 0))::numeric, 1) as avg_iai
      FROM complexes
    `);
    const listingStats = await pool.query(`
      SELECT 
        COUNT(*) as total_listings,
        COUNT(*) FILTER (WHERE ssi_score IS NOT NULL AND ssi_score > 0) as with_ssi,
        COUNT(*) FILTER (WHERE ssi_score >= 60) as high_ssi,
        ROUND(AVG(NULLIF(ssi_score, 0))::numeric, 1) as avg_ssi
      FROM listings
      WHERE is_active = true OR created_at > NOW() - INTERVAL '30 days'
    `);

    const newTransactions = await pool.query("SELECT COUNT(*) as count FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours'");
    const newListings = await pool.query("SELECT COUNT(*) as count FROM listings WHERE created_at > NOW() - INTERVAL '24 hours'");
    const newAlerts = await pool.query("SELECT COUNT(*) as count FROM alerts WHERE created_at > NOW() - INTERVAL '24 hours'");

    // Auto-fix stuck scans
    const fixResult = await pool.query(`
      UPDATE scan_logs SET status = 'failed', completed_at = NOW(),
        errors = 'Auto-failed by morning report - scan stuck > 2 hours'
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
    `);

    const stats = complexStats.rows[0];
    const lstats = listingStats.rows[0];
    res.json({
      report_date: new Date().toISOString(),
      system_health: 'operational',
      scans_last_24h: recentScans.rows.length,
      scans: recentScans.rows,
      portfolio: {
        total_complexes: parseInt(stats.total),
        with_iai: parseInt(stats.with_iai),
        high_iai_opportunities: parseInt(stats.high_iai),
        avg_iai: parseFloat(stats.avg_iai) || 0,
        total_listings: parseInt(lstats.total_listings),
        with_ssi: parseInt(lstats.with_ssi),
        high_ssi_stressed: parseInt(lstats.high_ssi),
        avg_ssi: parseFloat(lstats.avg_ssi) || 0
      },
      new_data_24h: {
        transactions: parseInt(newTransactions.rows[0].count),
        listings: parseInt(newListings.rows[0].count),
        alerts: parseInt(newAlerts.rows[0].count)
      },
      maintenance: { stuck_scans_auto_fixed: fixResult.rowCount }
    });
  } catch (err) {
    logger.error('Morning report failed', { error: err.message });
    res.status(500).json({ error: `Morning report failed: ${err.message}` });
  }
});

// GET /api/scan/:id - MUST BE LAST (catch-all for numeric scan IDs)
router.get('/:id', async (req, res) => {
  try {
    const scanId = parseInt(req.params.id);
    if (isNaN(scanId)) return res.status(400).json({ error: `Unknown scan route: ${req.params.id}. Valid routes: /status, /health, /morning-report, /results, /scheduler/status` });
    const result = await pool.query('SELECT * FROM scan_logs WHERE id = $1', [scanId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Scan not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch scan' }); }
});

module.exports = router;