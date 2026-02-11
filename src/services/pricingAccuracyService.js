/**
 * Pricing Accuracy Service - Phase 4.5
 * מקורות: yad2 מכירות בפועל, מדד המחירים של הלמ"ס, נתוני בנק ישראל
 */

const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const CBS_REGIONS = {
  'תל אביב': 'tel_aviv', 'רמת גן': 'gush_dan', 'גבעתיים': 'gush_dan', 'בני ברק': 'gush_dan',
  'פתח תקווה': 'center', 'ראשון לציון': 'center', 'חולון': 'center', 'בת ים': 'center',
  'הרצליה': 'sharon', 'רעננה': 'sharon', 'כפר סבא': 'sharon', 'נתניה': 'sharon',
  'ירושלים': 'jerusalem', 'חיפה': 'haifa', 'קריית ים': 'haifa', 'קריית ביאליק': 'haifa'
};

async function searchWithPerplexity(query, context = '') {
  if (!PERPLEXITY_API_KEY) return null;
  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{ role: 'system', content: `אתה עוזר מחקר נדל"ן ישראלי. ${context}` }, { role: 'user', content: query }],
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
  const query = `מחירי דירות שנמכרו בפועל ${locationFilter} ${roomsFilter} בחודשים האחרונים. החזר JSON: {"averagePrice": number, "pricePerSqm": number, "sampleSize": number, "priceRange": {"min": number, "max": number}, "recentSales": []}`;
  const result = await searchWithPerplexity(query, 'התמקד במחירי מכירה בפועל, לא מחירי מבוקש');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'yad2_sold', ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'yad2_sold', rawResponse: result, city, street };
}

async function getCBSPriceIndex(city) {
  logger.info('Fetching CBS price index', { city });
  const region = CBS_REGIONS[city] || 'national';
  const query = `מדד מחירי הדירות של הלמ"ס לאזור ${city}. החזר JSON: {"indexValue": number, "quarterlyChange": number, "yearlyChange": number, "trend": "rising|falling|stable", "lastUpdate": ""}`;
  const result = await searchWithPerplexity(query, 'מידע מהלשכה המרכזית לסטטיסטיקה');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'cbs_index', region, ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'cbs_index', region, rawResponse: result };
}

async function getBOIMortgageStats(city = null) {
  logger.info('Fetching BOI mortgage stats', { city });
  const query = `נתוני משכנתאות מבנק ישראל${city ? ` לאזור ${city}` : ''}. החזר JSON: {"avgLTV": number, "avgInterestRate": number, "creditVolume": number, "defaultRate": number, "trend": "expanding|contracting|stable"}`;
  const result = await searchWithPerplexity(query, 'נתונים עדכניים מבנק ישראל');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'boi_mortgage', ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'boi_mortgage', rawResponse: result };
}

