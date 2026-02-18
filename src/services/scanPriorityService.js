const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Scan Priority Service - QUANTUM Intelligence Layer
 * 
 * Calculates Priority Scan Score (PSS) for every complex.
 * Ranks by: return potential x certainty x speed / visibility
 * 
 * The golden formula for investors:
 *   "Maximum upside, minimum time, high certainty, before the market catches on"
 * 
 * TIERS:
 *   Tier 1 (HOT)     - Top 50 by PSS  -> FULL mode weekly
 *   Tier 2 (ACTIVE)  - Next 200       -> STANDARD mode bi-weekly  
 *   Tier 3 (DORMANT) - Remaining      -> FAST mode monthly
 * 
 * Auto-promotion: complexes move up tiers when events trigger
 */

// Plan stage scoring - how close to money
const PLAN_STAGE_SCORES = {
  // Advanced stages (investor can realize gains sooner)
  'בביצוע': 15, 'בבנייה': 15, 'construction': 15,
  'היתר': 14, 'היתר בנייה': 14, 'permit': 14, 'בהליכי רישוי': 13, 'רישוי': 13,
  'היתר בנייה צפוי': 12,
  // Approved - high certainty, 1-2 years to permit
  'אושרה': 11, 'מאושרת': 11, 'תוכנית מאושרת': 11,
  'קיבלה תוקף': 11, 'תוקף': 11, 'תב"ע קיבלה תוקף': 11,
  // Deposited - good momentum
  'הופקדה': 8, 'אושרה להפקדה': 7,
  // Tender completed - developer chosen
  'זכייה במכרז דיירים': 9, 'מכרז דיירים': 8, 'נבחרה יזמה': 8,
  // Early stages
  'הוכרזה': 5, 'הומלצה להפקדה': 6,
  'בתכנון': 3, 'בשלבי תכנון': 3, 'תכנון': 3,
  'הכנת תב"ע': 3, 'בתכנון - שלב מוקדם': 2,
  // Stalled
  'הוקפאה': 1,
};

/**
 * Normalize messy plan_stage strings to a score
 * Uses fuzzy matching for enrichment-generated verbose stages
 */
function scorePlanStage(stage) {
  if (!stage) return 0;
  const s = stage.trim();
  
  // Direct match
  if (PLAN_STAGE_SCORES[s] !== undefined) return PLAN_STAGE_SCORES[s];
  
  // Fuzzy match - check if stage contains key phrases
  const lower = s.toLowerCase();
  if (lower.includes('בביצוע') || lower.includes('בבנייה')) return 15;
  if (lower.includes('היתר')) return 14;
  if (lower.includes('רישוי')) return 13;
  if (lower.includes('תוקף')) return 11;
  if (lower.includes('אושרה') || lower.includes('מאושרת')) return 11;
  if (lower.includes('הופקדה') || lower.includes('להפקדה')) return 8;
  if (lower.includes('מכרז') || lower.includes('זכייה')) return 9;
  if (lower.includes('הוכרזה')) return 5;
  if (lower.includes('תכנון') || lower.includes('תכנית')) return 3;
  if (lower.includes('הוקפאה') || lower.includes('הקפאה')) return 1;
  
  return 2; // Unknown but exists = minimal score
}

/**
 * Calculate Priority Scan Score (PSS) for a complex
 * Returns 0-100, higher = more attractive for investors
 * 
 * Components:
 *   ALPHA    (30%) - Return potential: premium gap, multiplier
 *   VELOCITY (25%) - Speed to realization: plan stage, signatures
 *   SHIELD   (20%) - Risk reduction: developer quality, sentiment
 *   STEALTH  (15%) - Under the radar: low listing activity, not mainstream
 *   STRESS   (10%) - Motivated sellers present: SSI signals
 */
