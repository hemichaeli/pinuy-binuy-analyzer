const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { detectKeywords } = require('./ssiCalculator');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_BETWEEN_REQUESTS = 4000; // 4s rate limit

/**
 * Query Perplexity for yad2 listings for a specific complex
 */
async function queryYad2Listings(complex) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');

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
      "asking_price": מחיר_בקשה_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח_במטר_רבוע,
      "floor": קומה,
      "description": "תיאור קצר של המודעה",
      "url": "קישור למודעה אם זמין",
      "listing_id": "מזהה מודעה אם זמין",
      "days_on_market": ימים_באתר_אם_ידוע,
      "is_urgent": true/false_אם_יש_מילים_כמו_דחוף_או_הזדמנות
    }
  ],
  "total_found": מספר_כולל,
  "search_area": "אזור החיפוש"
}

חשוב:
- חפש רק דירות למכירה, לא להשכרה
- כלול גם מודעות מאתרים דומים אם יש (מדלן, הומלס)
- אם אין מודעות, החזר listings ריק
- מחירים בשקלים בלבד
- שים לב למילים כמו: דחוף, הזדמנות, כינוס, ירושה, חייב למכור`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a real estate data extraction assistant. Return ONLY valid JSON, no markdown, no explanations.'
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
    return parseListingsResponse(content);
  } catch (err) {
    logger.warn(`Perplexity yad2 query failed for ${complex.name}`, { error: err.message });
    return { listings: [], total_found: 0 };
  }
}

/**
 * Parse Perplexity response into structured listings data
 */
function parseListingsResponse(content) {
  try {
    // Try direct JSON parse
    const cleaned = content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    
    const parsed = JSON.parse(cleaned);
    return {
      listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      total_found: parsed.total_found || 0,
      search_area: parsed.search_area || ''
    };
  } catch (e) {
    // Try to extract JSON from text
    const jsonMatch = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          listings: Array.isArray(parsed.listings) ? parsed.listings : [],
          total_found: parsed.total_found || 0,
          search_area: parsed.search_area || ''
        };
      } catch (e2) {
        logger.warn('Failed to parse yad2 listings JSON', { content: content.substring(0, 200) });
      }
    }
    return { listings: [], total_found: 0 };
  }
}

/**
 * Process and store a single listing for a complex
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

    // Check for existing listing by source_listing_id or address+price combo
    const existing = await pool.query(
      `SELECT id, asking_price, original_price, price_changes, first_seen, days_on_market
       FROM listings 
       WHERE complex_id = $1 AND (
         (source_listing_id = $2 AND source_listing_id IS NOT NULL AND source_listing_id != '')
         OR (address = $3 AND asking_price = $4)
       ) AND is_active = TRUE
       LIMIT 1`,
      [complexId, sourceListingId, address, price]
    );

    if (existing.rows.length > 0) {
      // Update existing listing
      const ex = existing.rows[0];
      const updates = { last_seen: 'CURRENT_DATE' };
      let priceChanges = ex.price_changes || 0;
      let totalDrop = 0;
      const originalPrice = parseFloat(ex.original_price) || parseFloat(ex.asking_price);

      // Detect price change
      if (price && ex.asking_price && Math.abs(price - parseFloat(ex.asking_price)) > 1000) {
        priceChanges++;
        if (originalPrice && price < originalPrice) {
          totalDrop = ((originalPrice - price) / originalPrice) * 100;
        }
      }

      // Update days on market
      let daysOnMarket = ex.days_on_market || 0;
      if (listing.days_on_market) {
        daysOnMarket = Math.max(daysOnMarket, parseInt(listing.days_on_market));
      } else if (ex.first_seen) {
        const firstSeen = new Date(ex.first_seen);
        daysOnMarket = Math.floor((Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24));
      }

      // Detect keywords
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
          is_inheritance = $10
        WHERE id = $11`,
        [
          price, pricePsm, priceChanges, totalDrop, daysOnMarket,
          description.substring(0, 500),
          keywords.has_urgent_keywords, keywords.urgent_keywords_found,
          keywords.is_foreclosure, keywords.is_inheritance,
          ex.id
        ]
      );

      return { action: 'updated', id: ex.id, priceChanged: priceChanges > ex.price_changes };

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
          price, // original_price = first asking_price
          description.substring(0, 500),
          keywords.has_urgent_keywords, keywords.urgent_keywords_found,
          keywords.is_foreclosure, keywords.is_inheritance
        ]
      );

      if (result.rows.length > 0) {
        return { action: 'inserted', id: result.rows[0].id };
      }
      return { action: 'skipped' };
    }
  } catch (err) {
    logger.warn(`Failed to process listing for complex ${complexId}`, { error: err.message, listing });
    return { action: 'error', error: err.message };
  }
}

/**
 * Scan yad2 listings for a single complex
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
  logger.info(`Scanning yad2 for: ${complex.name} (${complex.city})`);

  const data = await queryYad2Listings(complex);
  
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
    }
    else if (result.action === 'error') errors++;
  }

  // Mark listings not seen in this scan as potentially inactive
  // (only if we got results - avoid mass deactivation on empty response)
  if (data.listings.length > 0) {
    await pool.query(
      `UPDATE listings SET is_active = FALSE 
       WHERE complex_id = $1 AND source = 'yad2' AND is_active = TRUE 
       AND last_seen < CURRENT_DATE - INTERVAL '30 days'`,
      [complexId]
    );
  }

  const result = {
    complex: complex.name,
    city: complex.city,
    totalFound: data.total_found,
    listingsProcessed: data.listings.length,
    newListings,
    updatedListings,
    priceChanges,
    errors
  };

  logger.info(`yad2 scan for ${complex.name}: ${newListings} new, ${updatedListings} updated, ${priceChanges} price changes`);
  return result;
}

/**
 * Scan yad2 listings for all complexes (batch mode)
 */
async function scanAll(options = {}) {
  const { staleOnly = true, limit = 50, city = null } = options;

  let query = 'SELECT id, name, city, addresses FROM complexes WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (city) {
    paramCount++;
    query += ` AND city = $${paramCount}`;
    params.push(city);
  }

  if (staleOnly) {
    // Only scan complexes that haven't had yad2 listings updated in 7+ days
    query += ` AND id NOT IN (
      SELECT DISTINCT complex_id FROM listings 
      WHERE source = 'yad2' AND last_seen > CURRENT_DATE - INTERVAL '7 days'
    )`;
  }

  // Prioritize complexes with higher IAI scores
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
  const details = [];

  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      succeeded++;
      totalNew += result.newListings;
      totalUpdated += result.updatedListings;
      totalPriceChanges += result.priceChanges;
      details.push({ status: 'ok', ...result });

      // Rate limiting
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
      // Shorter delay on error
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const summary = {
    total,
    succeeded,
    failed,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    details
  };

  logger.info(`yad2 batch scan complete: ${succeeded}/${total} ok, ${totalNew} new listings, ${totalUpdated} updated, ${totalPriceChanges} price changes`);
  return summary;
}

module.exports = {
  scanComplex,
  scanAll,
  queryYad2Listings,
  processListing
};
