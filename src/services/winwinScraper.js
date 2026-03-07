/**
 * WinWin (winwin.co.il) Scraper - Issue #4 P1
 * Scrapes property listings from winwin.co.il
 * Stores in `listings` table (source='winwin')
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 4000;
const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.winwin.co.il'
};

// Try WinWin direct API (search endpoint)
async function queryWinwinDirect(city, limit = 50) {
  try {
    const response = await axios.get('https://www.winwin.co.il/api/properties/search', {
      params: {
        city,
        dealType: 'sale',
        propertyType: 'apartment',
        page: 1,
        pageSize: limit
      },
      headers: HEADERS,
      timeout: 15000
    });

    if (response.data?.items?.length > 0) {
      return response.data.items.map(item => parseWinwinItem(item));
    }

    // Try alternate API pattern
    const r2 = await axios.get(`https://www.winwin.co.il/nadlan/forsale`, {
      params: { city, page: 1 },
      headers: HEADERS,
      timeout: 15000
    });

    if (r2.data?.properties?.length > 0) {
      return r2.data.properties.map(item => parseWinwinItem(item));
    }

    return null;
  } catch (err) {
    logger.debug(`[WinWin] Direct API failed for ${city}: ${err.message}`);
    return null;
  }
}

function parseWinwinItem(item) {
  const phone = item.phone || item.contactPhone || item.contact?.phone || null;
  const price = parseInt(String(item.price || item.askingPrice || '').replace(/\D/g, '')) || null;
  return {
    source: 'winwin',
    listing_id: String(item.id || item.propertyId || ''),
    address: item.address || item.street || '',
    city: item.city || item.cityName || '',
    price,
    rooms: parseFloat(item.rooms || item.roomCount || 0) || null,
    area_sqm: parseFloat(item.size || item.squareMeters || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(phone),
    contact_name: item.contactName || item.agentName || null,
    url: item.url || (item.id ? `https://www.winwin.co.il/item/${item.id}` : null),
    description: (item.description || item.title || '').substring(0, 500)
  };
}

// Perplexity fallback for WinWin
async function queryWinwinPerplexity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש מודעות מכירת דירות פעילות באתר winwin.co.il בעיר ${city}.

החזר JSON בלבד:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "city": "${city}",
      "price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח,
      "floor": קומה,
      "phone": "מספר_טלפון_או_null",
      "contact_name": "שם_איש_קשר_או_null",
      "url": "קישור_למודעה",
      "listing_id": "מזהה_מודעה",
      "description": "תיאור קצר"
    }
  ]
}

רק דירות למכירה. מחירים בשקלים. החזר JSON בלבד.`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.1
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });

    const content = res.data.choices?.[0]?.message?.content || '';
    return parseJsonListings(content);
  } catch (err) {
    logger.warn(`[WinWin] Perplexity fallback failed for ${city}: ${err.message}`);
    return [];
  }
}

function parseJsonListings(content) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.listings) ? parsed.listings : [];
  } catch {
    const match = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]).listings || []; } catch { }
    }
    return [];
  }
}

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits;
}

async function saveListing(listing) {
  try {
    const sourceId = listing.listing_id || `winwin-${listing.city}-${listing.address}-${listing.price}`;
    const existing = await pool.query(
      `SELECT id FROM listings WHERE source = 'winwin' AND source_listing_id = $1 LIMIT 1`,
      [sourceId]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE listings SET asking_price = COALESCE($1, asking_price),
          last_seen = CURRENT_DATE, updated_at = NOW(), url = COALESCE($2, url)
         WHERE id = $3`,
        [listing.price, listing.url, existing.rows[0].id]
      );
      return 'updated';
    }

    await pool.query(
      `INSERT INTO listings (source, source_listing_id, address, city, asking_price,
        rooms, area_sqm, floor, phone, contact_name, url, description_snippet,
        is_active, first_seen, last_seen, created_at, updated_at)
       VALUES ('winwin', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        TRUE, CURRENT_DATE, CURRENT_DATE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        sourceId, listing.address, listing.city, listing.price,
        listing.rooms, listing.area_sqm, listing.floor,
        listing.phone, listing.contact_name,
        listing.url, listing.description
      ]
    );
    return 'inserted';
  } catch (err) {
    logger.warn(`[WinWin] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanCity(city) {
  logger.info(`[WinWin] Scanning ${city}...`);

  // Try direct API first, fallback to Perplexity
  let rawListings = await queryWinwinDirect(city);
  let source = 'winwin_api';

  if (!rawListings || rawListings.length === 0) {
    rawListings = await queryWinwinPerplexity(city);
    source = 'perplexity';
  }

  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[WinWin] No listings found for ${city}`);
    return { city, listings: 0, inserted: 0, updated: 0, source };
  }

  let inserted = 0, updated = 0;
  for (const listing of rawListings) {
    if (!listing.address && !listing.price) continue;
    if (!listing.city) listing.city = city;
    if (!listing.source) listing.source = 'winwin';

    const result = await saveListing(listing);
    if (result === 'inserted') inserted++;
    else if (result === 'updated') updated++;
  }

  logger.info(`[WinWin] ${city}: ${inserted} new, ${updated} updated (via ${source})`);
  return { city, listings: rawListings.length, inserted, updated, source };
}

// Main: scan top Israeli cities for WinWin listings
const TARGET_CITIES = [
  'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה',
  'נתניה', 'בת ים', 'חולון', 'רמת גן', 'בני ברק',
  'רחובות', 'אשדוד', 'הרצליה', 'כפר סבא', 'רעננה'
];

async function scanAll(options = {}) {
  const { cities = TARGET_CITIES, limit = 15 } = options;
  const citiesToScan = cities.slice(0, limit);

  logger.info(`[WinWin] Starting scan of ${citiesToScan.length} cities`);

  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let i = 0; i < citiesToScan.length; i++) {
    try {
      const result = await scanCity(citiesToScan[i]);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[WinWin] Error for ${citiesToScan[i]}: ${err.message}`);
      results.push({ city: citiesToScan[i], error: err.message });
    }

    if (i < citiesToScan.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const summary = {
    total_cities: citiesToScan.length,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    results
  };
  logger.info('[WinWin] Scan complete:', { totalInserted, totalUpdated });
  return summary;
}

module.exports = { scanAll, scanCity };
