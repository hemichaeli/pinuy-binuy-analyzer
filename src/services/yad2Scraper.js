/**
 * yad2 Direct Scraper (Phase 4.2)
 * 
 * Enhanced scraper that queries yad2's API directly for:
 * - Real-time listing data
 * - Accurate price tracking
 * - Days on market
 * - Urgent/distress indicators
 * 
 * Falls back to Perplexity AI if direct API fails.
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { detectKeywords } = require('./ssiCalculator');

// yad2 API endpoints
const YAD2_API_BASE = 'https://gw.yad2.co.il/feed-search-legacy/realestate/forsale';
const YAD2_ITEM_API = 'https://gw.yad2.co.il/feed-search-legacy/item';
const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

const DELAY_BETWEEN_REQUESTS = 3500; // 3.5s between requests
const MAX_RETRIES = 2;

// City code mapping for yad2 API
const CITY_CODES = {
  'תל אביב יפו': '5000',
  'תל אביב': '5000',
  'רמת גן': '8600',
  'גבעתיים': '6300',
  'חולון': '6600',
  'בת ים': '6200',
  'ראשון לציון': '8300',
  'פתח תקווה': '7900',
  'בני ברק': '6100',
  'הרצליה': '6400',
  'רעננה': '8700',
  'כפר סבא': '6900',
  'נתניה': '7400',
  'חיפה': '4000',
  'באר שבע': '9000',
  'ירושלים': '3000',
  'אשדוד': '70',
  'אשקלון': '7100',
  'רחובות': '8400',
  'לוד': '7000',
  'רמלה': '8500',
  'מודיעין': '1200',
  'נס ציונה': '7300',
  'ראש העין': '2640',
  'חדרה': '6500',
  'עפולה': '7800',
  'נצרת עילית': '1061',
  'קריית אתא': '8200',
  'קריית ביאליק': '9200',
  'קריית ים': '6800',
  'קריית מוצקין': '8000'
};

/**
 * Get yad2 city code
 */
function getCityCode(cityName) {
  // Direct match
  if (CITY_CODES[cityName]) return CITY_CODES[cityName];
  
  // Partial match
  for (const [name, code] of Object.entries(CITY_CODES)) {
    if (cityName.includes(name) || name.includes(cityName)) {
      return code;
    }
  }
  return null;
}

/**
 * Query yad2 API directly for listings in a specific area
 */
