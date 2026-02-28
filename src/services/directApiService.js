const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_BETWEEN_REQUESTS_MS = 3500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== NADLAN.GOV.IL ====================
const NADLAN_API_BASE = 'https://www.nadlan.gov.il/Nadlan.REST/Main';

async function fetchNadlanTransactions(address, city) {
  try {
    // Search endpoint
    const searchResponse = await axios.get(`${NADLAN_API_BASE}/GetAssestAndDeals`, {
      params: {
        ObjectID: '',
        CurrentLavel: 1,
        PageNo: 1,
        OrderByFilled: '',
        OrderByDescending: false,
        Query: `${address}, ${city}`
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nadlan.gov.il/'
      },
      timeout: 30000
    });

    const data = searchResponse.data;
    if (!data || !data.AllResults) {
      return [];
    }

    // Parse transactions
    const transactions = data.AllResults
      .filter(item => item.DEALAMOUNT && item.DEALAMOUNT > 0)
      .map(item => ({
        date: item.DEALDATETIME ? item.DEALDATETIME.split('T')[0] : null,
        address: item.FULLADRESS || item.STREETNAME || address,
        price: parseInt(item.DEALAMOUNT) || 0,
        rooms: parseFloat(item.ASSETROOMNUM) || null,
        area_sqm: parseFloat(item.DEALNATURE) || null,
        floor: parseInt(item.FLOORNO) || null,
        building_year: parseInt(item.BUILDINGYEAR) || null,
        source: 'nadlan.gov.il'
      }));

    return transactions;
  } catch (error) {
    logger.warn(`Nadlan API error for ${address}, ${city}`, { error: error.message });
    return [];
  }
}

// ==================== YAD2 API ====================
const YAD2_API_BASE = 'https://gw.yad2.co.il/feed-search-legacy/realestate/forsale';

async function fetchYad2Listings(city, streetName) {
  try {
    // City code mapping (partial - expand as needed)
    const cityCodes = {
      'תל אביב': 5000, 'תל אביב יפו': 5000, 'תל-אביב': 5000,
      'חולון': 6600, 'בת ים': 6200, 'רמת גן': 8600,
      'גבעתיים': 6300, 'פתח תקווה': 7900, 'ראשון לציון': 8300,
      'נתניה': 7400, 'חיפה': 4000, 'ירושלים': 3000,
      'אשדוד': 70, 'באר שבע': 9000, 'רחובות': 8400,
      'הרצליה': 6400, 'כפר סבא': 6900, 'רעננה': 8700,
      'הוד השרון': 6500, 'רמת השרון': 8300, 'לוד': 7000,
      'רמלה': 8200, 'יבנה': 2660, 'אור יהודה': 2600,
      'קריית אונו': 7100
    };

    const cityCode = cityCodes[city];
    if (!cityCode) {
      logger.warn(`No city code for ${city}`);
      return [];
    }

    const response = await axios.get(YAD2_API_BASE, {
      params: {
        city: cityCode,
        street: streetName,
        propertyGroup: 'apartments',
        page: 1
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.yad2.co.il/'
      },
      timeout: 30000
    });

    const data = response.data;
    if (!data || !data.data || !data.data.feed || !data.data.feed.feed_items) {
      return [];
    }

    const listings = data.data.feed.feed_items
      .filter(item => item.price && item.type === 'ad')
      .map(item => ({
        yad2_id: item.id || item.link_token,
        address: item.street || item.address_more?.street?.text || streetName,
        asking_price: parseInt(String(item.price).replace(/[^\d]/g, '')) || 0,
        rooms: parseFloat(item.rooms_text || item.Rooms_text) || null,
        area_sqm: parseInt(item.square_meters || item.SquareMeter) || null,
        floor: parseInt(item.floor) || null,
        url: item.id ? `https://www.yad2.co.il/item/${item.id}` : null,
        img_url: item.images?.[0]?.src || item.img_url || null,
        description: item.title || item.title_1 || null,
        source: 'yad2'
      }));

    return listings;
  } catch (error) {
    if (error.response?.status === 403) {
      logger.warn(`Yad2 blocked request for ${city}`, { status: 403 });
    } else {
      logger.warn(`Yad2 API error for ${city}`, { error: error.message });
    }
    return [];
  }
}

