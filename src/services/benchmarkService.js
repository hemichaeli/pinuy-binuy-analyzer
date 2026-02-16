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

const PERPLEXITY_MODEL = 'sonar';
const RATE_LIMIT_DELAY = 3500; // 3.5s between requests
const MAX_RETRIES = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get average price_per_sqm for a complex from its transactions
 * Uses last 3 years of data, preferring recent transactions
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
 * Source 1: Internal DB benchmark
 * Find average price_per_sqm from other complexes in the same city
 * that are at earlier planning stages (less affected by PB premium)
 */
async function getInternalBenchmark(complexId, city) {
  const result = await pool.query(`
    SELECT 
      AVG(t.price_per_sqm) as avg_psm,
      COUNT(DISTINCT t.id) as tx_count,
      COUNT(DISTINCT c.id) as complex_count
    FROM transactions t
    JOIN complexes c ON t.complex_id = c.id
    WHERE c.city = $1
      AND c.id != $2
      AND c.status IN ('declared', 'planning', 'pre_deposit')
      AND t.price_per_sqm IS NOT NULL
      AND t.price_per_sqm > 5000
      AND t.transaction_date > NOW() - INTERVAL '3 years'
  `, [city, complexId]);

  const row = result.rows[0];
  if (!row || parseInt(row.tx_count) < 3) return null;

  return {
    benchmark_psm: Math.round(parseFloat(row.avg_psm)),
    tx_count: parseInt(row.tx_count),
    complex_count: parseInt(row.complex_count),
    source: 'internal_db'
  };
}

/**
 * Source 2: Perplexity AI benchmark
 * Query average price per sqm for comparable non-PB buildings
 */
async function getPerplexityBenchmark(complexName, city, neighborhood) {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('Perplexity API key not configured - cannot calculate benchmarks');
    return null;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const locationDetail = neighborhood ? `שכונת ${neighborhood} ב${city}` : city;
      const prompt = `מה המחיר הממוצע למטר רבוע של דירות יד שנייה (לא פינוי בינוי, לא חדש מקבלן) ב${locationDetail}?
אני מחפש מחיר ממוצע למ"ר של דירות בבניינים רגילים (ישנים, לפני פינוי בינוי) באזור.
החזר רק מספר אחד - המחיר הממוצע למ"ר בש"ח. 
פורמט: {"avg_price_per_sqm": NUMBER, "source": "TEXT", "confidence": "high/medium/low"}`;

      const response = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'You are a real estate price analyst for Israel. Return ONLY valid JSON. No explanations.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const content = response.data.choices?.[0]?.message?.content || '';
      logger.debug(`Perplexity benchmark response for ${city}: ${content.substring(0, 200)}`);
      
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`Perplexity benchmark no JSON found for ${city}: ${content.substring(0, 100)}`);
        if (attempt < MAX_RETRIES) { await sleep(RATE_LIMIT_DELAY); continue; }
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const avgPsm = parseFloat(parsed.avg_price_per_sqm);

      if (!avgPsm || avgPsm < 5000 || avgPsm > 200000) {
        logger.warn(`Perplexity benchmark unrealistic for ${city}: ${avgPsm}`);
        return null;
      }

      logger.info(`Perplexity benchmark for ${city}: ${avgPsm}/sqm (confidence: ${parsed.confidence || 'unknown'})`);

      return {
        benchmark_psm: Math.round(avgPsm),
        tx_count: 0,
        complex_count: 0,
        source: 'perplexity',
        confidence: parsed.confidence || 'medium',
        perplexity_source: parsed.source || ''
      };

    } catch (err) {
      logger.warn(`Perplexity benchmark attempt ${attempt + 1} failed for ${city}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RATE_LIMIT_DELAY);
      } else {
        return null;
      }
    }
  }
  return null;
}

/**
 * Calculate benchmark and actual_premium for a single complex
 */
async function calculateBenchmark(complexId) {
  try {
    const complex = await pool.query(
      `SELECT id, name, city, neighborhood, status, 
              theoretical_premium_min, theoretical_premium_max
       FROM complexes WHERE id = $1`,
      [complexId]
    );

    if (complex.rows.length === 0) return null;
    const { name, city, neighborhood, theoretical_premium_min, theoretical_premium_max } = complex.rows[0];

    const complexPrice = await getComplexAvgPrice(complexId);
    if (!complexPrice) {
      logger.debug(`No transaction data for benchmark: ${name} (${city})`);
      return null;
    }

    logger.info(`Benchmark calculating for "${name}" (${city}): complex avg=${complexPrice.avg_price_per_sqm}/sqm, ${complexPrice.tx_count} transactions`);

    let benchmark = await getInternalBenchmark(complexId, city);
    
    if (!benchmark) {
      benchmark = await getPerplexityBenchmark(name, city, neighborhood);
    }

    if (!benchmark) {
      logger.info(`No benchmark data available for ${name} (${city}) - skipping`);
      return null;
    }

    const actualPremium = ((complexPrice.avg_price_per_sqm - benchmark.benchmark_psm) / benchmark.benchmark_psm) * 100;

    const theoreticalMid = (parseFloat(theoretical_premium_min || 0) + parseFloat(theoretical_premium_max || 0)) / 2;
    const premiumGap = theoreticalMid - actualPremium;

    await pool.query(
      `UPDATE complexes SET 
        actual_premium = $1,
        premium_gap = $2,
        updated_at = NOW()
       WHERE id = $3`,
      [Math.round(actualPremium * 100) / 100, Math.round(premiumGap * 100) / 100, complexId]
    );

    await pool.query(
      `INSERT INTO benchmarks (complex_id, benchmark_city, benchmark_price_sqm, num_transactions, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [complexId, city, benchmark.benchmark_psm, benchmark.tx_count,
       complexPrice.period_start, complexPrice.period_end]
    );

    const result = {
      complexId,
      name,
      city,
      complex_avg_psm: complexPrice.avg_price_per_sqm,
      benchmark_psm: benchmark.benchmark_psm,
      benchmark_source: benchmark.source,
      actual_premium: Math.round(actualPremium * 100) / 100,
      theoretical_mid: theoreticalMid,
      premium_gap: Math.round(premiumGap * 100) / 100,
      tx_count: complexPrice.tx_count,
      status: 'success'
    };

    logger.info(`Benchmark for "${name}": complex=${complexPrice.avg_price_per_sqm}/sqm, ` +
      `benchmark=${benchmark.benchmark_psm}/sqm (${benchmark.source}), ` +
      `premium=${actualPremium.toFixed(1)}%, gap=${premiumGap.toFixed(1)}%`);

    return result;

  } catch (err) {
    logger.error(`Benchmark calculation failed for complex ${complexId}`, { error: err.message, stack: err.stack });
    return { complexId, status: 'error', error: err.message };
  }
}