async function queryYad2Direct(complex) {
  const cityCode = getCityCode(complex.city);
  if (!cityCode) {
    logger.debug(`No city code for ${complex.city}, falling back to Perplexity`);
    return null;
  }

  // Extract street names from addresses
  const addresses = (complex.addresses || '').split(',').map(a => a.trim()).filter(Boolean);
  const streetNames = addresses.map(addr => {
    // Remove house numbers
    return addr.replace(/\d+/g, '').trim();
  }).filter(Boolean);

  const searchParams = {
    city: cityCode,
    propertyGroup: 'apartments',
    dealType: 'forsale',
    page: 1,
    limit: 50
  };

  // Add street filter if available
  if (streetNames.length > 0) {
    searchParams.street = streetNames[0]; // yad2 API accepts one street at a time
  }

  try {
    const response = await axios.get(YAD2_API_BASE, {
      params: searchParams,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
        'Referer': 'https://www.yad2.co.il/realestate/forsale',
        'Origin': 'https://www.yad2.co.il'
      },
      timeout: 15000
    });

    if (response.data?.feed?.feed_items) {
      const listings = response.data.feed.feed_items
        .filter(item => item.type === 'ad' && item.id)
        .map(item => parseYad2Item(item, complex));
      
      logger.debug(`yad2 direct API returned ${listings.length} listings for ${complex.name}`);
      return { listings, source: 'yad2_api' };
    }
    
    return null;
  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 429) {
      logger.warn(`yad2 API blocked/rate limited for ${complex.name}`);
    } else {
      logger.debug(`yad2 direct API failed for ${complex.name}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Parse yad2 API item into our format
 */
function parseYad2Item(item, complex) {
  const price = parseInt(item.price?.replace(/[^\d]/g, '')) || null;
  const areaSqm = parseInt(item.square_meters) || parseInt(item.SquareMeter) || null;
  const rooms = parseFloat(item.rooms) || parseFloat(item.Rooms_text) || null;
  const floor = parseInt(item.floor) || parseInt(item.Floor_text) || null;
  
  // Extract address components
  const address = [
    item.street || item.street_name || '',
    item.house_number || item.HomeNumber || ''
  ].filter(Boolean).join(' ').trim() || item.address_more?.text || '';

  // Calculate days on market from date_added
  let daysOnMarket = 0;
  if (item.date_added || item.DateAdded) {
    const addedDate = new Date(item.date_added || item.DateAdded);
    daysOnMarket = Math.floor((Date.now() - addedDate.getTime()) / (1000 * 60 * 60 * 24));
  } else if (item.date) {
    // Parse relative date like "לפני 3 ימים"
    const match = item.date.match(/לפני\s+(\d+)\s+(ימים|יום|שבועות|שבוע|חודשים|חודש)/);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2];
      if (unit.includes('יום') || unit.includes('ימים')) daysOnMarket = num;
      else if (unit.includes('שבוע')) daysOnMarket = num * 7;
      else if (unit.includes('חודש')) daysOnMarket = num * 30;
    }
  }

  // Check for urgent indicators in title/description
  const text = [item.title, item.info_text, item.merchant_name].filter(Boolean).join(' ');
  const isUrgent = /דחוף|הזדמנות|חייב למכור|מחיר מיוחד|להתקשר עכשיו/i.test(text);
  const isForeclosure = /כינוס|כונס|הוצל"פ|הוצלפ/i.test(text);
  const isInheritance = /ירושה|עיזבון/i.test(text);

  return {
    listing_id: item.id?.toString() || item.token,
    address,
    street: item.street || item.street_name || '',
    house_number: item.house_number || item.HomeNumber || '',
    asking_price: price,
    rooms,
    area_sqm: areaSqm,
    floor,
    days_on_market: daysOnMarket,
    description: [item.title, item.info_text].filter(Boolean).join(' - ').substring(0, 500),
    url: item.id ? `https://www.yad2.co.il/item/${item.id}` : null,
    is_urgent: isUrgent,
    is_foreclosure: isForeclosure,
    is_inheritance: isInheritance,
    updated_at: item.updated_at || item.date_added || new Date().toISOString()
  };
}

/**
 * Query Perplexity for yad2 listings (fallback)
 */
async function queryYad2Perplexity(complex) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const addresses = complex.addresses || '';
  const streets = addresses.split(',').map(a => a.trim()).filter(Boolean);
  const streetList = streets.length > 0 ? streets.join(', ') : complex.name;

  const prompt = `חפש מודעות למכירה פעילות באתר yad2.co.il עבור הכתובות הבאות ב${complex.city}:
${streetList}

עבור כל מודעה שנמצאת, החזר את הפרטים הבאים בפורמט JSON:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "street": "שם הרחוב",
      "house_number": "מספר בית",
      "asking_price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח_במ"ר,
      "floor": קומה,
      "description": "תיאור קצר",
      "url": "קישור למודעה",
      "listing_id": "מזהה מודעה",
      "days_on_market": ימים_באתר,
      "is_urgent": true/false,
      "is_foreclosure": true/false,
      "is_inheritance": true/false
    }
  ],
  "total_found": מספר_כולל
}

חשוב:
- רק דירות למכירה, לא להשכרה
- מחירים בשקלים
- שים לב למילים: דחוף, הזדמנות, כינוס, ירושה, חייב למכור`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Return ONLY valid JSON, no markdown, no explanations.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    const parsed = parsePerplexityResponse(content);
    return { listings: parsed.listings, source: 'perplexity' };
  } catch (err) {
    logger.warn(`Perplexity yad2 query failed for ${complex.name}`, { error: err.message });
    return null;
  }
}

/**
 * Parse Perplexity JSON response
 */
function parsePerplexityResponse(content) {
  try {
    const cleaned = content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    
    const parsed = JSON.parse(cleaned);
    return {
      listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      total_found: parsed.total_found || 0
    };
  } catch (e) {
    const jsonMatch = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          listings: Array.isArray(parsed.listings) ? parsed.listings : [],
          total_found: parsed.total_found || 0
        };
      } catch (e2) {}
    }
    return { listings: [], total_found: 0 };
  }
}

/**
 * Query yad2 with fallback strategy
 */
