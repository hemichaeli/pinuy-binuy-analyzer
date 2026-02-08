const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * SSI (Seller Stress Index) Calculator
 * Measures seller urgency/stress level for active listings
 * Range: 0-100
 * 
 * Components:
 *   ssi_time_score (0-40): Based on days on market
 *   ssi_price_score (0-35): Based on total price drop percentage
 *   ssi_indicator_score (0-25): Based on urgency keywords, foreclosure, inheritance
 */

// Hebrew urgency keywords to search in listing descriptions
const URGENT_KEYWORDS = [
  'דחוף', 'הזדמנות', 'מתחת למחיר', 'חייב למכור', 'חייבים למכור',
  'מכירה מהירה', 'מכירה דחופה', 'ירושה', 'כינוס', 'כונס נכסים',
  'עוזבים את הארץ', 'עוזב את הארץ', 'מחיר מציאה', 'למכירה מיידית',
  'מחיר סופי', 'ללא מתווכים', 'הנחה', 'מוכרחים', 'במחיר נמוך',
  'מוטיבציה גבוהה', 'פינוי מהיר'
];

const FORECLOSURE_KEYWORDS = ['כינוס', 'כונס נכסים', 'כונס', 'הוצאה לפועל'];
const INHERITANCE_KEYWORDS = ['ירושה', 'עיזבון', 'יורשים'];

/**
 * Calculate time-based stress score (0-40)
 */
function calculateTimeScore(daysOnMarket) {
  if (!daysOnMarket || daysOnMarket < 30) return 0;
  if (daysOnMarket < 60) return 10;
  if (daysOnMarket < 90) return 20;
  if (daysOnMarket < 120) return 30;
  return 40;
}

/**
 * Calculate price-drop stress score (0-35)
 */
function calculatePriceScore(totalPriceDropPercent) {
  const drop = parseFloat(totalPriceDropPercent) || 0;
  if (drop <= 0) return 0;
  if (drop < 5) return 10;
  if (drop < 10) return 20;
  if (drop < 15) return 30;
  return 35;
}

/**
 * Calculate indicator-based stress score (0-25)
 */
function calculateIndicatorScore(listing) {
  let score = 0;

  // Check for urgent keywords in description
  const description = (listing.description_snippet || '').toLowerCase();
  const foundKeywords = [];

  for (const keyword of URGENT_KEYWORDS) {
    if (description.includes(keyword)) {
      foundKeywords.push(keyword);
    }
  }

  if (foundKeywords.length > 0) {
    score += 10;
  }

  // Check for foreclosure
  const isForeclosure = FORECLOSURE_KEYWORDS.some(kw => description.includes(kw));
  if (isForeclosure || listing.is_foreclosure) {
    score += 15;
  }

  // Check for inheritance
  const isInheritance = INHERITANCE_KEYWORDS.some(kw => description.includes(kw));
  if (isInheritance || listing.is_inheritance) {
    score += 10;
  }

  // Multiple price changes indicate desperation
  if ((listing.price_changes || 0) >= 2) {
    score += 5;
  }

  // Cap at 25
  return Math.min(25, score);
}

/**
 * Detect keywords and update flags on a listing
 */
function detectKeywords(description) {
  const desc = (description || '').toLowerCase();
  const foundKeywords = URGENT_KEYWORDS.filter(kw => desc.includes(kw));
  const isForeclosure = FORECLOSURE_KEYWORDS.some(kw => desc.includes(kw));
  const isInheritance = INHERITANCE_KEYWORDS.some(kw => desc.includes(kw));

  return {
    has_urgent_keywords: foundKeywords.length > 0,
    urgent_keywords_found: foundKeywords.length > 0 ? foundKeywords.join(', ') : null,
    is_foreclosure: isForeclosure,
    is_inheritance: isInheritance
  };
}

/**
 * Calculate SSI for a single listing
 */
async function calculateSSI(listingId) {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (result.rows.length === 0) return null;

    const listing = result.rows[0];

    // Update days_on_market based on first_seen
    let daysOnMarket = listing.days_on_market || 0;
    if (listing.first_seen) {
      const firstSeen = new Date(listing.first_seen);
      const now = new Date();
      daysOnMarket = Math.floor((now - firstSeen) / (1000 * 60 * 60 * 24));
    }

    // Calculate price drop
    let totalPriceDropPercent = parseFloat(listing.total_price_drop_percent) || 0;
    if (listing.original_price && listing.asking_price && listing.original_price > listing.asking_price) {
      totalPriceDropPercent = ((listing.original_price - listing.asking_price) / listing.original_price) * 100;
    }

    // Detect keywords
    const keywords = detectKeywords(listing.description_snippet);

    // Calculate sub-scores
    const ssi_time_score = calculateTimeScore(daysOnMarket);
    const ssi_price_score = calculatePriceScore(totalPriceDropPercent);
    const ssi_indicator_score = calculateIndicatorScore({
      ...listing,
      ...keywords
    });

    const ssi_score = ssi_time_score + ssi_price_score + ssi_indicator_score;

    // Update listing in DB
    await pool.query(`
      UPDATE listings SET
        days_on_market = $1,
        total_price_drop_percent = $2,
        has_urgent_keywords = $3,
        urgent_keywords_found = $4,
        is_foreclosure = $5,
        is_inheritance = $6,
        ssi_score = $7,
        ssi_time_score = $8,
        ssi_price_score = $9,
        ssi_indicator_score = $10,
        last_seen = CURRENT_DATE
      WHERE id = $11
    `, [
      daysOnMarket,
      totalPriceDropPercent,
      keywords.has_urgent_keywords,
      keywords.urgent_keywords_found,
      keywords.is_foreclosure,
      keywords.is_inheritance,
      ssi_score,
      ssi_time_score,
      ssi_price_score,
      ssi_indicator_score,
      listingId
    ]);

    return {
      listing_id: listingId,
      ssi_score,
      ssi_time_score,
      ssi_price_score,
      ssi_indicator_score,
      days_on_market: daysOnMarket,
      total_price_drop_percent: totalPriceDropPercent,
      keywords: keywords
    };
  } catch (err) {
    logger.error(`Error calculating SSI for listing ${listingId}`, { error: err.message });
    throw err;
  }
}

/**
 * Calculate SSI for all active listings
 */
async function calculateAllSSI() {
  const listings = await pool.query('SELECT id FROM listings WHERE is_active = TRUE');
  const total = listings.rows.length;
  let updated = 0;
  let highStress = 0;

  logger.info(`Calculating SSI for ${total} active listings`);

  for (const listing of listings.rows) {
    try {
      const result = await calculateSSI(listing.id);
      if (result) {
        updated++;
        if (result.ssi_score >= 50) highStress++;
      }
    } catch (err) {
      logger.warn(`SSI calculation failed for listing ${listing.id}`, { error: err.message });
    }
  }

  logger.info(`SSI calculation complete: ${updated}/${total} updated, ${highStress} high-stress listings`);

  return {
    total,
    updated,
    highStress,
    summary: `SSI: ${updated}/${total} listings scored, ${highStress} with SSI >= 50`
  };
}

module.exports = {
  calculateSSI,
  calculateAllSSI,
  calculateTimeScore,
  calculatePriceScore,
  calculateIndicatorScore,
  detectKeywords,
  URGENT_KEYWORDS
};
