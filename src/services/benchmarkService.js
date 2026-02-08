const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Benchmark Service
 * Calculates actual_premium for each complex by comparing its transaction prices
 * against similar non-pinuy-binuy buildings in the same area.
 * 
 * Data sources (in priority order):
 * 1. Internal DB: transactions from other complexes at earlier stages in the same city
 * 2. Perplexity AI: average price per sqm queries for comparable buildings
 * 
 * Formula:
 *   complex_avg_psm = average price_per_sqm of complex's transactions
 *   benchmark_psm = average price_per_sqm of comparable non-PB buildings
 *   actual_premium = ((complex_avg_psm - benchmark_psm) / benchmark_psm) * 100
 *   premium_gap = theoretical_premium_mid - actual_premium  (used by IAI calculator)
 */

const RATE_LIMIT_DELAY = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get average price_per_sqm for a complex from its transactions
 * Uses last 2 years of data, weighted toward recent transactions
 */
async function getComplexAvgPrice(complexId) {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as tx_count,
      AVG(price_per_sqm) as avg_psm,
      MIN(price_per_sqm) as min_psm,
      MAX(price_per_sqm) as max_psm,
      AVG(CASE WHEN transaction_date > NOW() - INTERVAL '1 year' 
          THEN price_per_sqm ELSE NULL END) as recent_avg_psm,
      MIN(transaction_date) as earliest_date,
      MAX(transaction_date) as latest_date
    FROM transactions 
    WHERE complex_id = $1 
      AND price_per_sqm IS NOT NULL 
      AND price_per_sqm > 5000
      AND transaction_date > NOW() - INTERVAL '3 years'
  `, [complexId]);

  const row = result.rows[0];
  if (!row || parseInt(row.tx_count) === 0) return null;

  // Prefer recent average if available (last year), otherwise use overall
  const avgPsm = row.recent_avg_psm ? parseFloat(row.recent_avg_psm) : parseFloat(row.avg_psm);

  return {
    avg_price_per_sqm: Math.round(avgPsm),
    tx_count: parseInt(row.tx_count),
    min_psm: Math.round(parseFloat(row.min_psm)),
    max_psm: Math.round(parseFloat(row.max_psm)),
    period_start: row.earliest_date,
    period_end: row.latest_date,
    used_recent: !!row.recent_avg_psm
  };
}

/**
 * Try to find benchmark data from internal DB
 * Looks for transactions in same city from complexes at early stages (before_declaration, declared)
 * or from buildings not associated with any complex
 */
async function getBenchmarkFromDB(city, excludeComplexId) {
  // Get average from complexes in same city at early planning stages (minimal premium)
  const result = await pool.query(`
    SELECT 
      AVG(t.price_per_sqm) as avg_psm,
      COUNT(*) as tx_count,
      MIN(t.transaction_date) as period_start,
      MAX(t.transaction_date) as period_end
    FROM transactions t
    LEFT JOIN complexes c ON t.complex_id = c.id
    WHERE t.city = $1
      AND t.complex_id != $2
      AND t.price_per_sqm IS NOT NULL
      AND t.price_per_sqm > 5000
      AND t.transaction_date > NOW() - INTERVAL '3 years'
      AND (c.status IS NULL OR c.status IN ('unknown', 'declared', 'planning'))
  `, [city, excludeComplexId]);

  const row = result.rows[0];
  if (!row || parseInt(row.tx_count) < 3) return null; // Need at least 3 transactions

  return {
    benchmark_price_per_sqm: Math.round(parseFloat(row.avg_psm)),
    num_transactions: parseInt(row.tx_count),
    period_start: row.period_start,
    period_end: row.period_end,
    source: 'internal_db'
  };
}

/**
 * Get benchmark data from Perplexity
 * Asks for average price per sqm in comparable buildings (not pinuy binuy) in the same city
 */
async function getBenchmarkFromPerplexity(complexName, city, neighborhood) {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('No PERPLEXITY_API_KEY - cannot get Perplexity benchmark');
    return null;
  }

  const areaDesc = neighborhood ? `שכונת ${neighborhood} ב${city}` : city;

  const prompt = `מה המחיר הממוצע למטר מרובע (מ"ר) של דירות ישנות (בנייה לפני 1980) ב${areaDesc}?

אני מחפש מחירי השוואה (benchmark) לבניינים רגילים שאינם בפינוי בינוי.

החזר JSON בלבד (בלי טקסט נוסף) בפורמט:
{
  "avg_price_per_sqm": מספר,
  "price_range_min": מספר,
  "price_range_max": מספר,
  "based_on": "תיאור קצר של מקור הנתון",
  "year": 2025,
  "confidence": "high/medium/low"
}

התבסס על נתוני nadlan.gov.il, מדלן, או מקורות אמינים אחרים.
אם אין מספיק מידע, החזר {"avg_price_per_sqm": 0, "confidence": "none"}.`;

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'You are a real estate data analyst specializing in Israeli real estate. Return ONLY valid JSON, no markdown, no text.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 500
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || '';

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.avg_price_per_sqm || parsed.avg_price_per_sqm < 5000 || parsed.confidence === 'none') {
      return null;
    }

    return {
      benchmark_price_per_sqm: Math.round(parsed.avg_price_per_sqm),
      price_range_min: parsed.price_range_min || null,
      price_range_max: parsed.price_range_max || null,
      source: 'perplexity',
      based_on: parsed.based_on || 'Perplexity AI estimate',
      confidence: parsed.confidence || 'medium'
    };
  } catch (err) {
    logger.warn(`Perplexity benchmark failed for ${complexName} (${city})`, { error: err.message });
    return null;
  }
}

/**
 * Save benchmark data to DB
 */
async function saveBenchmark(complexId, benchmarkData) {
  try {
    await pool.query(`
      INSERT INTO benchmarks 
        (complex_id, benchmark_city, benchmark_price_sqm, num_transactions, 
         period_start, period_end)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      complexId,
      benchmarkData.city || null,
      benchmarkData.benchmark_price_per_sqm,
      benchmarkData.num_transactions || 0,
      benchmarkData.period_start || null,
      benchmarkData.period_end || null
    ]);
  } catch (err) {
    // Non-critical, log and continue
    logger.warn(`Failed to save benchmark for complex ${complexId}`, { error: err.message });
  }
}

