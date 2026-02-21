const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

// Service loading with proper error handling
let deepEnrichmentService;
let scanPriorityService; 
let smartBatchService;
let neighborhoodBenchmarkService;
let onboardingPipeline;

try {
  deepEnrichmentService = require('../services/deepEnrichmentService');
} catch (err) {
  logger.warn('Deep enrichment service not available', { error: err.message });
}

try {
  scanPriorityService = require('../services/scanPriorityService');
} catch (err) {
  logger.warn('Scan priority service not available', { error: err.message });
}

try {
  smartBatchService = require('../services/smartBatchService');
} catch (err) {
  logger.warn('Smart batch service not available', { error: err.message });
}

try {
  neighborhoodBenchmarkService = require('../services/neighborhoodBenchmarkService');
} catch (err) {
  logger.warn('Neighborhood benchmark service not available', { error: err.message });
}

try {
  onboardingPipeline = require('../services/onboardingPipeline');
} catch (err) {
  logger.warn('Onboarding pipeline not available', { error: err.message });
}

// Existing routes - keep all functionality but fix syntax issues
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

// NEW v6.0: Targeted enrichment for specific data gaps (pricing, signatures, buildings)
router.post('/targeted', async (req, res) => {
  if (!deepEnrichmentService?.enrichTargeted) {
    return res.status(503).json({ error: 'Targeted enrichment not available (update deepEnrichmentService to v6.0)' });
  }
  try {
    const { target = 'pricing', limit = 50, city } = req.body;
    logger.info(`Starting targeted enrichment: target=${target}, limit=${limit}, city=${city || 'all'}`);
    const result = await deepEnrichmentService.enrichTargeted({ target, limit, city });
    res.json(result);
  } catch (err) {
    logger.error('Targeted enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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

router.get('/jobs', async (req, res) => {
  let jobs = [];
  if (deepEnrichmentService) {
    jobs = deepEnrichmentService.getAllBatchJobs();
  }
  if (smartBatchService) {
    jobs = [...jobs, ...smartBatchService.getAllSmartBatchJobs()];
  }
  res.json(jobs);
});

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

// Smart scan routes
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

// Neighborhood benchmark routes
router.post('/benchmark/:id', async (req, res) => {
  if (!neighborhoodBenchmarkService) return res.status(503).json({ error: 'Neighborhood benchmark service not available' });
  try {
    const complexId = parseInt(req.params.id);
    if (isNaN(complexId)) return res.status(400).json({ error: 'Invalid complex ID' });
    const result = await neighborhoodBenchmarkService.fetchNeighborhoodBenchmark(complexId);
    res.json(result);
  } catch (err) {
    logger.error('Benchmark failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/benchmark/batch', async (req, res) => {
  if (!neighborhoodBenchmarkService) return res.status(503).json({ error: 'Neighborhood benchmark service not available' });
  try {
    const { limit = 100, city, staleOnly = true } = req.body;
    const jobId = `benchmark_${Date.now()}`;
    // Run async
    setImmediate(async () => {
      try {
        await neighborhoodBenchmarkService.scanNeighborhoodBenchmarks({ limit, city, staleOnly });
      } catch (err) {
        logger.error('Benchmark batch failed', { error: err.message });
      }
    });
    res.json({ jobId, message: `Benchmark batch started`, limit, city: city || 'all' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/benchmark/status', async (req, res) => {
  try {
    const { rows } = await require('../db/pool').query(`
      SELECT
        COUNT(*) as total,
        COUNT(neighborhood_avg_sqm) as has_benchmark,
        COUNT(nadlan_neighborhood_avg_sqm) as has_nadlan,
        COUNT(madlan_neighborhood_avg_sqm) as has_madlan,
        COUNT(*) FILTER (WHERE benchmark_data_flag = true) as flagged,
        COUNT(*) FILTER (WHERE neighborhood_benchmark_source = 'city_avg_fallback') as fallback_only,
        ROUND(COUNT(neighborhood_avg_sqm)::numeric / COUNT(*) * 100, 1) as coverage_pct
      FROM complexes
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Onboarding pipeline routes
router.post('/onboarding/:id', async (req, res) => {
  if (!onboardingPipeline) return res.status(503).json({ error: 'Onboarding pipeline not available' });
  try {
    const complexId = parseInt(req.params.id);
    if (isNaN(complexId)) return res.status(400).json({ error: 'Invalid complex ID' });
    const { forceAll = false, skipPhases = [] } = req.body;
    // Run async and return job reference
    const jobId = `onboarding_${complexId}_${Date.now()}`;
    setImmediate(async () => {
      try {
        await onboardingPipeline.runOnboarding(complexId, { forceAll, skipPhases });
      } catch (err) {
        logger.error(`Onboarding failed for ${complexId}`, { error: err.message });
      }
    });
    res.json({ jobId, complexId, message: 'Onboarding pipeline started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/onboarding/batch', async (req, res) => {
  if (!onboardingPipeline) return res.status(503).json({ error: 'Onboarding pipeline not available' });
  try {
    const { limit = 50, forceAll = false, onlyPending = true } = req.body;
    const result = await onboardingPipeline.batchOnboarding({ limit, forceAll, onlyPending });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/onboarding/status', async (req, res) => {
  try {
    const { rows } = await require('../db/pool').query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE onboarding_status = 'completed') as completed,
        COUNT(*) FILTER (WHERE onboarding_status = 'partial') as partial,
        COUNT(*) FILTER (WHERE onboarding_status = 'pending' OR onboarding_status IS NULL) as pending,
        ROUND(COUNT(*) FILTER (WHERE onboarding_status = 'completed')::numeric / COUNT(*) * 100, 1) as completion_pct
      FROM complexes
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================================
// IAI RECALCULATION WITH NEIGHBORHOOD DATA
// ========================================================================

router.post('/recalculate-iai-all', async (req, res) => {
  try {
    const { limit = 100 } = req.body;
    const pool = require('../db/pool');
    const iaiCalculator = require('../services/iaiCalculator');
    
    logger.info(`Starting IAI recalculation for ${limit} complexes`);
    
    const { rows } = await pool.query('SELECT id FROM complexes ORDER BY iai_score ASC LIMIT $1', [limit]);
    
    let updated = 0;
    let errors = 0;
    
    for (const complex of rows) {
      try {
        await iaiCalculator.calculateIAI(complex.id);
        updated++;
      } catch (err) {
        errors++;
        logger.warn(`IAI calculation failed for complex ${complex.id}`, { error: err.message });
      }
    }
    
    res.json({ 
      message: `IAI recalculation completed`,
      updated, 
      errors,
      total: rows.length 
    });
  } catch (err) {
    logger.error('IAI recalculation batch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ========================================================================
// TIER 1 PRIORITY ENDPOINTS
// ========================================================================

router.post('/onboarding/tier1-priority', async (req, res) => {
  if (!onboardingPipeline) return res.status(503).json({ error: 'Onboarding pipeline not available' });
  try {
    // Get top IAI complexes that need onboarding
    const pool = require('../db/pool');
    const { rows } = await pool.query(`
      SELECT id, name, city, iai_score 
      FROM complexes 
      WHERE iai_score >= 60 
        AND (onboarding_status IS NULL OR onboarding_status = 'pending')
      ORDER BY iai_score DESC 
      LIMIT 20
    `);
    
    if (rows.length === 0) {
      return res.json({ message: 'No Tier 1 complexes need onboarding' });
    }
    
    // Run async batch onboarding
    const jobId = `tier1_priority_${Date.now()}`;
    setImmediate(async () => {
      for (const complex of rows) {
        try {
          await onboardingPipeline.runOnboarding(complex.id, { forceAll: false });
          logger.info(`Tier 1 onboarding completed for ${complex.name} (IAI: ${complex.iai_score})`);
        } catch (err) {
          logger.error(`Tier 1 onboarding failed for ${complex.name}`, { error: err.message });
        }
      }
    });
    
    res.json({
      jobId,
      message: 'Tier 1 priority onboarding started',
      complexes: rows.length,
      targets: rows.map(r => ({ id: r.id, name: r.name, city: r.city, iai: r.iai_score }))
    });
  } catch (err) {
    logger.error('Tier 1 priority onboarding failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ========================================================================
// v4.29.0: COVERAGE BOOST - Zero-cost data gap filling
// ========================================================================

/**
 * POST /api/enrichment/infer-signatures
 * Bulk infer signature_percent from project status and plan_stage.
 * Zero Perplexity API cost - pure logic inference.
 * 
 * Rules:
 *   construction/permit -> 100% (already built/building)
 *   approved + plan_stage contains approved keywords -> 85%
 *   deposited -> 70%
 *   pre_deposit with developer -> 55%
 *   developer_selected -> 40%
 *   declared -> 20%
 */
router.post('/infer-signatures', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { dryRun = false } = req.body;
    
    // Get complexes missing signature_percent
    const { rows } = await pool.query(`
      SELECT id, name, city, status, plan_stage, developer
      FROM complexes
      WHERE signature_percent IS NULL
      ORDER BY iai_score DESC NULLS LAST
    `);
    
    logger.info(`[INFER-SIG] Found ${rows.length} complexes without signature data`);
    
    const inferences = [];
    const statusRules = {
      'construction': { percent: 100, confidence: 'high', reason: 'project in construction phase' },
      'permit':       { percent: 100, confidence: 'high', reason: 'building permit issued' },
      'approved':     { percent: 85,  confidence: 'medium', reason: 'plan approved - implies >80% tenant agreement' },
      'deposited':    { percent: 70,  confidence: 'medium', reason: 'plan deposited - typically 60-80% agreement' },
      'pre_deposit':  { percent: 55,  confidence: 'low', reason: 'pre-deposit stage - developer working on signatures' },
      'developer_selected': { percent: 40, confidence: 'low', reason: 'developer selected - signature process beginning' },
      'submitted':    { percent: 50,  confidence: 'low', reason: 'plan submitted' },
      'declared':     { percent: 20,  confidence: 'low', reason: 'declared complex - early stage' },
      'planning':     { percent: 30,  confidence: 'low', reason: 'in planning' }
    };
    
    // Enhanced rules based on plan_stage keywords (Hebrew)
    const planStageBoosts = [
      { pattern: /תוקף|אושרה סופית|קיבלה תוקף/i, percent: 95, confidence: 'high', reason: 'plan has legal force (tokef)' },
      { pattern: /היתר|permit|בנייה/i, percent: 100, confidence: 'high', reason: 'building permit stage' },
      { pattern: /אושרה|מאושרת|approved/i, percent: 85, confidence: 'medium', reason: 'plan approved by committee' },
      { pattern: /הופקדה|deposited/i, percent: 70, confidence: 'medium', reason: 'plan deposited' },
      { pattern: /בביצוע|בבנייה|construction/i, percent: 100, confidence: 'high', reason: 'in construction' },
      { pattern: /נבחרה יזמ|developer.*selected/i, percent: 40, confidence: 'low', reason: 'developer selected' },
      { pattern: /מכרז דיירים/i, percent: 45, confidence: 'low', reason: 'tenant tender in progress' }
    ];
    
    for (const complex of rows) {
      let inference = null;
      
      // First check plan_stage for more specific keywords
      if (complex.plan_stage) {
        for (const boost of planStageBoosts) {
          if (boost.pattern.test(complex.plan_stage)) {
            inference = {
              id: complex.id,
              name: complex.name,
              city: complex.city,
              signature_percent: boost.percent,
              confidence: boost.confidence,
              reason: boost.reason,
              source: 'inferred_from_plan_stage',
              original_status: complex.status,
              original_plan_stage: complex.plan_stage
            };
            break;
          }
        }
      }
      
      // Fallback to status-based inference
      if (!inference && statusRules[complex.status]) {
        const rule = statusRules[complex.status];
        inference = {
          id: complex.id,
          name: complex.name,
          city: complex.city,
          signature_percent: rule.percent,
          confidence: rule.confidence,
          reason: rule.reason,
          source: 'inferred_from_status',
          original_status: complex.status,
          original_plan_stage: complex.plan_stage
        };
      }
      
      if (inference) {
        inferences.push(inference);
      }
    }
    
    // Apply updates unless dry run
    let applied = 0;
    if (!dryRun && inferences.length > 0) {
      for (const inf of inferences) {
        try {
          await pool.query(`
            UPDATE complexes 
            SET signature_percent = $1, 
                signature_source = $2,
                signature_confidence = $3
            WHERE id = $4 AND signature_percent IS NULL
          `, [inf.signature_percent, inf.source, inf.confidence, inf.id]);
          applied++;
        } catch (err) {
          logger.warn(`Failed to update signature for ${inf.name}: ${err.message}`);
        }
      }
      logger.info(`[INFER-SIG] Applied ${applied} signature inferences`);
    }
    
    // Summary by confidence level
    const summary = {
      high: inferences.filter(i => i.confidence === 'high').length,
      medium: inferences.filter(i => i.confidence === 'medium').length,
      low: inferences.filter(i => i.confidence === 'low').length
    };
    
    res.json({
      message: dryRun ? 'Dry run - no changes applied' : `Applied ${applied} signature inferences`,
      total_missing: rows.length,
      total_inferred: inferences.length,
      applied: dryRun ? 0 : applied,
      remaining_gaps: rows.length - inferences.length,
      by_confidence: summary,
      sample: inferences.slice(0, 20).map(i => ({
        name: i.name,
        city: i.city,
        inferred_percent: i.signature_percent,
        confidence: i.confidence,
        reason: i.reason,
        status: i.original_status,
        plan_stage: i.original_plan_stage
      }))
    });
  } catch (err) {
    logger.error('Signature inference failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enrichment/fill-city-averages
 * Fill city_avg_price_sqm from median of other complexes in same city.
 * Zero Perplexity API cost - uses existing DB data.
 */
router.post('/fill-city-averages', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { dryRun = false } = req.body;
    
    // Calculate city averages from existing data
    const { rows: cityAvgs } = await pool.query(`
      SELECT city, 
             ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY accurate_price_sqm)) as median_price,
             COUNT(*) as sample_size,
             ROUND(AVG(accurate_price_sqm)) as avg_price,
             MIN(accurate_price_sqm) as min_price,
             MAX(accurate_price_sqm) as max_price
      FROM complexes 
      WHERE accurate_price_sqm IS NOT NULL 
        AND accurate_price_sqm > 5000 
        AND accurate_price_sqm < 150000
      GROUP BY city 
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC
    `);
    
    logger.info(`[FILL-CITY-AVG] Calculated averages for ${cityAvgs.length} cities`);
    
    // Find complexes missing city_avg but we have data for their city
    const { rows: missing } = await pool.query(`
      SELECT id, name, city, accurate_price_sqm, city_avg_price_sqm, actual_premium
      FROM complexes
      WHERE city_avg_price_sqm IS NULL
      ORDER BY iai_score DESC NULLS LAST
    `);
    
    const cityMap = {};
    for (const ca of cityAvgs) {
      cityMap[ca.city] = ca;
    }
    
    let filled = 0;
    let premiumsCalculated = 0;
    const updates = [];
    
    for (const complex of missing) {
      const cityData = cityMap[complex.city];
      if (!cityData) continue;
      
      const entry = {
        id: complex.id,
        name: complex.name,
        city: complex.city,
        city_avg: parseInt(cityData.median_price),
        sample_size: parseInt(cityData.sample_size),
        has_own_price: !!complex.accurate_price_sqm
      };
      
      if (!dryRun) {
        const updateFields = ['city_avg_price_sqm = $1'];
        const params = [parseInt(cityData.median_price)];
        let idx = 2;
        
        // If we also have price_per_sqm, calculate actual_premium
        if (complex.accurate_price_sqm && !complex.actual_premium) {
          const premium = ((parseInt(cityData.median_price) - complex.accurate_price_sqm) / complex.accurate_price_sqm * 100).toFixed(2);
          updateFields.push(`actual_premium = $${idx}`);
          params.push(premium);
          idx++;
          entry.calculated_premium = parseFloat(premium);
          premiumsCalculated++;
        }
        
        params.push(complex.id);
        await pool.query(
          `UPDATE complexes SET ${updateFields.join(', ')} WHERE id = $${idx}`,
          params
        );
        filled++;
      }
      
      updates.push(entry);
    }
    
    res.json({
      message: dryRun ? 'Dry run - no changes applied' : `Filled ${filled} city averages, calculated ${premiumsCalculated} new premiums`,
      cities_with_data: cityAvgs.length,
      complexes_missing_city_avg: missing.length,
      filled: dryRun ? 0 : filled,
      premiums_calculated: dryRun ? 0 : premiumsCalculated,
      city_averages: cityAvgs.map(ca => ({
        city: ca.city,
        median_price_sqm: parseInt(ca.median_price),
        avg_price_sqm: parseInt(ca.avg_price),
        sample_size: parseInt(ca.sample_size)
      })),
      sample_updates: updates.slice(0, 15)
    });
  } catch (err) {
    logger.error('Fill city averages failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enrichment/boost-coverage
 * Master endpoint: runs all zero-cost coverage improvements in sequence.
 * 1. Infer signatures from status
 * 2. Fill city averages from DB
 * 3. Recalculate all IAI scores
 */
router.post('/boost-coverage', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const startTime = Date.now();
    const results = { phases: [] };
    
    // === PHASE 1: Infer signatures ===
    logger.info('[BOOST] Phase 1: Inferring signatures from status...');
    const sigResponse = await new Promise((resolve) => {
      const mockReq = { body: { dryRun: false } };
      const mockRes = { json: (data) => resolve(data), status: () => ({ json: (data) => resolve({ error: data }) }) };
      router.handle({ method: 'POST', url: '/infer-signatures', body: { dryRun: false }, ...mockReq }, mockRes, () => {});
    }).catch(() => null);
    
    // Direct execution instead of routing
    const { rows: sigMissing } = await pool.query(`
      SELECT id, status, plan_stage, developer FROM complexes WHERE signature_percent IS NULL
    `);
    
    const statusRules = {
      'construction': 100, 'permit': 100, 'approved': 85,
      'deposited': 70, 'pre_deposit': 55, 'developer_selected': 40,
      'submitted': 50, 'declared': 20, 'planning': 30
    };
    
    const planBoosts = [
      { pattern: /תוקף|אושרה סופית|קיבלה תוקף/i, pct: 95 },
      { pattern: /היתר|permit|בנייה/i, pct: 100 },
      { pattern: /אושרה|מאושרת|approved/i, pct: 85 },
      { pattern: /הופקדה|deposited/i, pct: 70 },
      { pattern: /בביצוע|בבנייה|construction/i, pct: 100 }
    ];
    
    let sigFilled = 0;
    for (const c of sigMissing) {
      let pct = null;
      let src = 'inferred_from_status';
      
      if (c.plan_stage) {
        for (const b of planBoosts) {
          if (b.pattern.test(c.plan_stage)) { pct = b.pct; src = 'inferred_from_plan_stage'; break; }
        }
      }
      if (pct === null && statusRules[c.status]) {
        pct = statusRules[c.status];
      }
      
      if (pct !== null) {
        await pool.query(
          'UPDATE complexes SET signature_percent = $1, signature_source = $2 WHERE id = $3 AND signature_percent IS NULL',
          [pct, src, c.id]
        );
        sigFilled++;
      }
    }
    results.phases.push({ phase: 'infer_signatures', missing: sigMissing.length, filled: sigFilled });
    
    // === PHASE 2: Fill city averages ===
    logger.info('[BOOST] Phase 2: Filling city averages...');
    const { rows: cityAvgs } = await pool.query(`
      SELECT city, ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY accurate_price_sqm)) as median_price,
             COUNT(*) as sample_size
      FROM complexes WHERE accurate_price_sqm IS NOT NULL AND accurate_price_sqm > 5000 AND accurate_price_sqm < 150000
      GROUP BY city HAVING COUNT(*) >= 2
    `);
    
    const cityMap = {};
    for (const ca of cityAvgs) { cityMap[ca.city] = parseInt(ca.median_price); }
    
    const { rows: avgMissing } = await pool.query(
      'SELECT id, city, accurate_price_sqm, actual_premium FROM complexes WHERE city_avg_price_sqm IS NULL'
    );
    
    let avgFilled = 0;
    let premCalc = 0;
    for (const c of avgMissing) {
      if (!cityMap[c.city]) continue;
      const updates = ['city_avg_price_sqm = $1'];
      const params = [cityMap[c.city]];
      let idx = 2;
      
      if (c.accurate_price_sqm && !c.actual_premium) {
        const prem = ((cityMap[c.city] - c.accurate_price_sqm) / c.accurate_price_sqm * 100).toFixed(2);
        updates.push(`actual_premium = $${idx}`);
        params.push(prem);
        idx++;
        premCalc++;
      }
      
      params.push(c.id);
      await pool.query(`UPDATE complexes SET ${updates.join(', ')} WHERE id = $${idx}`, params);
      avgFilled++;
    }
    results.phases.push({ phase: 'fill_city_averages', missing: avgMissing.length, filled: avgFilled, premiums_calculated: premCalc });
    
    // === PHASE 3: Recalculate IAI ===
    logger.info('[BOOST] Phase 3: Recalculating IAI scores...');
    const iaiCalculator = require('../services/iaiCalculator');
    const { rows: allIds } = await pool.query('SELECT id FROM complexes');
    let iaiUpdated = 0;
    let iaiErrors = 0;
    for (const c of allIds) {
      try { await iaiCalculator.calculateIAI(c.id); iaiUpdated++; }
      catch { iaiErrors++; }
    }
    results.phases.push({ phase: 'recalculate_iai', updated: iaiUpdated, errors: iaiErrors });
    
    // === FINAL: Get new coverage ===
    const { rows: finalCov } = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(actual_premium) as premium, COUNT(signature_percent) as sig,
        COUNT(accurate_price_sqm) as price, COUNT(city_avg_price_sqm) as city_avg,
        COUNT(num_buildings) as buildings
      FROM complexes
    `);
    const fc = finalCov[0];
    const total = parseInt(fc.total);
    const pct = (n) => Math.round(parseInt(n) / total * 100);
    
    results.final_coverage = {
      actual_premium: { count: parseInt(fc.premium), percent: pct(fc.premium) },
      signature_percent: { count: parseInt(fc.sig), percent: pct(fc.sig) },
      price_per_sqm: { count: parseInt(fc.price), percent: pct(fc.price) },
      city_avg: { count: parseInt(fc.city_avg), percent: pct(fc.city_avg) },
      num_buildings: { count: parseInt(fc.buildings), percent: pct(fc.buildings) }
    };
    results.elapsed_ms = Date.now() - startTime;
    
    logger.info(`[BOOST] Coverage boost completed in ${results.elapsed_ms}ms`);
    res.json(results);
  } catch (err) {
    logger.error('Coverage boost failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ========================================================================
// EMERGENCY ACTIVATION ENDPOINT
// ========================================================================

router.post('/activate-quantum-v4-8', async (req, res) => {
  logger.info('QUANTUM v4.8.0 Neighborhood Benchmark System - ACTIVATION STARTING');
  
  try {
    const pool = require('../db/pool');
    
    // Check if migration ran
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'complexes' AND column_name = 'neighborhood_avg_sqm'
    `);
    
    if (rows.length === 0) {
      return res.status(400).json({ 
        error: 'Database migration required first',
        action: 'Run the SQL migration in Railway Database Console',
        migration_needed: [
          'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS neighborhood_avg_sqm NUMERIC(10,2);',
          'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS nadlan_neighborhood_avg_sqm NUMERIC(10,2);',
          '-- Plus 9 more columns (see migration file)'
        ]
      });
    }
    
    logger.info('Database migration detected - proceeding with activation');
    
    // Trigger benchmark calculation for top complexes
    if (neighborhoodBenchmarkService) {
      setTimeout(async () => {
        try {
          logger.info('Starting auto-benchmark for top 50 complexes');
          await neighborhoodBenchmarkService.scanNeighborhoodBenchmarks({ limit: 50, staleOnly: true });
        } catch (err) {
          logger.error('Auto-benchmark failed', { error: err.message });
        }
      }, 2000);
    }
    
    // Trigger IAI recalculation 
    setTimeout(async () => {
      try {
        const iaiCalculator = require('../services/iaiCalculator');
        const { rows: complexes } = await pool.query('SELECT id FROM complexes ORDER BY iai_score DESC LIMIT 50');
        for (const complex of complexes) {
          await iaiCalculator.calculateIAI(complex.id);
        }
        logger.info('IAI recalculation completed for top 50 complexes');
      } catch (err) {
        logger.error('Auto-IAI recalculation failed', { error: err.message });
      }
    }, 5000);
    
    res.json({
      status: 'activated',
      version: '4.8.0',
      system: 'QUANTUM Neighborhood Benchmark System',
      message: 'QUANTUM v4.8.0 successfully activated!',
      features_enabled: [
        'Hyper-local benchmarks (300m radius)',
        'Dual-source validation (nadlan + madlan)', 
        'Neighborhood vs city premium calculation',
        'Automatic onboarding pipeline',
        'Enhanced IAI calculation'
      ],
      expected_results: [
        'IAI scores become unique (no more 68 defaults)',
        'Neighborhood benchmarks replace city averages',
        'Tier 1 complexes show accurate rankings',
        'Investment decisions based on hyper-local data'
      ],
      processing: {
        benchmark_calculation: 'Started for top 50 complexes',
        iai_recalculation: 'Queued for 2-3 minutes',
        estimated_completion: '30-45 minutes for full system'
      },
      endpoints_activated: [
        'POST /api/enrichment/benchmark/batch',
        'POST /api/enrichment/recalculate-iai-all',
        'POST /api/enrichment/onboarding/tier1-priority',
        'GET /api/enrichment/benchmark/status'
      ]
    });
    
  } catch (err) {
    logger.error('QUANTUM v4.8.0 activation failed', { error: err.message });
    res.status(500).json({ 
      error: 'Activation failed', 
      message: err.message,
      recovery: 'Check database migration and service availability'
    });
  }
});

module.exports = router;
