/**
 * Pricing Accuracy Routes - Phase 4.5
 * API endpoints for accurate pricing data
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getPricingService() {
  try {
    return require('../services/pricingAccuracyService');
  } catch (e) {
    logger.warn('Pricing accuracy service not available', { error: e.message });
    return null;
  }
}

// GET /api/pricing/status
router.get('/status', (req, res) => {
  const service = getPricingService();
  res.json({
    version: '4.5.0',
    service: 'Pricing Accuracy',
    available: !!service,
    sources: [
      { name: 'nadlan.gov.il', description: 'רשות המסים - עסקאות בפועל', weight: 0.4 },
      { name: 'yad2_sold', description: 'מחירי מכירה מ-yad2', weight: 0.3 },
      { name: 'cbs', description: 'מדד מחירי דירות הלמ"ס', weight: 0.2 },
      { name: 'boi', description: 'נתוני משכנתאות בנק ישראל', weight: 0.1 }
    ],
    regions: service ? Object.keys(service.CBS_REGIONS) : [],
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  });
});

// GET /api/pricing/city/:city - Get comprehensive city stats
router.get('/city/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const stats = await service.getCityPricingStats(city, pool);
    res.json(stats);
  } catch (err) {
    logger.error('City pricing stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/benchmark/:complexId - Calculate accurate benchmark
router.post('/benchmark/:complexId', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    
    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const benchmark = await service.calculateAccurateBenchmark(complexResult.rows[0], pool);
    res.json(benchmark);
  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/sold/:city - Get Yad2 sold prices
router.get('/sold/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const { street, rooms } = req.query;
    const prices = await service.getYad2SoldPrices(city, street || null, rooms ? parseInt(rooms) : null);
    res.json(prices);
  } catch (err) {
    logger.error('Sold prices fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/index/:city - Get CBS price index
router.get('/index/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const index = await service.getCBSPriceIndex(city);
    res.json(index);
  } catch (err) {
    logger.error('CBS index fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/mortgage - Get BOI mortgage stats
router.get('/mortgage', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.query;
    const stats = await service.getBOIMortgageStats(city || null);
    res.json(stats);
  } catch (err) {
    logger.error('Mortgage stats fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/compare/:city - Compare complex prices in city
router.get('/compare/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const comparison = await service.compareComplexPrices(city, pool);
    res.json(comparison);
  } catch (err) {
    logger.error('Price comparison failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/batch - Batch update pricing
router.post('/batch', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city, limit, staleOnly } = req.body;

    res.json({
      message: 'Batch pricing update started',
      params: { city, limit, staleOnly },
      note: 'Running in background'
    });

    (async () => {
      try {
        const results = await service.batchUpdatePricing(pool, { city, limit, staleOnly });
        logger.info('Manual batch pricing complete', results);
      } catch (err) {
        logger.error('Background batch pricing failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/top-opportunities - Get best price-to-value opportunities
router.get('/top-opportunities', async (req, res) => {
  try {
    const { city, limit } = req.query;

    let query = `
      SELECT c.*, 
        CASE WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0
          THEN ROUND(((c.city_avg_price_sqm - c.accurate_price_sqm) / c.city_avg_price_sqm * 100)::numeric, 1)
          ELSE NULL
        END as discount_percent
      FROM complexes c
      WHERE c.accurate_price_sqm IS NOT NULL
        AND c.iai_score >= 50
    `;
    const params = [];
    let paramIndex = 1;

    if (city) {
      query += ` AND c.city = $${paramIndex++}`;
      params.push(city);
    }

    query += ` ORDER BY discount_percent DESC NULLS LAST, c.iai_score DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 20);

    const result = await pool.query(query, params);

    res.json({
      total: result.rows.length,
      opportunities: result.rows.map(c => ({
        id: c.id,
        name: c.name,
        city: c.city,
        address: c.address,
        pricePerSqm: c.accurate_price_sqm,
        cityAvgPrice: c.city_avg_price_sqm,
        discountPercent: c.discount_percent,
        estimatedPremium: c.estimated_premium_price,
        iaiScore: c.iai_score,
        status: c.status,
        confidence: c.price_confidence_score
      }))
    });
  } catch (err) {
    logger.error('Top opportunities query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
