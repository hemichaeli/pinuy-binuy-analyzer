/**
 * Pricing Accuracy Service - Phase 4.5
 * מקורות: Yad2 sold prices, CBS price index, BOI mortgage stats
 */

const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const CBS_REGIONS = {
  'תל אביב': 'tel_aviv',
  'רמת גן': 'gush_dan',
  'גבעתיים': 'gush_dan',
  'בני ברק': 'gush_dan',
  'חולון': 'gush_dan',
  'בת ים': 'gush_dan',
  'פתח תקווה': 'center',
  'ראשון לציון': 'center',
  'רחובות': 'center',
  'נס ציונה': 'center',
  'הרצליה': 'sharon',
  'רעננה': 'sharon',
  'כפר סבא': 'sharon',
  'הוד השרון': 'sharon',
  'נתניה': 'sharon',
  'ירושלים': 'jerusalem',
  'חיפה': 'haifa',
  'קריית ביאליק': 'haifa',
  'קריית מוצקין': 'haifa'
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

  const query = `מחירי דירות שנמכרו ${locationFilter} ${roomsFilter} בשנה האחרונה. החזר JSON: {"avgPricePerSqm": number, "transactions": [{"price": number, "sqm": number, "rooms": number, "date": ""}], "priceRange": {"min": number, "max": number}}`;
  const result = await searchWithPerplexity(query, 'חפש מחירי עסקאות בפועל, לא מחירי מבוקש');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'yad2_sold', city, street, rooms, ...parsed, rawResponse: result };
    }
  } catch (e) {}

  return { source: 'yad2_sold', city, rawResponse: result, avgPricePerSqm: null };
}

async function getCBSPriceIndex(city) {
  logger.info('Fetching CBS price index', { city });
  const region = CBS_REGIONS[city] || 'center';

  const query = `מדד מחירי הדירות של הלמ"ס לאזור ${city}/${region}. החזר JSON: {"currentIndex": number, "quarterlyChange": number, "yearlyChange": number, "trend": "up|down|stable"}`;
  const result = await searchWithPerplexity(query, 'מידע מהלשכה המרכזית לסטטיסטיקה');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'cbs', city, region, ...parsed };
    }
  } catch (e) {}

  return { source: 'cbs', city, region, rawResponse: result };
}

async function getBOIMortgageStats(city = null) {
  logger.info('Fetching BOI mortgage stats', { city });

  const query = `סטטיסטיקות משכנתאות מבנק ישראל${city ? ` לאזור ${city}` : ''}. החזר JSON: {"avgLTV": number, "avgInterestRate": number, "creditVolume": number, "defaultRate": number, "trend": "expanding|contracting|stable"}`;
  const result = await searchWithPerplexity(query, 'מידע מבנק ישראל');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'boi', city, ...parsed };
    }
  } catch (e) {}

  return { source: 'boi', city, rawResponse: result };
}

async function calculateAccurateBenchmark(complex, pool) {
  logger.info('Calculating accurate benchmark', { complexId: complex.id, city: complex.city });

  const sources = { nadlan_db: { weight: 0.4, data: null }, yad2_sold: { weight: 0.3, data: null }, cbs_index: { weight: 0.2, data: null }, boi_mortgage: { weight: 0.1, data: null } };

  try {
    // 1. Get nadlan.gov.il transactions from database
    const txResult = await pool.query(`
      SELECT AVG(price_per_sqm) as avg_price, COUNT(*) as count, MAX(transaction_date) as latest
      FROM transactions WHERE complex_id = $1 AND transaction_date > NOW() - INTERVAL '2 years'
    `, [complex.id]);
    
    if (txResult.rows[0]?.avg_price) {
      sources.nadlan_db.data = { avgPricePerSqm: parseFloat(txResult.rows[0].avg_price), count: parseInt(txResult.rows[0].count), latest: txResult.rows[0].latest };
    }

    // 2. Get Yad2 sold prices
    sources.yad2_sold.data = await getYad2SoldPrices(complex.city, complex.street);

    // 3. Get CBS price index
    sources.cbs_index.data = await getCBSPriceIndex(complex.city);

    // 4. Get BOI mortgage stats
    sources.boi_mortgage.data = await getBOIMortgageStats(complex.city);

    // Calculate weighted average
    let weightedSum = 0, totalWeight = 0;
    const usedSources = [];

    if (sources.nadlan_db.data?.avgPricePerSqm) {
      weightedSum += sources.nadlan_db.data.avgPricePerSqm * sources.nadlan_db.weight;
      totalWeight += sources.nadlan_db.weight;
      usedSources.push('nadlan_db');
    }

    if (sources.yad2_sold.data?.avgPricePerSqm) {
      weightedSum += sources.yad2_sold.data.avgPricePerSqm * sources.yad2_sold.weight;
      totalWeight += sources.yad2_sold.weight;
      usedSources.push('yad2_sold');
    }

    // Calculate estimated price per sqm
    const estimatedPricePerSqm = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;

    // Confidence score based on sources used
    const confidenceScore = Math.round((totalWeight / 0.7) * 100);

    // Price trend from CBS
    const priceTrend = sources.cbs_index.data?.trend || 'unknown';

    // Calculate premium price based on project status
    let premiumMultiplier = 1.2;
    if (complex.status === 'construction') premiumMultiplier = 1.4;
    else if (complex.status === 'approved') premiumMultiplier = 1.3;
    else if (complex.status === 'planning') premiumMultiplier = 1.25;

    const estimatedPremiumPrice = estimatedPricePerSqm ? Math.round(estimatedPricePerSqm * premiumMultiplier) : null;

    const result = {
      complexId: complex.id,
      city: complex.city,
      estimatedPricePerSqm,
      confidenceScore,
      priceTrend,
      estimatedPremiumPrice,
      premiumMultiplier,
      sources: usedSources,
      sourceData: sources,
      timestamp: new Date().toISOString()
    };

    // Update database
    if (estimatedPricePerSqm) {
      await pool.query(`
        UPDATE complexes SET
          accurate_price_sqm = $1,
          price_confidence_score = $2,
          price_trend = $3,
          estimated_premium_price = $4,
          price_last_updated = NOW(),
          price_sources = $5
        WHERE id = $6
      `, [estimatedPricePerSqm, confidenceScore, priceTrend, estimatedPremiumPrice, usedSources.join(','), complex.id]);
    }

    logger.info('Benchmark calculated', { complexId: complex.id, estimatedPricePerSqm, confidenceScore });
    return result;

  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message, complexId: complex.id });
    return { error: err.message, complexId: complex.id };
  }
}

