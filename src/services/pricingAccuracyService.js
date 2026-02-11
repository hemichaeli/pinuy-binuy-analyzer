/**
 * Pricing Accuracy Service - Phase 4.5
 * מקורות: Yad2 מחירי מכירה, מדד הלמ"ס, נתוני בנק ישראל
 */

const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const CBS_REGIONS = {
  'תל אביב': 'תל אביב יפו',
  'גוש דן': ['רמת גן', 'גבעתיים', 'בני ברק', 'חולון', 'בת ים'],
  'מרכז': ['פתח תקווה', 'ראשון לציון', 'רחובות', 'נס ציונה', 'לוד', 'רמלה'],
  'שרון': ['הרצליה', 'רעננה', 'כפר סבא', 'הוד השרון', 'נתניה'],
  'ירושלים': 'ירושלים',
  'חיפה': ['חיפה', 'קריות', 'עכו']
};

async function searchWithPerplexity(query, context = '') {
  if (!PERPLEXITY_API_KEY) return null;
  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{ role: 'system', content: `אתה מומחה למחירי נדל"ן בישראל. ${context}` }, { role: 'user', content: query }],
        temperature: 0.1, max_tokens: 2000
      })
    });
    if (!response.ok) throw new Error(`Perplexity API error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.error('Perplexity search failed', { error: err.message });
    return null;
  }
}

async function getYad2SoldPrices(city, street = null, rooms = null) {
  logger.info('Fetching Yad2 sold prices', { city, street, rooms });
  const locationFilter = street ? `ברחוב ${street} ב${city}` : `ב${city}`;
  const roomsFilter = rooms ? `${rooms} חדרים` : '';
  const query = `מחירי מכירה בפועל של דירות ${roomsFilter} ${locationFilter} מהחודשים האחרונים. החזר JSON: {"avgPricePerSqm": number, "minPrice": number, "maxPrice": number, "sampleSize": number, "recentSales": []}`;
  const result = await searchWithPerplexity(query, 'התמקד במחירי סגירה בפועל, לא מחירי פרסום');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'yad2_sold', ...JSON.parse(jsonMatch[0]), rawResponse: result };
  } catch (e) {}
  return { source: 'yad2_sold', rawResponse: result };
}

async function getCBSPriceIndex(city) {
  logger.info('Fetching CBS price index', { city });
  const query = `מדד מחירי הדירות של הלמ"ס עבור ${city}. החזר JSON: {"currentIndex": number, "quarterlyChange": number, "yearlyChange": number, "trend": "rising|falling|stable"}`;
  const result = await searchWithPerplexity(query, 'נתונים מהלשכה המרכזית לסטטיסטיקה');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'cbs', city, ...JSON.parse(jsonMatch[0]), rawResponse: result };
  } catch (e) {}
  return { source: 'cbs', city, rawResponse: result };
}

async function getBOIMortgageStats(city = null) {
  logger.info('Fetching BOI mortgage stats', { city });
  const locationFilter = city ? `ב${city}` : 'בישראל';
  const query = `נתוני משכנתאות מבנק ישראל ${locationFilter}. החזר JSON: {"avgLTV": number, "avgInterestRate": number, "creditVolume": number, "defaultRate": number, "trend": ""}`;
  const result = await searchWithPerplexity(query, 'נתונים מבנק ישראל');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'boi', ...JSON.parse(jsonMatch[0]), rawResponse: result };
  } catch (e) {}
  return { source: 'boi', rawResponse: result };
}

