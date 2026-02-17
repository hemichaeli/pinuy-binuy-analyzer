const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let deepEnrichmentService;
try {
  deepEnrichmentService = require('../services/deepEnrichmentService');
} catch (err) {
  logger.warn('Deep enrichment service not available', { error: err.message });
}

// Enrich single complex (synchronous)
router.post('/complex/:id', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const complexId = parseInt(req.params.id);
    if (isNaN(complexId)) return res.status(400).json({ error: 'Invalid complex ID' });
    logger.info(`Starting deep enrichment for complex ${complexId}`);
    const result = await deepEnrichmentService.deepEnrichComplex(complexId);
    res.json(result);
  } catch (err) {
    logger.error('Deep enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Start async batch enrichment - returns immediately with job ID
router.post('/batch', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const { limit = 20, city, minIai = 0, staleOnly = true } = req.body;
    logger.info(`Starting async batch enrichment: limit=${limit}, city=${city || 'all'}, minIai=${minIai}`);
    const result = await deepEnrichmentService.enrichAll({ limit, city, minIai, staleOnly });
    res.json(result);
  } catch (err) {
    logger.error('Batch enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get batch job status
router.get('/batch/:jobId', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  const status = deepEnrichmentService.getBatchStatus(req.params.jobId);
  if (!status) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: req.params.jobId,
    status: status.status,
    progress: `${status.enriched}/${status.total}`,
    percent: status.total > 0 ? Math.round((status.enriched / status.total) * 100) : 0,
    currentComplex: status.currentComplex,
    totalFieldsUpdated: status.totalFieldsUpdated,
    errors: status.errors,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    details: status.status === 'completed' ? status.details : undefined
  });
});

// List all batch jobs
router.get('/jobs', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  res.json(deepEnrichmentService.getAllBatchJobs());
});

// Quick enrich top IAI complexes
router.post('/top', async (req, res) => {
  if (!deepEnrichmentService) return res.status(503).json({ error: 'Deep enrichment service not available' });
  try {
    const result = await deepEnrichmentService.enrichAll({ limit: 10, minIai: 60, staleOnly: false });
    res.json(result);
  } catch (err) {
    logger.error('Top enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Coverage status
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
