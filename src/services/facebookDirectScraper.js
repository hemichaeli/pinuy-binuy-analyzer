/**
 * Facebook Marketplace Direct Scraper (No Apify dependency)
 *
 * Scrapes Facebook Marketplace using direct HTTP requests with cookies.
 * Uses Facebook's internal GraphQL API (same approach FB's frontend uses).
 * Falls back to HTML parsing if GraphQL fails.
 */

const axios = require('axios');
const { logger } = require('./logger');

// Lazy-load cheerio to avoid startup issues
let cheerio;
function getCheerio() {
  if (!cheerio) cheerio = require('cheerio');
  return cheerio;
}

const FB_BASE = 'https://www.facebook.com';
const FB_GRAPHQL = 'https://www.facebook.com/api/graphql/';
const REQUEST_DELAY = 2000; // 2s between requests to avoid rate limiting
const MAX_RETRIES = 2;

// Common headers to mimic real browser
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

/**
 * Load FB cookies from env and format as cookie header string
 */
function getCookieString() {
  const b64 = process.env.FB_COOKIES_BASE64;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const cookies = JSON.parse(json);
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (err) {
    logger.warn(`Failed to parse FB_COOKIES_BASE64: ${err.message}`);
  }
  return null;
}

/**
 * Get fb_dtsg token from a Facebook page (needed for GraphQL calls)
 */
async function getFbDtsg(cookieStr) {
  try {
    const resp = await axios.get(`${FB_BASE}/marketplace/`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 30000,
      maxRedirects: 5
    });
    const html = resp.data;

    // Extract fb_dtsg from page source
    const dtsgMatch = html.match(/"DTSGInitialData".*?"token":"([^"]+)"/);
    if (dtsgMatch) return dtsgMatch[1];

    // Alternative patterns
    const dtsgMatch2 = html.match(/name="fb_dtsg" value="([^"]+)"/);
    if (dtsgMatch2) return dtsgMatch2[1];

    const dtsgMatch3 = html.match(/"dtsg":\{"token":"([^"]+)"/);
    if (dtsgMatch3) return dtsgMatch3[1];

    const dtsgMatch4 = html.match(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/);
    if (dtsgMatch4) return dtsgMatch4[1];

    logger.warn('Could not extract fb_dtsg from page');
    return null;
  } catch (err) {
    logger.warn(`Failed to get fb_dtsg: ${err.message}`);
    return null;
  }
}

/**
 * Extract user ID from cookies
 */
