/**
 * Facebook Marketplace Scraper (Phase 4.20 - Apify Integration)
 * 
 * Scrapes Facebook Marketplace real estate listings using Apify API.
 * Replaces Perplexity AI approach with actual Facebook scraping via Apify actors.
 * 
 * Strategy:
 * 1. Build Facebook Marketplace URLs for Israeli cities (property for sale)
 * 2. Run Apify actor to scrape actual listings
 * 3. Parse and normalize Apify results to our listing format
 * 4. Match listings to tracked complexes by address
 * 5. Store in listings table with source='facebook'
 * 6. Track price changes and generate alerts
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { detectKeywords } = require('./ssiCalculator');

// Apify configuration
const APIFY_BASE_URL = 'https://api.apify.com/v2';
const APIFY_ACTOR_ID = 'apify~facebook-marketplace-scraper'; // Official Apify FB Marketplace scraper
const APIFY_TIMEOUT = 120000; // 2 minutes max wait for sync run
const DELAY_BETWEEN_SCANS = 5000; // 5s between city scans

// Facebook Marketplace URL slugs for Israeli cities
const FB_CITY_SLUGS = {
  'תל אביב יפו': 'tel-aviv',
  'תל אביב': 'tel-aviv',
  'רמת גן': 'ramat-gan',
  'גבעתיים': 'givatayim',
  'חולון': 'holon',
  'בת ים': 'bat-yam',
  'ראשון לציון': 'rishon-lezion',
  'פתח תקווה': 'petah-tikva',
  'בני ברק': 'bnei-brak',
  'הרצליה': 'herzliya',
  'רעננה': 'raanana',
  'כפר סבא': 'kfar-saba',
  'נתניה': 'netanya',
  'חיפה': 'haifa',
  'באר שבע': 'beer-sheva',
  'ירושלים': 'jerusalem',
  'אשדוד': 'ashdod',
  'אשקלון': 'ashkelon',
  'רחובות': 'rehovot',
  'לוד': 'lod',
  'רמלה': 'ramla',
  'מודיעין': 'modiin',
  'נס ציונה': 'ness-ziona',
  'ראש העין': 'rosh-haayin',
  'חדרה': 'hadera',
  'יבנה': 'yavne',
  'נהריה': 'nahariya',
  'עכו': 'akko',
  'כרמיאל': 'karmiel',
  'טבריה': 'tiberias',
  'אילת': 'eilat',
  'קריית גת': 'kiryat-gat',
  'קריית אתא': 'kiryat-ata',
  'קריית ים': 'kiryat-yam'
};

// Hebrew city name variations for matching
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
 * Build Facebook Marketplace URL for a city
 */
function buildMarketplaceUrl(city, category = 'propertyforsale') {
  const slug = FB_CITY_SLUGS[city];
  if (!slug) {
    const names = getCityNames(city);
    const englishName = names.find(n => /^[a-zA-Z]/.test(n));
    if (englishName) {
      return `https://www.facebook.com/marketplace/${englishName.toLowerCase().replace(/\s+/g, '-')}/${category}`;
    }
    return null;
  }
  return `https://www.facebook.com/marketplace/${slug}/${category}`;
}

/**
 * Run Apify actor and get results (synchronous - waits for completion)
 */
async function runApifyActor(input, options = {}) {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    logger.warn('APIFY_API_TOKEN not set, cannot scrape Facebook Marketplace');
    return null;
  }

  const timeout = options.timeout || APIFY_TIMEOUT;
  const actorId = options.actorId || APIFY_ACTOR_ID;

  try {
    const response = await axios.post(
      `${APIFY_BASE_URL}/acts/${actorId}/run-sync-get-dataset-items`,
      input,
      {
        params: { token: apiToken },
        headers: { 'Content-Type': 'application/json' },
        timeout: timeout
      }
    );

    const items = response.data;
    if (!Array.isArray(items)) {
      logger.warn('Apify returned non-array response', { type: typeof items });
      return [];
    }

    logger.info(`Apify actor returned ${items.length} items`);
    return items;

  } catch (err) {
    if (err.response?.status === 402) {
      logger.error('Apify: insufficient credits (402). Check your plan.');
    } else if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      logger.warn('Apify actor timed out, trying async approach...');
      return await runApifyActorAsync(input, options);
    } else {
      logger.warn(`Apify actor failed: ${err.message}`, { 
        status: err.response?.status,
        data: JSON.stringify(err.response?.data || '').substring(0, 200)
      });
    }
    return null;
  }
}

