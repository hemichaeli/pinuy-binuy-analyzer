const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * IAI (Investment Attractiveness Index) Calculator v3
 * 
 * PROBLEM SOLVED: v2 produced IAI=68 for 90% of Tier 1 complexes because:
 *   1. gapPoints always hit the 50-point cap
 *   2. multiplier data was missing for 90% of complexes
 *   3. certainty factor had too few differentiators
 *
 * v3 APPROACH: 6 independent scoring axes using data that actually exists
 *   - planning_score:   0-25 pts  (status/stage progression)
 *   - premium_score:    0-25 pts  (actual premium gap with graduated scaling)
 *   - momentum_score:   0-20 pts  (signatures, listings, multiplier)
 *   - scale_score:      0-10 pts  (project size & density)
 *   - developer_score:  0-10 pts  (developer strength & track record)
 *   - data_score:       0-10 pts  (data completeness = decision confidence)
 *   TOTAL:              0-100 pts
 *
 * Each axis varies independently, ensuring diverse final scores.
 */

// === CONFIGURATION ===

const PLANNING_SCORES = {
  'construction':        25,
  'permit':              21,
  'approved':            17,
  'deposited':           13,
  'pre_deposit':         11,
  'submitted':            9,
  'developer_selected':   7,
  'declared':             5,
  'planning':             4,
  'before_declaration':   2,
  'unknown':              0
};

const STRONG_DEVELOPERS = [
  'שטיינמץ עקיבא', 'אפריקה ישראל', 'אלדד', 'אלקטרה', 'ג.ג.ח',
  'רנדס', 'קרסו', 'אלמוג', 'ICR', 'אאורה', 'גרופית', 'דמרי',
  'יוסי אברהמי', 'בוני התיכון', 'אשדר', 'שיכון ובינוי', 'אזורים'
];

const PREMIUM_TABLE = {
  'before_declaration': { min: 0, max: 0 },
  'declared':           { min: 5, max: 15 },
  'developer_selected': { min: 15, max: 25 },
  'submitted':          { min: 20, max: 35 },
  'pre_deposit':        { min: 20, max: 35 },
  'deposited':          { min: 35, max: 50 },
  'approved':           { min: 50, max: 70 },
  'permit':             { min: 70, max: 90 },
  'construction':       { min: 90, max: 100 },
  'planning':           { min: 5, max: 15 },
  'unknown':            { min: 0, max: 0 }
};

// === SCORING FUNCTIONS ===

/**
 * Axis 1: Planning Stage Score (0-25)
 * Direct mapping from status - simple, reliable, always available.
 */
function calcPlanningScore(complex) {
  return PLANNING_SCORES[complex.status] || PLANNING_SCORES['unknown'];
}

/**
 * Axis 2: Premium Score (0-25)
 * How much investment upside exists based on actual vs theoretical premium.
 * Uses graduated scaling instead of a hard cap.
 */
async function calcPremiumScore(complex) {
  const theoretical = PREMIUM_TABLE[complex.status] || PREMIUM_TABLE['unknown'];
  const theoreticalMid = (theoretical.min + theoretical.max) / 2;
  
  // Try to get actual premium
  const actualPremium = await resolveActualPremium(complex);
  
  if (actualPremium === null) {
    // No premium data - give a neutral mid-range score, slightly penalized
    // Differentiate by stage: higher stage = more likely to have real gap
    const stageBonus = Math.min(5, theoreticalMid / 10);
    return Math.round(8 + stageBonus); // 8-13 range when no data
  }
  
  // Calculate gap
  const gap = theoreticalMid - actualPremium;
  
  if (gap <= 0) return 2; // No gap = minimal score (not zero, still invested)
  
  // Graduated scoring: diminishing returns above gap=50
  // gap 0-20:   linear (0-10 points)
  // gap 20-50:  slower growth (10-18 points)  
  // gap 50-100: logarithmic (18-25 points)
  let score;
  if (gap <= 20) {
    score = gap * 0.5; // 0-10
  } else if (gap <= 50) {
    score = 10 + (gap - 20) * 0.267; // 10-18
  } else {
    score = 18 + Math.min(7, Math.log2(gap - 49) * 2.5); // 18-25
  }
  
  return Math.round(Math.min(25, Math.max(0, score)));
}

/**
 * Resolve actual premium from available data sources.
 * Returns numeric value or null.
 */
