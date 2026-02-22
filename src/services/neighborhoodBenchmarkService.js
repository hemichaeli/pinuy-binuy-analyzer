/**
 * Neighborhood Benchmark Service v2
 *
 * Dual-engine architecture:
 * - Claude (web_search): nadlan.gov.il closed transactions (complex Hebrew analysis)
 * - Gemini Flash (Google Search): madlan/yad2 market data (fast, cheap, Google search)
 * Both run in PARALLEL for speed, then results are merged.
 *
 * Calculates a hyper-local price benchmark for each complex by:
 * 1. Fetching real closed transactions via Claude web_search (nadlan.gov.il data)
 * 2. Fetching market data via Gemini Google Search (madlan/yad2 data)
 * 3. Computing a weighted average (60% nadlan / 40% madlan)
 * 4. Flagging data quality issues when sources diverge > 20%
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { fetchNadlanViaClaude } = require('./claudeEnrichmentService');
const { fetchMadlanViaGemini } = require('./geminiEnrichmentService');

const DELAY_MS = 2000;
const BENCHMARK_DIVERGENCE_THRESHOLD = 20; // % gap that triggers data_flag
const NADLAN_WEIGHT = 0.60;
const MADLAN_WEIGHT = 0.40;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse an address string into street name and house number.
 */
function parseAddress(addressStr) {
  if (!addressStr) return null;

  const cleaned = addressStr
    .replace(/^(רחוב|שדרות|דרך|סמטת|שד'|רח')\s+/i, '')
    .trim();

  const match = cleaned.match(/^([^\d,]+?)\s+(\d+)/);
  if (!match) {
    const streetOnly = cleaned.split(',')[0].trim();
    return { street: streetOnly, houseNum: '' };
  }

  return {
    street: match[1].trim(),
    houseNum: match[2]
  };
}

/**
 * Extract all unique street names from a complex's addresses field.
 */
function extractStreets(complex) {
  const addressText = complex.addresses || complex.address || '';
  if (!addressText) return [];

  const streets = new Set();
  const segments = addressText.split(/[;,\n]+/);

  for (const seg of segments) {
    const parsed = parseAddress(seg.trim());
    if (parsed && parsed.street && parsed.street.length > 2) {
      if (parsed.street.length < 40) {
        streets.add(parsed.street);
      }
    }
  }

  return Array.from(streets).slice(0, 5);
}

/**
 * Calculate weighted neighborhood average from nadlan + madlan data.
 */
function calculateWeightedBenchmark(nadlanAvg, nadlanCount, madlanData, cityAvg) {
  const results = { nadlan: null, madlan: null, weighted: null, source: null, flag: false, gap: null };

  if (nadlanAvg && nadlanAvg > 0) results.nadlan = nadlanAvg;
  if (madlanData && madlanData.avg_price_sqm > 0) results.madlan = madlanData.avg_price_sqm;

  if (results.nadlan && results.madlan) {
    results.weighted = Math.round(
      results.nadlan * NADLAN_WEIGHT + results.madlan * MADLAN_WEIGHT
    );
    results.source = 'claude_nadlan+gemini_madlan';

    const gap = Math.abs(results.nadlan - results.madlan) / results.nadlan * 100;
    results.gap = Math.round(gap);
    results.flag = gap > BENCHMARK_DIVERGENCE_THRESHOLD;

  } else if (results.nadlan) {
    results.weighted = results.nadlan;
    results.source = 'claude_nadlan_only';
  } else if (results.madlan) {
    results.weighted = results.madlan;
    results.source = 'gemini_madlan_only';
  } else {
    results.weighted = cityAvg || null;
    results.source = 'city_avg_fallback';
  }

  if (results.weighted && cityAvg && cityAvg > 0) {
    results.premiumVsCity = Math.round(
      (results.weighted - cityAvg) / cityAvg * 100
    );
  }

  return results;
}

/**
 * Main function: fetch and store neighborhood benchmark for a single complex.
 * Runs Claude (nadlan) and Gemini (madlan) in PARALLEL for speed.
 */
