/**
 * Facebook Marketplace Scraper (Phase 4.19)
 * 
 * Scrapes Facebook Marketplace real estate listings using Perplexity AI.
 * Facebook doesn't offer a public API for Marketplace, so we use AI-powered
 * search to find and parse listings.
 * 
 * Strategy:
 * 1. Query Perplexity AI to search Facebook Marketplace for each city/complex
 * 2. Parse structured listing data from AI response
 * 3. Match listings to tracked complexes
 * 4. Store in listings table with source='facebook'
 * 5. Track price changes and generate alerts
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { detectKeywords } = require('./ssiCalculator');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_BETWEEN_REQUESTS = 4000; // 4s between requests (be gentle)

// Facebook Marketplace Hebrew city name variations
const FB_CITY_NAMES = {
  'תל אביב יפו': ['תל אביב', 'תל אביב יפו', 'Tel Aviv'],
  'תל אביב': ['תל אביב', 'תל אביב יפו', 'Tel Aviv'],
  'רמת גן': ['רמת גן', 'Ramat Gan'],
  'גבעתיים': ['גבעתיים', 'Givatayim'],
  'חולון': ['חולון', 'Holon'],
  'בת ים': ['בת ים', 'Bat Yam'],
  'ראשון לציון': ['ראשון לציון', 'Rishon LeZion'],
  'פתח תקווה': ['פתח תקווה', 'Petah Tikva'],
  'בני ברק': ['בני ברק', 'Bnei Brak'],
  'הרצליה': ['הרצליה', 'Herzliya'],
  'רעננה': ['רעננה', 'Raanana'],
  'כפר סבא': ['כפר סבא', 'Kfar Saba'],
  'נתניה': ['נתניה', 'Netanya'],
  'חיפה': ['חיפה', 'Haifa'],
  'באר שבע': ['באר שבע', 'Beer Sheva'],
  'ירושלים': ['ירושלים', 'Jerusalem'],
  'אשדוד': ['אשדוד', 'Ashdod'],
  'אשקלון': ['אשקלון', 'Ashkelon'],
  'רחובות': ['רחובות', 'Rehovot'],
  'לוד': ['לוד', 'Lod'],
  'רמלה': ['רמלה', 'Ramla'],
  'מודיעין': ['מודיעין', 'Modiin'],
  'נס ציונה': ['נס ציונה', 'Ness Ziona'],
  'ראש העין': ['ראש העין', 'Rosh HaAyin'],
  'חדרה': ['חדרה', 'Hadera']
};

/**
 * Get Facebook-friendly city name variations
 */
function getCityNames(cityName) {
  if (FB_CITY_NAMES[cityName]) return FB_CITY_NAMES[cityName];
  return [cityName];
}

/**
 * Query Perplexity AI to search Facebook Marketplace listings
 */
async function queryFacebookPerplexity(complex) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    logger.warn('PERPLEXITY_API_KEY not set, cannot search Facebook Marketplace');
    return null;
  }

  const cityNames = getCityNames(complex.city);
  const addresses = (complex.addresses || '').split(',').map(a => a.trim()).filter(Boolean);
  const streetNames = addresses.map(addr => addr.replace(/\d+/g, '').trim()).filter(Boolean);
  
  const locationHint = streetNames.length > 0 
    ? `ברחובות: ${streetNames.slice(0, 3).join(', ')} ב${complex.city}`
    : `ב${complex.city}`;

  const prompt = `חפש מודעות דירות למכירה בפייסבוק מרקטפלייס (Facebook Marketplace) ${locationHint}.

חפש גם בקבוצות פייסבוק לנדל"ן ב${complex.city} כמו:
- "דירות למכירה ${complex.city}"
- "נדל"ן ${complex.city}"
- "דירות ${complex.city}"

עבור כל מודעה שנמצאת, החזר את הפרטים בפורמט JSON:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "street": "שם הרחוב",
      "house_number": "מספר בית",
      "asking_price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח_במטרים,
      "floor": קומה,
      "description": "תיאור קצר מהמודעה",
      "url": "קישור למודעה בפייסבוק",
      "listing_id": "מזהה מודעה או קישור",
      "seller_name": "שם המפרסם",
      "days_on_market": ימים_מאז_פרסום,
      "is_urgent": true/false,
      "is_foreclosure": true/false,
      "is_inheritance": true/false,
      "is_agent": true/false,
      "phone": "טלפון אם מופיע"
    }
  ],
  "total_found": מספר_כולל,
  "groups_searched": ["שמות הקבוצות שנבדקו"]
}

חשוב מאוד:
- רק דירות למכירה, לא להשכרה
- מחירים בשקלים בלבד
- שים לב למילים: דחוף, הזדמנות, כינוס, ירושה, חייב למכור, מתחת לשוק, הורדת מחיר
- ציין אם המפרסם הוא מתווך/סוכן (is_agent)
- אם יש מספר טלפון במודעה, הוסף אותו
- החזר רק JSON תקין, בלי הסברים`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a real estate data extraction expert. Return ONLY valid JSON, no markdown, no explanations. Search Facebook Marketplace Israel for real estate listings.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 3000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    const parsed = parsePerplexityResponse(content);
    
    logger.debug(`Facebook Perplexity returned ${parsed.listings.length} listings for ${complex.name} (${complex.city})`);
    return { 
      listings: parsed.listings, 
      source: 'facebook_perplexity',
      groups_searched: parsed.groups_searched || []
    };
  } catch (err) {
    logger.warn(`Facebook Perplexity query failed for ${complex.name}`, { error: err.message });
    return null;
  }
}