async function resolveActualPremium(complex) {
  // Priority 1: stored actual_premium
  if (complex.actual_premium !== null && complex.actual_premium !== undefined) {
    const val = parseFloat(complex.actual_premium);
    if (!isNaN(val) && val !== 0) return val;
  }
  
  // Priority 2: derive from price_per_sqm vs neighborhood/city average
  const psm = complex.price_per_sqm ? parseFloat(complex.price_per_sqm) : null;
  if (!psm || psm <= 0) return null;
  
  // Try neighborhood avg first
  const neighborhoodAvg = complex.neighborhood_avg_sqm ? parseFloat(complex.neighborhood_avg_sqm) : null;
  if (neighborhoodAvg && neighborhoodAvg > 0) {
    const derived = Math.round(((psm - neighborhoodAvg) / neighborhoodAvg) * 100);
    if (derived >= -30 && derived <= 250) return derived;
  }
  
  // Fallback: city average
  let cityAvg = complex.city_avg_price_sqm ? parseFloat(complex.city_avg_price_sqm) : null;
  if (!cityAvg || cityAvg <= 0) {
    const cached = await getCityAvgFromCache(complex.city);
    if (cached) cityAvg = cached.value;
  }
  
  if (cityAvg && cityAvg > 0) {
    const derived = Math.round(((psm - cityAvg) / cityAvg) * 100);
    if (derived >= -30 && derived <= 250) return derived;
  }
  
  return null;
}

/**
 * Axis 3: Momentum Score (0-20)
 * Progress indicators: signatures, market activity, build ratio.
 */
function calcMomentumScore(complex) {
  let score = 0;
  
  // Signature progress (0-10 points)
  if (complex.signature_percent) {
    const sig = parseFloat(complex.signature_percent);
    if (sig >= 100) score += 10;
    else if (sig >= 90) score += 8;
    else if (sig >= 80) score += 6;
    else if (sig >= 67) score += 4;
    else if (sig >= 50) score += 2;
    else score += 1;
  }
  // No signature data = 0 points (unknown progress)
  
  // Active listings indicate market activity (0-4 points)
  const listings = parseInt(complex.active_listings) || 0;
  if (listings >= 10) score += 4;
  else if (listings >= 5) score += 3;
  else if (listings >= 1) score += 2;
  
  // Multiplier / build ratio (0-6 points)
  const mult = parseFloat(complex.multiplier) || 0;
  if (mult > 0) {
    if (mult >= 4) score += 6;
    else if (mult >= 3.5) score += 5;
    else if (mult >= 3) score += 4;
    else if (mult >= 2.5) score += 3;
    else score += 1;
  } else {
    // Derive from planned_units / existing_units if multiplier missing
    const planned = parseInt(complex.planned_units) || 0;
    const existing = parseInt(complex.existing_units) || 0;
    if (existing > 0 && planned > 0) {
      const ratio = planned / existing;
      if (ratio >= 4) score += 5;
      else if (ratio >= 3.5) score += 4;
      else if (ratio >= 3) score += 3;
      else if (ratio >= 2.5) score += 2;
      else score += 1;
    }
  }
  
  return Math.min(20, score);
}

/**
 * Axis 4: Scale Score (0-10)
 * Larger projects = more apartment options, more liquidity.
 */
function calcScaleScore(complex) {
  let score = 0;
  
  const planned = parseInt(complex.planned_units) || 0;
  const buildings = parseInt(complex.num_buildings) || 0;
  
  // Planned units scoring (0-7)
  if (planned >= 500) score += 7;
  else if (planned >= 300) score += 6;
  else if (planned >= 200) score += 5;
  else if (planned >= 100) score += 4;
  else if (planned >= 50) score += 3;
  else if (planned > 0) score += 1;
  
  // Building count bonus (0-3)
  if (buildings >= 10) score += 3;
  else if (buildings >= 5) score += 2;
  else if (buildings >= 2) score += 1;
  
  return Math.min(10, score);
}

/**
 * Axis 5: Developer Score (0-10)
 * Developer quality affects completion probability.
 */
function calcDeveloperScore(complex) {
  let score = 5; // Default neutral
  
  const devStrength = complex.developer_strength;
  const devName = complex.developer || '';
  
  if (devStrength === 'strong' || STRONG_DEVELOPERS.some(d => devName.includes(d))) {
    score = 8;
  } else if (devStrength === 'medium') {
    score = 5;
  } else if (devStrength === 'weak' || !devName || devName === 'unknown') {
    score = 2;
  }
  
  // Risk level adjustment
  if (complex.developer_risk_level === 'low') score = Math.min(10, score + 2);
  else if (complex.developer_risk_level === 'high') score = Math.max(0, score - 3);
  
  // Negative news penalty
  if (complex.has_negative_news === true || complex.has_negative_news === 'true') {
    score = Math.max(0, score - 2);
  }
  
  return Math.min(10, Math.max(0, score));
}

/**
 * Axis 6: Data Confidence Score (0-10)
 * Better data = better investment decisions = higher score.
 */
function calcDataScore(complex) {
  let score = 0;
  
  // Each piece of available data adds confidence
  if (complex.actual_premium && parseFloat(complex.actual_premium) !== 0) score += 2;
  if (complex.price_per_sqm && parseFloat(complex.price_per_sqm) > 0) score += 1.5;
  if (complex.signature_percent) score += 1.5;
  if (complex.neighborhood && complex.neighborhood !== 'unknown') score += 1;
  if (complex.address && complex.address.length > 10) score += 1;
  if (complex.num_buildings && parseInt(complex.num_buildings) > 0) score += 1;
  if (complex.active_listings && parseInt(complex.active_listings) > 0) score += 1;
  if (complex.city_avg_price_sqm && parseFloat(complex.city_avg_price_sqm) > 0) score += 1;
  
  return Math.min(10, Math.round(score));
}