async function fetchNeighborhoodBenchmark(complexId) {
  const result = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (result.rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = result.rows[0];
  logger.info(`[Benchmark] Starting: ${complex.name} (${complex.city})`);

  // Extract streets from address
  const streets = extractStreets(complex);
  if (streets.length === 0) {
    logger.warn(`[Benchmark] No streets found for ${complex.name} - skipping`);
    return { complexId, name: complex.name, status: 'no_address', streets: 0 };
  }

  // Run Claude (nadlan) and Gemini (madlan) in PARALLEL
  const [claudeResult, geminiResult] = await Promise.allSettled([
    fetchNadlanViaClaude(complex, streets),
    fetchMadlanViaGemini(complex, streets)
  ]);

  // Process nadlan (Claude) result
  let nadlanAvg = null;
  let allNadlanTransactions = [];
  if (claudeResult.status === 'fulfilled' && claudeResult.value && claudeResult.value.avg_price_sqm > 0) {
    nadlanAvg = claudeResult.value.avg_price_sqm;
    allNadlanTransactions = [{ price_per_sqm: nadlanAvg, source: 'nadlan_via_claude' }];
    logger.info(`[Benchmark] Claude nadlan: ${nadlanAvg} ILS/sqm (${claudeResult.value.data_quality})`);
  } else {
    const reason = claudeResult.status === 'rejected' ? claudeResult.reason?.message : 'no data';
    logger.info(`[Benchmark] Claude nadlan: null (${reason})`);
  }

  // Process madlan (Gemini) result
  let madlanData = null;
  if (geminiResult.status === 'fulfilled' && geminiResult.value && geminiResult.value.avg_price_sqm > 0) {
    madlanData = geminiResult.value;
    logger.info(`[Benchmark] Gemini madlan: ${madlanData.avg_price_sqm} ILS/sqm (${madlanData.data_quality})`);
  } else {
    const reason = geminiResult.status === 'rejected' ? geminiResult.reason?.message : 'no data';
    logger.info(`[Benchmark] Gemini madlan: null (${reason})`);
  }

  // Calculate weighted benchmark
  const cityAvg = complex.city_avg_price_sqm ? parseFloat(complex.city_avg_price_sqm) : null;
  const benchmark = calculateWeightedBenchmark(nadlanAvg, allNadlanTransactions.length, madlanData, cityAvg);

  // Calculate actual_premium using neighborhood benchmark
  const pricePerSqm = complex.price_per_sqm ? parseFloat(complex.price_per_sqm) : null;
  let actualPremium = null;
  if (pricePerSqm && benchmark.weighted && benchmark.weighted > 0) {
    actualPremium = Math.round((pricePerSqm - benchmark.weighted) / benchmark.weighted * 100);
  }

  // Store to DB
  await pool.query(`
    UPDATE complexes SET
      nadlan_neighborhood_avg_sqm = $1,
      madlan_neighborhood_avg_sqm = $2,
      neighborhood_avg_sqm = $3,
      neighborhood_streets = $4,
      neighborhood_benchmark_source = $5,
      benchmark_source_gap = $6,
      benchmark_data_flag = $7,
      premium_vs_city = $8,
      last_benchmark_update = NOW(),
      actual_premium = COALESCE($9, actual_premium),
      updated_at = NOW()
    WHERE id = $10
  `, [
    nadlanAvg,
    madlanData?.avg_price_sqm || null,
    benchmark.weighted,
    JSON.stringify(streets),
    benchmark.source,
    benchmark.gap,
    benchmark.flag,
    benchmark.premiumVsCity || null,
    actualPremium,
    complexId
  ]);

  logger.info(`[Benchmark] Done: ${complex.name} | nadlan=${nadlanAvg} | madlan=${madlanData?.avg_price_sqm || 'N/A'} | weighted=${benchmark.weighted} | source=${benchmark.source} | actual_premium=${actualPremium}%`);

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    streets,
    nadlanTransactions: allNadlanTransactions.length,
    nadlanAvg,
    madlanAvg: madlanData?.avg_price_sqm || null,
    neighborhoodAvg: benchmark.weighted,
    benchmarkSource: benchmark.source,
    divergenceGap: benchmark.gap,
    dataFlag: benchmark.flag,
    premiumVsCity: benchmark.premiumVsCity,
    actualPremium,
    status: benchmark.weighted ? 'success' : 'no_data'
  };
}

/**
 * Batch scan - runs neighborhood benchmark for all complexes or filtered set.
 */
async function scanNeighborhoodBenchmarks(options = {}) {
  const { limit, city, staleOnly = true } = options;

  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let idx = 1;

  if (city) {
    query += ` AND city = $${idx++}`;
    params.push(city);
  }

  if (staleOnly) {
    query += ` AND (last_benchmark_update IS NULL OR last_benchmark_update < NOW() - INTERVAL '30 days')`;
  }

  query += ' ORDER BY (CASE WHEN address IS NOT NULL AND length(address) > 10 THEN 0 ELSE 1 END), iai_score DESC NULLS LAST';

  if (limit) {
    query += ` LIMIT $${idx++}`;
    params.push(limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`[Benchmark] Starting dual-engine batch: ${total} complexes (Claude+Gemini parallel)`);

  const results = { total, processed: 0, success: 0, no_address: 0, failed: 0, flagged: 0 };

  for (let i = 0; i < complexes.rows.length; i++) {
    const complex = complexes.rows[i];
    try {
      const result = await fetchNeighborhoodBenchmark(complex.id);
      results.processed++;

      if (result.status === 'success') results.success++;
      else if (result.status === 'no_address') results.no_address++;
      if (result.dataFlag) results.flagged++;

      logger.info(`[Benchmark ${i + 1}/${total}] ${complex.name}: ${result.status} (${result.benchmarkSource})`);
    } catch (err) {
      results.processed++;
      results.failed++;
      logger.error(`[Benchmark ${i + 1}/${total}] ${complex.name}: ERROR - ${err.message}`);
    }

    // Shorter delay since both engines run in parallel
    if (i < complexes.rows.length - 1) await sleep(DELAY_MS);
  }

  logger.info('[Benchmark] Dual-engine batch completed', results);
  return results;
}

module.exports = {
  fetchNeighborhoodBenchmark,
  scanNeighborhoodBenchmarks,
  extractStreets,
  parseAddress,
  calculateWeightedBenchmark
};