/**
 * Calculate actual_premium for a single complex
 * Returns { actual_premium, premium_gap, details } or null
 */
async function calculateBenchmark(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, neighborhood, status, theoretical_premium_min, theoretical_premium_max FROM complexes WHERE id = $1',
    [complexId]
  );

  if (complexResult.rows.length === 0) return null;
  const complex = complexResult.rows[0];

  // Step 1: Get complex's own average price per sqm
  const complexPrice = await getComplexAvgPrice(complexId);
  if (!complexPrice) {
    logger.info(`No transactions with price_per_sqm for ${complex.name} - skipping benchmark`);
    return null;
  }

  // Step 2: Get benchmark price (try internal DB first, then Perplexity)
  let benchmark = await getBenchmarkFromDB(complex.city, complexId);

  if (!benchmark) {
    benchmark = await getBenchmarkFromPerplexity(complex.name, complex.city, complex.neighborhood);
    if (benchmark) {
      benchmark.city = complex.city;
    }
  }

  if (!benchmark || !benchmark.benchmark_price_per_sqm) {
    logger.info(`No benchmark data available for ${complex.name} (${complex.city})`);
    return null;
  }

  // Step 3: Calculate actual premium
  const actualPremium = ((complexPrice.avg_price_per_sqm - benchmark.benchmark_price_per_sqm) / benchmark.benchmark_price_per_sqm) * 100;
  const actualPremiumRounded = Math.round(actualPremium * 100) / 100;

  // Step 4: Calculate premium gap
  const theoreticalMid = ((complex.theoretical_premium_min || 0) + (complex.theoretical_premium_max || 0)) / 2;
  const premiumGap = Math.max(0, theoreticalMid - actualPremiumRounded);

  // Step 5: Update complex
  await pool.query(`
    UPDATE complexes SET 
      actual_premium = $1,
      premium_gap = $2,
      updated_at = NOW()
    WHERE id = $3
  `, [actualPremiumRounded, premiumGap, complexId]);

  // Step 6: Save benchmark record
  benchmark.city = complex.city;
  await saveBenchmark(complexId, benchmark);

  const result = {
    complex_id: complexId,
    complex_name: complex.name,
    city: complex.city,
    complex_avg_psm: complexPrice.avg_price_per_sqm,
    benchmark_avg_psm: benchmark.benchmark_price_per_sqm,
    actual_premium: actualPremiumRounded,
    theoretical_premium_mid: theoreticalMid,
    premium_gap: premiumGap,
    tx_count: complexPrice.tx_count,
    benchmark_source: benchmark.source,
    benchmark_confidence: benchmark.confidence || 'db'
  };

  logger.info(`Benchmark calculated for ${complex.name}: actual_premium=${actualPremiumRounded}%, gap=${premiumGap}%`, result);

  return result;
}

/**
 * Calculate benchmarks for all complexes that have transactions
 * Options: { city, limit, force }
 *   force: recalculate even if actual_premium exists
 */
