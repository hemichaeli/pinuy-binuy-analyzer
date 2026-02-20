const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * IAI (Investment Attractiveness Index) Calculator
 * Formula: IAI = (theoretical_premium - actual_premium) * certainty_factor * yield_factor
 * Range: 0-100
 *
 * SMART ACTUAL_PREMIUM LOGIC (v2):
 * 1. Use stored actual_premium if exists (verified by scan)
 * 2. Auto-derive from price_per_sqm + city_avg_price_sqm if both exist
 * 3. Fill city_avg from city-wide cache (other complexes in same city)
 * 4. If nothing found - mark as unknown, penalize certainty factor (don't assume 0)
 */

// Theoretical premium ranges by planning status
const PREMIUM_TABLE = {
  'before_declaration': { min: 0, max: 0 },
  'declared': { min: 5, max: 15 },
  'developer_selected': { min: 15, max: 25 },
  'submitted': { min: 20, max: 35 },
  'pre_deposit': { min: 20, max: 35 },
  'deposited': { min: 35, max: 50 },
  'approved': { min: 50, max: 70 },
  'permit': { min: 70, max: 90 },
  'construction': { min: 90, max: 100 },
  'planning': { min: 5, max: 15 },
  'unknown': { min: 0, max: 0 }
};

const STRONG_DEVELOPERS = [
  'שטיינמץ עקיבא', 'אפריקה ישראל', 'אלדד', 'אלקטרה', 'ג.ג.ח',
  'רנדס', 'קרסו', 'אלמוג', 'ICR'
];
const WEAK_DEVELOPERS = ['unknown', '', null];

function getTheoreticalPremium(status) {
  return PREMIUM_TABLE[status] || PREMIUM_TABLE['unknown'];
}

/**
 * Get city average price from other complexes in same city.
 * Uses weighted average across all complexes with known city_avg_price_sqm.
 */
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
    logger.warn(`[IAI] city_avg cache lookup failed for ${city}`, { error: err.message });
    return null;
  }
}

/**
 * Propagate city_avg to all complexes in city that are missing it.
 * Called automatically when a scan finds a new city_avg.
 */
async function propagateCityAvg(city, cityAvg) {
  try {
    const result = await pool.query(`
      UPDATE complexes
      SET city_avg_price_sqm = $1, updated_at = NOW()
      WHERE city = $2
        AND (city_avg_price_sqm IS NULL OR city_avg_price_sqm::numeric = 0)
    `, [cityAvg, city]);
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info(`[IAI] Propagated city_avg ${cityAvg} to ${count} complexes in ${city}`);
    }
    return count;
  } catch (err) {
    logger.warn(`[IAI] city_avg propagation failed for ${city}`, { error: err.message });
    return 0;
  }
}

/**
 * Derive actual_premium from price_per_sqm vs neighborhood benchmark.
 * Returns { value, confidence, source } or null.
 *
 * Benchmark priority:
 *   1. neighborhood_avg_sqm  - weighted nadlan+madlan local average (highest accuracy)
 *   2. city_avg_price_sqm    - city-wide average (fallback, lower accuracy)
 *   3. city_cache            - derived from other complexes in same city (lowest)
 *
 * Confidence levels:
 *   'high'     - actual_premium stored from verified scan with neighborhood benchmark
 *   'medium'   - derived from neighborhood_avg_sqm (local benchmark)
 *   'medium-low' - derived from city_avg_price_sqm (city-wide, less accurate)
 *   'low'      - derived from city cache
 *   null       - not enough data
 */
async function deriveActualPremium(complex) {
  // Priority 1: stored actual_premium + neighborhood benchmark exists (best case)
  if (complex.actual_premium !== null && complex.actual_premium !== undefined &&
      parseFloat(complex.actual_premium) > 0 && complex.neighborhood_avg_sqm) {
    return {
      value: parseFloat(complex.actual_premium),
      confidence: 'high',
      source: 'stored_neighborhood'
    };
  }

  const psm = complex.price_per_sqm ? parseFloat(complex.price_per_sqm) : null;
  if (!psm || psm <= 0) return null;

  // Priority 2: use neighborhood_avg_sqm (hyper-local benchmark)
  const neighborhoodAvg = complex.neighborhood_avg_sqm ? parseFloat(complex.neighborhood_avg_sqm) : null;
  if (neighborhoodAvg && neighborhoodAvg > 0) {
    const derived = Math.round(((psm - neighborhoodAvg) / neighborhoodAvg) * 100);
    if (derived >= -20 && derived <= 200) {
      return {
        value: derived,
        confidence: 'medium',
        source: complex.neighborhood_benchmark_source || 'neighborhood_avg'
      };
    }
    logger.warn(`[IAI] Suspicious neighborhood premium ${derived}% for ${complex.name} - falling back`);
  }

  // Priority 3: fallback to city_avg_price_sqm
  let cityAvg = complex.city_avg_price_sqm ? parseFloat(complex.city_avg_price_sqm) : null;
  let source = 'city_avg';

  // Priority 4: fallback to city cache
  if (!cityAvg || cityAvg <= 0) {
    const cached = await getCityAvgFromCache(complex.city);
    if (cached) {
      cityAvg = cached.value;
      source = 'city_cache';
    }
  }

  if (!cityAvg || cityAvg <= 0) return null;

  const derived = Math.round(((psm - cityAvg) / cityAvg) * 100);

  // Sanity check
  if (derived < -20 || derived > 200) {
    logger.warn(`[IAI] Suspicious derived premium ${derived}% for ${complex.name} - skipping`);
    return null;
  }

  return {
    value: derived,
    confidence: source === 'city_cache' ? 'low' : 'medium-low',
    source
  };
}

