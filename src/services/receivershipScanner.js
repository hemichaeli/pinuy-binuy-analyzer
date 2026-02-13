/**
 * Receivership Scanner Service
 * Uses Perplexity AI to search for receivership listings in identified complex areas
 * 
 * Architecture:
 * - Perplexity API searches for כינוס נכסים listings near complex addresses
 * - Results are parsed and imported into kones_listings table
 * - Matches with existing complexes boost SSI scores
 * 
 * Both Claude (manual web search + import via /api/kones/import) 
 * and Perplexity (automated API via this scanner) feed into the same DB
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';
const DELAY_BETWEEN_REQUESTS_MS = 4000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Perplexity for receivership listings in a specific area
 */
async function searchReceiverships(city, addresses, complexName) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const streetNames = (addresses || '')
    .split(',')
    .map(s => s.replace(/רחוב|שכונת|שדרות|פינת|דונם|\d+/g, '').trim())
    .filter(s => s.length > 2)
    .slice(0, 4)
    .join(', ');

  const prompt = `חפש נכסים למכירה מכונס נכסים או בהליך כינוס נכסים ב${city}, באזור: ${streetNames || complexName}.

חפש ב:
- bidspirit.com (מכרזי נדלן)
- konesonline.co.il
- konesisrael.co.il  
- אתרי עורכי דין שמפרסמים כינוסים
- פרסומים בעיתונות (גלובס, כלכליסט, מעריב)
- קבוצות פייסבוק של נדלן מכונס

חפש גם: פירוק שיתוף, מימוש משכנתא, הוצאה לפועל, מכירת עיזבון, התמחרות.

החזר JSON בלבד:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "city": "${city}",
      "propertyType": "דירה/פנטהאוז/בית/מגרש",
      "gushHelka": "גוש XXXX חלקה XXX",
      "contactPerson": "שם עורך דין או כונס",
      "phone": "טלפון",
      "price": "מחיר מינימום בשח",
      "deadline": "מועד אחרון",
      "source": "מקור (אתר/עיתון)",
      "url": "קישור",
      "status": "פתוח/סגור",
      "type": "כינוס/פירוק שיתוף/עיזבון/הוצלפ"
    }
  ],
  "totalFound": 0,
  "notes": ""
}

אם לא נמצאו - החזר listings ריק. רק תוצאות אמיתיות ומאומתות!`;

  const systemPrompt = `אתה מומחה בנדל"ן ישראלי המתמחה בכינוס נכסים. 
חפש נכסים אמיתיים בלבד - לא להמציא מידע.
החזר רק JSON תקין ללא טקסט נוסף.
חפש מידע עדכני: 2024-2026.`;

  try {
    const response = await axios.post(PERPLEXITY_API_URL, {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    const text = response.data.choices[0].message.content;
    return parseJsonResponse(text);
  } catch (error) {
    logger.warn(`Receivership search failed for ${city}/${complexName}: ${error.message}`);
    return { listings: [], error: error.message };
  }
}

/**
 * Parse JSON from Perplexity response
 */
function parseJsonResponse(text) {
  try { return JSON.parse(text); } catch (e) {}
  
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch (e) {}
  }
  
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch (e) {}
  }
  
  return { listings: [], parseError: true, rawText: text.substring(0, 300) };
}

/**
 * Extract gush number from gushHelka string
 */
function extractGush(gushHelka) {
  if (!gushHelka) return null;
  const match = gushHelka.match(/גוש\s*(\d+)/);
  return match ? match[1] : null;
}

/**
 * Import found listings into kones_listings table (same table Claude uses)
 */