/**
 * Query Perplexity for Facebook groups listings by city (batch approach)
 */
async function queryFacebookByCity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  const cityNames = getCityNames(city);

  const prompt = `חפש את כל הדירות למכירה בפייסבוק מרקטפלייס ובקבוצות פייסבוק של נדל"ן ב${city}.

חפש בקבוצות כמו:
- "דירות למכירה ב${city}"
- "נדל"ן ${city}"
- "דירות ${city} והסביבה"
- "פינוי בינוי ${city}"

החזר עד 30 מודעות בפורמט JSON:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "street": "שם הרחוב",
      "house_number": "מספר בית",
      "asking_price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח_במטרים,
      "floor": קומה,
      "description": "תיאור קצר",
      "url": "קישור",
      "listing_id": "מזהה",
      "seller_name": "שם המפרסם",
      "days_on_market": ימים,
      "is_urgent": true/false,
      "is_foreclosure": true/false,
      "is_inheritance": true/false,
      "is_agent": true/false,
      "phone": "טלפון"
    }
  ],
  "total_found": מספר_כולל,
  "groups_searched": ["שמות קבוצות"]
}

חשוב: רק מכירה, לא השכרה. מחירים בשקלים. שים לב למילות מצוקה: דחוף, כינוס, ירושה, חייב למכור.`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Return ONLY valid JSON. Search Facebook Marketplace and Facebook groups for Israeli real estate listings.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    const parsed = parsePerplexityResponse(content);
    
    logger.info(`Facebook city scan: ${parsed.listings.length} listings found for ${city}`);
    return { 
      listings: parsed.listings, 
      source: 'facebook_perplexity',
      groups_searched: parsed.groups_searched || []
    };
  } catch (err) {
    logger.warn(`Facebook city scan failed for ${city}`, { error: err.message });
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
      total_found: parsed.total_found || 0,
      groups_searched: parsed.groups_searched || []
    };
  } catch (e) {
    // Try to extract JSON from mixed content
    const jsonMatch = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          listings: Array.isArray(parsed.listings) ? parsed.listings : [],
          total_found: parsed.total_found || 0,
          groups_searched: parsed.groups_searched || []
        };
      } catch (e2) {}
    }
    logger.debug('Failed to parse Facebook Perplexity response', { content: content.substring(0, 200) });
    return { listings: [], total_found: 0, groups_searched: [] };
  }
}

/**
 * Match a listing to a complex by address/street
 */