/**
 * Run Apify actor asynchronously (for longer-running scrapes)
 */
async function runApifyActorAsync(input, options = {}) {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) return null;

  const actorId = options.actorId || APIFY_ACTOR_ID;

  try {
    const startResponse = await axios.post(
      `${APIFY_BASE_URL}/acts/${actorId}/runs`,
      input,
      {
        params: { token: apiToken },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const runId = startResponse.data?.data?.id;
    if (!runId) {
      logger.warn('Apify: no run ID returned');
      return null;
    }

    logger.info(`Apify actor started, run ID: ${runId}`);

    const maxWait = 180000;
    const pollInterval = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

      const statusResponse = await axios.get(
        `${APIFY_BASE_URL}/actor-runs/${runId}`,
        { params: { token: apiToken }, timeout: 10000 }
      );

      const status = statusResponse.data?.data?.status;
      logger.debug(`Apify run ${runId} status: ${status}`);

      if (status === 'SUCCEEDED') {
        const datasetId = statusResponse.data?.data?.defaultDatasetId;
        if (!datasetId) return [];

        const dataResponse = await axios.get(
          `${APIFY_BASE_URL}/datasets/${datasetId}/items`,
          { params: { token: apiToken, format: 'json' }, timeout: 30000 }
        );

        return Array.isArray(dataResponse.data) ? dataResponse.data : [];
      }

      if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        logger.warn(`Apify run ${runId} ended with status: ${status}`);
        return null;
      }
    }

    logger.warn(`Apify run ${runId} polling timed out after ${maxWait / 1000}s`);
    return null;

  } catch (err) {
    logger.warn(`Apify async run failed: ${err.message}`);
    return null;
  }
}

/**
 * Normalize Apify listing to our internal format
 */
