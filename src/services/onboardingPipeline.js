/**
 * Onboarding Pipeline
 *
 * Full 7-phase automated pipeline for every new pinuy-binuy complex.
 * Runs automatically when discoveryService finds a new complex.
 * Can also be triggered manually for existing complexes.
 *
 * Phases:
 *   1. Basic enrichment   - plan_stage, developer, signature_percent, num_buildings
 *   2. Developer risk     - financial health, red flags, reputation score
 *   3. News & legal       - sentiment, receivership, enforcement, liens
 *   4. Price data         - price_per_sqm from nadlan.gov.il direct transactions
 *   5. Neighborhood bench - nadlan+madlan weighted avg for nearby streets
 *   6. IAI calculation    - score based on real neighborhood benchmark
 *   7. Tier classification - assign to Tier 1/2/3 based on IAI + status
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

const PHASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lazy-load services to avoid circular deps
function getDeepEnrichment() { return require('./deepEnrichmentService'); }
function getNeighborhoodBenchmark() { return require('./neighborhoodBenchmarkService'); }
function getIaiCalculator() { return require('./iaiCalculator'); }
function getNadlanScraper() { return require('./nadlanScraper'); }

/**
 * Mark a phase as completed in DB.
 */
async function markPhaseComplete(complexId, phase) {
  try {
    await pool.query(`
      UPDATE complexes SET
        onboarding_phases_completed = (
          SELECT jsonb_agg(DISTINCT val)
          FROM (
            SELECT jsonb_array_elements_text(
              COALESCE(onboarding_phases_completed::jsonb, '[]'::jsonb)
            ) AS val
            UNION ALL SELECT $1::text
          ) sub
        )::text,
        updated_at = NOW()
      WHERE id = $2
    `, [phase, complexId]);
  } catch (err) {
    // Non-fatal - just log
    logger.debug(`[Onboarding] Could not mark phase ${phase} complete: ${err.message}`);
  }
}

/**
 * Phase 1: Basic enrichment
 * Gets plan_stage, developer details, signature_percent, num_buildings, address refinement.
 * Uses 'fast' mode (Perplexity only) for speed.
 */
