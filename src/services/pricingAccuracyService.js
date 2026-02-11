/**
 * Pricing Accuracy Service - Phase 4.5
 * מקורות: Yad2 sold prices, CBS index, BOI mortgage stats
 */

const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const CBS_REGIONS = {
  'תל אביב': 'תל אביב',
  'רמת גן': 'גוש דן',
  'גבעתיים': 'גוש דן',
  'בני ברק': 'גוש דן',
  'חולון': 'גוש דן',
  'בת ים': 'גוש דן',
  'פתח תקווה': 'מרכז',
  'ראשון לציון': 'מרכז',
  'רחובות': 'מרכז',
  'נתניה': 'שרון',
  'הרצליה': 'שרון',
  'רעננה': 'שרון',
  'כפר סבא': 'שרון',
  'ירושלים': 'ירושלים',
  'חיפה': 'חיפה',
  'קריות': 'חיפה'
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
  logger.info('Getting Yad2 sold prices', { city, street, rooms });
  const locationFilter = street ? `ברחוב ${street} ב${city}` : `ב${city}`;
  const roomsFilter = rooms ? `${rooms} חדרים` : '';
  const query = `מחירי דירות שנמכרו לאחרונה ${locationFilter} ${roomsFilter}. החזר JSON: {"avgPricePerSqm": number, "transactions": [{"price": 0, "sqm": 0, "rooms": 0, "date": ""}], "priceRange": {"min": 0, "max": 0}}`;
  const result = await searchWithPerplexity(query, 'התמקד בעסקאות מהחודשים האחרונים');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'yad2_sold', ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'yad2_sold', rawResponse: result, city, street };
}

async function getCBSPriceIndex(city) {
  logger.info('Getting CBS price index', { city });
  const region = CBS_REGIONS[city] || city;
  const query = `מדד מחירי הדירות של הלמ"ס באזור ${region}? החזר JSON: {"indexValue": number, "quarterlyChange": number, "yearlyChange": number, "trend": "rising|falling|stable"}`;
  const result = await searchWithPerplexity(query, 'מידע מהלשכה המרכזית לסטטיסטיקה');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'cbs_index', region, ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'cbs_index', region, rawResponse: result };
}

async function getBOIMortgageStats(city = null) {
  logger.info('Getting BOI mortgage stats', { city });
  const locationFilter = city ? `באזור ${city}` : 'בישראל';
  const query = `נתוני משכנתאות מבנק ישראל ${locationFilter}? החזר JSON: {"avgLTV": number, "avgInterestRate": number, "creditVolume": number, "defaultRate": number, "trend": "expanding|contracting|stable"}`;
  const result = await searchWithPerplexity(query, 'מידע מבנק ישראל');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { source: 'boi_mortgage', ...JSON.parse(jsonMatch[0]) };
  } catch (e) {}
  return { source: 'boi_mortgage', rawResponse: result };
}

async function calculateAccurateBenchmark(complex, pool) {
  logger.info('Calculating accurate benchmark', { complexId: complex.id });
  const results = {
    complexId: complex.id, complexName: complex.name, city: complex.city, sources: [],
    estimatedPricePerSqm: 0, confidenceScore: 0, priceTrend: 'unknown', timestamp: new Date().toISOString()
  };

  try {
    // Source 1: Database transactions (weight 0.4)
    const dbTransactions = await pool.query(`
      SELECT AVG(price_per_sqm) as avg_price, COUNT(*) as count, MAX(transaction_date) as latest
      FROM transactions WHERE complex_id = $1 AND transaction_date > NOW() - INTERVAL '2 years'
    `, [complex.id]);
    if (dbTransactions.rows[0]?.avg_price) {
      results.sources.push({ name: 'nadlan_db', avgPrice: parseFloat(dbTransactions.rows[0].avg_price), count: parseInt(dbTransactions.rows[0].count), weight: 0.4 });
    }

    // Source 2: Yad2 sold prices (weight 0.3)
    const yad2Data = await getYad2SoldPrices(complex.city, complex.street);
    if (yad2Data.avgPricePerSqm) {
      results.sources.push({ name: 'yad2_sold', avgPrice: yad2Data.avgPricePerSqm, weight: 0.3 });
    }

    // Source 3: CBS index (weight 0.2)
    const cbsData = await getCBSPriceIndex(complex.city);
    if (cbsData.indexValue) {
      results.sources.push({ name: 'cbs_index', indexValue: cbsData.indexValue, trend: cbsData.trend, weight: 0.2 });
      results.priceTrend = cbsData.trend || 'unknown';
    }

    // Source 4: BOI mortgage context (weight 0.1)
    const boiData = await getBOIMortgageStats(complex.city);
    if (boiData.avgLTV) {
      results.sources.push({ name: 'boi_mortgage', avgLTV: boiData.avgLTV, trend: boiData.trend, weight: 0.1 });
    }

    // Calculate weighted average
    let weightedSum = 0, totalWeight = 0;
    for (const source of results.sources) {
      if (source.avgPrice) {
        weightedSum += source.avgPrice * source.weight;
        totalWeight += source.weight;
      }
    }
    if (totalWeight > 0) {
      results.estimatedPricePerSqm = Math.round(weightedSum / totalWeight);
      results.confidenceScore = Math.min(Math.round(totalWeight * 100), 100);
    }

    // Calculate premium price based on project status
    const premiumMultipliers = { 'declared': 1.20, 'approved_local': 1.25, 'approved_district': 1.30, 'permit': 1.35, 'construction': 1.40 };
    const multiplier = premiumMultipliers[complex.status] || 1.25;
    results.estimatedPremiumPrice = Math.round(results.estimatedPricePerSqm * multiplier);
    results.premiumPercentage = Math.round((multiplier - 1) * 100);

    logger.info('Benchmark calculated', { complexId: complex.id, estimatedPrice: results.estimatedPricePerSqm, confidence: results.confidenceScore });
  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message, complexId: complex.id });
    results.error = err.message;
  }
  return results;
}