async function getCityPricingStats(city, pool) {
  logger.info('Getting city pricing stats', { city });

  const stats = { city, timestamp: new Date().toISOString() };

  try {
    // Database averages
    const dbResult = await pool.query(`
      SELECT AVG(accurate_price_sqm) as avg_price, COUNT(*) as complex_count,
        AVG(price_confidence_score) as avg_confidence
      FROM complexes WHERE city = $1 AND accurate_price_sqm IS NOT NULL
    `, [city]);

    stats.database = {
      avgPricePerSqm: dbResult.rows[0]?.avg_price ? Math.round(parseFloat(dbResult.rows[0].avg_price)) : null,
      complexCount: parseInt(dbResult.rows[0]?.complex_count) || 0,
      avgConfidence: dbResult.rows[0]?.avg_confidence ? Math.round(parseFloat(dbResult.rows[0].avg_confidence)) : null
    };

    // External sources
    stats.yad2 = await getYad2SoldPrices(city);
    stats.cbs = await getCBSPriceIndex(city);
    stats.boi = await getBOIMortgageStats(city);

  } catch (err) {
    logger.error('City stats failed', { error: err.message, city });
    stats.error = err.message;
  }

  return stats;
}

async function compareComplexPrices(city, pool) {
  logger.info('Comparing complex prices', { city });

  try {
    const result = await pool.query(`
      SELECT id, name, address, accurate_price_sqm, price_confidence_score, status, iai_score
      FROM complexes
      WHERE city = $1 AND accurate_price_sqm IS NOT NULL
      ORDER BY accurate_price_sqm ASC
    `, [city]);

    const complexes = result.rows;
    const avgPrice = complexes.reduce((sum, c) => sum + parseFloat(c.accurate_price_sqm), 0) / complexes.length;

    return {
      city,
      complexCount: complexes.length,
      avgPricePerSqm: Math.round(avgPrice),
      complexes: complexes.map(c => ({
        id: c.id,
        name: c.name,
        pricePerSqm: Math.round(parseFloat(c.accurate_price_sqm)),
        vsAverage: Math.round(((parseFloat(c.accurate_price_sqm) / avgPrice) - 1) * 100),
        confidence: c.price_confidence_score,
        status: c.status,
        iaiScore: c.iai_score
      }))
    };
  } catch (err) {
    logger.error('Price comparison failed', { error: err.message, city });
    return { error: err.message, city };
  }
}

async function batchUpdatePricing(pool, options = {}) {
  logger.info('Starting batch pricing update', options);

  const results = { updated: 0, failed: 0, skipped: 0 };

  try {
    let query = 'SELECT * FROM complexes WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (options.city) {
      query += ` AND city = $${paramIndex++}`;
      params.push(options.city);
    }

    if (options.staleOnly) {
      query += ` AND (price_last_updated IS NULL OR price_last_updated < NOW() - INTERVAL '7 days')`;
    }

    query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${paramIndex}`;
    params.push(options.limit || 50);

    const complexes = await pool.query(query, params);

    for (const complex of complexes.rows) {
      try {
        const benchmark = await calculateAccurateBenchmark(complex, pool);
        if (benchmark.estimatedPricePerSqm) {
          results.updated++;
        } else {
          results.skipped++;
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        results.failed++;
        logger.warn(`Pricing update failed for ${complex.name}`, { error: e.message });
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
  getYad2SoldPrices,
  getCBSPriceIndex,
  getBOIMortgageStats,
  calculateAccurateBenchmark,
  getCityPricingStats,
  compareComplexPrices,
  batchUpdatePricing,
  CBS_REGIONS
};
