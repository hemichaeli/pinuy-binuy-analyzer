/**
 * Komo Direct Scraper - fetches individual listing pages with phone numbers
 * Uses komo's phone reveal API: POST /api/modaotService/showPhoneDetails/post/
 * No login required - phone API is open
 */
const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 1500; // 1.5s between requests to be polite
const BASE_URL = 'https://www.komo.co.il';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.komo.co.il'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanPhone(pre, num) {
  if (!num) return null;
  const full = `${pre || ''}${num}`.replace(/\D/g, '');
  if (full.length < 9 || full.length > 12) return null;
  return full.startsWith('972') ? '0' + full.slice(3) : full;
}

/**
 * Fetch all listing IDs from a komo search page for a given city
 */
async function fetchListingIds(city, page = 1) {
  try {
    const url = `${BASE_URL}/code/nadlan/apartments-for-sale.asp`;
    const r = await axios.get(url, {
      params: { city, page },
      headers: HEADERS,
      timeout: 20000
    });
    
    const html = r.data;
    // Extract modaaNum from links like /code/nadlan/details/?modaaNum=4757861
    const matches = [...html.matchAll(/modaaNum=(\d+)/g)];
    const ids = [...new Set(matches.map(m => m[1]))];
    logger.debug(`[KomoDirect] City ${city} page ${page}: found ${ids.length} listing IDs`);
    return ids;
  } catch (err) {
    logger.warn(`[KomoDirect] Failed to fetch listing IDs for ${city} page ${page}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch phone number for a komo listing using the phone reveal API
 */
async function fetchPhone(modaaNum) {
  try {
    const r = await axios.post(
      `${BASE_URL}/api/modaotService/showPhoneDetails/post/`,
      `luachNum=2&modaaNum=${modaaNum}&source=1`,
      {
        headers: {
          ...HEADERS,
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${BASE_URL}/code/nadlan/details/?modaaNum=${modaaNum}`
        },
        timeout: 10000
      }
    );
    
    if (r.data?.status === 'OK' && r.data?.list) {
      const { name, phone1_pre, phone1, phone2_pre, phone2 } = r.data.list;
      return {
        contact_name: name || null,
        phone: cleanPhone(phone1_pre, phone1) || cleanPhone(phone2_pre, phone2) || null
      };
    }
    return { phone: null, contact_name: null };
  } catch (err) {
    logger.debug(`[KomoDirect] Phone fetch failed for ${modaaNum}: ${err.message}`);
    return { phone: null, contact_name: null };
  }
}

/**
 * Fetch full listing details from the detail page
 */
