/**
 * Mavat Building Routes
 * 
 * API endpoints for building-level enrichment from mavat.iplan.gov.il
 * Uses Gemini + Google Search Grounding
 * 
 * Routes:
 *   GET  /api/mavat/buildings/:complexId  - Get building details for a complex
 *   POST /api/mavat/enrich/:complexId     - Trigger enrichment for single complex
 *   POST /api/mavat/batch                 - Batch enrich multiple complexes
 *   GET  /api/mavat/stats                 - Building data coverage stats
 *   GET  /api/mavat/missing-plans         - Complexes missing plan_numbers
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// Lazy-load service to prevent startup failures
function getService() {
  return require('../services/mavatBuildingService');
}

/**
 * GET /buildings/:complexId - Get building details
 */
router.get('/buildings/:complexId', async (req, res) => {
  try {
    const service = getService();
    const data = await service.getBuildingDetails(parseInt(req.params.complexId));
    
    if (!data) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    res.json({
      status: 'ok',
      ...data,
      summary: {
        total_existing: data.buildings.reduce((sum, b) => sum + (b.existing_units || 0), 0),
        total_planned: data.buildings.reduce((sum, b) => sum + (b.planned_units || 0), 0),
        buildings_with_data: data.buildings.filter(b => b.existing_units || b.planned_units).length
      }
    });
  } catch (err) {
    logger.error('[MavatRoutes] buildings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /enrich/:complexId - Enrich single complex
 */
router.post('/enrich/:complexId', async (req, res) => {
  try {
    const service = getService();
    const result = await service.enrichComplex(parseInt(req.params.complexId));
    res.json(result);
  } catch (err) {
    logger.error('[MavatRoutes] enrich error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /batch - Batch enrich complexes
 * Body: { city?, limit?, staleOnly? }
 */
router.post('/batch', async (req, res) => {
  try {
    const service = getService();
    const { city, limit = 10, staleOnly = true } = req.body || {};
    
    // Return immediately, run in background
    res.json({ 
      status: 'started', 
      message: `Batch mavat building scan started (limit: ${limit}, city: ${city || 'all'})`,
      note: 'Check /api/mavat/stats for progress'
    });

    // Run in background
    service.batchEnrich({ city, limit, staleOnly }).then(result => {
      logger.info(`[MavatRoutes] Batch complete: ${JSON.stringify({
        succeeded: result.succeeded,
        failed: result.failed,
        buildings_found: result.buildings_found
      })}`);
    }).catch(err => {
      logger.error('[MavatRoutes] Batch error:', err.message);
    });
  } catch (err) {
    logger.error('[MavatRoutes] batch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stats - Building data coverage statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const service = getService();
    await service.ensureTable();

    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM complexes) as total_complexes,
        (SELECT COUNT(*) FROM complexes WHERE num_buildings IS NOT NULL AND num_buildings > 0) as has_buildings_count,
        (SELECT COUNT(*) FROM complexes WHERE plan_number IS NOT NULL) as has_plan_number,
        (SELECT COUNT(*) FROM complexes WHERE last_building_scan IS NOT NULL) as scanned,
        (SELECT COUNT(DISTINCT complex_id) FROM building_details) as has_building_details,
        (SELECT COUNT(*) FROM building_details) as total_building_records,
        (SELECT COUNT(*) FROM building_details WHERE existing_units IS NOT NULL) as buildings_with_existing,
        (SELECT COUNT(*) FROM building_details WHERE planned_units IS NOT NULL) as buildings_with_planned
    `);

    const s = stats.rows[0];
    
    // Top complexes with building details
    const detailed = await pool.query(`
      SELECT c.id, c.name, c.city, c.plan_number, c.num_buildings,
             COUNT(bd.id) as building_records,
             SUM(bd.existing_units) as total_existing,
             SUM(bd.planned_units) as total_planned,
             c.last_building_scan
      FROM complexes c
      JOIN building_details bd ON bd.complex_id = c.id
      GROUP BY c.id, c.name, c.city, c.plan_number, c.num_buildings, c.last_building_scan
      ORDER BY c.last_building_scan DESC
      LIMIT 20
    `);

    res.json({
      status: 'ok',
      coverage: {
        total_complexes: parseInt(s.total_complexes),
        has_buildings_count: parseInt(s.has_buildings_count),
        has_plan_number: parseInt(s.has_plan_number),
        scanned_for_buildings: parseInt(s.scanned),
        has_building_details: parseInt(s.has_building_details),
        total_building_records: parseInt(s.total_building_records),
        buildings_with_existing_units: parseInt(s.buildings_with_existing),
        buildings_with_planned_units: parseInt(s.buildings_with_planned),
        coverage_percent: s.has_buildings_count > 0 
          ? Math.round((parseInt(s.has_building_details) / parseInt(s.has_buildings_count)) * 100) 
          : 0
      },
      recent_scans: detailed.rows
    });
  } catch (err) {
    logger.error('[MavatRoutes] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /missing-plans - Complexes missing plan_numbers (enrichment targets)
 */
router.get('/missing-plans', async (req, res) => {
  try {
    const { city, status: planStatus, limit = 50 } = req.query;

    let query = `SELECT id, name, city, status, plan_stage, developer, 
                        num_buildings, existing_units, planned_units, neighborhood
                 FROM complexes 
                 WHERE plan_number IS NULL 
                 AND status NOT IN ('unknown')`;
    const params = [];
    let idx = 1;

    if (city) {
      query += ` AND city = $${idx}`;
      params.push(city);
      idx++;
    }

    if (planStatus) {
      query += ` AND status = $${idx}`;
      params.push(planStatus);
      idx++;
    }

    query += ` ORDER BY CASE status
      WHEN 'deposited' THEN 1 WHEN 'approved' THEN 2
      WHEN 'pre_deposit' THEN 3 ELSE 4 END,
      planned_units DESC NULLS LAST
      LIMIT $${idx}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      status: 'ok',
      total_missing: result.rows.length,
      complexes: result.rows
    });
  } catch (err) {
    logger.error('[MavatRoutes] missing-plans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