function calculatePSS(complex) {
  const scores = { alpha: 0, velocity: 0, shield: 0, stealth: 0, stress: 0 };
  const details = {};

  // ===== ALPHA (30 pts) - Return Potential =====
  const premiumGap = parseFloat(complex.premium_gap) || 0;
  const multiplier = parseFloat(complex.multiplier) || 1;
  const actualPremium = parseFloat(complex.actual_premium);
  
  // Premium gap: 0-100% maps to 0-20 pts
  scores.alpha += Math.min(20, premiumGap * 0.2);
  details.premium_gap = premiumGap;
  
  // Multiplier bonus: 2x=2pts, 3x=5pts, 4x+=10pts
  if (multiplier >= 4) scores.alpha += 10;
  else if (multiplier >= 3) scores.alpha += 5 + ((multiplier - 3) * 5);
  else if (multiplier >= 2) scores.alpha += 2 + ((multiplier - 2) * 3);
  details.multiplier = multiplier;

  // Actual premium reality check - if actual premium exists and is LOW, 
  // that means current prices haven't caught up = OPPORTUNITY
  if (actualPremium !== null && !isNaN(actualPremium)) {
    if (actualPremium < 20) scores.alpha += 5;      // Price barely moved
    else if (actualPremium < 40) scores.alpha += 3;  // Some movement
    else if (actualPremium < 60) scores.alpha += 1;  // Moderate
    // Above 60% = market already priced in much of the premium
    details.actual_premium = actualPremium;
  }

  // Cap at 30
  scores.alpha = Math.min(30, scores.alpha);

  // ===== VELOCITY (25 pts) - Speed to Realization =====
  const stageScore = scorePlanStage(complex.plan_stage);
  scores.velocity += stageScore; // 0-15
  details.plan_stage = complex.plan_stage;
  details.stage_score = stageScore;

  // Signature progress (0-10 pts)
  const sigPct = parseFloat(complex.signature_percent) || 0;
  if (sigPct >= 80) scores.velocity += 10;
  else if (sigPct >= 60) scores.velocity += 7;
  else if (sigPct >= 40) scores.velocity += 4;
  else if (sigPct > 0) scores.velocity += 2;
  details.signature_percent = sigPct;

  scores.velocity = Math.min(25, scores.velocity);

  // ===== SHIELD (20 pts) - Risk Reduction =====
  // Developer strength
  const devStrength = complex.developer_strength;
  if (devStrength === 'strong') scores.shield += 8;
  else if (devStrength === 'medium') scores.shield += 4;
  else if (devStrength === 'weak') scores.shield += 1;

  // Developer risk level
  const riskLevel = complex.developer_risk_level;
  if (riskLevel === 'low') scores.shield += 5;
  else if (riskLevel === 'medium' || riskLevel === 'moderate') scores.shield += 3;
  else if (riskLevel === 'high') scores.shield += 0;

  // News sentiment
  const sentiment = complex.news_sentiment;
  if (sentiment === 'positive') scores.shield += 5;
  else if (sentiment === 'neutral') scores.shield += 3;
  else if (sentiment === 'mixed') scores.shield += 2;
  else if (sentiment === 'negative') scores.shield += 0;
  
  // Negative news penalty
  if (complex.has_negative_news) scores.shield -= 3;

  scores.shield = Math.max(0, Math.min(20, scores.shield));
  details.developer_strength = devStrength;
  details.risk_level = riskLevel;
  details.sentiment = sentiment;

  // ===== STEALTH (15 pts) - Under the Radar =====
  // Fewer listings = less market attention = more opportunity
  const activeListings = parseInt(complex.active_listings) || 0;
  if (activeListings === 0) scores.stealth += 10;       // No one's watching
  else if (activeListings <= 3) scores.stealth += 8;     // Low visibility
  else if (activeListings <= 10) scores.stealth += 4;    // Some activity
  else scores.stealth += 1;                               // Crowded
  
  // Few transactions = market hasn't discovered it
  const txCount = parseInt(complex.transactions_count) || 0;
  if (txCount === 0) scores.stealth += 5;
  else if (txCount <= 3) scores.stealth += 3;
  else scores.stealth += 1;

  scores.stealth = Math.min(15, scores.stealth);
  details.active_listings = activeListings;
  details.transactions = txCount;

  // ===== STRESS (10 pts) - Motivated Sellers =====
  const avgSsi = parseFloat(complex.avg_ssi) || 0;
  const maxSsi = parseInt(complex.max_ssi) || 0;
  
  if (maxSsi >= 70) scores.stress += 5;
  else if (maxSsi >= 50) scores.stress += 3;
  else if (maxSsi >= 30) scores.stress += 2;
  else if (avgSsi > 0) scores.stress += 1;

  // Has distress indicators at complex level
  if (complex.has_enforcement_cases) scores.stress += 2;
  if (complex.is_receivership) scores.stress += 3;
  if (complex.has_bankruptcy_proceedings) scores.stress += 2;

  scores.stress = Math.min(10, scores.stress);
  details.avg_ssi = avgSsi;
  details.max_ssi = maxSsi;

  // ===== TOTAL PSS =====
  const pss = Math.round(scores.alpha + scores.velocity + scores.shield + scores.stealth + scores.stress);

  return {
    pss: Math.min(100, pss),
    components: scores,
    details,
    tier: pss >= 45 ? 1 : pss >= 25 ? 2 : 3,
    tier_label: pss >= 45 ? 'HOT' : pss >= 25 ? 'ACTIVE' : 'DORMANT'
  };
}

