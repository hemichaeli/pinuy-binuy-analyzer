const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';

// Rate limiting: Perplexity allows ~20 req/min on most plans
const DELAY_BETWEEN_REQUESTS_MS = 3500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Perplexity API for data about a specific complex
 */
async function queryPerplexity(prompt, systemPrompt) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not set');
  }

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

  return response.data.choices[0].message.content;
}

/**
 * Parse JSON from Perplexity response (handles markdown code blocks)
 */
function parseJsonResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try extracting from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (e2) {
        // noop
      }
    }
    // Try finding JSON object/array in text
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (e3) {
        // noop
      }
    }
    logger.warn('Could not parse JSON from Perplexity response', { text: text.substring(0, 500) });
    return null;
  }
}

/**
 * Build the query prompt for a specific complex
 */
function buildTransactionQuery(complex) {
  const addresses = complex.addresses || '';
  return `חפש מידע עדכני על מתחם פינוי בינוי "${complex.name}" ב${complex.city}.
כתובות: ${addresses}

אני צריך את המידע הבא בפורמט JSON בלבד (ללא טקסט נוסף):

{
  "status_update": {
    "current_status": "הסטטוס התכנוני הנוכחי (הוכרז/בתכנון/הופקד/אושר/בביצוע או null אם לא ידוע)",
    "status_details": "פרטים על הסטטוס",
    "last_update_date": "YYYY-MM-DD או null",
    "objections": "האם יש התנגדויות? פרט",
    "developer_update": "עדכון על היזם"
  },
  "recent_transactions": [
    {
      "date": "YYYY-MM-DD",
      "address": "כתובת מלאה",
      "price": 0,
      "rooms": 0,
      "area_sqm": 0,
      "floor": 0,
      "source": "מקור המידע"
    }
  ],
  "current_market": {
    "avg_price_per_sqm": 0,
    "price_range_min": 0,
    "price_range_max": 0,
    "num_active_listings": 0,
    "notable_listings": [
      {
        "address": "כתובת",
        "asking_price": 0,
        "rooms": 0,
        "area_sqm": 0,
        "days_on_market": 0,
        "source": "yad2/madlan/אחר",
        "url": "קישור אם יש"
      }
    ]
  },
  "news": "חדשות או עדכונים אחרונים על המתחם (טקסט חופשי)",
  "confidence": "high/medium/low"
}

חפש באתרים: madlan.co.il, yad2.co.il, nadlan.gov.il, globes.co.il, calcalist.co.il, themarker.com
החזר JSON בלבד, ללא הסבר נוסף.`;
}

const SYSTEM_PROMPT = `You are a real estate data extraction assistant focused on Israeli Pinuy Binuy (urban renewal) projects.
Return ONLY valid JSON. No explanations, no markdown formatting, no text before or after the JSON.
If you don't have data for a field, use null or empty array [].
All prices should be in Israeli Shekels (ILS).
Always search in Hebrew sources for the most accurate local data.
Be precise with numbers - don't estimate unless clearly marked.`;

/**
 * Process Perplexity results and store in database
 */
async function storeTransactionData(complexId, data) {
  if (!data || !data.recent_transactions) return { transactions: 0, listings: 0 };

  let newTransactions = 0;
  let newListings = 0;

  // Store transactions
  if (data.recent_transactions && data.recent_transactions.length > 0) {
    for (const tx of data.recent_transactions) {
      if (!tx.price || tx.price === 0) continue;

      try {
        // Check for duplicate (same address, date, price)
        const existing = await pool.query(
          `SELECT id FROM transactions 
           WHERE complex_id = $1 AND address = $2 AND price = $3 
           AND transaction_date = $4`,
          [complexId, tx.address, tx.price, tx.date || null]
        );

        if (existing.rows.length === 0) {
          const pricePerSqm = tx.area_sqm && tx.area_sqm > 0 
            ? Math.round(tx.price / tx.area_sqm) 
            : null;

          await pool.query(
            `INSERT INTO transactions 
             (complex_id, transaction_date, price, area_sqm, rooms, floor, 
              price_per_sqm, address, city, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 
                     (SELECT city FROM complexes WHERE id = $1), $9)`,
            [complexId, tx.date || null, tx.price, tx.area_sqm || null,
             tx.rooms || null, tx.floor || null, pricePerSqm,
             tx.address, tx.source || 'perplexity']
          );
          newTransactions++;
        }
      } catch (err) {
        logger.warn(`Error storing transaction for complex ${complexId}`, { error: err.message });
      }
    }
  }

  // Store listings
  if (data.current_market && data.current_market.notable_listings) {
    for (const listing of data.current_market.notable_listings) {
      if (!listing.asking_price || listing.asking_price === 0) continue;

      try {
        // Check for duplicate (same address, price)
        const existing = await pool.query(
          `SELECT id FROM listings 
           WHERE complex_id = $1 AND address = $2 AND asking_price = $3 AND is_active = true`,
          [complexId, listing.address, listing.asking_price]
        );

        if (existing.rows.length === 0) {
          const pricePerSqm = listing.area_sqm && listing.area_sqm > 0
            ? Math.round(listing.asking_price / listing.area_sqm)
            : null;

          await pool.query(
            `INSERT INTO listings 
             (complex_id, source, url, asking_price, area_sqm, rooms, 
              price_per_sqm, address, city, first_seen, last_seen, 
              days_on_market, original_price)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     (SELECT city FROM complexes WHERE id = $1),
                     CURRENT_DATE, CURRENT_DATE, $9, $4)`,
            [complexId, listing.source || 'perplexity', listing.url || null,
             listing.asking_price, listing.area_sqm || null, listing.rooms || null,
             pricePerSqm, listing.address,
             listing.days_on_market || 0]
          );
          newListings++;
        }
      } catch (err) {
        logger.warn(`Error storing listing for complex ${complexId}`, { error: err.message });
      }
    }
  }

  return { transactions: newTransactions, listings: newListings };
}

