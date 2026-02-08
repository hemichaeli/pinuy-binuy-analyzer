const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Nadlan.gov.il Transaction Scraper
 * Fetches real estate transactions from the Israeli Tax Authority's open data.
 * 
 * Primary: Direct API call to nadlan.gov.il REST endpoint
 * Fallback: Enhanced Perplexity query focused on transaction data
 * 
 * Note: nadlan.gov.il may block server-side requests with WAF/bot protection.
 * If direct API fails, the fallback uses Perplexity to gather transaction data.
 * For reliable direct access, consider adding a proxy service (e.g. BrightData).
 */

const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const RATE_LIMIT_DELAY = 2000; // 2 seconds between requests
const MAX_PAGES = 5; // Max pages per address query

const NADLAN_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'content-type': 'application/json;charset=UTF-8',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'origin': 'https://www.nadlan.gov.il',
  'referer': 'https://www.nadlan.gov.il/'
};

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse addresses string into individual street names
 * Input: "רחוב בן צבי, רחוב שמורק, רחוב ארליך - 30 דונם"
 * Output: ["בן צבי", "שמורק", "ארליך"]
 */
function parseAddresses(addressStr) {
  if (!addressStr) return [];
  
  // Split by comma, dash, and common separators
  const parts = addressStr.split(/[,;\/]/).map(s => s.trim()).filter(Boolean);
  
  const streets = [];
  for (const part of parts) {
    let street = part
      // Remove common prefixes
      .replace(/^רחוב\s+/i, '')
      .replace(/^רח['׳]\s*/i, '')
      .replace(/^שדרות\s+/i, '')
      .replace(/^דרך\s+/i, '')
      // Remove suffixes like "30 דונם", house number ranges
      .replace(/\s*-\s*\d+\s*(דונם|דירות|בניינים|יח"ד|יחידות).*$/i, '')
      .replace(/\s+\d+-\d+$/, '')
      .replace(/\s+\d+$/, '')
      .trim();
    
    // Skip if too short or contains only numbers/special chars
    if (street.length >= 2 && /[\u0590-\u05FF]/.test(street)) {
      streets.push(street);
    }
  }
  
  return [...new Set(streets)]; // deduplicate
}

/**
 * Build request body for nadlan.gov.il API
 */
function buildNadlanRequestBody(city, street, pageNo = 1) {
  return {
    ObjectID: '',
    CurrentLavel: 1,
    PageNo: pageNo,
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
}

/**
 * Parse a single transaction result from the nadlan API
 */
function parseNadlanResult(item) {
  return {
    address: item.FULLADRESS || item.DISPLAYADRESS || null,
    city: item.CITY || null,
    price: parseFloat(item.DEALAMOUNT) || null,
    area_sqm: parseFloat(item.DEALNATURE === 1 ? item.ASSETROOMNUM : null) || null,
    rooms: parseFloat(item.ASSETROOMNUM) || null,
    floor: parseInt(item.FLOORNO) || null,
    transaction_date: item.DEALDATE || item.DEALDATETIME || null,
    price_per_sqm: null, // calculated below
    building_year: parseInt(item.BUILDINGYEAR || item.YEARBUILT) || null,
    deal_type: item.DEALNATUREDESCRIPTION || null,
    source_id: item.KEYVALUE || null
  };
}

/**
 * Fetch transactions from nadlan.gov.il for a specific city + street
 * Returns array of parsed transactions or null if API is blocked
 */
async function fetchFromNadlan(city, street) {
  const transactions = [];
  
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const body = buildNadlanRequestBody(city, street, page);
      
      const response = await axios.post(NADLAN_API_URL, body, {
        headers: NADLAN_HEADERS,
        timeout: 15000,
        validateStatus: () => true // Don't throw on non-2xx
      });
      
      // Check if we got JSON (API might return HTML if blocked)
      if (typeof response.data === 'string' && response.data.includes('<!doctype')) {
        logger.warn(`nadlan.gov.il returned HTML instead of JSON (blocked) for ${city}/${street}`);
        return null; // Signal that API is blocked
      }
      
      const results = response.data?.AllResults || response.data?.ResultLavel1 || [];
      
      if (!Array.isArray(results) || results.length === 0) {
        break; // No more results
      }
      
      for (const item of results) {
        const tx = parseNadlanResult(item);
        if (tx.price && tx.price > 0) {
          // Calculate price per sqm if area is available
          if (tx.area_sqm && tx.area_sqm > 0) {
            tx.price_per_sqm = Math.round(tx.price / tx.area_sqm);
          }
          transactions.push(tx);
        }
      }
      
      // If fewer than 10 results, no more pages
      if (results.length < 10) break;
      
      await sleep(RATE_LIMIT_DELAY);
      
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        logger.warn(`Timeout fetching nadlan data for ${city}/${street} page ${page}`);
      } else {
        logger.warn(`Error fetching nadlan data for ${city}/${street} page ${page}`, { 
          error: err.message 
        });
      }
      break;
    }
  }
  
  return transactions;
}

/**
 * Fetch transaction data via Perplexity as fallback
 * Uses targeted queries to get actual transaction prices
 */
async function fetchViaPerplexity(complexName, city, addresses) {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('No PERPLEXITY_API_KEY set, cannot use Perplexity fallback');
    return [];
  }
  
  const streetList = addresses.slice(0, 3).join(', ');
  
  const prompt = `חפש עסקאות נדל"ן שנרשמו ב-2 השנים האחרונות באזור מתחם פינוי בינוי "${complexName}" ב${city}, ברחובות: ${streetList}.

החזר JSON array בלבד (בלי טקסט נוסף) בפורמט:
[
  {
    "address": "כתובת מלאה",
    "price": מחיר_במספר,
    "rooms": מספר_חדרים,
    "area_sqm": שטח_במ"ר,
    "floor": קומה,
    "date": "YYYY-MM-DD",
    "price_per_sqm": מחיר_למ"ר
  }
]

אם אין מידע על עסקאות ספציפיות, החזר מערך ריק [].
התבסס על נתוני רשות המיסים (nadlan.gov.il) או מדלן אם זמינים.`;

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'You are a real estate data analyst. Return ONLY valid JSON arrays, no text.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || '';
    
    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    
    return parsed.map(tx => ({
      address: tx.address || null,
      city: city,
      price: parseFloat(tx.price) || null,
      area_sqm: parseFloat(tx.area_sqm) || null,
      rooms: parseFloat(tx.rooms) || null,
      floor: parseInt(tx.floor) || null,
      transaction_date: tx.date || null,
      price_per_sqm: parseFloat(tx.price_per_sqm) || null,
      source_id: null
    })).filter(tx => tx.price && tx.price > 50000); // Filter out invalid prices
    
  } catch (err) {
    logger.warn(`Perplexity fallback failed for ${complexName}`, { error: err.message });
    return [];
  }
}