function calculateCertaintyFactor(complex, premiumConfidence) {
  let factor = 1.0;

  // Developer strength
  if (complex.developer_strength === 'strong' ||
      STRONG_DEVELOPERS.some(d => complex.developer && complex.developer.includes(d))) {
    factor += 0.15;
  } else if (complex.developer_strength === 'weak' ||
             WEAK_DEVELOPERS.includes(complex.developer)) {
    factor -= 0.15;
  }

  // Signature progress
  if (complex.signature_percent) {
    if (complex.signature_percent >= 90) factor += 0.15;
    else if (complex.signature_percent < 67) factor -= 0.25;
  }

  // Planning stage certainty
  if (['approved', 'permit', 'construction'].includes(complex.status)) {
    factor += 0.2;
  }

  // Penalize when actual_premium is missing or low-confidence
  if (!premiumConfidence) {
    factor -= 0.3; // Unknown premium = significant uncertainty
  } else if (premiumConfidence === 'low') {
    factor -= 0.1; // City cache estimate = minor penalty
  }

  return Math.max(0.5, Math.min(1.5, factor));
}

function calculateYieldFactor(complex) {
  let factor = 1.0;
  if (complex.multiplier && parseFloat(complex.multiplier) > 3) {
    factor += 0.2;
  }
  return Math.max(0.5, Math.min(1.5, factor));
}

async function calculateIAI(complexId) {
  try {
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return null;

    const complex = complexResult.rows[0];
    const premium = getTheoreticalPremium(complex.status);
    const theoreticalPremiumMid = (premium.min + premium.max) / 2;

    // Smart actual_premium derivation
    const derived = await deriveActualPremium(complex);
    const actualPremium = derived ? derived.value : null;
    const premiumConfidence = derived ? derived.confidence : null;
    const premiumSource = derived ? derived.source : 'unknown';

    // If we derived a medium/low confidence premium, persist it back
    if (derived && derived.source !== 'stored' && actualPremium !== null) {
      try {
        await pool.query(`
          UPDATE complexes SET
            actual_premium = $1,
            actual_premium_source = $2,
            actual_premium_confidence = $3,
            updated_at = NOW()
          WHERE id = $4
            AND (actual_premium IS NULL OR actual_premium::numeric = 0)
        `, [actualPremium, premiumSource, premiumConfidence, complexId]);
      } catch (e) {
        // Column may not exist yet - non-fatal
        logger.debug(`[IAI] Could not persist derived premium: ${e.message}`);
      }

      // Propagate city_avg if we used a direct scan value
      if (derived.source === 'scan' && complex.city_avg_price_sqm) {
        await propagateCityAvg(complex.city, parseFloat(complex.city_avg_price_sqm));
      }
    }

    // GAP calculation
    // If no actual_premium data at all - use theoretical midpoint as gap (conservative)
    const premiumGap = actualPremium !== null
      ? Math.max(0, theoreticalPremiumMid - actualPremium)
      : theoreticalPremiumMid * 0.5; // Penalized gap when unknown (not full gap, not zero)

    const gapPoints = Math.min(50, premiumGap);
    const certaintyFactor = calculateCertaintyFactor(complex, premiumConfidence);
    const yieldFactor = calculateYieldFactor(complex);
    const iai = Math.round(Math.min(100, gapPoints * certaintyFactor * yieldFactor));

    await pool.query(`
      UPDATE complexes SET
        theoretical_premium_min = $1, theoretical_premium_max = $2,
        premium_gap = $3, certainty_factor = $4, yield_factor = $5,
        iai_score = $6, updated_at = NOW()
      WHERE id = $7
    `, [premium.min, premium.max, Math.round(premiumGap * 100) / 100,
        certaintyFactor, yieldFactor, iai, complexId]);

    logger.info(`[IAI] ${complex.name}: IAI=${iai} | gap=${Math.round(premiumGap)}% | actual_premium=${actualPremium !== null ? actualPremium + '%' : 'unknown'} (${premiumSource}) | certainty=${certaintyFactor}`, { complexId });

    return {
      iai_score: iai,
      premium_gap: premiumGap,
      certainty_factor: certaintyFactor,
      yield_factor: yieldFactor,
      theoretical_premium: { min: premium.min, max: premium.max },
      actual_premium: actualPremium,
      actual_premium_confidence: premiumConfidence,
      actual_premium_source: premiumSource
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

module.exports = {
  calculateIAI, calculateAllIAI, getTheoreticalPremium,
  calculateCertaintyFactor, calculateYieldFactor,
  deriveActualPremium, propagateCityAvg, getCityAvgFromCache,
  PREMIUM_TABLE, STRONG_DEVELOPERS
};