// === CITY AVERAGE HELPERS ===

async function getCityAvgFromCache(city) {
  try {
    const result = await pool.query(`
      SELECT AVG(city_avg_price_sqm::numeric) as avg,
             COUNT(*) as sources
      FROM complexes
      WHERE city = $1
        AND city_avg_price_sqm IS NOT NULL
        AND city_avg_price_sqm::numeric > 0
    `, [city]);
    if (result.rows[0]?.avg) {
      return {
        value: Math.round(parseFloat(result.rows[0].avg)),
        sources: parseInt(result.rows[0].sources),
        origin: 'city_cache'
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function propagateCityAvg(city, cityAvg) {
  try {
    const result = await pool.query(`
      UPDATE complexes
      SET city_avg_price_sqm = $1, updated_at = NOW()
      WHERE city = $2
        AND (city_avg_price_sqm IS NULL OR city_avg_price_sqm::numeric = 0)
    `, [cityAvg, city]);
    return result.rowCount || 0;
  } catch (err) {
    return 0;
  }
}

// === MAIN CALCULATION ===

async function calculateIAI(complexId) {
  try {
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return null;

    const complex = complexResult.rows[0];
    
    // Calculate all 6 axes
    const planning  = calcPlanningScore(complex);
    const premium   = await calcPremiumScore(complex);
    const momentum  = calcMomentumScore(complex);
    const scale     = calcScaleScore(complex);
    const developer = calcDeveloperScore(complex);
    const dataConf  = calcDataScore(complex);
    
    const iai = Math.min(100, planning + premium + momentum + scale + developer + dataConf);
    
    // Store theoretical premium for backward compatibility
    const theoreticalRange = PREMIUM_TABLE[complex.status] || PREMIUM_TABLE['unknown'];
    const theoreticalMid = (theoreticalRange.min + theoreticalRange.max) / 2;
    const actualPremium = await resolveActualPremium(complex);
    const premiumGap = actualPremium !== null 
      ? Math.max(0, theoreticalMid - actualPremium)
      : theoreticalMid * 0.5;

    // Backward-compatible certainty and yield factors
    const certaintyFactor = (planning + developer + dataConf) / 45; // normalized
    const yieldFactor = (premium + momentum + scale) / 55; // normalized

    await pool.query(`
      UPDATE complexes SET
        theoretical_premium_min = $1, theoretical_premium_max = $2,
        premium_gap = $3, certainty_factor = $4, yield_factor = $5,
        iai_score = $6, updated_at = NOW()
      WHERE id = $7
    `, [theoreticalRange.min, theoreticalRange.max, 
        Math.round(premiumGap * 100) / 100,
        Math.round(certaintyFactor * 1000) / 1000, 
        Math.round(yieldFactor * 1000) / 1000, 
        iai, complexId]);

    logger.info(`[IAI v3] ${complex.name}: IAI=${iai} | plan=${planning} prem=${premium} mom=${momentum} scale=${scale} dev=${developer} data=${dataConf} | actual_premium=${actualPremium !== null ? actualPremium + '%' : 'N/A'}`, { complexId });

    return {
      iai_score: iai,
      breakdown: { planning, premium, momentum, scale, developer, data: dataConf },
      premium_gap: premiumGap,
      certainty_factor: certaintyFactor,
      yield_factor: yieldFactor,
      theoretical_premium: { min: theoreticalRange.min, max: theoreticalRange.max },
      actual_premium: actualPremium,
      actual_premium_source: actualPremium !== null ? 'resolved' : 'unknown'
    };
  } catch (err) {
    logger.error(`Error calculating IAI for complex ${complexId}`, { error: err.message });
    throw err;
  }
}

async function calculateAllIAI() {
  const complexes = await pool.query('SELECT id FROM complexes');
  const results = [];
  for (const complex of complexes.rows) {
    try {
      const result = await calculateIAI(complex.id);
      results.push({ id: complex.id, ...result });
    } catch (err) {
      results.push({ id: complex.id, error: err.message });
    }
  }
  return results;
}

function getTheoreticalPremium(status) {
  return PREMIUM_TABLE[status] || PREMIUM_TABLE['unknown'];
}

// Backward-compatible exports (old function names still work)
function calculateCertaintyFactor() { return 1.0; }
function calculateYieldFactor() { return 1.0; }
async function deriveActualPremium(complex) { return resolveActualPremium(complex); }

module.exports = {
  calculateIAI, calculateAllIAI, getTheoreticalPremium,
  calculateCertaintyFactor, calculateYieldFactor,
  deriveActualPremium, propagateCityAvg, getCityAvgFromCache,
  PREMIUM_TABLE, STRONG_DEVELOPERS,
  // v3 specific
  calcPlanningScore, calcPremiumScore, calcMomentumScore,
  calcScaleScore, calcDeveloperScore, calcDataScore,
  // Alias for deepEnrichmentService compatibility
  recalculateComplex: calculateIAI
};