async function matchListingToComplex(listing, city) {
  if (!listing.street && !listing.address) return null;

  const searchTerms = [
    listing.street,
    listing.address?.split(/\d/)[0]?.trim()
  ].filter(Boolean);

  for (const term of searchTerms) {
    if (!term || term.length < 3) continue;
    
    try {
      const result = await pool.query(
        `SELECT id, name, addresses FROM complexes 
         WHERE city = $1 AND addresses ILIKE $2
         LIMIT 1`,
        [city, `%${term}%`]
      );
      if (result.rows.length > 0) return result.rows[0];
    } catch (err) {
      logger.debug(`Complex match query failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Process and store a single Facebook listing
 */
async function processListing(listing, complexId, complexCity) {
  try {
    const price = parseFloat(listing.asking_price) || null;
    const areaSqm = parseFloat(listing.area_sqm) || null;
    const rooms = parseFloat(listing.rooms) || null;
    const floor = parseInt(listing.floor) || null;
    const pricePsm = (price && areaSqm && areaSqm > 0) ? Math.round(price / areaSqm) : null;
    const address = listing.address || `${listing.street || ''} ${listing.house_number || ''}`.trim();
    const sourceListingId = listing.listing_id || listing.url || `fb-${complexId}-${address}-${price}`;
    
    // Build description with seller info
    let description = listing.description || '';
    if (listing.seller_name) description += ` | מפרסם: ${listing.seller_name}`;
    if (listing.is_agent) description += ' [מתווך]';
    if (listing.phone) description += ` | טל: ${listing.phone}`;

    // Check for existing listing
    const existing = await pool.query(
      `SELECT id, asking_price, original_price, price_changes, first_seen, days_on_market
       FROM listings 
       WHERE complex_id = $1 AND (
         (source_listing_id = $2 AND source_listing_id IS NOT NULL AND source_listing_id != '')
         OR (source = 'facebook' AND address = $3 AND ABS(COALESCE(asking_price,0) - $4) < 50000)
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

      if (price && ex.asking_price) {
        const priceDiff = Math.abs(price - parseFloat(ex.asking_price));
        if (priceDiff > parseFloat(ex.asking_price) * 0.01 && priceDiff > 5000) {
          priceChanges++;
          if (originalPrice && price < originalPrice) {
            totalDrop = ((originalPrice - price) / originalPrice) * 100;
          }
        }
      }

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
          complexId, 'facebook', sourceListingId, listing.url || null,
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
    logger.warn(`Failed to process Facebook listing for complex ${complexId}`, { error: err.message });
    return { action: 'error', error: err.message };
  }
}

/**
 * Scan Facebook Marketplace for a single complex
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, addresses FROM complexes WHERE id = $1',
    [complexId]
  );
  if (complexResult.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = complexResult.rows[0];
  logger.info(`Scanning Facebook for: ${complex.name} (${complex.city})`);

  const data = await queryFacebookPerplexity(complex);
  
  if (!data || data.listings.length === 0) {
    return {
      complex: complex.name,
      city: complex.city,
      source: 'none',
      listingsProcessed: 0,
      newListings: 0,
      updatedListings: 0,
      priceChanges: 0,
      errors: 0
    };
  }

  let newListings = 0;
  let updatedListings = 0;
  let priceChanges = 0;
  let errors = 0;

  for (const listing of data.listings) {
    const result = await processListing(listing, complexId, complex.city);
    if (result.action === 'inserted') newListings++;
    else if (result.action === 'updated') {
      updatedListings++;
      if (result.priceChanged) priceChanges++;
    } else if (result.action === 'error') errors++;
  }

  // Mark old Facebook listings as inactive
  if (data.listings.length > 0) {
    await pool.query(
      `UPDATE listings SET is_active = FALSE 
       WHERE complex_id = $1 AND source = 'facebook' AND is_active = TRUE 
       AND last_seen < CURRENT_DATE - INTERVAL '14 days'`,
      [complexId]
    );
  }

  // Update last scan timestamp
  await pool.query(
    `UPDATE complexes SET last_facebook_scan = NOW() WHERE id = $1`,
    [complexId]
  );

  return {
    complex: complex.name,
    city: complex.city,
    source: data.source,
    groups_searched: data.groups_searched,
    listingsProcessed: data.listings.length,
    newListings,
    updatedListings,
    priceChanges,
    errors
  };
}

/**
 * Scan Facebook by city - find listings and match to complexes
 */
async function scanCity(city) {
  logger.info(`Facebook city scan starting: ${city}`);

  const data = await queryFacebookByCity(city);
  if (!data || data.listings.length === 0) {
    return { city, source: 'none', listings: 0, matched: 0, unmatched: 0, errors: 0 };
  }

  let matched = 0;
  let unmatched = 0;
  let newListings = 0;
  let errors = 0;

  for (const listing of data.listings) {
    try {
      // Try to match listing to a complex
      const complex = await matchListingToComplex(listing, city);
      
      if (complex) {
        const result = await processListing(listing, complex.id, city);
        matched++;
        if (result.action === 'inserted') newListings++;
      } else {
        unmatched++;
        // Store unmatched listings with complex_id = NULL for manual review
        const sourceListingId = listing.listing_id || listing.url || `fb-city-${city}-${listing.address}-${listing.asking_price}`;
        const price = parseFloat(listing.asking_price) || null;
        const areaSqm = parseFloat(listing.area_sqm) || null;
        const pricePsm = (price && areaSqm && areaSqm > 0) ? Math.round(price / areaSqm) : null;
        
        let description = listing.description || '';
        if (listing.seller_name) description += ` | מפרסם: ${listing.seller_name}`;
        if (listing.phone) description += ` | טל: ${listing.phone}`;

        await pool.query(
          `INSERT INTO listings (
            complex_id, source, source_listing_id, url,
            asking_price, area_sqm, rooms, floor, price_per_sqm,
            address, city, first_seen, last_seen, days_on_market,
            original_price, description_snippet,
            has_urgent_keywords, is_foreclosure, is_inheritance, is_active
          ) VALUES (NULL, 'facebook', $1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, CURRENT_DATE, $10, $3, $11, $12, $13, $14, TRUE)
          ON CONFLICT DO NOTHING`,
          [
            sourceListingId, listing.url || null,
            price, areaSqm, parseFloat(listing.rooms) || null, parseInt(listing.floor) || null, pricePsm,
            listing.address || '', city, parseInt(listing.days_on_market) || 0,
            (description || '').substring(0, 500),
            listing.is_urgent || false, listing.is_foreclosure || false, listing.is_inheritance || false
          ]
        );
        if (price) newListings++;
      }
    } catch (err) {
      errors++;
      logger.debug(`Error processing Facebook listing in ${city}: ${err.message}`);
    }
  }

  logger.info(`Facebook city scan complete: ${city} - ${data.listings.length} found, ${matched} matched, ${unmatched} unmatched, ${newListings} new`);

  return {
    city,
    source: data.source,
    groups_searched: data.groups_searched,
    totalListings: data.listings.length,
    matched,
    unmatched,
    newListings,
    errors
  };
}

/**
 * Scan Facebook for all complexes (batch)
 */
async function scanAll(options = {}) {
  const { staleOnly = true, limit = 30, city = null } = options;

  let query = 'SELECT id, name, city, addresses, iai_score FROM complexes WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (city) {
    paramCount++;
    query += ` AND city = $${paramCount}`;
    params.push(city);
  }

  if (staleOnly) {
    query += ` AND (last_facebook_scan IS NULL OR last_facebook_scan < NOW() - INTERVAL '5 days')`;
  }

  query += ` ORDER BY iai_score DESC NULLS LAST`;
  
  paramCount++;
  query += ` LIMIT $${paramCount}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`Facebook batch scan: ${total} complexes to scan`);

  let succeeded = 0;
  let failed = 0;
  let totalNew = 0;
  let totalUpdated = 0;
  const details = [];

  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      succeeded++;
      totalNew += result.newListings;
      totalUpdated += result.updatedListings;
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
      logger.warn(`Facebook scan failed for ${complex.name}`, { error: err.message });
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info(`Facebook batch scan complete: ${succeeded}/${total} ok, ${totalNew} new, ${totalUpdated} updated`);

  return {
    total,
    succeeded,
    failed,
    totalNew,
    totalUpdated,
    details
  };
}

/**
 * Get Facebook scan statistics
 */
async function getStats() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_listings,
      COUNT(*) FILTER (WHERE is_active) as active_listings,
      COUNT(*) FILTER (WHERE complex_id IS NOT NULL) as matched_listings,
      COUNT(*) FILTER (WHERE complex_id IS NULL) as unmatched_listings,
      COUNT(*) FILTER (WHERE has_urgent_keywords) as urgent_listings,
      COUNT(*) FILTER (WHERE is_foreclosure) as foreclosure_listings,
      COUNT(DISTINCT city) as cities,
      MIN(first_seen) as earliest_listing,
      MAX(last_seen) as latest_scan
    FROM listings 
    WHERE source = 'facebook'
  `);

  return result.rows[0];
}

module.exports = {
  scanComplex,
  scanCity,
  scanAll,
  queryFacebookPerplexity,
  queryFacebookByCity,
  processListing,
  matchListingToComplex,
  getStats,
  getCityNames
};