async function calculateAccurateBenchmark(complex, pool) {
  logger.info('Calculating accurate benchmark', { complexId: complex.id, city: complex.city });

  const results = {
    complexId: complex.id, complexName: complex.name, city: complex.city,
    sources: [], weightedPricePerSqm: null, confidenceScore: 0, priceTrend: 'unknown',
    timestamp: new Date().toISOString()
  };

  const weights = { nadlan_db: 0.4, yad2_sold: 0.3, cbs_index: 0.2, boi_mortgage: 0.1 };
  let totalWeight = 0, weightedSum = 0;

  try {
    // Source 1: Database transactions (using transaction_date, not deal_date)
    const dbTransactions = await pool.query(`
      SELECT AVG(price_per_sqm) as avg_price, COUNT(*) as count, MAX(transaction_date) as latest
      FROM transactions WHERE city = $1 AND transaction_date > NOW() - INTERVAL '12 months'
    `, [complex.city]);

    if (dbTransactions.rows[0]?.avg_price) {
      const avgPrice = parseFloat(dbTransactions.rows[0].avg_price);
      results.sources.push({ source: 'nadlan_db', pricePerSqm: avgPrice, sampleSize: parseInt(dbTransactions.rows[0].count), weight: weights.nadlan_db });
      weightedSum += avgPrice * weights.nadlan_db;
      totalWeight += weights.nadlan_db;
    }

    // Source 2: Yad2 sold prices
    const yad2Data = await getYad2SoldPrices(complex.city, complex.street);
    if (yad2Data.avgPricePerSqm) {
      results.sources.push({ source: 'yad2_sold', pricePerSqm: yad2Data.avgPricePerSqm, sampleSize: yad2Data.sampleSize, weight: weights.yad2_sold });
      weightedSum += yad2Data.avgPricePerSqm * weights.yad2_sold;
      totalWeight += weights.yad2_sold;
    }

    // Source 3: CBS index
    const cbsData = await getCBSPriceIndex(complex.city);
    if (cbsData.currentIndex) {
      results.sources.push({ source: 'cbs_index', index: cbsData.currentIndex, trend: cbsData.trend, weight: weights.cbs_index });
      results.priceTrend = cbsData.trend || 'unknown';
    }

    // Source 4: BOI mortgage
    const boiData = await getBOIMortgageStats(complex.city);
    if (boiData.avgInterestRate) {
      results.sources.push({ source: 'boi_mortgage', interestRate: boiData.avgInterestRate, ltv: boiData.avgLTV, weight: weights.boi_mortgage });
    }

    // Calculate weighted average
    if (totalWeight > 0) {
      results.weightedPricePerSqm = Math.round(weightedSum / totalWeight);
      results.confidenceScore = Math.round((totalWeight / (weights.nadlan_db + weights.yad2_sold)) * 100);

      // Calculate premium price based on project status
      const premiumMultipliers = { 'הוכרז': 1.20, 'בתכנון': 1.25, 'מאושר': 1.30, 'בבנייה': 1.40 };
      const multiplier = premiumMultipliers[complex.status] || 1.25;
      results.estimatedPremiumPrice = Math.round(results.weightedPricePerSqm * multiplier);
    }

    logger.info('Accurate benchmark calculated', { complexId: complex.id, pricePerSqm: results.weightedPricePerSqm, confidence: results.confidenceScore });

  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message, complexId: complex.id });
    results.error = err.message;
  }

  return results;
}

async function getCityPricingStats(city) {
  logger.info('Getting city pricing stats', { city });
  const results = { city, timestamp: new Date().toISOString(), sources: {} };
  results.sources.yad2 = await getYad2SoldPrices(city);
  results.sources.cbs = await getCBSPriceIndex(city);
  results.sources.boi = await getBOIMortgageStats(city);
  return results;
}

async function compareComplexPrices(city, pool) {
  logger.info('Comparing complex prices', { city });

  const cityStats = await getCityPricingStats(city);
  const cityAvg = cityStats.sources.yad2?.avgPricePerSqm || null;

  const complexes = await pool.query(`
    SELECT id, name, address, status, avg_price_sqm, iai_score
    FROM complexes WHERE city = $1 AND avg_price_sqm IS NOT NULL
    ORDER BY avg_price_sqm ASC
  `, [city]);

  return {
    city, cityAvgPricePerSqm: cityAvg,
    complexes: complexes.rows.map(c => ({
      id: c.id, name: c.name, address: c.address, status: c.status,
      pricePerSqm: c.avg_price_sqm, iaiScore: c.iai_score,
      vsCity: cityAvg ? Math.round(((c.avg_price_sqm - cityAvg) / cityAvg) * 100) : null
    }))
  };
}

async function batchUpdatePricing(pool, options = {}) {
  logger.info('Starting batch pricing update', options);
  const { city, limit, staleOnly } = options;

  let query = `SELECT * FROM complexes WHERE 1=1`;
  const params = [];
  let paramIndex = 1;

  if (city) { query += ` AND city = $${paramIndex++}`; params.push(city); }
  if (staleOnly) { query += ` AND (price_last_updated IS NULL OR price_last_updated < NOW() - INTERVAL '7 days')`; }
  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${paramIndex}`;
  params.push(parseInt(limit) || 50);

  const complexes = await pool.query(query, params);
  let updated = 0;

  for (const complex of complexes.rows) {
    try {
      const benchmark = await calculateAccurateBenchmark(complex, pool);
      if (benchmark.weightedPricePerSqm) {
        await pool.query(`
          UPDATE complexes SET accurate_price_sqm = $1, price_confidence_score = $2, price_trend = $3,
            estimated_premium_price = $4, price_last_updated = NOW(), price_sources = $5
          WHERE id = $6
        `, [benchmark.weightedPricePerSqm, benchmark.confidenceScore, benchmark.priceTrend,
            benchmark.estimatedPremiumPrice, JSON.stringify(benchmark.sources), complex.id]);
        updated++;
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      logger.warn(`Pricing update failed for ${complex.name}`, { error: e.message });
    }
  }

  logger.info('Batch pricing update complete', { total: complexes.rows.length, updated });
  return { total: complexes.rows.length, updated };
}

module.exports = {
  getYad2SoldPrices, getCBSPriceIndex, getBOIMortgageStats,
  calculateAccurateBenchmark, getCityPricingStats, compareComplexPrices, batchUpdatePricing, CBS_REGIONS
};