function normalizeApifyListing(item, city) {
  try {
    let price = null;
    const priceRaw = item.price || item.salePrice || item.listingPrice || '';
    const priceStr = String(priceRaw).replace(/[₪,\s]/g, '').replace(/[^\d.]/g, '');
    if (priceStr) {
      price = parseFloat(priceStr);
      if (price < 100000 || price > 50000000) price = null;
    }

    const title = item.title || item.name || '';
    const location = item.location || item.address || '';
    const description = item.description || '';
    
    const addressText = location || title;
    const streetMatch = addressText.match(/(רח(?:וב)?\.?\s*[^\d,]+?)[\s,]*(\d+)?/);
    const street = streetMatch ? streetMatch[1].replace(/^רח(?:וב)?\.?\s*/, '').trim() : '';
    const houseNumber = streetMatch ? (streetMatch[2] || '') : '';

    let rooms = null;
    const roomsMatch = (title + ' ' + description).match(/(\d+(?:\.\d)?)\s*(?:חד|חדר|rooms)/i);
    if (roomsMatch) rooms = parseFloat(roomsMatch[1]);

    let areaSqm = null;
    const areaMatch = (title + ' ' + description).match(/(\d+)\s*(?:מ"ר|מטר|sqm|m²)/i);
    if (areaMatch) areaSqm = parseFloat(areaMatch[1]);

    let floor = null;
    const floorMatch = (title + ' ' + description).match(/קומה\s*(\d+)/i);
    if (floorMatch) floor = parseInt(floorMatch[1]);

    const fullText = `${title} ${description} ${location}`.toLowerCase();
    const isUrgent = /דחוף|הזדמנות|חייב למכור|מתחת לשוק|הורדת מחיר|urgent/.test(fullText);
    const isForeclosure = /כינוס|כונס|receivership/.test(fullText);
    const isInheritance = /ירושה|עיזבון|inheritance/.test(fullText);
    const isAgent = /מתווך|תיווך|סוכן|agent|broker/.test(fullText);

    let daysOnMarket = 0;
    if (item.postedAt || item.datePosted || item.listingDate) {
      const postedDate = new Date(item.postedAt || item.datePosted || item.listingDate);
      if (!isNaN(postedDate.getTime())) {
        daysOnMarket = Math.floor((Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24));
      }
    }
    if (item.time) {
      const timeMatch = String(item.time).match(/(\d+)\s*(day|week|month|hour|minute|יום|שבוע|חודש)/i);
      if (timeMatch) {
        const num = parseInt(timeMatch[1]);
        const unit = timeMatch[2].toLowerCase();
        if (unit.includes('week') || unit.includes('שבוע')) daysOnMarket = num * 7;
        else if (unit.includes('month') || unit.includes('חודש')) daysOnMarket = num * 30;
        else if (unit.includes('day') || unit.includes('יום')) daysOnMarket = num;
        else daysOnMarket = 0;
      }
    }

    const sellerName = item.seller?.name || item.sellerName || item.seller || '';
    const phone = item.seller?.phone || item.phone || '';

    return {
      address: location || `${street} ${houseNumber}`.trim() || title.substring(0, 100),
      street, house_number: houseNumber,
      asking_price: price, rooms, area_sqm: areaSqm, floor,
      description: `${title}${description ? ' | ' + description.substring(0, 300) : ''}`,
      url: item.url || item.link || item.listingUrl || null,
      listing_id: item.id || item.listingId || item.url || null,
      seller_name: sellerName, days_on_market: daysOnMarket,
      is_urgent: isUrgent, is_foreclosure: isForeclosure,
      is_inheritance: isInheritance, is_agent: isAgent,
      phone, image: item.image || item.thumbnail || item.images?.[0] || null
    };
  } catch (err) {
    logger.debug(`Failed to normalize Apify listing: ${err.message}`);
    return null;
  }
}

/**
 * Query Facebook Marketplace via Apify for a specific city
 */
async function queryFacebookApify(city) {
  const marketplaceUrl = buildMarketplaceUrl(city);
  if (!marketplaceUrl) {
    logger.warn(`No Facebook Marketplace URL mapping for city: ${city}`);
    return null;
  }

  logger.info(`Querying Apify for Facebook Marketplace: ${city} → ${marketplaceUrl}`);

  const input = {
    startUrls: [{ url: marketplaceUrl }],
    maxItems: 50,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
  };

  const items = await runApifyActor(input);
  if (!items || items.length === 0) {
    return { listings: [], source: 'apify_empty' };
  }

  const listings = items
    .map(item => normalizeApifyListing(item, city))
    .filter(l => l !== null);

  logger.info(`Apify returned ${items.length} raw items, ${listings.length} normalized for ${city}`);
  return { listings, source: 'apify', rawCount: items.length };
}

/**
 * Query Facebook Marketplace for a specific complex
 */
async function queryFacebookForComplex(complex) {
  const marketplaceUrl = buildMarketplaceUrl(complex.city);
  if (!marketplaceUrl) return null;

  const input = {
    startUrls: [{ url: marketplaceUrl }],
    maxItems: 30,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
  };

  const items = await runApifyActor(input);
  if (!items || items.length === 0) return null;

  const listings = items
    .map(item => normalizeApifyListing(item, complex.city))
    .filter(l => l !== null);

  const complexAddresses = (complex.addresses || '').split(',').map(a => a.trim()).filter(Boolean);
  const streetNames = complexAddresses.map(addr => addr.replace(/\d+/g, '').trim()).filter(s => s.length > 2);

  if (streetNames.length > 0) {
    const matched = listings.filter(l => {
      const listingText = `${l.address} ${l.street} ${l.description}`.toLowerCase();
      return streetNames.some(street => listingText.includes(street.toLowerCase()));
    });
    if (matched.length > 0) {
      return { listings: matched, source: 'apify', rawCount: items.length };
    }
  }

  return { listings, source: 'apify', rawCount: items.length };
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
         WHERE city = $1 AND addresses ILIKE $2 LIMIT 1`,
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
    
    let description = listing.description || '';
    if (listing.seller_name) description += ` | מפרסם: ${listing.seller_name}`;
    if (listing.is_agent) description += ' [מתווך]';
    if (listing.phone) description += ` | טל: ${listing.phone}`;

    const existing = await pool.query(
      `SELECT id, asking_price, original_price, price_changes, first_seen, days_on_market
       FROM listings 
       WHERE complex_id = $1 AND (
         (source_listing_id = $2 AND source_listing_id IS NOT NULL AND source_listing_id != '')
         OR (source = 'facebook' AND address = $3 AND ABS(COALESCE(asking_price,0) - $4) < 50000)
       ) AND is_active = TRUE LIMIT 1`,
      [complexId, sourceListingId, address, price || 0]
    );

    if (existing.rows.length > 0) {
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
          last_seen = CURRENT_DATE, asking_price = COALESCE($1, asking_price),
          price_per_sqm = COALESCE($2, price_per_sqm), price_changes = $3,
          total_price_drop_percent = $4, days_on_market = $5,
          description_snippet = COALESCE($6, description_snippet),
          has_urgent_keywords = $7, urgent_keywords_found = $8,
          is_foreclosure = $9, is_inheritance = $10,
          url = COALESCE($11, url), updated_at = NOW()
        WHERE id = $12`,
        [price, pricePsm, priceChanges, totalDrop, daysOnMarket,
          description.substring(0, 500),
          keywords.has_urgent_keywords || listing.is_urgent,
          keywords.urgent_keywords_found,
          keywords.is_foreclosure || listing.is_foreclosure,
          keywords.is_inheritance || listing.is_inheritance,
          listing.url, ex.id]
      );

      return { action: 'updated', id: ex.id, priceChanged: priceChanges > (ex.price_changes || 0),
        priceDrop: totalDrop > 0 ? totalDrop.toFixed(1) : null };
    } else {
      const keywords = detectKeywords(description);
      const daysOnMarket = parseInt(listing.days_on_market) || 0;

      const result = await pool.query(
        `INSERT INTO listings (
          complex_id, source, source_listing_id, url,
          asking_price, area_sqm, rooms, floor, price_per_sqm,
          address, city, first_seen, last_seen, days_on_market,
          original_price, description_snippet,
          has_urgent_keywords, urgent_keywords_found, is_foreclosure, is_inheritance, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE, CURRENT_DATE, $12, $13, $14, $15, $16, $17, $18, TRUE)
        ON CONFLICT DO NOTHING RETURNING id`,
        [complexId, 'facebook', sourceListingId, listing.url || null,
          price, areaSqm, rooms, floor, pricePsm,
          address, complexCity, daysOnMarket, price,
          description.substring(0, 500),
          keywords.has_urgent_keywords || listing.is_urgent,
          keywords.urgent_keywords_found,
          keywords.is_foreclosure || listing.is_foreclosure,
          keywords.is_inheritance || listing.is_inheritance]
      );

      if (result.rows.length > 0) return { action: 'inserted', id: result.rows[0].id };
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
    'SELECT id, name, city, addresses FROM complexes WHERE id = $1', [complexId]
  );
  if (complexResult.rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = complexResult.rows[0];
  logger.info(`Scanning Facebook for: ${complex.name} (${complex.city})`);

  const data = await queryFacebookForComplex(complex);
  
  if (!data || data.listings.length === 0) {
    return { complex: complex.name, city: complex.city, source: data?.source || 'none',
      listingsProcessed: 0, newListings: 0, updatedListings: 0, priceChanges: 0, errors: 0 };
  }

  let newListings = 0, updatedListings = 0, priceChanges = 0, errors = 0;

  for (const listing of data.listings) {
    const result = await processListing(listing, complexId, complex.city);
    if (result.action === 'inserted') newListings++;
    else if (result.action === 'updated') { updatedListings++; if (result.priceChanged) priceChanges++; }
    else if (result.action === 'error') errors++;
  }

  if (data.listings.length > 0) {
    await pool.query(
      `UPDATE listings SET is_active = FALSE 
       WHERE complex_id = $1 AND source = 'facebook' AND is_active = TRUE 
       AND last_seen < CURRENT_DATE - INTERVAL '14 days'`, [complexId]
    );
  }

  await pool.query(`UPDATE complexes SET last_facebook_scan = NOW() WHERE id = $1`, [complexId]);

  return { complex: complex.name, city: complex.city, source: data.source, rawCount: data.rawCount,
    listingsProcessed: data.listings.length, newListings, updatedListings, priceChanges, errors };
}

/**
 * Scan Facebook by city
 */
async function scanCity(city) {
  logger.info(`Facebook city scan starting: ${city}`);

  const data = await queryFacebookApify(city);
  if (!data || data.listings.length === 0) {
    return { city, source: data?.source || 'none', listings: 0, matched: 0, unmatched: 0, errors: 0 };
  }

  let matched = 0, unmatched = 0, newListings = 0, errors = 0;

  for (const listing of data.listings) {
    try {
      const complex = await matchListingToComplex(listing, city);
      
      if (complex) {
        const result = await processListing(listing, complex.id, city);
        matched++;
        if (result.action === 'inserted') newListings++;
      } else {
        unmatched++;
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
          [sourceListingId, listing.url || null, price, areaSqm,
            parseFloat(listing.rooms) || null, parseInt(listing.floor) || null, pricePsm,
            listing.address || '', city, parseInt(listing.days_on_market) || 0,
            (description || '').substring(0, 500),
            listing.is_urgent || false, listing.is_foreclosure || false, listing.is_inheritance || false]
        );
        if (price) newListings++;
      }
    } catch (err) {
      errors++;
      logger.debug(`Error processing Facebook listing in ${city}: ${err.message}`);
    }
  }

  logger.info(`Facebook city scan complete: ${city} - ${data.listings.length} found, ${matched} matched, ${unmatched} unmatched`);

  return { city, source: data.source, rawCount: data.rawCount,
    totalListings: data.listings.length, matched, unmatched, newListings, errors };
}