/**
 * Calculate benchmarks for all complexes (or filtered subset)
 */
async function calculateAllBenchmarks(options = {}) {
  const { city, limit, force } = options;

  let query = `
    SELECT DISTINCT c.id, c.name, c.city, c.iai_score 
    FROM complexes c
    INNER JOIN transactions t ON c.id = t.complex_id 
      AND t.price_per_sqm IS NOT NULL 
      AND t.price_per_sqm > 5000
    WHERE 1=1
  `;
  const params = [];

  if (city) {
    params.push(city);
    query += ` AND c.city = $${params.length}`;
  }

  if (!force) {
    query += ` AND (c.actual_premium IS NULL OR c.updated_at < NOW() - INTERVAL '7 days')`;
  }

  query += ' ORDER BY c.iai_score DESC NULLS LAST';

  if (limit) {
    params.push(limit);
    query += ` LIMIT $${params.length}`;
  }

  const complexes = await pool.query(query, params);
  logger.info(`Benchmark calculation starting for ${complexes.rows.length} complexes with transaction data`);

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
      
      if (result && result.status === 'success') {
        results.calculated++;
      } else if (result && result.status === 'error') {
        results.errors++;
      } else {
        results.skipped++;
      }

      if (result) results.details.push(result);

      await sleep(RATE_LIMIT_DELAY);

    } catch (err) {
      results.errors++;
      logger.warn(`Benchmark failed for ${complex.name}`, { error: err.message });
    }
  }

  logger.info(`Benchmark complete: ${results.calculated} calculated, ${results.skipped} skipped, ${results.errors} errors`);
  return results;
}

module.exports = { calculateAllBenchmarks, calculateBenchmark };