// ==================== MAVAT (Planning Authority) ====================
const MAVAT_SEARCH_URL = 'https://mavat.iplan.gov.il/rest/api/Search/';

async function fetchMavatStatus(planNumber, city) {
  try {
    // Search for plan
    const searchResponse = await axios.post(MAVAT_SEARCH_URL, {
      query: planNumber || city,
      type: 'plan'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    const plans = searchResponse.data?.results || [];
    if (plans.length === 0) {
      return null;
    }

    const plan = plans[0];
    return {
      plan_number: plan.planNumber || plan.PL_NUMBER,
      status: plan.status || plan.PL_LANDUSE_STATUS,
      status_date: plan.statusDate || plan.LAST_UPDATE,
      plan_name: plan.name || plan.PL_NAME,
      area: plan.area,
      developer: plan.developer,
      source: 'mavat'
    };
  } catch (error) {
    logger.warn(`Mavat API error for ${planNumber || city}`, { error: error.message });
    return null;
  }
}

// ==================== AGGREGATE SCAN ====================

/**
 * Scan a single complex using direct APIs (no Perplexity)
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (complexResult.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = complexResult.rows[0];
  const addresses = (complex.addresses || '').split(',').map(a => a.trim()).filter(a => a);
  const primaryAddress = addresses[0] || complex.name;

  logger.info(`[DirectAPI] Scanning: ${complex.name} (${complex.city})`, { complexId });

  let newTransactions = 0;
  let newListings = 0;
  let statusUpdated = false;

  // 1. Fetch Nadlan transactions
  try {
    const transactions = await fetchNadlanTransactions(primaryAddress, complex.city);
    for (const tx of transactions) {
      if (!tx.price || tx.price === 0) continue;

      const existing = await pool.query(
        `SELECT id FROM transactions 
         WHERE complex_id = $1 AND address = $2 AND price = $3 
         AND transaction_date = $4`,
        [complexId, tx.address, tx.price, tx.date]
      );

      if (existing.rows.length === 0) {
        const pricePerSqm = tx.area_sqm > 0 ? Math.round(tx.price / tx.area_sqm) : null;
        await pool.query(
          `INSERT INTO transactions 
           (complex_id, transaction_date, price, area_sqm, rooms, floor, 
            price_per_sqm, address, city, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [complexId, tx.date, tx.price, tx.area_sqm, tx.rooms, tx.floor,
           pricePerSqm, tx.address, complex.city, tx.source]
        );
        newTransactions++;
      }
    }
    logger.info(`[Nadlan] ${complex.name}: ${newTransactions} new transactions`);
  } catch (err) {
    logger.warn(`[Nadlan] Error for ${complex.name}`, { error: err.message });
  }

  await sleep(1000);

  // 2. Fetch Yad2 listings
  try {
    const listings = await fetchYad2Listings(complex.city, primaryAddress);
    for (const listing of listings) {
      if (!listing.asking_price || listing.asking_price === 0) continue;

      const existing = await pool.query(
        `SELECT id FROM listings 
         WHERE complex_id = $1 AND yad2_id = $2`,
        [complexId, listing.yad2_id]
      );

      if (existing.rows.length === 0) {
        const pricePerSqm = listing.area_sqm > 0 
          ? Math.round(listing.asking_price / listing.area_sqm) : null;
        await pool.query(
          `INSERT INTO listings 
           (complex_id, source, yad2_id, url, asking_price, area_sqm, rooms, 
            price_per_sqm, address, city, first_seen, last_seen, original_price, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE, CURRENT_DATE, $5, true)`,
          [complexId, listing.source, listing.yad2_id, listing.url, 
           listing.asking_price, listing.area_sqm, listing.rooms,
           pricePerSqm, listing.address, complex.city]
        );
        newListings++;
      } else {
        // Update existing - mark as still active
        await pool.query(
          `UPDATE listings SET last_seen = CURRENT_DATE, is_active = true WHERE id = $1`,
          [existing.rows[0].id]
        );
      }
    }
    logger.info(`[Yad2] ${complex.name}: ${newListings} new listings`);
  } catch (err) {
    logger.warn(`[Yad2] Error for ${complex.name}`, { error: err.message });
  }

  await sleep(1000);

  // 3. Fetch Mavat status
  try {
    const mavatStatus = await fetchMavatStatus(complex.plan_number, complex.city);
    if (mavatStatus && mavatStatus.status) {
      const statusMap = {
        'הוכרז': 'declared',
        'בתכנון': 'planning', 
        'להפקדה': 'pre_deposit',
        'הופקד': 'deposited',
        'הופקדה': 'deposited',
        'אושר': 'approved',
        'אושרה': 'approved',
        'בביצוע': 'construction',
        'היתר בניה': 'permit',
        'מאושר': 'approved',
        'מופקד': 'deposited'
      };
      const newStatus = statusMap[mavatStatus.status] || null;
      if (newStatus && newStatus !== complex.status) {
        await pool.query(
          `UPDATE complexes SET status = $1, mavat_last_check = NOW() WHERE id = $2`,
          [newStatus, complexId]
        );
        statusUpdated = true;
        logger.info(`[Mavat] ${complex.name}: status updated to ${newStatus}`);
      }
    }
  } catch (err) {
    logger.warn(`[Mavat] Error for ${complex.name}`, { error: err.message });
  }

  // Update dedicated scan timestamp (NOT updated_at which gets reset by enrichment/other updates)
  await pool.query(
    `UPDATE complexes SET last_direct_api_scan = NOW() WHERE id = $1`,
    [complexId]
  );

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    status: 'success',
    transactions: newTransactions,
    listings: newListings,
    statusUpdated
  };
}

/**
 * Scan multiple complexes using direct APIs
 */
async function scanAll(options = {}) {
  // Ensure dedicated scan tracking column exists (like last_yad2_scan)
  try {
    await pool.query(`
      ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_direct_api_scan TIMESTAMP;
    `);
  } catch (e) {
    logger.warn('Could not ensure last_direct_api_scan column', { error: e.message });
  }

  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (options.city) {
    query += ` AND city = $${paramIndex}`;
    params.push(options.city);
    paramIndex++;
  }

  if (options.status) {
    query += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  if (options.staleOnly) {
    // Use dedicated scan column - not updated_at which gets reset by enrichment
    query += ` AND (last_direct_api_scan IS NULL OR last_direct_api_scan < NOW() - INTERVAL '3 days')`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST, name ASC';

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`[DirectAPI] Starting scan of ${total} complexes`, { options });

  const results = {
    total,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    totalNewTransactions: 0,
    totalNewListings: 0,
    details: []
  };

  for (let i = 0; i < complexes.rows.length; i++) {
    const complex = complexes.rows[i];
    try {
      const result = await scanComplex(complex.id);
      results.scanned++;
      results.succeeded++;
      results.totalNewTransactions += result.transactions;
      results.totalNewListings += result.listings;
      results.details.push(result);

      logger.info(`[${i + 1}/${total}] ${complex.name}: ${result.transactions} tx, ${result.listings} listings`);
    } catch (err) {
      results.scanned++;
      results.failed++;
      results.details.push({
        complexId: complex.id,
        name: complex.name,
        status: 'error',
        error: err.message
      });
      logger.error(`[${i + 1}/${total}] ${complex.name}: ERROR - ${err.message}`);
    }

    // Rate limiting
    if (i < complexes.rows.length - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  logger.info('[DirectAPI] Scan completed', {
    total: results.total,
    succeeded: results.succeeded,
    failed: results.failed,
    newTransactions: results.totalNewTransactions,
    newListings: results.totalNewListings
  });

  return results;
}

module.exports = {
  fetchNadlanTransactions,
  fetchYad2Listings,
  fetchMavatStatus,
  scanComplex,
  scanAll
};
