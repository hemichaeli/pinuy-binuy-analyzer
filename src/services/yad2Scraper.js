/**
 * yad2 Direct Scraper (Phase 4.3) - WhatsApp Auto-Alerts
 * 
 * Enhanced scraper that queries yad2's API directly for:
 * - Real-time listing data
 * - Accurate price tracking
 * - Days on market
 * - Urgent/distress indicators
 * 
 * NEW: Sends WhatsApp alerts to subscribed leads matching criteria
 */

const axios = require('axios');
const { enrichListing } = require('./adEnrichmentService');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { detectKeywords } = require('./ssiCalculator');

// yad2 API endpoints
const YAD2_API_BASE = 'https://gw.yad2.co.il/feed-search-legacy/realestate/forsale';
const YAD2_ITEM_API = 'https://gw.yad2.co.il/feed-search-legacy/item';
const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

// Cloudflare Worker proxy URL (bypasses yad2 IP blocking on Railway)
const YAD2_PROXY_URL = process.env.YAD2_PROXY_URL || 'https://yad2-proxy.pinuy-binuy.workers.dev';

const DELAY_BETWEEN_REQUESTS = 3500; // 3.5s between requests
const MAX_RETRIES = 2;

// City code mapping for yad2 API (CBS settlement codes - verified from data.gov.il)
const CITY_CODES = {
  // Tel Aviv area
  'תל אביב יפו': '5000',
  'תל אביב - יפו': '5000',
  'תל אביב': '5000',
  'רמת גן': '8600',
  'גבעתיים': '6300',
  'בני ברק': '6100',
  'חולון': '6600',
  'בת ים': '6200',
  // Center
  'ראשון לציון': '8300',
  'פתח תקווה': '7900',
  'הרצליה': '6400',
  'רעננה': '8700',
  'כפר סבא': '6900',
  'הוד השרון': '9700',
  'רמת השרון': '2650',
  'כוכב יאיר': '1224',
  'כוכב יאיר-צור יגאל': '1224',
  'ראש העין': '2640',
  'אור יהודה': '2400',
  'יהוד': '9400',
  'יהוד-מונוסון': '9400',
  'נס ציונה': '7200',
  'רחובות': '8400',
  'יבנה': '2660',
  'באר יעקב': '2530',
  'לוד': '7000',
  'רמלה': '8500',
  'מודיעין': '1200',
  'מודיעין-מכבים-רעות': '1200',
  // North coast
  'נתניה': '7400',
  'חדרה': '6500',
  'טירת כרמל': '2100',
  // Haifa area
  'חיפה': '4000',
  'קריית אתא': '6800',
  'קריית ביאליק': '9500',
  'קריית ים': '9600',
  'קריית מוצקין': '8200',
  'קריות': '9600',  // fallback to קריית ים
  'קריית אונו': '2620',
  'נשר': '2500',
  // Jerusalem area
  'ירושלים': '3000',
  'מבשרת ציון': '1015',
  'מעלה אדומים': '3616',
  // South
  'אשדוד': '70',
  'אשקלון': '7100',
  'באר שבע': '9000',
  // Other
  'עפולה': '7800',
  'נצרת עילית': '1061',
  'בית שמש': '2610',
  // Krayot (with alternate spellings - קרית vs קריית)
  'קרית אתא': '6800',
  'קרית ביאליק': '9500',
  'קרית ים': '9600',
  'קרית מוצקין': '8200',
  'קרית אונו': '2620'
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

  // Extract street names from addresses (use both 'addresses' and 'address' fields)
  const addressSrc = [complex.addresses || '', complex.address || ''].filter(Boolean).join(',');
  const addresses = addressSrc.split(',').map(a => a.trim()).filter(Boolean);
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

  // Extract thumbnail image URL from yad2 API response
  const thumbnail =
    item.images?.[0]?.src ||
    item.images?.[0]?.url ||
    item.cover_image ||
    item.main_image ||
    item.image ||
    item.img_url ||
    null;

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
    thumbnail_url: thumbnail,
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

  // Use both 'addresses' and 'address' fields for street list
  const addressSrc = [complex.addresses || '', complex.address || ''].filter(Boolean).join(',');
  const streets = addressSrc.split(',').map(a => a.trim()).filter(Boolean);
  const streetList = streets.length > 0 ? streets.join(', ') : complex.name;

  const prompt = `חפש מודעות למכירה פעילות באתר yad2.co.il עבור הכתובות הבאות ב${complex.city}:
${streetList}

חשוב מאוד: כלול מספר טלפון של המוכר/מתווך לכל מודעה!

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
      "phone": "מספר טלפון של המוכר/מתווך או null",
      "contact_name": "שם המוכר/מתווך או null",
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
- שים לב למילים: דחוף, הזדמנות, כינוס, ירושה, חייב למכור
- נסה לכלול מספר טלפון לכל מודעה - זה קריטי!`;

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
      // Clean phone for update too
      function cleanPhoneUpd(p) {
        if (!p) return null;
        const d = String(p).replace(/\D/g, '');
        if (d.length < 9 || d.length > 12) return null;
        if (d.startsWith('972')) return '0' + d.slice(3);
        return d.startsWith('0') ? d : null;
      }
      const updPhone = cleanPhoneUpd(listing.phone);
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
          phone = COALESCE(phone, $13),
          contact_name = COALESCE(contact_name, $14),
          thumbnail_url = COALESCE(thumbnail_url, $15),
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
          ex.id,
          updPhone,
          listing.contact_name || null,
          listing.thumbnail_url || null
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

      // Clean phone number
      function cleanPhone(p) {
        if (!p) return null;
        const d = String(p).replace(/\D/g, '');
        if (d.length < 9 || d.length > 12) return null;
        if (d.startsWith('972')) return '0' + d.slice(3);
        return d.startsWith('0') ? d : null;
      }
      const phone = cleanPhone(listing.phone);
      const contactName = listing.contact_name || null;

      const result = await pool.query(
        `INSERT INTO listings (
          complex_id, source, source_listing_id, url,
          asking_price, area_sqm, rooms, floor, price_per_sqm,
          address, city, first_seen, last_seen, days_on_market,
          original_price, description_snippet,
          has_urgent_keywords, urgent_keywords_found, is_foreclosure, is_inheritance,
          phone, contact_name, thumbnail_url,
          is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE, CURRENT_DATE, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, TRUE)
        ON CONFLICT (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
        DO UPDATE SET last_seen=CURRENT_DATE, asking_price=COALESCE(EXCLUDED.asking_price, listings.asking_price),
          phone=COALESCE(EXCLUDED.phone, listings.phone),
          url=COALESCE(EXCLUDED.url, listings.url),
          complex_id=COALESCE(EXCLUDED.complex_id, listings.complex_id),
          updated_at=NOW()
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
          keywords.is_inheritance || listing.is_inheritance,
          phone, contactName, listing.thumbnail_url || null
        ]
      );

      if (result.rows.length > 0) {
        // Trigger async enrichment (non-blocking)
        const newListingId = result.rows[0].id;
        setImmediate(async () => {
          try {
            const { rows: listingRows } = await pool.query(
              `SELECT l.*, c.iai_score FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`,
              [newListingId]
            );
            if (listingRows.length > 0) {
              await enrichListing(listingRows[0]);
            }
          } catch (enrichErr) {
            logger.warn(`[yad2Scraper] Enrichment failed for listing ${newListingId}: ${enrichErr.message}`);
          }
        });
        return { action: 'inserted', id: newListingId };
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
    'SELECT id, name, city, addresses, address, iai_score FROM complexes WHERE id = $1',
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
  let whatsappAlertsSent = 0;

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
  
  // Send WhatsApp alerts for new listings
  try {
    const whatsappAlertService = require('./whatsappAlertService');
    for (const { id } of newListingIds) {
      // Get full listing details for WhatsApp alert
      const listingDetails = await pool.query(
        `SELECT l.*, c.name as complex_name 
         FROM listings l 
         LEFT JOIN complexes c ON l.complex_id = c.id 
         WHERE l.id = $1`,
        [id]
      );
      
      if (listingDetails.rows.length > 0) {
        const fullListing = listingDetails.rows[0];
        const alertResult = await whatsappAlertService.processNewListing(fullListing);
        whatsappAlertsSent += alertResult.sent || 0;
        logger.debug(`[WHATSAPP-ALERT] Sent ${alertResult.sent} alerts for listing ${id}`);
      }
    }
  } catch (whatsappErr) {
    logger.warn('[WHATSAPP-ALERT] Failed to send WhatsApp alerts', { error: whatsappErr.message });
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
    whatsappAlertsSent,
    errors
  };
}

/**
 * Scan yad2 listings for ALL complexes (no limit) using parallel batches
 */
const SCAN_BATCH_SIZE = 8; // parallel requests per batch
async function scanAll(options = {}) {
  const { staleOnly = true, limit = null, city = null } = options;

  let query = 'SELECT id, name, city, addresses, address, iai_score FROM complexes WHERE 1=1';
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

  // Only add LIMIT if explicitly specified (null = scan all)
  if (limit !== null && limit !== undefined) {
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`yad2 batch scan: ${total} complexes to scan (parallel batch size: ${SCAN_BATCH_SIZE})`);

  let succeeded = 0;
  let failed = 0;
  let totalNew = 0;
  let totalUpdated = 0;
  let totalPriceChanges = 0;
  let totalAlerts = 0;
  let totalWhatsAppAlerts = 0;
  const details = [];

  // Process in parallel batches to speed up scanning
  for (let i = 0; i < complexes.rows.length; i += SCAN_BATCH_SIZE) {
    const batch = complexes.rows.slice(i, i + SCAN_BATCH_SIZE);
    const batchNum = Math.floor(i / SCAN_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / SCAN_BATCH_SIZE);
    logger.info(`yad2 scanning batch ${batchNum}/${totalBatches} (complexes ${i + 1}-${Math.min(i + SCAN_BATCH_SIZE, total)} of ${total})`);

    const batchResults = await Promise.allSettled(
      batch.map(complex => scanComplex(complex.id))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const br = batchResults[j];
      const complex = batch[j];
      if (br.status === 'fulfilled') {
        const result = br.value;
        succeeded++;
        totalNew += result.newListings;
        totalUpdated += result.updatedListings;
        totalPriceChanges += result.priceChanges;
        totalAlerts += result.priceDropAlerts || 0;
        totalWhatsAppAlerts += result.whatsappAlertsSent || 0;
        details.push({ status: 'ok', ...result });
      } else {
        failed++;
        details.push({
          status: 'error',
          complex: complex.name,
          city: complex.city,
          error: br.reason?.message || 'unknown error'
        });
        logger.warn(`yad2 scan failed for ${complex.name}`, { error: br.reason?.message });
      }
    }

    // Delay between batches to avoid rate limiting
    if (i + SCAN_BATCH_SIZE < complexes.rows.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logger.info(`yad2 batch scan complete: ${succeeded}/${total} ok, ${totalNew} new, ${totalUpdated} updated, ${totalPriceChanges} price changes, ${totalAlerts} alerts, ${totalWhatsAppAlerts} WhatsApp sent`);

  return {
    total,
    succeeded,
    failed,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    totalAlerts,
    totalWhatsAppAlerts,
    details
  };
}

/**
 * NEW: Scan yad2 by city (40 API calls) instead of by complex (762 calls).
 * For each city that has pinuy-binuy complexes, fetch ALL listings from yad2,
 * then use complexMatcher to identify which listings belong to a complex.
 * This reduces scan time from ~70 minutes to ~1 minute.
 */
async function scanAllByCities(options = {}) {
  const { staleOnly = false } = options;
  const { findMatchingComplex, loadComplexCache } = require('./complexMatcher');

  // Load complex cache
  await loadComplexCache();

  // Get all unique cities that have complexes
  let cityQuery = 'SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL';
  if (staleOnly) {
    cityQuery += " AND (last_yad2_scan IS NULL OR last_yad2_scan < NOW() - INTERVAL '3 days')";
  }
  const cityResult = await pool.query(cityQuery);
  const cities = cityResult.rows.map(r => r.city).filter(Boolean);

  logger.info(`[yad2-city-scan] Scanning ${cities.length} cities for pinuy-binuy listings`);

  let totalNew = 0;
  let totalUpdated = 0;
  let totalPriceChanges = 0;
  let totalListingsFound = 0;
  let citiesScanned = 0;
  let citiesWithResults = 0;
  const cityResults = [];

  // Process cities in parallel batches of 5
  const CITY_BATCH_SIZE = 5;
  for (let i = 0; i < cities.length; i += CITY_BATCH_SIZE) {
    const batch = cities.slice(i, i + CITY_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (cityName) => {
        const cityCode = getCityCode(cityName);
        if (!cityCode) {
          logger.debug(`[yad2-city-scan] No city code for ${cityName}, skipping`);
          return { city: cityName, skipped: true, reason: 'no_city_code' };
        }

        // Fetch all listings for this city from yad2 API (paginated)
        const allListings = [];
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 10) { // max 10 pages = 500 listings per city
          try {
            // Use Cloudflare Worker proxy to bypass Railway IP blocking
            const proxyUrl = `${YAD2_PROXY_URL}?city=${cityCode}&propertyGroup=apartments&dealType=forsale&page=${page}&limit=50&key=pinuy-binuy-2026`;
            const response = await axios.get(proxyUrl, { timeout: 20000 });

            // Check for bot challenge
            if (response.data?.error === 'bot_challenge') {
              logger.warn(`[yad2-city-scan] Bot challenge for ${cityName} - yad2 blocked Cloudflare IP too`);
              hasMore = false;
              break;
            }

            // Worker returns yad2 response directly (same format as direct API)
            const feedItems = response.data?.feed?.feed_items || [];
            const ads = feedItems.filter(item => item.type === 'ad' && item.id);
            allListings.push(...ads);

            // Check if there are more pages
            const totalCount = response.data?.feed?.total_items || 0;
            hasMore = allListings.length < totalCount && ads.length === 50;
            page++;

            if (ads.length < 50) hasMore = false;
          } catch (err) {
            logger.warn(`[yad2-city-scan] Proxy error for ${cityName} page ${page}: ${err.message}`);
            hasMore = false;
          }
        }

        logger.info(`[yad2-city-scan] ${cityName}: fetched ${allListings.length} listings from yad2`);

        // For each listing, try to match it to a pinuy-binuy complex
        let cityNew = 0;
        let cityUpdated = 0;
        let cityMatched = 0;

        for (const item of allListings) {
          const address = [
            item.street || item.street_name || '',
            item.house_number || item.HomeNumber || ''
          ].filter(Boolean).join(' ').trim() || item.address_more?.text || '';

          if (!address) continue;

          // Find matching complex
          const match = await findMatchingComplex(address, cityName);
          if (!match) continue;

          cityMatched++;
          // Parse the listing with the matched complex context
          const complexRow = { name: match.complexName, city: cityName, addresses: '', address: '' };
          const listing = parseYad2Item(item, complexRow);

          const result = await processListing(listing, match.complexId, cityName);
          if (result.action === 'inserted') {
            cityNew++;
            // Trigger alerts for new listings
            if (result.id) {
              const complexInfo = await pool.query('SELECT iai_score FROM complexes WHERE id = $1', [match.complexId]);
              const iai = complexInfo.rows[0]?.iai_score;
              await createNewListingAlert(result.id, match.complexId, listing, iai);
            }
          } else if (result.action === 'updated') {
            cityUpdated++;
          }
        }

        // Update last_yad2_scan for all complexes in this city
        await pool.query(
          "UPDATE complexes SET last_yad2_scan = NOW() WHERE city = $1",
          [cityName]
        );

        return {
          city: cityName,
          cityCode,
          listingsFetched: allListings.length,
          listingsMatched: cityMatched,
          newListings: cityNew,
          updatedListings: cityUpdated
        };
      })
    );

    for (const br of batchResults) {
      if (br.status === 'fulfilled') {
        const r = br.value;
        citiesScanned++;
        if (!r.skipped) {
          totalListingsFound += r.listingsFetched || 0;
          totalNew += r.newListings || 0;
          totalUpdated += r.updatedListings || 0;
          if ((r.listingsMatched || 0) > 0) citiesWithResults++;
        }
        cityResults.push(r);
      } else {
        logger.warn(`[yad2-city-scan] City batch error: ${br.reason?.message}`);
      }
    }

    // Small delay between city batches
    if (i + CITY_BATCH_SIZE < cities.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  logger.info(`[yad2-city-scan] Complete: ${citiesScanned} cities, ${totalListingsFound} listings fetched, ${totalNew} new, ${totalUpdated} updated`);

  return {
    total: cities.length,
    citiesScanned,
    citiesWithResults,
    totalListingsFound,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    cityResults
  };
}

module.exports = {
  scanComplex,
  scanAll,
  scanAllByCities,
  queryYad2Listings,
  queryYad2Direct,
  queryYad2Perplexity,
  processListing,
  getCityCode,
  createNewListingAlert,
  createPriceDropAlert
};
