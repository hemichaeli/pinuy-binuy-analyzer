/**
 * Scan Priority Service v2.0
 * 
 * Calculates scanning priority for each complex based on:
 * - Data completeness (missing fields = higher priority)
 * - IAI score (higher score = higher priority) 
 * - Staleness (older data = higher priority)
 * - Market activity (more listings = higher priority)
 * 
 * Classifies complexes into tiers: HOT, ACTIVE, DORMANT
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

function calculatePSS(complex) {
  let score = 0;
  const components = { alpha: 0, velocity: 0, shield: 0, stealth: 0, stress: 0 };

  const fields = [
    'accurate_price_sqm', 'city_avg_price_sqm', 'actual_premium',
    'num_buildings', 'developer', 'plan_stage', 'neighborhood',
    'signature_percent', 'price_trend', 'news_sentiment'
  ];
  const missingFields = fields.filter(f => !complex[f] || complex[f] === 'unknown');
  components.alpha = Math.round((missingFields.length / fields.length) * 25);
  score += components.alpha;

  const listingCount = parseInt(complex.listing_count) || 0;
  components.velocity = Math.min(25, listingCount * 3);
  score += components.velocity;

  const iai = parseFloat(complex.iai_score) || 0;
  components.shield = Math.min(20, Math.round(iai / 5));
  score += components.shield;

  if (complex.last_perplexity_update) {
    const daysSince = (Date.now() - new Date(complex.last_perplexity_update).getTime()) / 86400000;
    components.stealth = Math.min(15, Math.round(daysSince / 2));
  } else {
    components.stealth = 15;
  }
  score += components.stealth;

  if (complex.has_enforcement_cases) components.stress += 5;
  if (complex.is_receivership) components.stress += 5;
  if (complex.has_bankruptcy_proceedings) components.stress += 5;
  components.stress = Math.min(15, components.stress);
  score += components.stress;

  return { pss: Math.min(100, score), components };
}

async function calculateAllPriorities() {
  const { rows: complexes } = await pool.query(`
    SELECT c.id, c.name, c.city, c.status, c.iai_score,
           c.accurate_price_sqm, c.city_avg_price_sqm, c.actual_premium,
           c.num_buildings, c.developer, c.plan_stage, c.neighborhood,
           c.signature_percent, c.price_trend, c.news_sentiment,
           c.last_perplexity_update, c.developer_status, c.developer_risk_level,
           c.has_enforcement_cases, c.is_receivership, c.has_bankruptcy_proceedings,
           (SELECT COUNT(*) FROM listings l WHERE l.complex_id = c.id AND l.is_active = true) as listing_count
    FROM complexes c
    ORDER BY c.iai_score DESC NULLS LAST
  `);

  const scored = complexes.map(c => {
    const { pss, components } = calculatePSS(c);
    return {
      id: c.id, name: c.name, city: c.city, status: c.status,
      iai_score: parseFloat(c.iai_score) || 0,
      plan_stage: c.plan_stage,
      pss, components,
      listing_count: parseInt(c.listing_count) || 0,
      last_scan: c.last_perplexity_update,
      details: {
        premium_gap: c.actual_premium ? null : 'missing',
        price_sqm: c.accurate_price_sqm ? parseFloat(c.accurate_price_sqm) : null
      }
    };
  });

  scored.sort((a, b) => b.pss - a.pss);

  const hot = scored.slice(0, 50);
  const dormantStatuses = ['unknown', 'cancelled', 'frozen'];
  const dormant = scored.filter(c => 
    dormantStatuses.includes(c.status) || 
    (!c.last_scan && c.iai_score === 0) ||
    c.pss < 10
  );
  const dormantIds = new Set(dormant.map(c => c.id));
  const hotIds = new Set(hot.map(c => c.id));
  const active = scored.filter(c => !hotIds.has(c.id) && !dormantIds.has(c.id));

  logger.info(`[PRIORITY] Calculated: ${hot.length} hot, ${active.length} active, ${dormant.length} dormant`);

  return {
    total: scored.length,
    top_50: hot,
    tiers: {
      hot: { count: hot.length, complexes: hot },
      active: { count: active.length, complexes: active },
      dormant: { count: dormant.length, complexes: dormant }
    },
    coverage: {
      with_premium: scored.filter(c => c.details.price_sqm).length,
      without_premium: scored.filter(c => !c.details.price_sqm).length,
      never_scanned: scored.filter(c => !c.last_scan).length
    }
  };
}

module.exports = { calculateAllPriorities, calculatePSS };
