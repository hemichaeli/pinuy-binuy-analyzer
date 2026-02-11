/**
 * Madlan.co.il Service
 * 
 * Provides enhanced transaction data and market analytics from madlan.co.il
 * Madlan aggregates data from multiple sources including:
 * - Tax authority transactions (nadlan.gov.il)
 * - Real estate listings
 * - Neighborhood statistics
 * - Price per sqm benchmarks
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryPerplexity, parseJsonResponse } = require('./perplexityService');

// Rate limiting
const DELAY_BETWEEN_REQUESTS_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build Perplexity query for Madlan data
 */
function buildMadlanQuery(complex) {
  const addresses = complex.addresses || complex.address || '';
  return `חפש מידע מאתר madlan.co.il על הנכסים בכתובות הבאות ב${complex.city}:
${addresses}

אני צריך נתוני עסקאות אמיתיות (לא מחירי ביקוש) שבוצעו ב-24 החודשים האחרונים.

החזר JSON בלבד בפורמט הבא:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "address": "כתובת מלאה",
      "price": 0,
      "rooms": 0,
      "area_sqm": 0,
      "floor": 0,
      "building_year": 0,
      "price_per_sqm": 0
    }
  ],
  "neighborhood_stats": {
    "avg_price_per_sqm": 0,
    "median_price_per_sqm": 0,
    "price_trend_percent": 0,
    "total_transactions_last_year": 0
  },
  "comparable_new_projects": [
    {
      "name": "שם הפרויקט",
      "developer": "שם היזם",
      "price_per_sqm": 0,
      "status": "בבנייה/מכירה מוקדמת/אכלוס"
    }
  ],
  "data_quality": "high/medium/low",
  "source_url": "קישור לעמוד במדלן"
}

חפש ב: madlan.co.il, nadlan.gov.il
החזר JSON בלבד.`;
}

const MADLAN_SYSTEM_PROMPT = `You are a real estate data extraction assistant focused on Israeli property transactions.
Extract ONLY verified transaction data from madlan.co.il.
Return ONLY valid JSON. No explanations.
All prices in Israeli Shekels (ILS).
Focus on actual closed transactions, not asking prices.
Include building year when available.`;

/**
 * Fetch Madlan data for a complex using Perplexity
 */
async function fetchMadlanData(complexId) {
  const result = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (result.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = result.rows[0];
  const prompt = buildMadlanQuery(complex);

  logger.info(`Fetching Madlan data for: ${complex.name} (${complex.city})`);

  try {
    const rawResponse = await queryPerplexity(prompt, MADLAN_SYSTEM_PROMPT);
    const data = parseJsonResponse(rawResponse);

    if (!data) {
      return { complexId, name: complex.name, status: 'no_data', transactions: 0 };
    }

    // Store transactions
    let newTransactions = 0;
    if (data.transactions && data.transactions.length > 0) {
      for (const tx of data.transactions) {
        if (!tx.price || tx.price === 0) continue;

        try {
          // Check for duplicate
          const existing = await pool.query(
            `SELECT id FROM transactions 
             WHERE complex_id = $1 AND address = $2 AND price = $3 
             AND transaction_date = $4`,
            [complexId, tx.address, tx.price, tx.date || null]
          );

          if (existing.rows.length === 0) {
            const pricePerSqm = tx.area_sqm && tx.area_sqm > 0 
              ? Math.round(tx.price / tx.area_sqm) 
              : tx.price_per_sqm || null;

            await pool.query(
              `INSERT INTO transactions 
               (complex_id, transaction_date, price, area_sqm, rooms, floor, 
                price_per_sqm, address, city, source, building_year)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'madlan', $10)`,
              [complexId, tx.date || null, tx.price, tx.area_sqm || null,
               tx.rooms || null, tx.floor || null, pricePerSqm,
               tx.address, complex.city, tx.building_year || null]
            );
            newTransactions++;
          }
        } catch (err) {
          logger.warn(`Error storing Madlan transaction: ${err.message}`);
        }
      }
    }

    // Update complex with neighborhood stats
    if (data.neighborhood_stats) {
      await pool.query(
        `UPDATE complexes SET 
         madlan_avg_price_sqm = $1,
         madlan_price_trend = $2,
         last_madlan_update = NOW()
         WHERE id = $3`,
        [
          data.neighborhood_stats.avg_price_per_sqm || null,
          data.neighborhood_stats.price_trend_percent || null,
          complexId
        ]
      );
    }

    return {
      complexId,
      name: complex.name,
      status: 'success',
      transactions: newTransactions,
      neighborhoodStats: data.neighborhood_stats,
      comparableProjects: data.comparable_new_projects?.length || 0,
      dataQuality: data.data_quality
    };

  } catch (err) {
    logger.error(`Madlan fetch error for ${complex.name}: ${err.message}`);
    return { complexId, name: complex.name, status: 'error', error: err.message };
  }
}

/**
 * Calculate premium based on Madlan benchmark data
 */
async function calculatePremiumBenchmark(complexId) {
  const result = await pool.query(`
    SELECT c.id, c.name, c.city, c.madlan_avg_price_sqm,
           c.actual_price_per_sqm, c.theoretical_price_per_sqm,
           (SELECT AVG(price_per_sqm) FROM transactions 
            WHERE complex_id = c.id AND source = 'madlan' 
            AND transaction_date > NOW() - INTERVAL '12 months') as recent_avg
    FROM complexes c WHERE c.id = $1
  `, [complexId]);

  if (result.rows.length === 0) return null;

  const complex = result.rows[0];
  const madlanBenchmark = complex.madlan_avg_price_sqm || complex.recent_avg;
  
  if (!madlanBenchmark) return null;

  // Calculate discount vs neighborhood average
  const actualPrice = complex.actual_price_per_sqm;
  const discount = actualPrice ? 
    ((madlanBenchmark - actualPrice) / madlanBenchmark * 100).toFixed(1) : null;

  return {
    complexId,
    madlanBenchmark,
    currentPrice: actualPrice,
    discountPercent: discount,
    potentialUpside: discount ? `${Math.abs(discount)}%` : null
  };
}

/**
 * Scan all complexes for Madlan data
 */
async function scanAllMadlan(options = {}) {
  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (options.city) {
    query += ` AND city = $${paramIndex}`;
    params.push(options.city);
    paramIndex++;
  }

  // Only scan if not updated in last 7 days
  if (options.staleOnly !== false) {
    query += ` AND (last_madlan_update IS NULL OR last_madlan_update < NOW() - INTERVAL '7 days')`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`Starting Madlan scan of ${total} complexes`);

  const results = {
    total,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    totalNewTransactions: 0
  };

  for (let i = 0; i < complexes.rows.length; i++) {
    const complex = complexes.rows[i];
    try {
      const result = await fetchMadlanData(complex.id);
      results.scanned++;
      
      if (result.status === 'success') {
        results.succeeded++;
        results.totalNewTransactions += result.transactions;
      } else {
        results.failed++;
      }

      logger.info(`[Madlan ${i + 1}/${total}] ${complex.name}: ${result.transactions || 0} tx`);
    } catch (err) {
      results.scanned++;
      results.failed++;
      logger.error(`[Madlan ${i + 1}/${total}] ${complex.name}: ERROR`);
    }

    if (i < complexes.rows.length - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  logger.info('Madlan scan completed', results);
  return results;
}

module.exports = {
  fetchMadlanData,
  scanAllMadlan,
  calculatePremiumBenchmark,
  buildMadlanQuery
};
