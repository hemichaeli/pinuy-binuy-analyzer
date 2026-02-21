/**
 * Neighborhood Benchmark Service
 *
 * Calculates a hyper-local price benchmark for each complex by:
 * 1. Fetching real closed transactions from nadlan.gov.il for nearby streets
 * 2. Fetching market data from madlan.co.il via Perplexity
 * 3. Computing a weighted average (60% nadlan / 40% madlan)
 * 4. Flagging data quality issues when sources diverge > 20%
 *
 * This replaces city_avg_price_sqm as the benchmark for actual_premium calculation.
 * city_avg_price_sqm is retained as a separate signal for neighborhood quality.
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryPerplexity, parseJsonResponse } = require('./perplexityService');

const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const DELAY_MS = 3000;
const MAX_TRANSACTIONS_AGE_MONTHS = 24;
const BENCHMARK_DIVERGENCE_THRESHOLD = 20; // % gap that triggers data_flag
const NADLAN_WEIGHT = 0.60;
const MADLAN_WEIGHT = 0.40;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse an address string into street name and house number.
 * Handles formats like: "רחוב שנקר 10-14, שכונת אגרובנק, חולון"
 */
function parseAddress(addressStr) {
  if (!addressStr) return null;

  // Strip prefixes like "רחוב", "שדרות", "דרך", "סמטת"
  const cleaned = addressStr
    .replace(/^(רחוב|שדרות|דרך|סמטת|שד'|רח')\s+/i, '')
    .trim();

  // Extract street name and first number
  const match = cleaned.match(/^([^\d,]+?)\s+(\d+)/);
  if (!match) {
    // No number found - return street name only
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
 * Returns up to 5 streets to query.
 */
function extractStreets(complex) {
  const addressText = complex.addresses || complex.address || '';
  if (!addressText) return [];

  const streets = new Set();

  // Split by semicolons, commas, or newlines - each segment may be an address
  const segments = addressText.split(/[;,\n]+/);

  for (const seg of segments) {
    const parsed = parseAddress(seg.trim());
    if (parsed && parsed.street && parsed.street.length > 2) {
      // Filter out neighborhood descriptions (too long = not a street name)
      if (parsed.street.length < 40) {
        streets.add(parsed.street);
      }
    }
  }

  return Array.from(streets).slice(0, 5);
}

/**
 * Fetch transactions from nadlan.gov.il for a specific street in a city.
 * Returns array of transactions with price_per_sqm calculated.
 */
async function fetchNadlanStreet(street, city) {
  try {
    const payload = {
      ObjectID: '',
      CurrentLavel: 1,
      PageNo: 1,
      OrderByFilled: 'DEALDATETIME',
      OrderByDescend: true,
      TblArea: '',
      TblDistrict: '',
      TblCity: city,
      TblStreet: street,
      TblHouseNum: '',
      FromDate: '',
      ToDate: '',
      Rone: '',
      Polygon: '',
      FromPrice: '',
      ToPrice: '',
      FromRoom: '',
      ToRoom: '',
      FromFloor: '',
      ToFloor: '',
      FromBuildYear: '',
      ToBuildYear: '',
      FromArea: '',
      ToArea: ''
    };

    const response = await axios.post(NADLAN_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const data = response.data;
    const results = data.AllResults || data.ResultLavel1 || [];

    if (!Array.isArray(results)) return [];

    // Filter to last MAX_TRANSACTIONS_AGE_MONTHS and apartments only
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - MAX_TRANSACTIONS_AGE_MONTHS);

    return results
      .filter(tx => {
        if (!tx.DEALAMOUNT || parseFloat(tx.DEALAMOUNT) <= 0) return false;
        if (!tx.ASSETAREA || parseFloat(tx.ASSETAREA) <= 0) return false;
        // Only residential apartments
        const assetType = (tx.ASSETTYPE || '').toLowerCase();
        if (assetType && !assetType.includes('דירה') && !assetType.includes('מגורים')) return false;
        // Date filter
        if (tx.DEALDATETIME) {
          const dealDate = new Date(tx.DEALDATETIME);
          if (dealDate < cutoff) return false;
        }
        return true;
      })
      .map(tx => {
        const price = parseFloat(tx.DEALAMOUNT);
        const area = parseFloat(tx.ASSETAREA);
        const pricePerSqm = area > 0 ? Math.round(price / area) : null;
        return {
          street,
          address: `${tx.ASSETADDRESS || street} ${tx.ASSETHOUSENUMBER || ''}`.trim(),
          price,
          area_sqm: area,
          price_per_sqm: pricePerSqm,
          date: tx.DEALDATETIME || null,
          source: 'nadlan_gov'
        };
      })
      .filter(tx => tx.price_per_sqm && tx.price_per_sqm > 3000 && tx.price_per_sqm < 150000);

  } catch (err) {
    logger.warn(`[Benchmark] nadlan error for ${street}, ${city}: ${err.message}`);
    return [];
  }
}

/**
 * Build Perplexity query to get madlan neighborhood data for a complex.
 */
function buildMadlanBenchmarkQuery(complex, streets) {
  const streetList = streets.join(', ');
  return `What is the average price per square meter for residential apartments sold in the last 24 months near these streets in ${complex.city}, Israel: ${streetList}

Search madlan.co.il and nadlan.gov.il for recent closed transactions (not asking prices).

Return ONLY a JSON object, no other text:
{"madlan_avg_price_sqm": NUMBER, "madlan_transactions_count": NUMBER, "data_quality": "high/medium/low", "streets_found": ["list"], "notes": "brief note"}

If you cannot find specific transaction data, estimate based on the neighborhood average for ${complex.city}. Always return the JSON.`;
}

/**
 * Fetch madlan benchmark data via Perplexity.
 */
async function fetchMadlanBenchmark(complex, streets) {
  try {
    const prompt = buildMadlanBenchmarkQuery(complex, streets);
    const systemPrompt = `You are a real estate data extraction assistant for Israel. Return ONLY valid JSON. No explanations, no markdown, no code blocks. Just the raw JSON object.`;

    const rawResponse = await queryPerplexity(prompt, systemPrompt);
    
    // Try multiple parsing strategies
    let data = null;
    
    // Strategy 1: Direct parse
    try { data = JSON.parse(rawResponse); } catch(e) {}
    
    // Strategy 2: Extract from markdown code block
    if (!data) {
      const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) try { data = JSON.parse(jsonMatch[1].trim()); } catch(e) {}
    }
    
    // Strategy 3: Find JSON object in text
    if (!data) {
      const objectMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (objectMatch) try { data = JSON.parse(objectMatch[0]); } catch(e) {}
    }
    
    // Strategy 4: Extract numbers from text if JSON fails
    if (!data) {
      const priceMatch = rawResponse.match(/(\d{2,3}[,.]?\d{3})\s*(?:₪|שקל|ILS|ש\"ח)?\s*(?:per|ל)\s*(?:sqm|square|מ\"ר|מטר)/i) ||
                         rawResponse.match(/(?:average|ממוצע|price per|מחיר ל)[\s\S]{0,50}?(\d{2,3}[,.]?\d{3})/i) ||
                         rawResponse.match(/(\d{2,3}[,.]?\d{3})\s*(?:₪|שקל|ILS|ש\"ח)\s*\/\s*(?:sqm|מ\"ר)/i);
      
      if (priceMatch) {
        const priceStr = priceMatch[1].replace(',', '');
        const price = parseInt(priceStr);
        if (price > 5000 && price < 150000) {
          data = {
            madlan_avg_price_sqm: price,
            madlan_transactions_count: 0,
            data_quality: 'low',
            notes: 'Extracted from unstructured Perplexity response'
          };
          logger.info(`[Benchmark] Extracted madlan price from text: ${price} for ${complex.name}`);
        }
      }
    }

    if (!data || !data.madlan_avg_price_sqm || data.madlan_avg_price_sqm <= 0) {
      logger.warn(`[Benchmark] No madlan data parsed for ${complex.name}`, { responsePreview: rawResponse.substring(0, 300) });
      return null;
    }

    return {
      avg_price_sqm: Math.round(data.madlan_avg_price_sqm),
      transactions_count: data.madlan_transactions_count || 0,
      data_quality: data.data_quality || 'medium',
      streets_found: data.streets_found || streets,
      freshness: data.madlan_data_freshness || null
    };

  } catch (err) {
    logger.warn(`[Benchmark] madlan Perplexity error for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Calculate weighted neighborhood average from nadlan + madlan data.
 * Returns benchmark object with avg, source info, and quality flags.
 */
function calculateWeightedBenchmark(nadlanAvg, nadlanCount, madlanData, cityAvg) {
  const results = { nadlan: null, madlan: null, weighted: null, source: null, flag: false, gap: null };

  if (nadlanAvg && nadlanAvg > 0) results.nadlan = nadlanAvg;
  if (madlanData && madlanData.avg_price_sqm > 0) results.madlan = madlanData.avg_price_sqm;

  if (results.nadlan && results.madlan) {
    // Both sources available - weighted average
    results.weighted = Math.round(
      results.nadlan * NADLAN_WEIGHT + results.madlan * MADLAN_WEIGHT
    );
    results.source = 'nadlan+madlan';

    // Check divergence - flag if > threshold
    const gap = Math.abs(results.nadlan - results.madlan) / results.nadlan * 100;
    results.gap = Math.round(gap);
    results.flag = gap > BENCHMARK_DIVERGENCE_THRESHOLD;

  } else if (results.nadlan) {
    results.weighted = results.nadlan;
    results.source = 'nadlan_only';
  } else if (results.madlan) {
    results.weighted = results.madlan;
    results.source = 'madlan_only';
  } else {
    // Fallback to city average with penalty note
    results.weighted = cityAvg || null;
    results.source = 'city_avg_fallback';
  }

  // premium_vs_city: how this neighborhood compares to city average
  if (results.weighted && cityAvg && cityAvg > 0) {
    results.premiumVsCity = Math.round(
      (results.weighted - cityAvg) / cityAvg * 100
    );
  }

  return results;
}

/**
 * Main function: fetch and store neighborhood benchmark for a single complex.
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

  // Fetch from nadlan for each street
  let allNadlanTransactions = [];
  for (const street of streets) {
    const txs = await fetchNadlanStreet(street, complex.city);
    allNadlanTransactions = allNadlanTransactions.concat(txs);
    await sleep(1500);
  }

  // Calculate nadlan average
  let nadlanAvg = null;
  if (allNadlanTransactions.length > 0) {
    const validPrices = allNadlanTransactions
      .map(tx => tx.price_per_sqm)
      .filter(p => p && p > 0);
    if (validPrices.length > 0) {
      nadlanAvg = Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length);
    }
  }

  // Fetch madlan via Perplexity
  await sleep(DELAY_MS);
  const madlanData = await fetchMadlanBenchmark(complex, streets);

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

  logger.info(`[Benchmark] Done: ${complex.name} | nadlan=${nadlanAvg} | madlan=${madlanData?.avg_price_sqm || 'N/A'} | weighted=${benchmark.weighted} | flag=${benchmark.flag} | actual_premium=${actualPremium}%`);

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
 * Options: { limit, tier, city, staleOnly }
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

  // Prioritize: complexes with addresses first, Tier 1 first within those
  query += ' ORDER BY (CASE WHEN address IS NOT NULL AND length(address) > 10 THEN 0 ELSE 1 END), iai_score DESC NULLS LAST';

  if (limit) {
    query += ` LIMIT $${idx++}`;
    params.push(limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`[Benchmark] Starting batch scan: ${total} complexes`);

  const results = { total, processed: 0, success: 0, no_address: 0, failed: 0, flagged: 0 };

  for (let i = 0; i < complexes.rows.length; i++) {
    const complex = complexes.rows[i];
    try {
      const result = await fetchNeighborhoodBenchmark(complex.id);
      results.processed++;

      if (result.status === 'success') results.success++;
      else if (result.status === 'no_address') results.no_address++;
      if (result.dataFlag) results.flagged++;

      logger.info(`[Benchmark ${i + 1}/${total}] ${complex.name}: ${result.status}`);
    } catch (err) {
      results.processed++;
      results.failed++;
      logger.error(`[Benchmark ${i + 1}/${total}] ${complex.name}: ERROR - ${err.message}`);
    }

    if (i < complexes.rows.length - 1) await sleep(DELAY_MS);
  }

  logger.info('[Benchmark] Batch completed', results);
  return results;
}

module.exports = {
  fetchNeighborhoodBenchmark,
  scanNeighborhoodBenchmarks,
  extractStreets,
  parseAddress,
  calculateWeightedBenchmark
};