async function importListings(listings, scanSource) {
  let imported = 0, skipped = 0;

  // Ensure table has extra columns
  try {
    await pool.query(`
      ALTER TABLE kones_listings 
        ADD COLUMN IF NOT EXISTS price VARCHAR(100),
        ADD COLUMN IF NOT EXISTS deadline VARCHAR(200),
        ADD COLUMN IF NOT EXISTS listing_status VARCHAR(50) DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS receivership_type VARCHAR(100),
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS scan_source VARCHAR(50)
    `);
  } catch (e) {
    // columns may already exist
  }

  for (const listing of listings) {
    if (!listing.address || !listing.city) {
      skipped++;
      continue;
    }

    try {
      // Deduplicate by address+city
      const existing = await pool.query(
        `SELECT id FROM kones_listings WHERE city = $1 AND address = $2 AND deleted_at IS NULL`,
        [listing.city, listing.address]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      const gush = extractGush(listing.gushHelka);

      await pool.query(`
        INSERT INTO kones_listings (
          source, property_type, city, address, region,
          gush_helka, gush, contact_person, phone, url,
          is_receivership, price, deadline, listing_status,
          receivership_type, notes, scan_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `, [
        listing.source || scanSource || 'perplexity_scan',
        listing.propertyType || 'דירה',
        listing.city,
        listing.address,
        listing.region || 'מרכז',
        listing.gushHelka || null,
        gush,
        listing.contactPerson || null,
        listing.phone || null,
        listing.url || null,
        true,
        listing.price || null,
        listing.deadline || null,
        listing.status || 'לא ידוע',
        listing.type || 'כינוס',
        listing.notes || null,
        scanSource || 'perplexity'
      ]);
      imported++;
    } catch (err) {
      logger.warn(`Import listing failed ${listing.address}: ${err.message}`);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * Main scan: searches all identified complexes for nearby receivership listings
 */
async function scanComplexesForReceiverships(options = {}) {
  const { limit = 20, minIAI = 50, cityFilter = null } = options;

  logger.info(`Receivership scan starting: limit=${limit}, minIAI=${minIAI}, city=${cityFilter || 'all'}`);

  let query = `
    SELECT id, name, city, addresses, iai_score, enhanced_ssi_score
    FROM complexes 
    WHERE city IS NOT NULL AND addresses IS NOT NULL
  `;
  const params = [];
  
  if (minIAI > 0) {
    params.push(minIAI);
    query += ` AND iai_score >= $${params.length}`;
  }
  if (cityFilter) {
    params.push(cityFilter);
    query += ` AND city = $${params.length}`;
  }
  
  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${params.length + 1}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  
  const results = {
    scannedComplexes: 0,
    totalListingsFound: 0,
    totalImported: 0,
    totalSkipped: 0,
    details: [],
    errors: []
  };

  // Group by city to reduce duplicate API calls
  const citySearched = new Set();

  for (const complex of complexes.rows) {
    const searchKey = `${complex.city}|${(complex.addresses || '').substring(0, 25)}`;
    if (citySearched.has(searchKey)) {
      results.details.push({
        complexId: complex.id,
        complexName: complex.name,
        city: complex.city,
        status: 'skipped_duplicate_area'
      });
      continue;
    }
    citySearched.add(searchKey);

    try {
      logger.info(`Scanning: ${complex.city} - ${complex.name}`);
      
      const searchResult = await searchReceiverships(
        complex.city, complex.addresses, complex.name
      );

      const listings = searchResult.listings || [];
      let importResult = { imported: 0, skipped: 0 };
      
      if (listings.length > 0) {
        importResult = await importListings(listings, 'perplexity_complex_scan');
      }

      results.scannedComplexes++;
      results.totalListingsFound += listings.length;
      results.totalImported += importResult.imported;
      results.totalSkipped += importResult.skipped;
      results.details.push({
        complexId: complex.id,
        complexName: complex.name,
        city: complex.city,
        addresses: (complex.addresses || '').substring(0, 60),
        listingsFound: listings.length,
        imported: importResult.imported,
        skipped: importResult.skipped
      });

      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    } catch (error) {
      results.errors.push({
        complexName: complex.name,
        city: complex.city,
        error: error.message
      });
    }
  }

  logger.info(`Receivership scan done: ${results.scannedComplexes} areas, ${results.totalListingsFound} found, ${results.totalImported} imported`);
  return results;
}

module.exports = {
  searchReceiverships,
  importListings,
  scanComplexesForReceiverships
};