/**
 * Scan Facebook for all cities (batch)
 */
async function scanAll(options = {}) {
  const { staleOnly = true, limit = 30, city = null } = options;

  let citiesQuery = 'SELECT DISTINCT city FROM complexes WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (city) { paramCount++; citiesQuery += ` AND city = $${paramCount}`; params.push(city); }
  if (staleOnly) {
    citiesQuery += ` AND (last_facebook_scan IS NULL OR last_facebook_scan < NOW() - INTERVAL '5 days')`;
  }
  paramCount++; citiesQuery += ` LIMIT $${paramCount}`; params.push(limit);

  const cities = await pool.query(citiesQuery, params);
  const total = cities.rows.length;

  logger.info(`Facebook batch scan: ${total} cities to scan`);

  let succeeded = 0, failed = 0, totalNew = 0, totalMatched = 0;
  const details = [];

  for (const row of cities.rows) {
    try {
      const result = await scanCity(row.city);
      succeeded++;
      totalNew += result.newListings || 0;
      totalMatched += result.matched || 0;
      details.push({ status: 'ok', ...result });

      await pool.query(`UPDATE complexes SET last_facebook_scan = NOW() WHERE city = $1`, [row.city]);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_SCANS));
    } catch (err) {
      failed++;
      details.push({ status: 'error', city: row.city, error: err.message });
      logger.warn(`Facebook scan failed for city ${row.city}`, { error: err.message });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logger.info(`Facebook batch scan complete: ${succeeded}/${total} cities ok, ${totalNew} new, ${totalMatched} matched`);
  return { total, succeeded, failed, totalNew, totalMatched, details };
}

