const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let deepEnrichmentService;
try {
  deepEnrichmentService = require('../services/deepEnrichmentService');
} catch (err) {
  logger.warn('Deep enrichment service not available', { error: err.message });
}

let scanPriorityService;
try {
  scanPriorityService = require('../services/scanPriorityService');
} catch (err) {
  logger.warn('Scan priority service not available', { error: err.message });
}

let smartBatchService;
try {
  smartBatchService = require('../services/smartBatchService');
} catch (err) {
  logger.warn('Smart batch service not available', { error: err.message });
}

// POST /api/enrichment/complex/:id?mode=standard|full|fast|turbo
router.post('/complex/:id', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const complexId = parseInt(req.params.id);
    if (isNaN(complexId)) return res.status(400).json({ error: 'Invalid complex ID' });
    const mode = req.body.mode || req.query.mode || 'standard';
    logger.info(`Starting deep enrichment for complex ${complexId} [mode: ${mode}]`);
    const result = await deepEnrichmentService.deepEnrichComplex(complexId, { mode });
    res.json(result);
  } catch (err) {
    logger.error('Deep enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/enrichment/batch {limit, city, minIai, staleOnly, mode}
router.post('/batch', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const { limit = 20, city, minIai = 0, staleOnly = true, mode = 'standard' } = req.body;
    logger.info(`Starting async batch enrichment: limit=${limit}, city=${city || 'all'}, minIai=${minIai}, mode=${mode}`);
    const result = await deepEnrichmentService.enrichAll({ limit, city, minIai, staleOnly, mode });
    res.json(result);
  } catch (err) {
    logger.error('Batch enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/enrichment/batch/:jobId - check both deep and smart batch jobs
router.get('/batch/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  let status = null;
  
  if (deepEnrichmentService) {
    status = deepEnrichmentService.getBatchStatus(jobId);
  }
  if (!status && smartBatchService) {
    status = smartBatchService.getSmartBatchStatus(jobId);
  }
  
  if (!status) return res.status(404).json({ error: 'Job not found' });
  
  res.json({
    jobId,
    status: status.status,
    progress: `${status.enriched}/${status.total}`,
    percent: status.total > 0 ? Math.round((status.enriched / status.total) * 100) : 0,
    currentComplex: status.currentComplex,
    mode: status.mode || 'standard',
    engine: status.engine,
    totalFieldsUpdated: status.totalFieldsUpdated,
    errors: status.errors,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    details: status.status === 'completed' ? status.details : undefined
  });
});

// GET /api/enrichment/jobs - list all batch jobs (deep + smart)
router.get('/jobs', async (req, res) => {
  let jobs = [];
  if (deepEnrichmentService) {
    jobs = deepEnrichmentService.getAllBatchJobs();
  }
  if (smartBatchService) {
    jobs = smartBatchService.getAllSmartBatchJobs();
  }
  res.json(jobs);
});

// POST /api/enrichment/top - Quick enrich top IAI complexes
router.post('/top', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const result = await deepEnrichmentService.enrichAll({ limit: 10, minIai: 60, staleOnly: false, mode: 'full' });
    res.json(result);
  } catch (err) {
    logger.error('Top enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SMART SCAN & TIER SYSTEM
// ============================================================

// GET /api/enrichment/priorities - Calculate PSS for all complexes, show tiers
router.get('/priorities', async (req, res) => {
  if (!scanPriorityService) return res.status(503).json({ error: 'Scan priority service not available' });
  try {
    const priorities = await scanPriorityService.calculateAllPriorities();
    res.json(priorities);
  } catch (err) {
    logger.error('Priority calculation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/enrichment/priorities/top50 - Just the top 50 for quick review
router.get('/priorities/top50', async (req, res) => {
  if (!scanPriorityService) return res.status(503).json({ error: 'Scan priority service not available' });
  try {
    const priorities = await scanPriorityService.calculateAllPriorities();
    res.json({
      total_complexes: priorities.total,
      top_50: priorities.top_50,
      tier_summary: {
        hot: priorities.tiers.hot.count,
        active: priorities.tiers.active.count,
        dormant: priorities.tiers.dormant.count
      },
      cost_to_scan_top50: {
        mode: 'full',
        cost_per_complex: 1.23,
        total: Math.round(Math.min(priorities.top_50.length, 50) * 1.23 * 100) / 100,
        estimated_hours: Math.round(Math.min(priorities.top_50.length, 50) * 5 / 60 * 10) / 10
      }
    });
  } catch (err) {
    logger.error('Top 50 priority failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/enrichment/smart-scan - Tiered enrichment by PSS score
// Body: { tier: 1|2|3, limit: number }
// Tier 1 (HOT) = FULL mode, Tier 2 (ACTIVE) = STANDARD, Tier 3 (DORMANT) = FAST
router.post('/smart-scan', async (req, res) => {
  if (!smartBatchService || !scanPriorityService) {
    return res.status(503).json({ error: 'Smart scan services not available' });
  }
  try {
    const { tier = 1, limit = 50 } = req.body;
    
    const priorities = await scanPriorityService.calculateAllPriorities();
    
    const tierNum = parseInt(tier);
    const tierKey = tierNum === 1 ? 'hot' : tierNum === 2 ? 'active' : 'dormant';
    const modeMap = { 1: 'full', 2: 'standard', 3: 'fast' };
    const mode = modeMap[tierNum] || 'standard';
    const tierLabel = tierNum === 1 ? 'HOT' : tierNum === 2 ? 'ACTIVE' : 'DORMANT';
    
    const tierData = priorities.tiers[tierKey];
    const ids = tierData.complexes.slice(0, limit).map(c => c.id);
    
    if (ids.length === 0) {
      return res.json({ status: 'empty', message: `No complexes in tier ${tierNum} (${tierLabel})` });
    }
    
    const job = await smartBatchService.enrichByIds(ids, mode);
    
    const costPerComplex = tierNum === 1 ? 1.23 : tierNum === 2 ? 0.26 : 0.15;
    
    res.json({
      status: 'started',
      tier: tierNum,
      tier_label: tierLabel,
      mode,
      count: ids.length,
      ...job,
      cost_estimate: {
        per_complex: costPerComplex,
        total: Math.round(ids.length * costPerComplex * 100) / 100,
        estimated_hours: Math.round(ids.length * (tierNum === 1 ? 5 : tierNum === 2 ? 1.5 : 0.75) / 60 * 10) / 10
      },
      top_complexes: tierData.complexes.slice(0, 10).map(c => ({
        id: c.id, name: c.name, city: c.city, 
        pss: c.pss, iai: c.iai_score,
        premium_gap: c.details?.premium_gap,
        plan_stage: c.plan_stage,
        alpha: c.components.alpha,
        velocity: c.components.velocity,
        shield: c.components.shield,
        stealth: c.components.stealth,
        stress: c.components.stress
      }))
    });
  } catch (err) {
    logger.error('Smart scan failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/enrichment/status - Coverage status
router.get('/status', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM complexes');
    const total = parseInt(totalResult.rows[0].total);

    const coverage = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(neighborhood) as has_neighborhood,
        COUNT(address) as has_precise_address,
        COUNT(num_buildings) as has_num_buildings,
        COUNT(actual_premium) as has_actual_premium,
        COUNT(accurate_price_sqm) as has_price_sqm,
        COUNT(city_avg_price_sqm) as has_city_avg,
        COUNT(price_trend) as has_price_trend,
        COUNT(developer_status) as has_developer_status,
        COUNT(developer_risk_level) as has_developer_risk,
        COUNT(news_sentiment) as has_news,
        COUNT(last_news_check) as has_news_check,
        COUNT(price_last_updated) as has_price_update,
        COUNT(signature_percent) as has_signature,
        COUNT(plan_stage) as has_plan_stage,
        COUNT(CASE WHEN has_enforcement_cases = true THEN 1 END) as enforcement_flagged,
        COUNT(CASE WHEN is_receivership = true THEN 1 END) as receivership_flagged,
        COUNT(CASE WHEN has_bankruptcy_proceedings = true THEN 1 END) as bankruptcy_flagged
      FROM complexes
    `);

    const c = coverage.rows[0];
    const pct = (n) => total > 0 ? Math.round((parseInt(n) / total) * 100) : 0;

    res.json({
      total_complexes: total,
      coverage: {
        neighborhood: { count: parseInt(c.has_neighborhood), percent: pct(c.has_neighborhood) },
        precise_address: { count: parseInt(c.has_precise_address), percent: pct(c.has_precise_address) },
        num_buildings: { count: parseInt(c.has_num_buildings), percent: pct(c.has_num_buildings) },
        actual_premium: { count: parseInt(c.has_actual_premium), percent: pct(c.has_actual_premium) },
        price_per_sqm: { count: parseInt(c.has_price_sqm), percent: pct(c.has_price_sqm) },
        city_avg: { count: parseInt(c.has_city_avg), percent: pct(c.has_city_avg) },
        price_trend: { count: parseInt(c.has_price_trend), percent: pct(c.has_price_trend) },
        developer_status: { count: parseInt(c.has_developer_status), percent: pct(c.has_developer_status) },
        developer_risk: { count: parseInt(c.has_developer_risk), percent: pct(c.has_developer_risk) },
        news_sentiment: { count: parseInt(c.has_news), percent: pct(c.has_news) },
        signature_percent: { count: parseInt(c.has_signature), percent: pct(c.has_signature) },
        plan_stage: { count: parseInt(c.has_plan_stage), percent: pct(c.has_plan_stage) }
      },
      distress_flags: {
        enforcement: parseInt(c.enforcement_flagged),
        receivership: parseInt(c.receivership_flagged),
        bankruptcy: parseInt(c.bankruptcy_flagged)
      },
      enriched_recently: parseInt(c.has_price_update)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