function getUserId(cookieStr) {
  const match = cookieStr.match(/c_user=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Scrape Marketplace listings via HTML parsing (fallback method)
 * Facebook embeds listing data in script tags as JSON
 */
async function scrapeViaHtml(marketplaceUrl, cookieStr) {
  try {
    logger.info(`[FB-Direct] HTML scrape: ${marketplaceUrl}`);
    const resp = await axios.get(marketplaceUrl, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 30000,
      maxRedirects: 5
    });

    const html = resp.data;
    const listings = [];

    // Method 1: Extract from embedded JSON (relay data)
    const jsonMatches = html.matchAll(/"marketplace_listing_title":"([^"]*)".*?"listing_price":\{[^}]*"formatted_amount":"([^"]*)"[^}]*\}.*?"location":\{[^}]*"reverse_geocode":\{[^}]*"city":"([^"]*)"[^}]*\}/g);
    for (const m of jsonMatches) {
      listings.push({
        title: m[1],
        price: m[2],
        city: m[3],
        source: 'html_json'
      });
    }

    // Method 2: Extract listing IDs and basic data from script tags
    const scriptData = [];
    const idPattern = /"listing_id":"(\d+)"/g;
    const pricePattern = /"formatted_amount":"([^"]+)"/g;
    const titlePattern = /"marketplace_listing_title":"([^"]+)"/g;

    let idMatch;
    const ids = [];
    while ((idMatch = idPattern.exec(html)) !== null) {
      ids.push(idMatch[1]);
    }

    // Extract structured data from require/define blocks
    const dataBlocks = html.matchAll(/\{"__typename":"MarketplaceListing"[^}]*"id":"(\d+)"[^]*?"marketplace_listing_title":"([^"]*)"[^]*?"listing_price":\{"formatted_amount":"([^"]*)"/g);
    for (const block of dataBlocks) {
      listings.push({
        id: block[1],
        title: block[2],
        price: block[3],
        url: `${FB_BASE}/marketplace/item/${block[1]}/`,
        source: 'html_structured'
      });
    }

    // Method 3: Parse any JSON-LD or embedded marketplace data
    const $ = getCheerio().load(html);

    // Look for marketplace listing cards in the HTML
    const relayData = [];
    const scriptTags = $('script');
    scriptTags.each((_, el) => {
      const content = $(el).html() || '';
      // Find marketplace listing data in script tags
      const listingMatches = content.matchAll(/"node":\{[^]*?"__typename":"MarketplaceListing"[^]*?"id":"(\d+)"[^]*?"marketplace_listing_title":"([^"]*)"[^]*?"listing_price":\{[^}]*?"formatted_amount":"([^"]*)"[^]*?"location":\{[^}]*?"reverse_geocode":\{[^}]*?"city":"([^"]*)"/g);
      for (const lm of listingMatches) {
        relayData.push({
          id: lm[1],
          title: lm[2],
          price: lm[3],
          city: lm[4],
          url: `${FB_BASE}/marketplace/item/${lm[1]}/`,
          source: 'html_relay'
        });
      }
    });

    if (relayData.length > 0) {
      logger.info(`[FB-Direct] Found ${relayData.length} listings via relay data`);
      return relayData;
    }

    // Method 4: Broader regex for any listing-like data
    const broadMatches = [];
    const broadPattern = /"id":"(\d{10,20})"[^]*?"marketplace_listing_title":"([^"]*)"[^]*?"formatted_amount":"([^"]*)"/g;
    let bm;
    while ((bm = broadPattern.exec(html)) !== null) {
      broadMatches.push({
        id: bm[1],
        title: bm[2],
        price: bm[3],
        url: `${FB_BASE}/marketplace/item/${bm[1]}/`,
        source: 'html_broad'
      });
    }

    if (broadMatches.length > 0) {
      logger.info(`[FB-Direct] Found ${broadMatches.length} listings via broad regex`);
      return broadMatches;
    }

    if (listings.length > 0) {
      logger.info(`[FB-Direct] Found ${listings.length} listings via HTML JSON`);
      return listings;
    }

    // Check if we got redirected to login
    if (html.includes('login') && !html.includes('marketplace_listing_title')) {
      logger.warn('[FB-Direct] Appears to be redirected to login - cookies may be expired');
      return [];
    }

    // Log snippet for debugging
    const snippet = html.substring(0, 500);
    const hasMarketplace = html.includes('marketplace');
    const hasListing = html.includes('listing');
    logger.info(`[FB-Direct] HTML parse found 0 listings. hasMarketplace=${hasMarketplace}, hasListing=${hasListing}, htmlLen=${html.length}, snippet=${snippet.substring(0, 100)}...`);

    // Try to find unique listing IDs even without full data
    if (ids.length > 0) {
      logger.info(`[FB-Direct] Found ${ids.length} listing IDs without full data: ${ids.slice(0, 5).join(', ')}`);
      return ids.map(id => ({
        id,
        url: `${FB_BASE}/marketplace/item/${id}/`,
        source: 'html_id_only'
      }));
    }

    return [];
  } catch (err) {
    logger.warn(`[FB-Direct] HTML scrape failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape a single listing's details page
 */
async function scrapeListingDetails(listingId, cookieStr) {
  try {
    const url = `${FB_BASE}/marketplace/item/${listingId}/`;
    const resp = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 20000,
      maxRedirects: 5
    });

    const html = resp.data;
    const details = { id: listingId, url };

    // Extract title
    const titleMatch = html.match(/"marketplace_listing_title":"([^"]+)"/);
    if (titleMatch) details.title = titleMatch[1];

    // Extract price
    const priceMatch = html.match(/"formatted_amount":"([^"]+)"/);
    if (priceMatch) details.price = priceMatch[1];

    // Extract description
    const descMatch = html.match(/"redacted_description":\{"text":"([^"]+)"/);
    if (descMatch) details.description = descMatch[1];

    // Alt description
    if (!details.description) {
      const descMatch2 = html.match(/"marketplace_listing_description":"([^"]+)"/);
      if (descMatch2) details.description = descMatch2[1];
    }

    // Extract location
    const locMatch = html.match(/"location_text":\{"text":"([^"]+)"/);
    if (locMatch) details.location = locMatch[1];

    const cityMatch = html.match(/"reverse_geocode":\{[^}]*"city":"([^"]+)"/);
    if (cityMatch) details.city = cityMatch[1];

    // Extract seller
    const sellerMatch = html.match(/"marketplace_listing_seller":\{[^}]*"name":"([^"]+)"/);
    if (sellerMatch) details.sellerName = sellerMatch[1];

    // Extract images
    const imgMatch = html.match(/"image":\{"uri":"([^"]+)"/);
    if (imgMatch) details.image = imgMatch[1].replace(/\\\//g, '/');

    // Extract listing date
    const dateMatch = html.match(/"creation_time":(\d+)/);
    if (dateMatch) details.createdAt = new Date(parseInt(dateMatch[1]) * 1000).toISOString();

    return details;
  } catch (err) {
    logger.debug(`[FB-Direct] Failed to get listing ${listingId} details: ${err.message}`);
    return { id: listingId, url: `${FB_BASE}/marketplace/item/${listingId}/` };
  }
}

/**
 * Main scraping function — tries GraphQL first, falls back to HTML
 */
async function scrapeMarketplace(marketplaceUrl, options = {}) {
  const { maxItems = 50, getDetails = false } = options;
  const cookieStr = getCookieString();

  if (!cookieStr) {
    logger.warn('[FB-Direct] No FB cookies configured. Set FB_COOKIES_BASE64');
    return { listings: [], source: 'no_cookies' };
  }

  const userId = getUserId(cookieStr);
  logger.info(`[FB-Direct] Starting scrape: ${marketplaceUrl} (userId=${userId})`);

  // Try HTML scraping (most reliable with cookies)
  let listings = await scrapeViaHtml(marketplaceUrl, cookieStr);

  // Deduplicate by ID
  const seen = new Set();
  listings = listings.filter(l => {
    if (!l.id) return true;
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });

  // Limit results
  if (listings.length > maxItems) {
    listings = listings.slice(0, maxItems);
  }

  // Optionally get details for each listing
  if (getDetails && listings.length > 0) {
    const listingsWithIds = listings.filter(l => l.id);
    logger.info(`[FB-Direct] Fetching details for ${listingsWithIds.length} listings`);

    for (let i = 0; i < listingsWithIds.length; i++) {
      const listing = listingsWithIds[i];
      const details = await scrapeListingDetails(listing.id, cookieStr);
      Object.assign(listing, details);

      // Rate limiting
      if (i < listingsWithIds.length - 1) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY));
      }
    }
  }

  logger.info(`[FB-Direct] Scraped ${listings.length} listings from ${marketplaceUrl}`);
  return { listings, source: 'direct', rawCount: listings.length };
}

/**
 * Convert direct scraper listing to internal format (same as normalizeApifyListing)
 */
function normalizeDirectListing(item, city) {
  try {
    let price = null;
    const priceRaw = item.price || '';
    const priceStr = String(priceRaw).replace(/[₪,\s]/g, '').replace(/[^\d.]/g, '');
    if (priceStr) {
      price = parseFloat(priceStr);
      if (price < 10000 || price > 50000000) price = null;
    }

    const title = item.title || '';
    const location = item.location || item.city || '';
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
    if (item.createdAt) {
      const posted = new Date(item.createdAt);
      if (!isNaN(posted.getTime())) {
        daysOnMarket = Math.floor((Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24));
      }
    }

    const sellerName = item.sellerName || '';

    return {
      address: location || `${street} ${houseNumber}`.trim() || title.substring(0, 100),
      street, house_number: houseNumber,
      asking_price: price, rooms, area_sqm: areaSqm, floor,
      description: `${title}${description ? ' | ' + description.substring(0, 300) : ''}`,
      url: item.url || null,
      listing_id: item.id || item.url || null,
      seller_name: sellerName, days_on_market: daysOnMarket,
      is_urgent: isUrgent, is_foreclosure: isForeclosure,
      is_inheritance: isInheritance, is_agent: isAgent,
      phone: '', image: item.image || null
    };
  } catch (err) {
    logger.debug(`[FB-Direct] Failed to normalize listing: ${err.message}`);
    return null;
  }
}

/**
 * Check if cookies are valid by loading Facebook
 */
async function checkCookies() {
  const cookieStr = getCookieString();
  if (!cookieStr) return { valid: false, reason: 'No cookies configured' };

  try {
    const resp = await axios.get(`${FB_BASE}/marketplace/`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    const html = resp.data;
    const isLoggedIn = html.includes('c_user') || html.includes('marketplace_listing') ||
                       html.includes('MarketplaceFeed') || !html.includes('/login/');
    const userId = getUserId(cookieStr);

    return {
      valid: isLoggedIn,
      userId,
      statusCode: resp.status,
      hasMarketplace: html.includes('marketplace'),
      htmlLength: html.length
    };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

module.exports = {
  scrapeMarketplace,
  scrapeListingDetails,
  normalizeDirectListing,
  checkCookies,
  getCookieString
};