/**
 * Get Facebook scan statistics
 */
async function getStats() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_listings, COUNT(*) FILTER (WHERE is_active) as active_listings,
      COUNT(*) FILTER (WHERE complex_id IS NOT NULL) as matched_listings,
      COUNT(*) FILTER (WHERE complex_id IS NULL) as unmatched_listings,
      COUNT(*) FILTER (WHERE has_urgent_keywords) as urgent_listings,
      COUNT(*) FILTER (WHERE is_foreclosure) as foreclosure_listings,
      COUNT(DISTINCT city) as cities, MIN(first_seen) as earliest_listing,
      MAX(last_seen) as latest_scan,
      AVG(asking_price) FILTER (WHERE asking_price > 0) as avg_price,
      COUNT(DISTINCT complex_id) FILTER (WHERE complex_id IS NOT NULL) as complexes_with_listings
    FROM listings WHERE source = 'facebook'
  `);

  const cityBreakdown = await pool.query(`
    SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active,
      COUNT(*) FILTER (WHERE complex_id IS NOT NULL) as matched
    FROM listings WHERE source = 'facebook' GROUP BY city ORDER BY total DESC
  `);

  return { ...result.rows[0], cities_breakdown: cityBreakdown.rows };
}

/**
 * Get available cities with Marketplace URL mappings
 */
function getAvailableCities() {
  return Object.entries(FB_CITY_SLUGS).map(([hebrew, slug]) => ({
    city: hebrew, slug,
    url: `https://www.facebook.com/marketplace/${slug}/propertyforsale`
  }));
}

module.exports = {
  scanComplex, scanCity, scanAll,
  queryFacebookApify, queryFacebookForComplex,
  processListing, matchListingToComplex,
  getStats, getCityNames, getAvailableCities,
  buildMarketplaceUrl, normalizeApifyListing
};