/**
 * Save transactions to DB, checking for duplicates
 * Returns count of new transactions inserted
 */
async function saveTransactions(complexId, transactions, source = 'nadlan_gov') {
  let newCount = 0;
  
  for (const tx of transactions) {
    try {
      // Check for duplicates by address + price + date
      const existing = await pool.query(
        `SELECT id FROM transactions 
         WHERE complex_id = $1 
         AND (
           (source_id IS NOT NULL AND source_id = $2)
           OR (address = $3 AND price = $4 AND transaction_date = $5)
         )`,
        [complexId, tx.source_id || '', tx.address, tx.price, tx.transaction_date]
      );
      
      if (existing.rows.length > 0) continue;
      
      // Calculate price_per_sqm if missing
      let priceSqm = tx.price_per_sqm;
      if (!priceSqm && tx.price && tx.area_sqm && tx.area_sqm > 0) {
        priceSqm = Math.round(tx.price / tx.area_sqm);
      }
      
      await pool.query(
        `INSERT INTO transactions 
         (complex_id, address, city, price, area_sqm, rooms, floor, 
          transaction_date, price_per_sqm, source, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          complexId, tx.address, tx.city, tx.price, tx.area_sqm,
          tx.rooms, tx.floor, tx.transaction_date, priceSqm,
          source, tx.source_id
        ]
      );
      
      newCount++;
    } catch (err) {
      // Skip duplicate key violations silently
      if (err.code !== '23505') {
        logger.warn(`Error saving transaction for complex ${complexId}`, { 
          error: err.message, address: tx.address 
        });
      }
    }
  }
  
  return newCount;
}

/**
 * Scan a single complex for transactions
 * Tries direct nadlan API first, falls back to Perplexity
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, addresses FROM complexes WHERE id = $1',
    [complexId]
  );
  
  if (complexResult.rows.length === 0) {
    return { status: 'error', message: 'Complex not found' };
  }
  
  const complex = complexResult.rows[0];
  const streets = parseAddresses(complex.addresses);
  
  if (streets.length === 0) {
    return { 
      status: 'skipped', 
      message: 'No parseable addresses',
      complex: complex.name 
    };
  }
  
  logger.info(`Nadlan scan: ${complex.name} (${complex.city}) - ${streets.length} streets`);
  
  let allTransactions = [];
  let source = 'nadlan_gov';
  let apiBlocked = false;
  
  // Try direct API for each street
  for (const street of streets) {
    const directResults = await fetchFromNadlan(complex.city, street);
    
    if (directResults === null) {
      apiBlocked = true;
      break; // API is blocked, switch to fallback
    }
    
    allTransactions.push(...directResults);
    await sleep(RATE_LIMIT_DELAY);
  }
  
  // Fallback to Perplexity if API is blocked
  if (apiBlocked) {
    logger.info(`Direct API blocked, using Perplexity fallback for ${complex.name}`);
    source = 'perplexity_nadlan';
    allTransactions = await fetchViaPerplexity(complex.name, complex.city, streets);
  }
  
  // Save to DB
  const newCount = await saveTransactions(complex.id, allTransactions, source);
  
  logger.info(`Nadlan scan complete: ${complex.name} - ${allTransactions.length} found, ${newCount} new`);
  
  return {
    status: 'success',
    complex: complex.name,
    city: complex.city,
    source,
    streetsSearched: streets.length,
    transactionsFound: allTransactions.length,
    newTransactions: newCount
  };
}

/**
 * Scan all complexes for transactions
 * Options: { city, status, limit, staleOnly }
 */
async function scanAll(options = {}) {
  const { city, status, limit, staleOnly } = options;
  
  let query = 'SELECT id, name, city, addresses FROM complexes WHERE addresses IS NOT NULL';
  const params = [];
  let paramIndex = 1;
  
  if (city) {
    query += ` AND city = $${paramIndex++}`;
    params.push(city);
  }
  if (status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (staleOnly) {
    // Only scan complexes that haven't had transactions in 30+ days
    query += ` AND id NOT IN (
      SELECT DISTINCT complex_id FROM transactions 
      WHERE created_at > NOW() - INTERVAL '30 days' AND source IN ('nadlan_gov', 'perplexity_nadlan')
    )`;
  }
  
  query += ' ORDER BY iai_score DESC NULLS LAST';
  
  if (limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(limit);
  }
  
  const complexes = await pool.query(query, params);
  
  logger.info(`Nadlan batch scan: ${complexes.rows.length} complexes to scan`);
  
  const results = {
    total: complexes.rows.length,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    totalTransactions: 0,
    totalNew: 0,
    source: 'unknown',
    details: []
  };
  
  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      results.scanned++;
      results.source = result.source || results.source;
      
      if (result.status === 'success') {
        results.succeeded++;
        results.totalTransactions += result.transactionsFound;
        results.totalNew += result.newTransactions;
      } else if (result.status === 'skipped') {
        // Don't count skips as failures
      } else {
        results.failed++;
      }
      
      results.details.push(result);
      
      // Rate limit between complexes
      await sleep(RATE_LIMIT_DELAY);
      
    } catch (err) {
      results.failed++;
      results.details.push({
        status: 'error',
        complex: complex.name,
        error: err.message
      });
      logger.warn(`Nadlan scan failed for ${complex.name}`, { error: err.message });
    }
  }
  
  logger.info(`Nadlan batch scan complete: ${results.succeeded}/${results.total} succeeded, ${results.totalNew} new transactions`);
  
  return results;
}

module.exports = {
  scanComplex,
  scanAll,
  fetchFromNadlan,
  fetchViaPerplexity,
  saveTransactions,
  parseAddresses
};
