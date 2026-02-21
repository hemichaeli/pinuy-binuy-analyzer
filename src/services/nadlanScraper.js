const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Nadlan.gov.il Transaction Scraper v2
 * Fetches real transaction data from Israel Tax Authority's open API.
 * Falls back to Perplexity AI queries when direct API fails or returns HTML.
 * 
 * API: https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals
 */

const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const RATE_LIMIT_DELAY = 2000; // 2s between requests
const MAX_RETRIES = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch transactions from nadlan.gov.il for a specific street+city
 * Returns: Array of transactions, or null if API is unavailable
 */
async function fetchFromNadlanGov(street, city, houseNum = '') {
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
      TblHouseNum: houseNum,
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
    
    // CRITICAL FIX: Detect HTML responses (API returns web page instead of JSON)
    if (typeof data === 'string') {
      if (data.includes('<html') || data.includes('<!DOCTYPE') || data.includes('<script')) {
        logger.warn(`Nadlan API returned HTML page for ${street}, ${city} - API blocked`);
        return null; // Trigger Perplexity fallback
      }
    }

    // Check response content type
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      logger.warn(`Nadlan API returned text/html for ${street}, ${city}`);
      return null; // Trigger Perplexity fallback
    }

    // API returns results in AllResults or ResultLavel1
    const results = data.AllResults || data.ResultLavel1 || [];
    
    if (!Array.isArray(results)) {
      logger.warn(`Nadlan API returned non-array for ${street}, ${city}`, { type: typeof results });
      return null; // Treat non-array as API failure too
    }

    return results.map(tx => ({
      transaction_date: tx.DEALDATETIME || tx.DEALDATE || null,
      price: parseFloat(tx.DEALAMOUNT) || null,
      area_sqm: parseFloat(tx.DEALNATURE === 'AREA' ? tx.DEALAMOUNT : tx.ASSETAREA) || null,
      rooms: parseFloat(tx.ASSETROOMNUM) || null,
      floor: parseInt(tx.FLOORNO) || null,
      address: `${tx.ASSETADDRESS || street} ${tx.ASSETHOUSENUMBER || houseNum}`.trim(),
      city: tx.ASSETCITYNAME || city,
      price_per_sqm: null, // calculate after
      source: 'nadlan_gov',
      source_id: tx.OBJECTID || tx.KEYVALUE || `${tx.DEALDATETIME}-${tx.DEALAMOUNT}`,
      year_built: parseInt(tx.BUILDINGYEAR) || null,
      building_floors: parseInt(tx.BUILDINGFLOORS) || null,
      asset_type: tx.ASSETTYPE || null
    }));

  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 429) {
      logger.warn(`Nadlan API blocked/rate-limited for ${street}, ${city}`);
    } else {
      logger.warn(`Nadlan API error for ${street}, ${city}: ${err.message}`);
    }
    return null; // null means API failed (vs [] means no results)
  }
}

/**
 * Fallback: Use Perplexity AI to get transaction data + neighborhood avg
 */
async function fetchFromPerplexity(complexName, city, addresses) {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('Perplexity API key not set, cannot use fallback');
    return { transactions: [], neighborhoodAvg: null };
  }

  try {
    const addressList = addresses ? addresses.split(',').slice(0, 3).join(', ') : complexName;
    const prompt = `חפש נתוני עסקאות נדל"ן אמיתיות (לא מחירי ביקוש) שבוצעו ב-24 החודשים האחרונים באזור: ${addressList} ב${city}.

אני צריך שני סוגי מידע:

1. עסקאות ספציפיות שבוצעו ברחובות הללו או בסביבתם הקרובה
2. ממוצע מחיר למ"ר באזור/שכונה

החזר JSON בפורמט הבא בלבד (ללא הסברים):
{
  "transactions": [
    {"date":"YYYY-MM-DD","price":NUMBER,"area_sqm":NUMBER,"floor":NUMBER,"rooms":NUMBER,"address":"TEXT","price_per_sqm":NUMBER}
  ],
  "neighborhood_avg_price_sqm": NUMBER,
  "neighborhood_name": "TEXT",
  "data_source": "TEXT",
  "confidence": "high/medium/low"
}

אם אין מידע, החזר: {"transactions":[],"neighborhood_avg_price_sqm":null}`;

    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'llama-3.1-sonar-large-128k-online',
      messages: [
        { role: 'system', content: 'You are a real estate data assistant specializing in Israeli real estate. Search nadlan.gov.il, madlan.co.il, and yad2.co.il for real transaction data. Return ONLY valid JSON. No explanations or markdown.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 3000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const content = response.data.choices?.[0]?.message?.content || '{}';
    
    // Extract JSON from response (handle markdown code blocks)
    let cleanContent = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // Try parsing as object first (new format)
    try {
      const parsed = JSON.parse(cleanContent);
      
      const transactions = (parsed.transactions || []).map(tx => ({
        transaction_date: tx.date || null,
        price: parseFloat(tx.price) || null,
        area_sqm: parseFloat(tx.area_sqm) || null,
        rooms: parseFloat(tx.rooms) || null,
        floor: parseInt(tx.floor) || null,
        address: tx.address || addressList,
        city: city,
        price_per_sqm: tx.price_per_sqm || null,
        source: 'perplexity_nadlan',
        source_id: `pplx-${tx.date}-${tx.price}`
      }));

      return {
        transactions,
        neighborhoodAvg: parsed.neighborhood_avg_price_sqm || null,
        neighborhoodName: parsed.neighborhood_name || null,
        confidence: parsed.confidence || 'low',
        dataSource: parsed.data_source || 'perplexity'
      };
    } catch (e) {
      // Try old array format as fallback
      const jsonMatch = cleanContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          return {
            transactions: parsed.map(tx => ({
              transaction_date: tx.date || null,
              price: parseFloat(tx.price) || null,
              area_sqm: parseFloat(tx.area_sqm) || null,
              rooms: parseFloat(tx.rooms) || null,
              floor: parseInt(tx.floor) || null,
              address: tx.address || addressList,
              city: city,
              price_per_sqm: null,
              source: 'perplexity_nadlan',
              source_id: `pplx-${tx.date}-${tx.price}`
            })),
            neighborhoodAvg: null
          };
        }
      }
      return { transactions: [], neighborhoodAvg: null };
    }

  } catch (err) {
    logger.warn(`Perplexity fallback failed for ${complexName}: ${err.message}`);
    return { transactions: [], neighborhoodAvg: null };
  }
}