async function calculateAccurateBenchmark(complex, pool) {
  logger.info('Calculating accurate benchmark', { complexId: complex.id, city: complex.city });
  const results = {
    complexId: complex.id, complexName: complex.name, city: complex.city,
    sources: [], estimatedPricePerSqm: 0, confidenceScore: 0, priceTrend: 'unknown', timestamp: new Date().toISOString()
  };

  try {
    // Source 1: Database transactions (weight 0.4)
    const dbTransactions = await pool.query(`
      SELECT AVG(price_per_sqm) as avg_price, COUNT(*) as count, MAX(transaction_date) as latest
      FROM transactions WHERE city = $1 AND transaction_date > NOW() - INTERVAL '12 months'
    `, [complex.city]);

    if (dbTransactions.rows[0]?.avg_price) {
      results.sources.push({
        name: 'nadlan_db', weight: 0.4, pricePerSqm: parseFloat(dbTransactions.rows[0].avg_price),
        sampleSize: parseInt(dbTransactions.rows[0].count), latestDate: dbTransactions.rows[0].latest
      });
    }

    // Source 2: Yad2 sold prices (weight 0.3)
    const yad2Prices = await getYad2SoldPrices(complex.city, complex.street);
    if (yad2Prices.pricePerSqm) {
      results.sources.push({ name: 'yad2_sold', weight: 0.3, pricePerSqm: yad2Prices.pricePerSqm, sampleSize: yad2Prices.sampleSize || 5 });
    }

    // Source 3: CBS index (weight 0.2)
    const cbsIndex = await getCBSPriceIndex(complex.city);
    if (cbsIndex.indexValue) {
      const basePrice = 45000; // Base price per sqm for index 100
      const indexedPrice = basePrice * (cbsIndex.indexValue / 100);
      results.sources.push({ name: 'cbs_index', weight: 0.2, pricePerSqm: indexedPrice, indexValue: cbsIndex.indexValue, trend: cbsIndex.trend });
      results.priceTrend = cbsIndex.trend || 'unknown';
    }

    // Source 4: BOI mortgage context (weight 0.1)
    const boiStats = await getBOIMortgageStats(complex.city);
    if (boiStats.avgLTV) {
      results.sources.push({ name: 'boi_mortgage', weight: 0.1, avgLTV: boiStats.avgLTV, avgInterestRate: boiStats.avgInterestRate, marketTrend: boiStats.trend });
    }

    // Calculate weighted average
    let totalWeight = 0, weightedSum = 0;
    for (const source of results.sources) {
      if (source.pricePerSqm && source.weight) {
        weightedSum += source.pricePerSqm * source.weight;
        totalWeight += source.weight;
      }
    }

    if (totalWeight > 0) {
      results.estimatedPricePerSqm = Math.round(weightedSum / totalWeight);
      results.confidenceScore = Math.min(100, Math.round((totalWeight / 1.0) * 100 * (results.sources.length / 4)));

      // Calculate premium price based on project status
      const premiumMultiplier = complex.status === 'construction' ? 1.4 : complex.status === 'approved' ? 1.35 : complex.status === 'planning' ? 1.3 : 1.2;
      results.estimatedPremiumPrice = Math.round(results.estimatedPricePerSqm * premiumMultiplier);
    }

    logger.info('Benchmark calculated', { complexId: complex.id, pricePerSqm: results.estimatedPricePerSqm, confidence: results.confidenceScore });

  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message, complexId: complex.id });
    results.error = err.message;
  }

  return results;
}

async function getCityPricingStats(city) {
  logger.info('Getting city pricing stats', { city });
  const stats = { city, timestamp: new Date().toISOString(), sources: {} };
  stats.sources.yad2 = await getYad2SoldPrices(city);
  stats.sources.cbs = await getCBSPriceIndex(city);
  stats.sources.boi = await getBOIMortgageStats(city);
  return stats;
}

async function compareComplexPrices(city, pool) {
  logger.info('Comparing complex prices', { city });
  const complexes = await pool.query(`SELECT id, name, address, status, accurate_price_sqm, price_confidence_score FROM complexes WHERE city = $1 AND accurate_price_sqm IS NOT NULL ORDER BY accurate_price_sqm DESC`, [city]);
  const cityAvg = complexes.rows.length > 0 ? complexes.rows.reduce((sum, c) => sum + (c.accurate_price_sqm || 0), 0) / complexes.rows.length : 0;
  return {
    city, totalComplexes: complexes.rows.length, cityAveragePrice: Math.round(cityAvg),
    complexes: complexes.rows.map(c => ({
      id: c.id, name: c.name, status: c.status, pricePerSqm: c.accurate_price_sqm,
      vsAverage: cityAvg > 0 ? Math.round(((c.accurate_price_sqm - cityAvg) / cityAvg) * 100) : 0, confidenceScore: c.price_confidence_score
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
  const results = { total: complexes.rows.length, updated: 0, errors: 0 };

  for (const complex of complexes.rows) {
    try {
      const benchmark = await calculateAccurateBenchmark(complex, pool);
      if (benchmark.estimatedPricePerSqm > 0) {
        await pool.query(`
          UPDATE complexes SET accurate_price_sqm = $1, price_confidence_score = $2, price_trend = $3,
            estimated_premium_price = $4, price_last_updated = NOW(), price_sources = $5 WHERE id = $6
        `, [benchmark.estimatedPricePerSqm, benchmark.confidenceScore, benchmark.priceTrend,
            benchmark.estimatedPremiumPrice, JSON.stringify(benchmark.sources), complex.id]);
        results.updated++;
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      logger.warn(`Pricing update failed for ${complex.name}`, { error: err.message });
      results.errors++;
    }
  }

  logger.info('Batch pricing update complete', results);
  return results;
}

module.exports = {
  getYad2SoldPrices, getCBSPriceIndex, getBOIMortgageStats,
  calculateAccurateBenchmark, getCityPricingStats, compareComplexPrices, batchUpdatePricing, CBS_REGIONS
};