async function calculateAllBenchmarks(options = {}) {
  const { city, limit, force } = options;

  let query = `
    SELECT DISTINCT c.id, c.name, c.city
    FROM complexes c
    INNER JOIN transactions t ON t.complex_id = c.id AND t.price_per_sqm IS NOT NULL
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (city) {
    query += ` AND c.city = $${paramIndex++}`;
    params.push(city);
  }

  if (!force) {
    // Skip complexes already benchmarked in last 30 days
    query += ` AND (c.actual_premium IS NULL OR c.updated_at < NOW() - INTERVAL '30 days')`;
  }

  query += ' ORDER BY c.iai_score DESC NULLS LAST';

  if (limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(limit);
  }

  const complexes = await pool.query(query, params);

  logger.info(`Benchmark calculation: ${complexes.rows.length} complexes to process`);

  const results = {
    total: complexes.rows.length,
    calculated: 0,
    skipped: 0,
    errors: 0,
    details: []
  };

  for (const complex of complexes.rows) {
    try {
      const result = await calculateBenchmark(complex.id);
      if (result) {
        results.calculated++;
        results.details.push(result);
      } else {
        results.skipped++;
      }

      // Rate limit for Perplexity calls
      await sleep(RATE_LIMIT_DELAY);
    } catch (err) {
      results.errors++;
      logger.warn(`Benchmark calculation failed for ${complex.name}`, { error: err.message });
    }
  }

  logger.info(`Benchmark calculation complete: ${results.calculated} calculated, ${results.skipped} skipped, ${results.errors} errors`);

  return results;
}

/**
 * Get benchmark summary for a specific complex
 * (Used by /api/projects/:id/benchmark endpoint)
 */
async function getBenchmarkSummary(complexId) {
  const complex = await pool.query(
    `SELECT id, name, city, neighborhood, status, 
            actual_premium, premium_gap, theoretical_premium_min, theoretical_premium_max,
            iai_score
     FROM complexes WHERE id = $1`,
    [complexId]
  );

  if (complex.rows.length === 0) return null;
  const c = complex.rows[0];

  const complexPrice = await getComplexAvgPrice(complexId);

  const latestBenchmark = await pool.query(
    'SELECT * FROM benchmarks WHERE complex_id = $1 ORDER BY created_at DESC LIMIT 1',
    [complexId]
  );

  return {
    complex: {
      id: c.id,
      name: c.name,
      city: c.city,
      status: c.status,
      iai_score: c.iai_score
    },
    pricing: {
      complex_avg_psm: complexPrice ? complexPrice.avg_price_per_sqm : null,
      tx_count: complexPrice ? complexPrice.tx_count : 0,
      period: complexPrice ? { start: complexPrice.period_start, end: complexPrice.period_end } : null
    },
    benchmark: latestBenchmark.rows.length > 0 ? {
      benchmark_psm: parseFloat(latestBenchmark.rows[0].benchmark_price_sqm),
      num_transactions: latestBenchmark.rows[0].num_transactions,
      calculated_at: latestBenchmark.rows[0].created_at
    } : null,
    premium: {
      theoretical_min: c.theoretical_premium_min,
      theoretical_max: c.theoretical_premium_max,
      theoretical_mid: ((c.theoretical_premium_min || 0) + (c.theoretical_premium_max || 0)) / 2,
      actual_premium: c.actual_premium,
      premium_gap: c.premium_gap,
      interpretation: interpretPremiumGap(c.premium_gap, c.actual_premium)
    }
  };
}

/**
 * Human-readable interpretation of premium gap
 */
function interpretPremiumGap(premiumGap, actualPremium) {
  if (premiumGap === null || premiumGap === undefined) {
    return 'לא ניתן לחשב - חסרים נתוני עסקאות';
  }
  if (premiumGap >= 30) {
    return `פרמיה בפועל (${actualPremium}%) נמוכה מאוד ביחס לתיאורטית - הזדמנות מצוינת`;
  }
  if (premiumGap >= 15) {
    return `פערים משמעותי (${premiumGap}%) - שווה בדיקה`;
  }
  if (premiumGap >= 5) {
    return `פער קטן (${premiumGap}%) - הזדמנות מוגבלת`;
  }
  if (actualPremium !== null && actualPremium < 0) {
    return `מחירים מתחת לבנצ'מרק (${actualPremium}%) - יתכן שהבניין בכלל לא מתומחר כפינוי בינוי`;
  }
  return `פרמיה בפועל קרובה לתיאורטית (פער: ${premiumGap}%) - מחיר כבר מגלם את הפרויקט`;
}

module.exports = {
  calculateBenchmark,
  calculateAllBenchmarks,
  getBenchmarkSummary,
  getComplexAvgPrice,
  getBenchmarkFromDB,
  getBenchmarkFromPerplexity
};