/**
 * Store transactions in the database
 */
async function storeTransactions(complexId, transactions) {
  let newCount = 0;

  for (const tx of transactions) {
    try {
      // Calculate price_per_sqm
      if (tx.price && tx.area_sqm && tx.area_sqm > 0 && !tx.price_per_sqm) {
        tx.price_per_sqm = Math.round(tx.price / tx.area_sqm);
      }

      // Skip unrealistic data
      if (tx.price_per_sqm && (tx.price_per_sqm < 3000 || tx.price_per_sqm > 200000)) {
        logger.debug(`Skipping unrealistic transaction: ${tx.price_per_sqm} NIS/sqm`);
        continue;
      }

      // Check for duplicates by source_id
      if (tx.source_id) {
        const existing = await pool.query(
          `SELECT id FROM transactions 
           WHERE complex_id = $1 AND source = $2 AND source_id = $3`,
          [complexId, tx.source, tx.source_id]
        );
        if (existing.rows.length > 0) continue;
      }

      // Also check by date + price + address to avoid duplication
      if (tx.transaction_date && tx.price) {
        const dupCheck = await pool.query(
          `SELECT id FROM transactions 
           WHERE complex_id = $1 AND transaction_date = $2 AND price = $3
           AND address = $4`,
          [complexId, tx.transaction_date, tx.price, tx.address]
        );
        if (dupCheck.rows.length > 0) continue;
      }

      await pool.query(
        `INSERT INTO transactions 
         (complex_id, transaction_date, price, area_sqm, rooms, floor, 
          price_per_sqm, address, city, source, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [complexId, tx.transaction_date, tx.price, tx.area_sqm, tx.rooms,
         tx.floor, tx.price_per_sqm, tx.address, tx.city, tx.source, tx.source_id]
      );
      newCount++;

    } catch (err) {
      if (err.code !== '23505') { // ignore duplicate key
        logger.warn(`Failed to store transaction for complex ${complexId}`, { error: err.message });
      }
    }
  }

  return newCount;
}

/**
 * Scan a single complex for nadlan.gov.il transactions
 * Always falls back to Perplexity if gov API fails or returns no data
 */
async function scanComplex(complexId) {
  try {
    const complex = await pool.query(
      'SELECT id, name, city, addresses FROM complexes WHERE id = $1',
      [complexId]
    );

    if (complex.rows.length === 0) {
      return { complexId, status: 'not_found', transactions: 0 };
    }

    const { name, city, addresses } = complex.rows[0];
    let allTransactions = [];
    let source = 'nadlan_gov';
    let neighborhoodAvg = null;
    let apiAvailable = true;

    // Parse addresses and try each street
    const addressList = addresses ? addresses.split(',').map(a => a.trim()) : [];
    
    if (addressList.length > 0 && apiAvailable) {
      for (const addr of addressList.slice(0, 5)) { // max 5 addresses
        // Extract street name (remove house numbers and semicolons)
        const street = addr.replace(/[;]/g, '').replace(/\d+[-/]?\d*/g, '').trim();
        if (!street || street.length < 2) continue;

        const results = await fetchFromNadlanGov(street, city);
        
        if (results === null) {
          apiAvailable = false;
          break; // API is down/blocked
        }

        if (results.length > 0) {
          allTransactions.push(...results);
        }

        await sleep(RATE_LIMIT_DELAY);
      }
    }

    // ALWAYS try Perplexity if we got no transactions (whether API failed or returned empty)
    if (allTransactions.length === 0) {
      logger.info(`No gov transactions for "${name}" - using Perplexity fallback`);
      const pplxResult = await fetchFromPerplexity(name, city, addresses);
      
      if (pplxResult.transactions.length > 0) {
        allTransactions = pplxResult.transactions;
        source = 'perplexity_nadlan';
      }
      
      neighborhoodAvg = pplxResult.neighborhoodAvg;
    }

    // Store transactions
    const newTransactions = await storeTransactions(complexId, allTransactions);

    // Update complex with neighborhood average if found
    if (neighborhoodAvg && neighborhoodAvg > 3000 && neighborhoodAvg < 200000) {
      await pool.query(`
        ALTER TABLE complexes ADD COLUMN IF NOT EXISTS nadlan_neighborhood_avg_sqm NUMERIC(10,2);
        ALTER TABLE complexes ADD COLUMN IF NOT EXISTS neighborhood_avg_sqm NUMERIC(10,2);
      `);
      
      await pool.query(`
        UPDATE complexes SET 
          nadlan_neighborhood_avg_sqm = $1,
          neighborhood_avg_sqm = COALESCE(neighborhood_avg_sqm, $1)
        WHERE id = $2 AND nadlan_neighborhood_avg_sqm IS NULL
      `, [neighborhoodAvg, complexId]);
    }

    // Calculate neighborhood avg from transactions if we got good data
    if (allTransactions.length >= 2 && !neighborhoodAvg) {
      const validPrices = allTransactions
        .filter(tx => tx.price_per_sqm && tx.price_per_sqm > 3000 && tx.price_per_sqm < 200000)
        .map(tx => tx.price_per_sqm);
      
      if (validPrices.length >= 2) {
        validPrices.sort((a, b) => a - b);
        const median = validPrices[Math.floor(validPrices.length / 2)];
        
        await pool.query(`
          ALTER TABLE complexes ADD COLUMN IF NOT EXISTS nadlan_neighborhood_avg_sqm NUMERIC(10,2);
          ALTER TABLE complexes ADD COLUMN IF NOT EXISTS neighborhood_avg_sqm NUMERIC(10,2);
        `);
        
        await pool.query(`
          UPDATE complexes SET 
            nadlan_neighborhood_avg_sqm = $1,
            neighborhood_avg_sqm = COALESCE(neighborhood_avg_sqm, $1)
          WHERE id = $2
        `, [median, complexId]);
        
        neighborhoodAvg = median;
      }
    }

    logger.info(`Nadlan scan for "${name}": ${allTransactions.length} found, ${newTransactions} new (source: ${source}), neighborhood_avg: ${neighborhoodAvg || 'N/A'}`);

    return {
      complexId,
      name,
      city,
      status: 'success',
      totalFound: allTransactions.length,
      newTransactions,
      source,
      neighborhoodAvg,
      apiAvailable
    };

  } catch (err) {
    logger.error(`Nadlan scan failed for complex ${complexId}`, { error: err.message });
    return { complexId, status: 'error', error: err.message, transactions: 0 };
  }
}

/**
 * Scan all complexes (or filtered subset)
 */
async function scanAll(options = {}) {
  const { city, limit, staleOnly } = options;

  let query = 'SELECT id, name, city, addresses FROM complexes WHERE 1=1';
  const params = [];

  if (city) {
    params.push(city);
    query += ` AND city = $${params.length}`;
  }

  if (staleOnly) {
    // Only scan complexes not scanned in the last 7 days
    query += ` AND (updated_at < NOW() - INTERVAL '7 days' OR updated_at IS NULL)`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';

  if (limit) {
    params.push(limit);
    query += ` LIMIT $${params.length}`;
  }

  const complexes = await pool.query(query, params);
  logger.info(`Nadlan scan starting for ${complexes.rows.length} complexes`);

  const results = {
    total: complexes.rows.length,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    totalNew: 0,
    withNeighborhoodAvg: 0,
    details: []
  };

  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      results.scanned++;
      
      if (result.status === 'success') {
        results.succeeded++;
        results.totalNew += result.newTransactions || 0;
        if (result.neighborhoodAvg) results.withNeighborhoodAvg++;
      } else {
        results.failed++;
      }

      results.details.push(result);
      await sleep(RATE_LIMIT_DELAY);

    } catch (err) {
      results.failed++;
      results.details.push({ complexId: complex.id, status: 'error', error: err.message });
      logger.warn(`Failed scanning complex ${complex.name}`, { error: err.message });
    }
  }

  logger.info(`Nadlan scan complete: ${results.succeeded}/${results.total} succeeded, ${results.totalNew} new transactions, ${results.withNeighborhoodAvg} with neighborhood avg`);
  return results;
}

module.exports = { scanAll, scanComplex };