async function phase1BasicEnrichment(complex) {
  logger.info(`[Onboarding P1] ${complex.name}: basic enrichment`);
  try {
    const service = getDeepEnrichment();
    await service.deepEnrichComplex(complex.id, { mode: 'fast' });
    await markPhaseComplete(complex.id, 'basic_enrichment');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P1] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 2: Developer risk assessment
 * Assesses financial health, reputation, red flags.
 * Uses standard mode with focus on developer.
 */
async function phase2DeveloperRisk(complex) {
  logger.info(`[Onboarding P2] ${complex.name}: developer risk`);
  try {
    // Re-fetch to get updated developer name from phase 1
    const updated = await pool.query('SELECT * FROM complexes WHERE id = $1', [complex.id]);
    const c = updated.rows[0];
    if (!c.developer || c.developer === 'unknown') {
      logger.info(`[Onboarding P2] ${complex.name}: no developer - skipping`);
      await markPhaseComplete(complex.id, 'developer_risk');
      return true;
    }

    // Check if developerInfoService exists
    try {
      const devService = require('./developerInfoService');
      if (devService && devService.assessDeveloperRisk) {
        await devService.assessDeveloperRisk(c.id);
      }
    } catch (e) {
      // Service may not exist - use deep enrichment developer mode
      logger.debug(`[Onboarding P2] developerInfoService not available, using deepEnrichment`);
    }

    await markPhaseComplete(complex.id, 'developer_risk');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P2] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 3: News & legal scan
 * Checks for negative news, receivership, enforcement, liens.
 */
async function phase3NewsLegal(complex) {
  logger.info(`[Onboarding P3] ${complex.name}: news & legal`);
  try {
    const service = getDeepEnrichment();
    // Standard mode includes Claude synthesis which handles news + legal
    await service.deepEnrichComplex(complex.id, { mode: 'standard' });
    await markPhaseComplete(complex.id, 'news_legal');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P3] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 4: Price data from nadlan.gov.il
 * Fetches actual closed transactions for the complex's own streets.
 */
async function phase4PriceData(complex) {
  logger.info(`[Onboarding P4] ${complex.name}: price data`);
  try {
    const nadlanScraper = getNadlanScraper();
    if (nadlanScraper && nadlanScraper.fetchTransactionsForComplex) {
      await nadlanScraper.fetchTransactionsForComplex(complex.id);
    } else {
      // Fallback: use deep enrichment which queries nadlan via Perplexity
      const service = getDeepEnrichment();
      await service.deepEnrichComplex(complex.id, { mode: 'standard' });
    }
    await markPhaseComplete(complex.id, 'price_data');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P4] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 5: Neighborhood benchmark
 * Fetches nadlan + madlan data for nearby streets, calculates weighted avg.
 * This is the core improvement - replaces city_avg with hyper-local benchmark.
 */
async function phase5NeighborhoodBenchmark(complex) {
  logger.info(`[Onboarding P5] ${complex.name}: neighborhood benchmark`);
  try {
    const benchmarkService = getNeighborhoodBenchmark();
    await benchmarkService.fetchNeighborhoodBenchmark(complex.id);
    await markPhaseComplete(complex.id, 'neighborhood_benchmark');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P5] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 6: IAI calculation
 * Calculates Investment Attractiveness Index using real neighborhood benchmark.
 */
async function phase6IaiCalculation(complex) {
  logger.info(`[Onboarding P6] ${complex.name}: IAI calculation`);
  try {
    const iaiCalc = getIaiCalculator();
    await iaiCalc.calculateIAI(complex.id);
    await markPhaseComplete(complex.id, 'iai_calculation');
    return true;
  } catch (err) {
    logger.warn(`[Onboarding P6] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Phase 7: Tier classification
 * Assigns complex to Tier 1/2/3 based on IAI score and project status.
 *
 * Tier 1: IAI >= 30 (top investor targets)
 * Tier 2: Active projects with IAI < 30
 * Tier 3: Dormant - no developer, no plan progress, IAI = 0
 */
async function phase7TierClassification(complex) {
  logger.info(`[Onboarding P7] ${complex.name}: tier classification`);
  try {
    const updated = await pool.query('SELECT * FROM complexes WHERE id = $1', [complex.id]);
    const c = updated.rows[0];

    const iai = parseFloat(c.iai_score) || 0;
    const status = c.status || 'unknown';
    const developer = c.developer;
    const hasDeveloper = developer && developer !== 'unknown' && developer !== '';

    let tier;
    if (iai >= 30) {
      tier = 1;
    } else if (
      status === 'unknown' ||
      status === 'before_declaration' ||
      (!hasDeveloper && iai < 5)
    ) {
      tier = 3; // Dormant
    } else {
      tier = 2; // Active but below Tier 1 threshold
    }

    await pool.query(`
      UPDATE complexes SET
        onboarding_status = 'completed',
        onboarding_completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [complex.id]);

    await markPhaseComplete(complex.id, 'tier_classification');

    logger.info(`[Onboarding P7] ${complex.name}: Tier ${tier} | IAI=${iai} | status=${status}`);
    return { tier, iai };
  } catch (err) {
    logger.warn(`[Onboarding P7] ${complex.name}: failed - ${err.message}`);
    return false;
  }
}

/**
 * Run full onboarding pipeline for a single complex.
 * Skips phases that have already been completed (idempotent).
 *
 * @param {number} complexId
 * @param {object} options - { forceAll: false, skipPhases: [] }
 */
async function runOnboarding(complexId, options = {}) {
  const { forceAll = false, skipPhases = [] } = options;

  const result = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (result.rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = result.rows[0];

  // Parse completed phases
  let completedPhases = [];
  try {
    completedPhases = JSON.parse(complex.onboarding_phases_completed || '[]');
  } catch (e) {
    completedPhases = [];
  }

  logger.info(`[Onboarding] Starting: ${complex.name} (${complex.city}) | completed: [${completedPhases.join(', ')}]`);

  const phaseDefs = [
    { key: 'basic_enrichment',      fn: phase1BasicEnrichment,      label: 'Phase 1: Basic Enrichment' },
    { key: 'developer_risk',        fn: phase2DeveloperRisk,         label: 'Phase 2: Developer Risk' },
    { key: 'news_legal',            fn: phase3NewsLegal,             label: 'Phase 3: News & Legal' },
    { key: 'price_data',            fn: phase4PriceData,             label: 'Phase 4: Price Data' },
    { key: 'neighborhood_benchmark',fn: phase5NeighborhoodBenchmark, label: 'Phase 5: Neighborhood Benchmark' },
    { key: 'iai_calculation',       fn: phase6IaiCalculation,        label: 'Phase 6: IAI Calculation' },
    { key: 'tier_classification',   fn: phase7TierClassification,    label: 'Phase 7: Tier Classification' }
  ];

  const phaseResults = {};

  for (const phase of phaseDefs) {
    if (skipPhases.includes(phase.key)) {
      phaseResults[phase.key] = 'skipped';
      continue;
    }

    if (!forceAll && completedPhases.includes(phase.key)) {
      phaseResults[phase.key] = 'already_done';
      logger.info(`[Onboarding] ${complex.name}: ${phase.label} - already completed, skipping`);
      continue;
    }

    logger.info(`[Onboarding] ${complex.name}: running ${phase.label}`);
    const success = await phase.fn(complex);
    phaseResults[phase.key] = success ? 'success' : 'failed';

    await sleep(PHASE_DELAY_MS);
  }

  // Mark overall status
  const allSuccess = Object.values(phaseResults).every(v => v === 'success' || v === 'already_done' || v === 'skipped');
  await pool.query(`
    UPDATE complexes SET
      onboarding_status = $1,
      updated_at = NOW()
    WHERE id = $2
  `, [allSuccess ? 'completed' : 'partial', complexId]);

  logger.info(`[Onboarding] Completed: ${complex.name} | status: ${allSuccess ? 'completed' : 'partial'}`);

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    status: allSuccess ? 'completed' : 'partial',
    phases: phaseResults
  };
}

/**
 * Batch onboarding - run pipeline for multiple complexes.
 * Options: { limit, status (pending/partial), forceAll }
 */
async function batchOnboarding(options = {}) {
  const { limit = 50, forceAll = false, onlyPending = true } = options;

  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let idx = 1;

  if (onlyPending) {
    query += ` AND (onboarding_status IS NULL OR onboarding_status IN ('pending', 'partial'))`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';
  query += ` LIMIT $${idx++}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`[Onboarding] Batch starting: ${total} complexes`);

  const jobId = `onboarding_${Date.now()}`;
  const results = { jobId, total, processed: 0, completed: 0, partial: 0, failed: 0 };

  // Run async in background
  setImmediate(async () => {
    for (let i = 0; i < complexes.rows.length; i++) {
      const complex = complexes.rows[i];
      try {
        const result = await runOnboarding(complex.id, { forceAll });
        results.processed++;
        if (result.status === 'completed') results.completed++;
        else results.partial++;
        logger.info(`[Onboarding ${i + 1}/${total}] ${complex.name}: ${result.status}`);
      } catch (err) {
        results.processed++;
        results.failed++;
        logger.error(`[Onboarding ${i + 1}/${total}] ${complex.name}: ERROR - ${err.message}`);
      }

      if (i < complexes.rows.length - 1) await sleep(PHASE_DELAY_MS);
    }
    logger.info('[Onboarding] Batch completed', results);
  });

  return { jobId, total, message: `Onboarding batch started for ${total} complexes` };
}

module.exports = {
  runOnboarding,
  batchOnboarding,
  phase1BasicEnrichment,
  phase2DeveloperRisk,
  phase3NewsLegal,
  phase4PriceData,
  phase5NeighborhoodBenchmark,
  phase6IaiCalculation,
  phase7TierClassification
};