/**
 * Scan all complexes, calculate PSS, return ranked list with tiers
 */
async function calculateAllPriorities() {
  const result = await pool.query(`
    SELECT 
      c.id, c.name, c.city, c.slug, c.status,
      c.iai_score, c.multiplier,
      c.planned_units, c.existing_units,
      c.theoretical_premium_min, c.theoretical_premium_max,
      c.actual_premium, c.premium_gap,
      c.plan_stage, c.plan_number,
      c.developer, c.developer_strength, c.developer_status, c.developer_risk_level,
      c.news_sentiment, c.has_negative_news,
      c.accurate_price_sqm, c.city_avg_price_sqm, c.price_trend,
      c.signature_percent, c.signature_source, c.signature_confidence,
      c.num_buildings, c.neighborhood, c.address,
      c.has_enforcement_cases, c.is_receivership, c.has_bankruptcy_proceedings,
      c.price_last_updated,
      COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE) as active_listings,
      COUNT(DISTINCT t.id) as transactions_count,
      AVG(l.ssi_score) FILTER (WHERE l.is_active = TRUE) as avg_ssi,
      MAX(l.ssi_score) FILTER (WHERE l.is_active = TRUE) as max_ssi
    FROM complexes c
    LEFT JOIN listings l ON l.complex_id = c.id
    LEFT JOIN transactions t ON t.complex_id = c.id
    GROUP BY c.id
    ORDER BY c.iai_score DESC NULLS LAST
  `);

  const ranked = result.rows.map(complex => {
    const priority = calculatePSS(complex);
    return {
      id: complex.id,
      name: complex.name,
      city: complex.city,
      slug: complex.slug,
      iai_score: complex.iai_score,
      pss: priority.pss,
      tier: priority.tier,
      tier_label: priority.tier_label,
      components: priority.components,
      details: priority.details,
      plan_stage: complex.plan_stage,
      developer: complex.developer,
      premium_gap: complex.premium_gap,
      multiplier: complex.multiplier,
      active_listings: complex.active_listings,
      price_last_updated: complex.price_last_updated,
      last_enriched_days_ago: complex.price_last_updated 
        ? Math.round((Date.now() - new Date(complex.price_last_updated).getTime()) / 86400000)
        : null
    };
  });

  // Sort by PSS descending
  ranked.sort((a, b) => b.pss - a.pss);

  const tiers = {
    hot: ranked.filter(r => r.tier === 1),
    active: ranked.filter(r => r.tier === 2),
    dormant: ranked.filter(r => r.tier === 3)
  };

  return {
    total: ranked.length,
    tiers: {
      hot: { count: tiers.hot.length, mode: 'full', frequency: 'weekly', complexes: tiers.hot },
      active: { count: tiers.active.length, mode: 'standard', frequency: 'bi-weekly', complexes: tiers.active },
      dormant: { count: tiers.dormant.length, mode: 'fast', frequency: 'monthly', complexes: tiers.dormant }
    },
    cost_estimate: {
      initial_scan: {
        hot: { count: tiers.hot.length, cost_per: 1.23, total: Math.round(tiers.hot.length * 1.23 * 100) / 100 },
        active: { count: tiers.active.length, cost_per: 0.26, total: Math.round(tiers.active.length * 0.26 * 100) / 100 },
        dormant: { count: tiers.dormant.length, cost_per: 0.15, total: Math.round(tiers.dormant.length * 0.15 * 100) / 100 }
      },
      monthly: {
        hot_weekly: Math.round(tiers.hot.length * 1.23 * 4 * 100) / 100,
        active_biweekly: Math.round(tiers.active.length * 0.26 * 2 * 100) / 100,
        dormant_monthly: Math.round(tiers.dormant.length * 0.15 * 100) / 100
      }
    },
    top_50: ranked.slice(0, 50)
  };
}

/**
 * Get IDs for a specific tier
 */
async function getTierComplexIds(tier = 1, limit = 50) {
  const all = await calculateAllPriorities();
  const tierKey = tier === 1 ? 'hot' : tier === 2 ? 'active' : 'dormant';
  return all.tiers[tierKey].complexes.slice(0, limit).map(c => c.id);
}

module.exports = { calculatePSS, calculateAllPriorities, getTierComplexIds, scorePlanStage };
