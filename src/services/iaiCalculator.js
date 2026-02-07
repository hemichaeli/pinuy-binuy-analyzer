const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * IAI (Investment Attractiveness Index) Calculator
 * Formula: IAI = (theoretical_premium - actual_premium) * certainty_factor * yield_factor
 * Range: 0-100
 */

// Theoretical premium ranges by planning status
const PREMIUM_TABLE = {
  'before_declaration': { min: 0, max: 0 },
  'declared': { min: 5, max: 15 },
  'developer_selected': { min: 15, max: 25 },
  'submitted': { min: 20, max: 35 },
  'pre_deposit': { min: 20, max: 35 },
  'deposited': { min: 35, max: 50 },
  'approved': { min: 50, max: 70 },
  'permit': { min: 70, max: 90 },
  'construction': { min: 90, max: 100 },
  'planning': { min: 5, max: 15 },
  'unknown': { min: 0, max: 0 }
};

// Developer strength ratings
const STRONG_DEVELOPERS = [
  'שיכון ובינוי', 'אפריקה ישראל', 'אאורה', 'אלקטרה', 'ב.ס.ר',
  'תדהר', 'קרסו', 'אלמוג', 'ICR'
];
const WEAK_DEVELOPERS = ['unknown', '', null];

function getTheoreticalPremium(status) {
  return PREMIUM_TABLE[status] || PREMIUM_TABLE['unknown'];
}

function calculateCertaintyFactor(complex) {
  let factor = 1.0;
  
  if (complex.developer_strength === 'strong' || 
      STRONG_DEVELOPERS.some(d => complex.developer && complex.developer.includes(d))) {
    factor += 0.15;
  } else if (complex.developer_strength === 'weak' || 
             WEAK_DEVELOPERS.includes(complex.developer)) {
    factor -= 0.15;
  }
  
  if (complex.signature_percent) {
    if (complex.signature_percent >= 90) factor += 0.15;
    else if (complex.signature_percent < 67) factor -= 0.25;
  }
  
  if (['approved', 'permit', 'construction'].includes(complex.status)) {
    factor += 0.2;
  }
  
  return Math.max(0.5, Math.min(1.5, factor));
}

function calculateYieldFactor(complex) {
  let factor = 1.0;
  if (complex.multiplier && complex.multiplier > 3) {
    factor += 0.2;
  }
  return Math.max(0.5, Math.min(1.5, factor));
}

async function calculateIAI(complexId) {
  try {
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return null;
    
    const complex = complexResult.rows[0];
    const premium = getTheoreticalPremium(complex.status);
    const theoreticalPremiumMid = (premium.min + premium.max) / 2;
    const actualPremium = complex.actual_premium || 0;
    const premiumGap = Math.max(0, theoreticalPremiumMid - actualPremium);
    const gapPoints = Math.min(50, premiumGap);
    const certaintyFactor = calculateCertaintyFactor(complex);
    const yieldFactor = calculateYieldFactor(complex);
    const iai = Math.round(Math.min(100, gapPoints * certaintyFactor * yieldFactor));
    
    await pool.query(`
      UPDATE complexes SET 
        theoretical_premium_min = $1, theoretical_premium_max = $2,
        premium_gap = $3, certainty_factor = $4, yield_factor = $5,
        iai_score = $6, updated_at = NOW()
      WHERE id = $7
    `, [premium.min, premium.max, premiumGap, certaintyFactor, yieldFactor, iai, complexId]);
    
    logger.info(`IAI calculated for complex ${complexId}: ${iai}`, {
      premiumGap, certaintyFactor, yieldFactor
    });
    
    return {
      iai_score: iai, premium_gap: premiumGap,
      certainty_factor: certaintyFactor, yield_factor: yieldFactor,
      theoretical_premium: { min: premium.min, max: premium.max },
      actual_premium: actualPremium
    };
  } catch (err) {
    logger.error(`Error calculating IAI for complex ${complexId}`, { error: err.message });
    throw err;
  }
}

async function calculateAllIAI() {
  const complexes = await pool.query('SELECT id FROM complexes');
  const results = [];
  for (const complex of complexes.rows) {
    try {
      const result = await calculateIAI(complex.id);
      results.push({ id: complex.id, ...result });
    } catch (err) {
      results.push({ id: complex.id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  calculateIAI, calculateAllIAI, getTheoreticalPremium,
  calculateCertaintyFactor, calculateYieldFactor, PREMIUM_TABLE, STRONG_DEVELOPERS
};
