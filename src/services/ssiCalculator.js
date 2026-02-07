const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * SSI (Seller Stress Index) Calculator
 * Formula: SSI = time_score + price_score + indicator_score
 * Range: 0-100
 */

// Urgent keywords to detect in Hebrew listings
const URGENT_KEYWORDS = {
  high: ['דחוף', 'כינוס נכסים', 'הוצאה לפועל', 'הוצל"פ'],
  medium: ['הזדמנות', 'מחיר סופי', 'ללא מתווכים', 'ללא תיווך', 'מכירה מיידית'],
  low: ['ירושה', 'גירושין', 'מעבר דירה', 'עוזבים את הארץ']
};

function calculateTimeScore(daysOnMarket) {
  if (daysOnMarket <= 30) return 0;
  if (daysOnMarket <= 60) return 10;
  if (daysOnMarket <= 90) return 20;
  return 30; // 90+ days
}

function calculatePriceScore(totalPriceDropPercent) {
  if (!totalPriceDropPercent || totalPriceDropPercent <= 0) return 0;
  if (totalPriceDropPercent <= 5) return 10;
  if (totalPriceDropPercent <= 10) return 20;
  if (totalPriceDropPercent <= 15) return 30;
  return 40; // 15%+ drop
}

function calculateIndicatorScore(listing) {
  let score = 0;
  
  if (listing.has_urgent_keywords) score += 10;
  if (listing.is_foreclosure) score += 30;
  if (listing.is_inheritance) score += 15;
  
  if (listing.description_snippet) {
    const desc = listing.description_snippet.toLowerCase();
    
    for (const keyword of URGENT_KEYWORDS.high) {
      if (desc.includes(keyword)) { score += 10; break; }
    }
    for (const keyword of URGENT_KEYWORDS.medium) {
      if (desc.includes(keyword)) { score += 5; break; }
    }
    for (const keyword of URGENT_KEYWORDS.low) {
      if (desc.includes(keyword)) { score += 5; break; }
    }
  }
  
  return Math.min(30, score);
}

function detectUrgentKeywords(text) {
  if (!text) return { found: false, keywords: [] };
  const lowerText = text.toLowerCase();
  const found = [];
  const allKeywords = [...URGENT_KEYWORDS.high, ...URGENT_KEYWORDS.medium, ...URGENT_KEYWORDS.low];
  for (const keyword of allKeywords) {
    if (lowerText.includes(keyword)) found.push(keyword);
  }
  return { found: found.length > 0, keywords: found };
}

async function calculateSSI(listingId) {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (result.rows.length === 0) return null;
    
    const listing = result.rows[0];
    const timeScore = calculateTimeScore(listing.days_on_market || 0);
    const priceScore = calculatePriceScore(listing.total_price_drop_percent || 0);
    const indicatorScore = calculateIndicatorScore(listing);
    const ssi = Math.min(100, timeScore + priceScore + indicatorScore);
    
    await pool.query(`
      UPDATE listings SET 
        ssi_score = $1, ssi_time_score = $2, ssi_price_score = $3,
        ssi_indicator_score = $4, updated_at = NOW()
      WHERE id = $5
    `, [ssi, timeScore, priceScore, indicatorScore, listingId]);
    
    return {
      ssi_score: ssi, time_score: timeScore, price_score: priceScore,
      indicator_score: indicatorScore,
      category: ssi >= 70 ? 'very_stressed' : ssi >= 50 ? 'stressed' : ssi >= 30 ? 'normal' : 'strong'
    };
  } catch (err) {
    logger.error(`Error calculating SSI for listing ${listingId}`, { error: err.message });
    throw err;
  }
}

async function calculateAllSSI() {
  const listings = await pool.query('SELECT id FROM listings WHERE is_active = TRUE');
  const results = [];
  for (const listing of listings.rows) {
    try {
      const result = await calculateSSI(listing.id);
      results.push({ id: listing.id, ...result });
    } catch (err) {
      results.push({ id: listing.id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  calculateSSI, calculateAllSSI, calculateTimeScore,
  calculatePriceScore, calculateIndicatorScore, detectUrgentKeywords, URGENT_KEYWORDS
};