async function queryYad2Listings(complex) {
  // Try direct API first
  let result = await queryYad2Direct(complex);
  
  // Fallback to Perplexity if direct fails
  if (!result || result.listings.length === 0) {
    result = await queryYad2Perplexity(complex);
  }
  
  if (!result) {
    return { listings: [], source: 'none' };
  }
  
  return result;
}

/**
 * Process and store a single listing
 */
async function processListing(listing, complexId, complexCity) {
  try {
    const price = parseFloat(listing.asking_price) || null;
    const areaSqm = parseFloat(listing.area_sqm) || null;
    const rooms = parseFloat(listing.rooms) || null;
    const floor = parseInt(listing.floor) || null;
    const pricePsm = (price && areaSqm && areaSqm > 0) ? Math.round(price / areaSqm) : null;
    const address = listing.address || `${listing.street || ''} ${listing.house_number || ''}`.trim();
    const sourceListingId = listing.listing_id || listing.url || `yad2-${complexId}-${address}-${price}`;
    const description = listing.description || '';

    // Check for existing listing
    const existing = await pool.query(
      `SELECT id, asking_price, original_price, price_changes, first_seen, days_on_market
       FROM listings 
       WHERE complex_id = $1 AND (
         (source_listing_id = $2 AND source_listing_id IS NOT NULL AND source_listing_id != '')
         OR (address = $3 AND ABS(asking_price - $4) < 50000)
       ) AND is_active = TRUE
       LIMIT 1`,
      [complexId, sourceListingId, address, price || 0]
    );

    if (existing.rows.length > 0) {
      // Update existing listing
      const ex = existing.rows[0];
      let priceChanges = ex.price_changes || 0;
      let totalDrop = 0;
      const originalPrice = parseFloat(ex.original_price) || parseFloat(ex.asking_price);

      // Detect price change (more than 1% difference)
      if (price && ex.asking_price) {
        const priceDiff = Math.abs(price - parseFloat(ex.asking_price));
        if (priceDiff > parseFloat(ex.asking_price) * 0.01 && priceDiff > 5000) {
          priceChanges++;
          if (originalPrice && price < originalPrice) {
            totalDrop = ((originalPrice - price) / originalPrice) * 100;
          }
        }
      }

      // Update days on market
      let daysOnMarket = listing.days_on_market || ex.days_on_market || 0;
      if (ex.first_seen && !listing.days_on_market) {
        const firstSeen = new Date(ex.first_seen);
        daysOnMarket = Math.max(daysOnMarket, Math.floor((Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24)));
      }

      const keywords = detectKeywords(description);

      await pool.query(
        `UPDATE listings SET
          last_seen = CURRENT_DATE,
          asking_price = COALESCE($1, asking_price),
          price_per_sqm = COALESCE($2, price_per_sqm),
          price_changes = $3,
          total_price_drop_percent = $4,
          days_on_market = $5,
          description_snippet = COALESCE($6, description_snippet),
          has_urgent_keywords = $7,
          urgent_keywords_found = $8,
          is_foreclosure = $9,
          is_inheritance = $10,
          url = COALESCE($11, url),
          updated_at = NOW()
        WHERE id = $12`,
        [
          price, pricePsm, priceChanges, totalDrop, daysOnMarket,
          description.substring(0, 500),
          keywords.has_urgent_keywords || listing.is_urgent,
          keywords.urgent_keywords_found,
          keywords.is_foreclosure || listing.is_foreclosure,
          keywords.is_inheritance || listing.is_inheritance,
          listing.url,
          ex.id
        ]
      );

      return { 
        action: 'updated', 
        id: ex.id, 
        priceChanged: priceChanges > (ex.price_changes || 0),
        priceDrop: totalDrop > 0 ? totalDrop.toFixed(1) : null
      };

    } else {
      // Insert new listing
      const keywords = detectKeywords(description);
      const daysOnMarket = parseInt(listing.days_on_market) || 0;

      const result = await pool.query(
        `INSERT INTO listings (
          complex_id, source, source_listing_id, url,
          asking_price, area_sqm, rooms, floor, price_per_sqm,
          address, city, first_seen, last_seen, days_on_market,
          original_price, description_snippet,
          has_urgent_keywords, urgent_keywords_found, is_foreclosure, is_inheritance,
          is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE, CURRENT_DATE, $12, $13, $14, $15, $16, $17, $18, TRUE)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
          complexId, 'yad2', sourceListingId, listing.url || null,
          price, areaSqm, rooms, floor, pricePsm,
          address, complexCity, daysOnMarket,
          price,
          description.substring(0, 500),
          keywords.has_urgent_keywords || listing.is_urgent,
          keywords.urgent_keywords_found,
          keywords.is_foreclosure || listing.is_foreclosure,
          keywords.is_inheritance || listing.is_inheritance
        ]
      );

      if (result.rows.length > 0) {
        return { action: 'inserted', id: result.rows[0].id };
      }
      return { action: 'skipped' };
    }
  } catch (err) {
    logger.warn(`Failed to process listing for complex ${complexId}`, { error: err.message });
    return { action: 'error', error: err.message };
  }
}


/**
 * Create alert for a new listing in a high-IAI complex
 */
async function createNewListingAlert(listingId, complexId, listing, iai_score) {
  if (!iai_score || iai_score < 40) return; // Only alert for investment-grade complexes

  const complex = await pool.query('SELECT name, city FROM complexes WHERE id = $1', [complexId]);
  if (complex.rows.length === 0) return;

  const c = complex.rows[0];
  const severity = iai_score >= 70 ? 'high' : 'medium';
  const price = listing.asking_price ? `${parseInt(listing.asking_price).toLocaleString('he-IL')} ₪` : 'מחיר לא ידוע';
  const rooms = listing.rooms ? `${listing.rooms} חד'` : '';
  const area = listing.area_sqm ? `${listing.area_sqm}מ"ר` : '';

  const urgencyFlag = (listing.is_urgent || listing.is_foreclosure || listing.is_inheritance)
    ? ' 🚨 ' + [
        listing.is_foreclosure ? 'כינוס' : null,
        listing.is_inheritance ? 'ירושה' : null,
        listing.is_urgent ? 'דחוף' : null
      ].filter(Boolean).join(' | ')
    : '';

  const title = `מודעה חדשה: ${c.name} (${c.city})${urgencyFlag}`;
  const message = `${listing.address || ''} | ${rooms} ${area} | ${price} | IAI: ${iai_score}`;

  try {
    await pool.query(
      `INSERT INTO alerts (complex_id, listing_id, alert_type, severity, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        complexId, listingId, 'new_listing', severity, title, message,
        JSON.stringify({
          listing_id: listingId,
          iai_score,
          is_foreclosure: listing.is_foreclosure,
          is_inheritance: listing.is_inheritance,
          is_urgent: listing.is_urgent,
          price: listing.asking_price,
          rooms: listing.rooms,
          area_sqm: listing.area_sqm
        })
      ]
    );
    logger.info(`[YAD2] New listing alert created for ${c.name}: ${title}`);
  } catch (err) {
    logger.warn(`[YAD2] Failed to create new listing alert`, { error: err.message });
  }
}

/**
 * Generate alert for significant price drop
 */
async function createPriceDropAlert(listingId, complexId, dropPercent, currentPrice, originalPrice, address) {
  if (dropPercent < 5) return; // Only alert on drops > 5%

  const complex = await pool.query('SELECT name, city FROM complexes WHERE id = $1', [complexId]);
  if (complex.rows.length === 0) return;

  const severity = dropPercent >= 20 ? 'high' : 'medium';
  const title = `ירידת מחיר: ${complex.rows[0].name} (${complex.rows[0].city})`;
  const message = `ירידה של ${dropPercent.toFixed(1)}% | ${address} | ` +
    `${currentPrice.toLocaleString()} ש"ח (היה ${originalPrice.toLocaleString()} ש"ח)`;

  await pool.query(
    `INSERT INTO alerts (complex_id, listing_id, alert_type, severity, title, message, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      complexId, listingId, 'price_drop', severity, title, message,
      JSON.stringify({ listing_id: listingId, drop_percent: dropPercent.toFixed(2) })
    ]
  );
}

/**
 * Scan yad2 listings for a single complex
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, addresses, iai_score FROM complexes WHERE id = $1',
    [complexId]
  );
  if (complexResult.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = complexResult.rows[0];
  logger.info(`Scanning yad2 for: ${complex.name} (${complex.city}) IAI=${complex.iai_score || 0}`);

  const data = await queryYad2Listings(complex);
  
  let newListings = 0;
  let updatedListings = 0;
  let priceChanges = 0;
  let errors = 0;
  const priceDrops = [];
  const newListingIds = []; // Track new listings for alerts

  for (const listing of data.listings) {
    const result = await processListing(listing, complexId, complex.city);
    if (result.action === 'inserted') {
      newListings++;
      if (result.id) { newListingIds.push({ id: result.id, listing }); }
    } else if (result.action === 'updated') {
      updatedListings++;
      if (result.priceChanged) {
        priceChanges++;
        if (result.priceDrop) {
          priceDrops.push({
            listingId: result.id,
            drop: parseFloat(result.priceDrop)
          });
        }
      }
    } else if (result.action === 'error') {
      errors++;
    }
  }

  // Generate alerts for significant price drops
  for (const drop of priceDrops) {
    const listingInfo = await pool.query(
      'SELECT asking_price, original_price, address FROM listings WHERE id = $1',
      [drop.listingId]
    );
    if (listingInfo.rows.length > 0) {
      const l = listingInfo.rows[0];
      await createPriceDropAlert(
        drop.listingId, complexId, drop.drop,
        parseFloat(l.asking_price), parseFloat(l.original_price), l.address
      );
    }
  }

  // Generate alerts for new listings in high-IAI complexes
  for (const { id, listing } of newListingIds) {
    await createNewListingAlert(id, complexId, listing, complex.iai_score);
  }

  // Mark old listings as inactive (only if we got results)
  if (data.listings.length > 0) {
    await pool.query(
      `UPDATE listings SET is_active = FALSE 
       WHERE complex_id = $1 AND source = 'yad2' AND is_active = TRUE 
       AND last_seen < CURRENT_DATE - INTERVAL '21 days'`,
      [complexId]
    );
  }

  // Update last scan timestamp
  await pool.query(
    `UPDATE complexes SET last_yad2_scan = NOW() WHERE id = $1`,
    [complexId]
  );

  return {
    complex: complex.name,
    city: complex.city,
    source: data.source,
    listingsProcessed: data.listings.length,
    newListings,
    updatedListings,
    priceChanges,
    priceDropAlerts: priceDrops.length,
    newListingAlerts: newListingIds.length,
    errors
  };
}

/**
 * Scan yad2 listings for all complexes
 */
async function scanAll(options = {}) {
  const { staleOnly = true, limit = 50, city = null } = options;

  let query = 'SELECT id, name, city, addresses, iai_score FROM complexes WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (city) {
    paramCount++;
    query += ` AND city = $${paramCount}`;
    params.push(city);
  }

  if (staleOnly) {
    query += ` AND (last_yad2_scan IS NULL OR last_yad2_scan < NOW() - INTERVAL '3 days')`;
  }

  // Prioritize high-IAI complexes
  query += ` ORDER BY iai_score DESC NULLS LAST`;
  
  paramCount++;
  query += ` LIMIT $${paramCount}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`yad2 batch scan: ${total} complexes to scan`);

  let succeeded = 0;
  let failed = 0;
  let totalNew = 0;
  let totalUpdated = 0;
  let totalPriceChanges = 0;
  let totalAlerts = 0;
  const details = [];

  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      succeeded++;
      totalNew += result.newListings;
      totalUpdated += result.updatedListings;
      totalPriceChanges += result.priceChanges;
      totalAlerts += result.priceDropAlerts || 0;
      details.push({ status: 'ok', ...result });

      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS));
    } catch (err) {
      failed++;
      details.push({
        status: 'error',
        complex: complex.name,
        city: complex.city,
        error: err.message
      });
      logger.warn(`yad2 scan failed for ${complex.name}`, { error: err.message });
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info(`yad2 batch scan complete: ${succeeded}/${total} ok, ${totalNew} new, ${totalUpdated} updated, ${totalPriceChanges} price changes, ${totalAlerts} alerts`);

  return {
    total,
    succeeded,
    failed,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    totalAlerts,
    details
  };
}

module.exports = {
  scanComplex,
  scanAll,
  queryYad2Listings,
  queryYad2Direct,
  queryYad2Perplexity,
  processListing,
  getCityCode,
  createNewListingAlert,
  createPriceDropAlert
};