async function getCityPricingStats(city) {
  logger.info('Getting city pricing stats', { city });
  const results = { city, timestamp: new Date().toISOString(), sources: {} };
  try {
    results.sources.yad2 = await getYad2SoldPrices(city);
    results.sources.cbs = await getCBSPriceIndex(city);
    results.sources.boi = await getBOIMortgageStats(city);
    if (results.sources.yad2?.avgPricePerSqm) results.avgPricePerSqm = results.sources.yad2.avgPricePerSqm;
    if (results.sources.cbs?.trend) results.priceTrend = results.sources.cbs.trend;
  } catch (err) {
    logger.error('City pricing stats failed', { error: err.message, city });
    results.error = err.message;
  }
  return results;
}

async function compareComplexPrices(city, pool) {
  logger.info('Comparing complex prices', { city });
  try {
    const cityStats = await getCityPricingStats(city);
    const cityAvg = cityStats.avgPricePerSqm || 0;
    const complexes = await pool.query(`
      SELECT c.*, AVG(t.price_per_sqm) as avg_transaction_price, COUNT(t.id) as transaction_count
      FROM complexes c LEFT JOIN transactions t ON t.complex_id = c.id AND t.transaction_date > NOW() - INTERVAL '2 years'
      WHERE c.city = $1 GROUP BY c.id ORDER BY avg_transaction_price DESC NULLS LAST LIMIT 50
    `, [city]);
    return {
      city, cityAvgPricePerSqm: cityAvg, priceTrend: cityStats.priceTrend,
      complexes: complexes.rows.map(c => ({
        id: c.id, name: c.name, avgPrice: c.avg_transaction_price ? Math.round(parseFloat(c.avg_transaction_price)) : null,
        transactionCount: parseInt(c.transaction_count), vsCity: c.avg_transaction_price && cityAvg ? Math.round(((parseFloat(c.avg_transaction_price) / cityAvg) - 1) * 100) : null,
        status: c.status, iaiScore: c.iai_score
      }))
    };
  } catch (err) {
    logger.error('Price comparison failed', { error: err.message, city });
    return { city, error: err.message };
  }
}

async function batchUpdatePricing(pool, options = {}) {
  logger.info('Starting batch pricing update', options);
  const results = { updated: 0, failed: 0, cities: [] };
  try {
    let query = 'SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL';
    const params = [];
    if (options.city) { query = 'SELECT DISTINCT city FROM complexes WHERE city = $1'; params.push(options.city); }
    query += ' LIMIT 20';
    const cities = await pool.query(query, params);

    for (const row of cities.rows) {
      try {
        const cityStats = await getCityPricingStats(row.city);
        if (cityStats.avgPricePerSqm) {
          await pool.query(`UPDATE complexes SET city_avg_price_sqm = $1, price_trend = $2, price_last_updated = NOW() WHERE city = $3`,
            [cityStats.avgPricePerSqm, cityStats.priceTrend || 'unknown', row.city]);
          results.cities.push({ city: row.city, avgPrice: cityStats.avgPricePerSqm, trend: cityStats.priceTrend });
          results.updated++;
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        logger.warn(`Pricing update failed for ${row.city}`, { error: e.message });
        results.failed++;
      }
    }
    logger.info('Batch pricing update complete', results);
  } catch (err) {
    logger.error('Batch pricing update failed', { error: err.message });
    results.error = err.message;
  }
  return results;
}

module.exports = {
  getYad2SoldPrices, getCBSPriceIndex, getBOIMortgageStats, calculateAccurateBenchmark,
  getCityPricingStats, compareComplexPrices, batchUpdatePricing, CBS_REGIONS
};
