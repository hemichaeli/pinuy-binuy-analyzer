/**
 * Pricing Accuracy Routes - Phase 4.5
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
    service: 'Pricing Accuracy - Multi-Source Pricing',
    available: !!service,
    sources: ['nadlan_db', 'yad2_sold', 'cbs_index', 'boi_mortgage'],
    regionsConfigured: service ? Object.keys(service.CBS_REGIONS).length : 0,
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  });
});

// GET /api/pricing/city/:city
router.get('/city/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const result = await service.getCityPricingStats(city);
    res.json(result);
  } catch (err) {
    logger.error('City pricing failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/benchmark/:complexId
router.post('/benchmark/:complexId', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const benchmark = await service.calculateAccurateBenchmark(complexResult.rows[0], pool);

    // Update database
    if (benchmark.estimatedPricePerSqm > 0) {
      await pool.query(`
        UPDATE complexes SET 
          accurate_price_sqm = $1, price_confidence_score = $2, price_trend = $3,
          estimated_premium_price = $4, price_last_updated = NOW(), price_sources = $5
        WHERE id = $6
      `, [benchmark.estimatedPricePerSqm, benchmark.confidenceScore, benchmark.priceTrend,
          benchmark.estimatedPremiumPrice, JSON.stringify(benchmark.sources), complexId]);
    }

    res.json(benchmark);
  } catch (err) {
    logger.error('Benchmark calculation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/sold/:city
router.get('/sold/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const { street, rooms } = req.query;
    const result = await service.getYad2SoldPrices(city, street || null, rooms ? parseInt(rooms) : null);
    res.json(result);
  } catch (err) {
    logger.error('Sold prices fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/index/:city
router.get('/index/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const result = await service.getCBSPriceIndex(city);
    res.json(result);
  } catch (err) {
    logger.error('CBS index fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/mortgage
router.get('/mortgage', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.query;
    const result = await service.getBOIMortgageStats(city || null);
    res.json(result);
  } catch (err) {
    logger.error('BOI mortgage stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/compare/:city
router.get('/compare/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city } = req.params;
    const result = await service.compareComplexPrices(city, pool);
    res.json(result);
  } catch (err) {
    logger.error('Price comparison failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/batch
router.post('/batch', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });

  try {
    const { city, staleOnly } = req.body;
    res.json({ message: 'Batch pricing update started', params: { city, staleOnly }, note: 'Running in background' });

    (async () => {
      try {
        await service.batchUpdatePricing(pool, { city, staleOnly });
      } catch (err) {
        logger.error('Background batch pricing failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/top-opportunities
router.get('/top-opportunities', async (req, res) => {
  try {
    const { city, limit } = req.query;
    let query = `
      SELECT c.*, 
        COALESCE(c.accurate_price_sqm, c.city_avg_price_sqm) as current_price,
        c.estimated_premium_price,
        CASE WHEN c.accurate_price_sqm > 0 AND c.estimated_premium_price > 0 
          THEN ROUND(((c.estimated_premium_price::float / c.accurate_price_sqm) - 1) * 100)
          ELSE NULL END as potential_return
      FROM complexes c
      WHERE c.estimated_premium_price > 0 AND c.accurate_price_sqm > 0
    `;
    const params = [];
    let paramIndex = 1;
    if (city) { query += ` AND c.city = $${paramIndex++}`; params.push(city); }
    query += ` ORDER BY potential_return DESC NULLS LAST LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 20);

    const result = await pool.query(query, params);
    res.json({
      total: result.rows.length,
      opportunities: result.rows.map(c => ({
        id: c.id, name: c.name, city: c.city, status: c.status,
        currentPriceSqm: c.current_price, estimatedPremiumSqm: c.estimated_premium_price,
        potentialReturn: c.potential_return, priceConfidence: c.price_confidence_score,
        iaiScore: c.iai_score, ssiScore: c.ssi_score
      }))
    });
  } catch (err) {
    logger.error('Top opportunities query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
