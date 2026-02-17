const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * Premium Calculator Routes
 * Calculates actual_premium for complexes that have price data but no premium
 * Formula: premium = ((new_price_sqm - old_price_sqm) / old_price_sqm) * 100
 * 
 * New price estimates per city (average new construction price/sqm in ILS, 2025-2026):
 */
const NEW_CONSTRUCTION_PRICES = {
  'תל אביב': 75000,
  'תל אביב יפו': 75000,
  'רמת גן': 52000,
  'גבעתיים': 55000,
  'בני ברק': 42000,
  'חולון': 40000,
  'בת ים': 38000,
  'ראשון לציון': 42000,
  'פתח תקווה': 40000,
  'הרצליה': 60000,
  'רעננה': 55000,
  'כפר סבא': 42000,
  'נתניה': 38000,
  'רמת השרון': 58000,
  'אור יהודה': 38000,
  'יהוד': 40000,
  'לוד': 28000,
  'רמלה': 26000,
  'ירושלים': 55000,
  'חיפה': 32000,
  'באר שבע': 25000,
  'אשדוד': 30000,
  'אשקלון': 28000,
  'רחובות': 42000,
  'נס ציונה': 42000,
  'קריית אונו': 48000,
  'גבעת שמואל': 50000,
  'הוד השרון': 45000,
  'כפר יונה': 30000,
  'default': 40000
};

/**
 * POST /api/premium/calculate
 * Calculate actual_premium for all complexes with price but no premium
 */
router.post('/calculate', async (req, res) => {
  try {
    // Find complexes with price data but no premium
    const complexes = await pool.query(`
      SELECT id, name, city, accurate_price_sqm, city_avg_price_sqm, actual_premium
      FROM complexes 
      WHERE accurate_price_sqm IS NOT NULL 
        AND accurate_price_sqm > 0
        AND (actual_premium IS NULL OR actual_premium = 0)
      ORDER BY iai_score DESC NULLS LAST
    `);

    let updated = 0;
    const details = [];

    for (const c of complexes.rows) {
      const oldPrice = parseFloat(c.accurate_price_sqm);
      const newPrice = NEW_CONSTRUCTION_PRICES[c.city] || NEW_CONSTRUCTION_PRICES['default'];
      
      if (oldPrice > 0 && newPrice > oldPrice) {
        const premium = Math.round(((newPrice - oldPrice) / oldPrice) * 100);
        const premiumPrice = Math.round(newPrice * 80); // ~80sqm new apartment
        
        await pool.query(
          `UPDATE complexes SET 
            actual_premium = $1, 
            estimated_premium_price = $2,
            price_vs_city_avg = CASE 
              WHEN city_avg_price_sqm > 0 THEN ROUND(((accurate_price_sqm - city_avg_price_sqm)::numeric / city_avg_price_sqm) * 100)
              ELSE 0 
            END,
            updated_at = NOW()
          WHERE id = $3`,
          [premium, premiumPrice, c.id]
        );
        updated++;
        details.push({
          id: c.id, name: c.name, city: c.city,
          old_price_sqm: oldPrice, new_price_sqm: newPrice,
          premium_percent: premium, estimated_apartment_value: premiumPrice
        });
      }
    }

    res.json({
      found: complexes.rows.length,
      updated,
      details
    });

  } catch (err) {
    logger.error('Premium calculation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/premium/recalculate-all
 * Recalculate premiums for ALL complexes with price data (overwrite existing)
 */
router.post('/recalculate-all', async (req, res) => {
  try {
    const complexes = await pool.query(`
      SELECT id, name, city, accurate_price_sqm, city_avg_price_sqm
      FROM complexes 
      WHERE accurate_price_sqm IS NOT NULL AND accurate_price_sqm > 0
    `);

    let updated = 0;
    for (const c of complexes.rows) {
      const oldPrice = parseFloat(c.accurate_price_sqm);
      const newPrice = NEW_CONSTRUCTION_PRICES[c.city] || NEW_CONSTRUCTION_PRICES['default'];
      
      if (oldPrice > 0 && newPrice > 0) {
        const premium = Math.round(((newPrice - oldPrice) / oldPrice) * 100);
        const premiumPrice = Math.round(newPrice * 80);
        
        await pool.query(
          `UPDATE complexes SET actual_premium = $1, estimated_premium_price = $2, updated_at = NOW() WHERE id = $3`,
          [premium, premiumPrice, c.id]
        );
        updated++;
      }
    }

    res.json({ found: complexes.rows.length, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/premium/prices
 * Show new construction price table used for premium calculation
 */
router.get('/prices', (req, res) => {
  const sorted = Object.entries(NEW_CONSTRUCTION_PRICES)
    .filter(([k]) => k !== 'default')
    .sort((a, b) => b[1] - a[1])
    .map(([city, price]) => ({ city, new_price_sqm: price }));
  
  res.json({ 
    prices: sorted, 
    default_price: NEW_CONSTRUCTION_PRICES['default'],
    note: 'Average new construction price per sqm in ILS (2025-2026 estimates)'
  });
});

module.exports = router;