async function fetchListingDetails(modaaNum) {
  try {
    const r = await axios.get(
      `${BASE_URL}/code/nadlan/details/?modaaNum=${modaaNum}`,
      { headers: HEADERS, timeout: 15000 }
    );
    
    const html = r.data;
    
    // Extract title: "למכירה דירה 4 חדרים  בתל אביב, הצפון הישן מרץ 2026"
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const titleText = titleMatch ? titleMatch[1] : '';
    
    // Extract city from title: "בתל אביב,"
    const cityMatch = titleText.match(/ב([^,]+),/);
    let city = cityMatch ? cityMatch[1].trim() : '';
    // Clean up city (remove "ב" prefix artifacts)
    city = city.replace(/^.*ב/, '').trim();
    
    // Extract neighborhood from title: ", נחלת יהודה מרץ"
    const neighMatch = titleText.match(/,\s*([^,\d]+?)\s+(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/);
    const neighborhood = neighMatch ? neighMatch[1].trim() : '';
    
    // Extract H1 for property type + neighborhood
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    const h1Text = h1Match ? h1Match[1].trim() : '';
    
    // Build address from neighborhood + city
    const address = neighborhood ? `${neighborhood}, ${city}` : city;
    
    // Extract price
    const priceMatch = html.match(/([\d,]+)\s*₪/);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
    
    // Extract rooms
    const roomsMatch = html.match(/(\d+\.?\d*)\s*חד/);
    const rooms = roomsMatch ? parseFloat(roomsMatch[1]) : null;
    
    // Extract sqm
    const sqmMatch = html.match(/(\d+)\s*מ['"]{0,2}ר/);
    const area_sqm = sqmMatch ? parseInt(sqmMatch[1]) : null;
    
    // Extract floor
    const floorMatch = html.match(/קומה[:\s]*(\d+)/);
    const floor = floorMatch ? parseInt(floorMatch[1]) : null;
    
    // Extract description
    const descMatch = html.match(/תיאור הנכס[:\s]*<\/[^>]+>\s*<[^>]+>([^<]{10,})/);
    const description = descMatch ? descMatch[1].trim().substring(0, 500) : '';
    
    return {
      source: 'komo',
      source_listing_id: modaaNum,
      address,
      city,
      neighborhood,
      price,
      rooms,
      area_sqm,
      floor,
      description,
      url: `${BASE_URL}/code/nadlan/details/?modaaNum=${modaaNum}`,
      property_type: h1Text.includes('וילה') || h1Text.includes('בית') ? 'house' : 'apartment'
    };
  } catch (err) {
    logger.warn(`[KomoDirect] Detail fetch failed for ${modaaNum}: ${err.message}`);
    return null;
  }
}

/**
 * Save or update a listing in the DB
 */
async function saveListing(listing) {
  try {
    const existing = await pool.query(
      `SELECT id, phone FROM listings WHERE source = 'komo' AND source_listing_id = $1`,
      [listing.source_listing_id]
    );
    
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // Update if we have new phone or price
      if (listing.phone && !row.phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name),
           asking_price = COALESCE($3, asking_price), url = COALESCE($4, url),
           last_seen = CURRENT_DATE, updated_at = NOW() WHERE id = $5`,
          [listing.phone, listing.contact_name, listing.price, listing.url, row.id]
        );
        return 'phone_updated';
      }
      if (listing.price && listing.price !== row.asking_price) {
        await pool.query(
          `UPDATE listings SET asking_price = $1, last_seen = CURRENT_DATE, updated_at = NOW() WHERE id = $2`,
          [listing.price, row.id]
        );
        return 'price_updated';
      }
      return 'skipped';
    }
    
    await pool.query(
      `INSERT INTO listings (source, source_listing_id, address, city, asking_price,
        rooms, area_sqm, floor, phone, contact_name, url, description_snippet,
        is_active, first_seen, last_seen, created_at, updated_at)
       VALUES ('komo', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        TRUE, CURRENT_DATE, CURRENT_DATE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        listing.source_listing_id, listing.address, listing.city, listing.price,
        listing.rooms, listing.area_sqm, listing.floor,
        listing.phone, listing.contact_name,
        listing.url, listing.description
      ]
    );
    return 'inserted';
  } catch (err) {
    logger.warn(`[KomoDirect] Save error for ${listing.source_listing_id}: ${err.message}`);
    return 'error';
  }
}

/**
 * Scan a single city - fetch listing IDs, then details + phone for each
 */
async function scanCity(city, maxPages = 3) {
  logger.info(`[KomoDirect] Scanning ${city} (up to ${maxPages} pages)...`);
  
  let allIds = [];
  for (let page = 1; page <= maxPages; page++) {
    const ids = await fetchListingIds(city, page);
    if (ids.length === 0) break;
    allIds = allIds.concat(ids);
    if (ids.length < 15) break; // Last page
    await sleep(DELAY_MS);
  }
  
  // Deduplicate
  allIds = [...new Set(allIds)];
  logger.info(`[KomoDirect] ${city}: ${allIds.length} unique listings to process`);
  
  let inserted = 0, phoneUpdated = 0, priceUpdated = 0, errors = 0;
  
  for (const modaaNum of allIds) {
    try {
      // Fetch details and phone in parallel
      const [details, phoneData] = await Promise.all([
        fetchListingDetails(modaaNum),
        fetchPhone(modaaNum)
      ]);
      
      if (!details) { errors++; continue; }
      
      const listing = { ...details, ...phoneData };
      const result = await saveListing(listing);
      
      if (result === 'inserted') inserted++;
      else if (result === 'phone_updated') phoneUpdated++;
      else if (result === 'price_updated') priceUpdated++;
      
      await sleep(DELAY_MS);
    } catch (err) {
      logger.warn(`[KomoDirect] Error processing ${modaaNum}: ${err.message}`);
      errors++;
    }
  }
  
  logger.info(`[KomoDirect] ${city}: ${inserted} new, ${phoneUpdated} phone updated, ${priceUpdated} price updated, ${errors} errors`);
  return { city, total: allIds.length, inserted, phoneUpdated, priceUpdated, errors };
}

/**
 * Enrich existing komo listings that have no phone
 */
async function enrichExistingListings(limit = 200) {
  logger.info(`[KomoDirect] Enriching up to ${limit} existing komo listings without phone...`);
  
  const rows = await pool.query(
    `SELECT id, source_listing_id, url FROM listings 
     WHERE source = 'komo' AND phone IS NULL AND source_listing_id IS NOT NULL
     AND source_listing_id ~ '^[0-9]+$'
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  
  logger.info(`[KomoDirect] Found ${rows.rows.length} listings to enrich`);
  
  let enriched = 0, failed = 0;
  
  for (const row of rows.rows) {
    try {
      const phoneData = await fetchPhone(row.source_listing_id);
      if (phoneData.phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
          [phoneData.phone, phoneData.contact_name, row.id]
        );
        enriched++;
        logger.debug(`[KomoDirect] Enriched ${row.source_listing_id}: ${phoneData.phone}`);
      }
      await sleep(800); // Faster for enrichment
    } catch (err) {
      logger.warn(`[KomoDirect] Enrich error for ${row.source_listing_id}: ${err.message}`);
      failed++;
    }
  }
  
  logger.info(`[KomoDirect] Enrichment complete: ${enriched} phones found, ${failed} failed`);
  return { enriched, failed, total: rows.rows.length };
}

const TARGET_CITIES = [
  'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה',
  'נתניה', 'בת ים', 'חולון', 'רמת גן', 'בני ברק',
  'רחובות', 'אשדוד', 'הרצליה', 'כפר סבא', 'רעננה',
  'מודיעין', 'אשקלון', 'באר שבע', 'הוד השרון', 'גבעתיים'
];

async function scanAll(options = {}) {
  const { cities = TARGET_CITIES, maxPages = 2 } = options;
  logger.info(`[KomoDirect] Starting full scan of ${cities.length} cities`);
  
  let totalInserted = 0, totalPhoneUpdated = 0;
  const results = [];
  
  for (let i = 0; i < cities.length; i++) {
    try {
      const result = await scanCity(cities[i], maxPages);
      totalInserted += result.inserted;
      totalPhoneUpdated += result.phoneUpdated;
      results.push(result);
    } catch (err) {
      logger.error(`[KomoDirect] Error scanning ${cities[i]}: ${err.message}`);
      results.push({ city: cities[i], error: err.message });
    }
    if (i < cities.length - 1) await sleep(2000);
  }
  
  logger.info(`[KomoDirect] Full scan complete: ${totalInserted} new, ${totalPhoneUpdated} phone updated`);
  return { total_cities: cities.length, total_inserted: totalInserted, total_phone_updated: totalPhoneUpdated, results };
}

module.exports = { scanAll, scanCity, enrichExistingListings, fetchPhone };
