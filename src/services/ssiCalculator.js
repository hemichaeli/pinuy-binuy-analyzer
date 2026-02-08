const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * SSI (Seller Stress Index) Calculator
 * Formula: SSI = ssi_time_score + ssi_price_score + ssi_indicator_score
 * Max: 100 (time: 0-40, price: 0-35, indicator: 0-25)
 */

// Urgent keywords to detect in Hebrew listings
const URGENT_KEYWORDS = {
  high: ['דחוף', 'כינוס נכסים', 'הוצאה לפועל', 'הוצל"פ', 'חייב למכור', 'מכירה מהירה'],
  medium: ['הזדמנות', 'מתחת למחיר', 'מחיר סופי', 'ללא מתווכים', 'ללא תיווך', 'מכירה מיידית'],
  low: ['ירושה', 'גירושין', 'מעבר דירה', 'עוזבים את הארץ']
};

/**
 * Time on market score (0-40)
 * Longer time = more seller stress
 */
function calculateTimeScore(daysOnMarket) {
  if (!daysOnMarket || daysOnMarket < 30) return 0;
  if (daysOnMarket < 60) return 10;
  if (daysOnMarket < 90) return 20;
  if (daysOnMarket < 120) return 30;
  return 40; // 120+ days
}

/**
 * Price drop score (0-35)
 * Bigger drops = more seller stress
 */
function calculatePriceScore(totalPriceDropPercent) {
  if (!totalPriceDropPercent || totalPriceDropPercent <= 0) return 0;
  if (totalPriceDropPercent <= 5) return 10;
  if (totalPriceDropPercent <= 10) return 20;
  if (totalPriceDropPercent <= 15) return 30;
  return 35; // 15%+ drop
}

/**
 * Stress indicator score (0-25)
 * Based on keywords, inheritance, foreclosure, multiple price drops
 */
function calculateIndicatorScore(listing) {
  let score = 0;

  // Urgent keywords in description: +10
  if (listing.has_urgent_keywords) {
    score += 10;
  } else if (listing.description_snippet) {
    const desc = listing.description_snippet;
    const allUrgent = [...URGENT_KEYWORDS.high, ...URGENT_KEYWORDS.medium];
    for (const keyword of allUrgent) {
      if (desc.includes(keyword)) {
        score += 10;
        break;
      }
    }
  }

  // Inheritance: +10
  if (listing.is_inheritance) {
    score += 10;
  } else if (listing.description_snippet) {
    if (listing.description_snippet.includes('ירושה')) {
      score += 10;
    }
  }

  // Foreclosure: +15 (replaces inheritance if both, since cap is 25)
  if (listing.is_foreclosure) {
    score += 15;
  } else if (listing.description_snippet) {
    if (listing.description_snippet.includes('כינוס נכסים') || listing.description_snippet.includes('כינוס')) {
      score += 15;
    }
  }

  // 2+ price drops: +5
  if (listing.price_changes && listing.price_changes >= 2) {
    score += 5;
  }

  return Math.min(25, score);
}

/**
 * Detect urgent keywords in a text string
 */
function detectUrgentKeywords(text) {
  if (!text) return { found: false, keywords: [] };
  const found = [];
  const allKeywords = [...URGENT_KEYWORDS.high, ...URGENT_KEYWORDS.medium, ...URGENT_KEYWORDS.low];
  for (const keyword of allKeywords) {
    if (text.includes(keyword)) found.push(keyword);
  }
  return { found: found.length > 0, keywords: found };
}

/**
 * Calculate SSI for a single listing
 */
async function calculateSSI(listingId) {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (result.rows.length === 0) return null;

    const listing = result.rows[0];

    // Auto-detect keywords if description exists and hasn't been scanned
    if (listing.description_snippet && !listing.has_urgent_keywords) {
      const detection = detectUrgentKeywords(listing.description_snippet);
      if (detection.found) {
        await pool.query(
          'UPDATE listings SET has_urgent_keywords = TRUE, urgent_keywords_found = $1 WHERE id = $2',
          [detection.keywords.join(', '), listingId]
        );
        listing.has_urgent_keywords = true;
        listing.urgent_keywords_found = detection.keywords.join(', ');
      }
    }

    const timeScore = calculateTimeScore(listing.days_on_market || 0);
    const priceScore = calculatePriceScore(parseFloat(listing.total_price_drop_percent) || 0);
    const indicatorScore = calculateIndicatorScore(listing);
    const ssi = Math.min(100, timeScore + priceScore + indicatorScore);

    await pool.query(`
      UPDATE listings SET 
        ssi_score = $1, ssi_time_score = $2, ssi_price_score = $3,
        ssi_indicator_score = $4, updated_at = NOW()
      WHERE id = $5
    `, [ssi, timeScore, priceScore, indicatorScore, listingId]);

    return {
      listing_id: listingId,
      ssi_score: ssi,
      time_score: timeScore,
      price_score: priceScore,
      indicator_score: indicatorScore,
      category: ssi >= 70 ? 'very_stressed' : ssi >= 50 ? 'stressed' : ssi >= 30 ? 'moderate' : 'low_stress'
    };
  } catch (err) {
    logger.error(`Error calculating SSI for listing ${listingId}`, { error: err.message });
    throw err;
  }
}

/**
 * Calculate SSI for all active listings
 * Returns summary of results
 */
async function calculateAllSSI() {
  logger.info('Starting SSI calculation for all active listings...');
  const listings = await pool.query('SELECT id FROM listings WHERE is_active = TRUE');
  
  const results = { total: listings.rows.length, calculated: 0, errors: 0, stressed: 0, very_stressed: 0 };
  
  for (const listing of listings.rows) {
    try {
      const result = await calculateSSI(listing.id);
      if (result) {
        results.calculated++;
        if (result.ssi_score >= 70) results.very_stressed++;
        else if (result.ssi_score >= 50) results.stressed++;
      }
    } catch (err) {
      results.errors++;
      logger.warn(`SSI calculation failed for listing ${listing.id}`, { error: err.message });
    }
  }

  logger.info(`SSI calculation complete: ${results.calculated}/${results.total} calculated, ${results.very_stressed} very stressed, ${results.stressed} stressed, ${results.errors} errors`);
  return results;
}

module.exports = {
  calculateSSI,
  calculateAllSSI,
  calculateTimeScore,
  calculatePriceScore,
  calculateIndicatorScore,
  detectUrgentKeywords,
  URGENT_KEYWORDS
};
