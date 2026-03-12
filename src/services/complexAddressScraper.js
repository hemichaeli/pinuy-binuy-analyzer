/**
 * Complex Address Scraper - Issue #5 P1
 * 
 * Searches for property listings on Homeless, Yad1, Winwin
 * by querying Perplexity Sonar with the EXACT complex address.
 * 
 * This ensures we only collect listings within pinuy-binuy complexes.
 * After insertion, auto-triggers Gemini+Perplexity enrichment.
 * 
 * Flow:
 *   1. Load all complexes from DB (with addresses)
 *   2. For each complex → query Perplexity: "find listings at [address] on homeless/yad1/winwin"
 *   3. Save listings with complex_id
 *   4. Auto-enrich via adEnrichmentService
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_MS = 3000; // delay between complex scans
const ENRICH_DELAY_MS = 2000; // delay between enrichments

// Sources to search
const SOURCES = ['homeless', 'yad1', 'winwin'];

// ============================================================
// PERPLEXITY SEARCH: Find listings for a specific complex address
// ============================================================
async function searchListingsForComplex(complex) {
  const apiKey = process.env.SONAR_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    logger.warn('[ComplexScraper] No Perplexity API key found');
    return [];
  }

  const address = complex.address || complex.neighborhood || complex.name;
  const city = complex.city;

  const prompt = `חפש מודעות נדל"ן למכירה בכתובת: "${address}", ${city}, ישראל.
חפש באתרים: homeless.co.il, yad1.co.il, winwin.co.il
אני מחפש דירות למכירה בדיוק בכתובות האלה (מתחם פינוי-בינוי).

החזר JSON בלבד בפורמט הזה:
{
  "listings": [
    {
      "source": "homeless" | "yad1" | "winwin",
      "listing_id": "מזהה המודעה מהאתר",
      "url": "https://...",
      "address": "כתובת מדויקת",
      "city": "${city}",
      "price": 1500000,
      "rooms": 3,
      "area_sqm": 75,
      "floor": 2,
      "phone": "0501234567",
      "contact_name": "שם המוכר",
      "description": "תיאור קצר"
    }
  ]
}

חשוב:
- רק מודעות שנמצאות בדיוק בכתובת "${address}" ב-${city}
- לא לכלול מודעות מרחובות אחרים
- אם אין מודעות, החזר {"listings": []}
- מחירים בשקלים`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations. Search the web for real estate listings.' },
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

    const content = res.data.choices?.[0]?.message?.content || '';
    return parseListingsJson(content, complex);
  } catch (err) {
    logger.warn(`[ComplexScraper] Perplexity failed for complex ${complex.id} (${complex.name}): ${err.message}`);
    return [];
  }
}

function parseListingsJson(content, complex) {
  try {
    const cleaned = content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    const listings = Array.isArray(parsed.listings) ? parsed.listings : [];
    return listings.map(l => ({ ...l, complex_id: complex.id, complex_name: complex.name }));
  } catch {
    // Try to extract JSON from text
    const match = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const listings = Array.isArray(parsed.listings) ? parsed.listings : [];
        return listings.map(l => ({ ...l, complex_id: complex.id, complex_name: complex.name }));
      } catch { }
    }
    return [];
  }
}

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  return digits.startsWith('972') ? '0' + digits.slice(3) : digits;
}

// ============================================================
// SAVE: Insert listing with complex_id
// ============================================================
async function saveListing(listing) {
  try {
    const source = listing.source || 'unknown';
    const sourceId = listing.listing_id || listing.url;
    if (!sourceId) return 'skip';

    const phone = cleanPhone(listing.phone);

    const r = await pool.query(
      `INSERT INTO listings (
        source, source_listing_id, url, phone, contact_name,
        asking_price, rooms, area_sqm, floor,
        address, city, description_snippet,
        complex_id,
        first_seen, last_seen, is_active,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CURRENT_DATE, CURRENT_DATE, TRUE, NOW(), NOW())
      ON CONFLICT (source, source_listing_id)
      WHERE source_listing_id IS NOT NULL
      DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, listings.phone),
        contact_name = COALESCE(EXCLUDED.contact_name, listings.contact_name),
        asking_price = COALESCE(EXCLUDED.asking_price, listings.asking_price),
        complex_id = COALESCE(listings.complex_id, EXCLUDED.complex_id),
        last_seen = CURRENT_DATE,
        updated_at = NOW()
      RETURNING id, (xmax = 0) as is_new`,
      [
        source,
        sourceId,
        listing.url || null,
        phone,
        listing.contact_name || null,
        listing.price ? parseFloat(listing.price) : null,
        listing.rooms ? parseFloat(listing.rooms) : null,
        listing.area_sqm ? parseFloat(listing.area_sqm) : null,
        listing.floor ? parseInt(listing.floor) : null,
        listing.address || null,
        listing.city || null,
        (listing.description || '').substring(0, 500),
        listing.complex_id || null
      ]
    );

    if (r.rows[0]?.is_new) return { status: 'inserted', id: r.rows[0].id };
    return { status: 'updated', id: r.rows[0]?.id };
  } catch (err) {
    logger.warn(`[ComplexScraper] Save error for ${listing.source}/${listing.listing_id}: ${err.message}`);
    return { status: 'error' };
  }
}

// ============================================================
// ENRICH: Trigger Gemini+Perplexity enrichment for new listings
// ============================================================
async function enrichNewListingIds(listingIds) {
  if (!listingIds || listingIds.length === 0) return;
  try {
    const { enrichListing } = require('./adEnrichmentService');
    logger.info(`[ComplexScraper] Enriching ${listingIds.length} new listings...`);
    for (const lid of listingIds) {
      try {
        const { rows } = await pool.query(
          `SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor,
                  l.description_snippet, l.source, l.phone,
                  COALESCE(c.iai_score, 0) as iai_score
           FROM listings l
           LEFT JOIN complexes c ON l.complex_id = c.id
           WHERE l.id = $1`, [lid]
        );
        if (rows[0]) {
          await enrichListing(rows[0]);
          await new Promise(r => setTimeout(r, ENRICH_DELAY_MS));
        }
      } catch (e) {
        logger.warn(`[ComplexScraper] Enrich error for listing ${lid}: ${e.message}`);
      }
    }
    logger.info(`[ComplexScraper] Enrichment complete for ${listingIds.length} listings`);
  } catch (e) {
    logger.warn(`[ComplexScraper] Enrichment batch error: ${e.message}`);
  }
}

// ============================================================
// SCAN SINGLE COMPLEX
// ============================================================
async function scanComplex(complex) {
  logger.info(`[ComplexScraper] Scanning complex ${complex.id}: ${complex.name} (${complex.city})`);

  const rawListings = await searchListingsForComplex(complex);
  if (!rawListings || rawListings.length === 0) {
    return { complex_id: complex.id, name: complex.name, listings: 0, inserted: 0, updated: 0 };
  }

  let inserted = 0, updated = 0;
  const newIds = [];

  for (const listing of rawListings) {
    if (!listing.url && !listing.listing_id) continue;
    if (!SOURCES.includes(listing.source)) continue; // only our target sources

    const result = await saveListing(listing);
    if (result.status === 'inserted') {
      inserted++;
      if (result.id) newIds.push(result.id);
    } else if (result.status === 'updated') {
      updated++;
    }
  }

  logger.info(`[ComplexScraper] Complex ${complex.name}: ${inserted} new, ${updated} updated`);

  // Trigger enrichment for new listings (async, non-blocking)
  if (newIds.length > 0) {
    setImmediate(() => enrichNewListingIds(newIds));
  }

  return {
    complex_id: complex.id,
    name: complex.name,
    city: complex.city,
    listings_found: rawListings.length,
    inserted,
    updated,
    new_ids: newIds
  };
}

// ============================================================
// SCAN ALL COMPLEXES (or a subset)
// ============================================================
async function scanAll(options = {}) {
  const {
    limit = 50,           // max complexes to scan per run
    minIai = 0,           // only scan complexes with IAI >= minIai
    onlyNew = false,      // only scan complexes with no listings yet
    complexIds = null     // specific complex IDs to scan
  } = options;

  let query;
  let params = [];

  if (complexIds && complexIds.length > 0) {
    query = `SELECT id, name, city, addresses as address, neighborhood, iai_score
             FROM complexes
             WHERE id = ANY($1)
             ORDER BY iai_score DESC NULLS LAST`;
    params = [complexIds];
  } else if (onlyNew) {
    query = `SELECT c.id, c.name, c.city, c.addresses as address, c.neighborhood, c.iai_score
             FROM complexes c
             WHERE c.iai_score >= $1
               AND NOT EXISTS (
                 SELECT 1 FROM listings l
                 WHERE l.complex_id = c.id
                   AND l.source IN ('homeless', 'yad1', 'winwin')
               )
             ORDER BY c.iai_score DESC NULLS LAST
             LIMIT $2`;
    params = [minIai, limit];
  } else {
    query = `SELECT id, name, city, addresses as address, neighborhood, iai_score
             FROM complexes
             WHERE iai_score >= $1
             ORDER BY iai_score DESC NULLS LAST
             LIMIT $2`;
    params = [minIai, limit];
  }

  const { rows: complexes } = await pool.query(query, params);

  if (complexes.length === 0) {
    logger.info('[ComplexScraper] No complexes to scan');
    return { total: 0, inserted: 0, updated: 0, results: [] };
  }

  logger.info(`[ComplexScraper] Starting scan of ${complexes.length} complexes (Homeless + Yad1 + Winwin)`);

  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let i = 0; i < complexes.length; i++) {
    try {
      const result = await scanComplex(complexes[i]);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[ComplexScraper] Error for complex ${complexes[i].id}: ${err.message}`);
      results.push({ complex_id: complexes[i].id, name: complexes[i].name, error: err.message });
    }

    // Delay between complexes to avoid rate limiting
    if (i < complexes.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const summary = {
    total_complexes: complexes.length,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    results
  };

  logger.info(`[ComplexScraper] Scan complete: ${totalInserted} inserted, ${totalUpdated} updated across ${complexes.length} complexes`);
  return summary;
}

module.exports = { scanAll, scanComplex, searchListingsForComplex };