/**
 * Update complex status and market data from Perplexity results
 */
async function updateComplexFromPerplexity(complexId, data) {
  if (!data) return;

  const updates = [];
  const params = [];
  let paramIndex = 1;

  // Update market prices if available
  if (data.current_market && data.current_market.avg_price_per_sqm) {
    // We can use this to calculate actual premium later
    // For now store the perplexity summary
  }

  // Update status if changed
  if (data.status_update && data.status_update.current_status) {
    const statusMap = {
      'הוכרז': 'declared',
      'בתכנון': 'planning',
      'להפקדה': 'pre_deposit',
      'הופקד': 'deposited',
      'הופקדה': 'deposited',
      'אושר': 'approved',
      'אושרה': 'approved',
      'בביצוע': 'construction',
      'היתר בניה': 'permit'
    };
    const newStatus = statusMap[data.status_update.current_status];
    if (newStatus) {
      updates.push(`status = $${paramIndex}`);
      params.push(newStatus);
      paramIndex++;
    }
  }

  // Build summary text
  const summaryParts = [];
  if (data.status_update && data.status_update.status_details) {
    summaryParts.push(data.status_update.status_details);
  }
  if (data.status_update && data.status_update.objections) {
    summaryParts.push(`התנגדויות: ${data.status_update.objections}`);
  }
  if (data.status_update && data.status_update.developer_update) {
    summaryParts.push(`יזם: ${data.status_update.developer_update}`);
  }
  if (data.current_market && data.current_market.avg_price_per_sqm) {
    summaryParts.push(`מחיר ממוצע למ"ר: ${data.current_market.avg_price_per_sqm.toLocaleString()} ש"ח`);
  }
  if (data.news) {
    summaryParts.push(data.news);
  }

  if (summaryParts.length > 0) {
    updates.push(`perplexity_summary = $${paramIndex}`);
    params.push(summaryParts.join(' | '));
    paramIndex++;
  }

  updates.push(`last_perplexity_update = NOW()`);

  if (updates.length > 0) {
    params.push(complexId);
    await pool.query(
      `UPDATE complexes SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }
}

/**
 * Scan a single complex using Perplexity
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (complexResult.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = complexResult.rows[0];
  const prompt = buildTransactionQuery(complex);

  logger.info(`Scanning complex: ${complex.name} (${complex.city})`, { complexId });

  const rawResponse = await queryPerplexity(prompt, SYSTEM_PROMPT);
  const data = parseJsonResponse(rawResponse);

  if (!data) {
    logger.warn(`No parseable data for complex ${complexId}`, { 
      name: complex.name, 
      responsePreview: rawResponse.substring(0, 200) 
    });
    // Still update the timestamp
    await pool.query(
      'UPDATE complexes SET last_perplexity_update = NOW() WHERE id = $1',
      [complexId]
    );
    return { complexId, name: complex.name, status: 'no_data', transactions: 0, listings: 0 };
  }

  const stored = await storeTransactionData(complexId, data);
  await updateComplexFromPerplexity(complexId, data);

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    status: 'success',
    confidence: data.confidence || 'unknown',
    transactions: stored.transactions,
    listings: stored.listings,
    hasStatusUpdate: !!(data.status_update && data.status_update.current_status),
    hasNews: !!data.news
  };
}

/**
 * Scan all complexes (or a batch) using Perplexity
 * @param {Object} options
 * @param {number} options.limit - Max complexes to scan (default: all)
 * @param {string} options.city - Filter by city
 * @param {string} options.status - Filter by status
 * @param {boolean} options.staleOnly - Only scan complexes not scanned in 7+ days
 */
async function scanAll(options = {}) {
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
    query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '7 days')`;
  }

  query += ' ORDER BY iai_score DESC, name ASC';

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`Starting Perplexity scan of ${total} complexes`, { options });

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

    // Rate limiting delay between requests
    if (i < complexes.rows.length - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  logger.info('Perplexity scan completed', {
    total: results.total,
    succeeded: results.succeeded,
    failed: results.failed,
    newTransactions: results.totalNewTransactions,
    newListings: results.totalNewListings
  });

  return results;
}

module.exports = {
  queryPerplexity,
  scanComplex,
  scanAll,
  parseJsonResponse,
  buildTransactionQuery,
  SYSTEM_PROMPT
};
