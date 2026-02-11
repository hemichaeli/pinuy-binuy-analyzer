/**
 * Pricing Accuracy Routes - Phase 4.5
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getPricingService() {
  try { return require('../services/pricingAccuracyService'); }
  catch (e) { logger.warn('Pricing service not available'); return null; }
}

// GET /api/pricing/status
router.get('/status', (req, res) => {
  const service = getPricingService();
  res.json({
    version: '4.5.0', service: 'Pricing Accuracy', available: !!service,
    sources: ['nadlan.gov.il transactions', 'Yad2 sold prices', 'CBS price index', 'BOI mortgage stats'],
    regions: service ? Object.keys(service.CBS_REGIONS) : [],
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  });
});

// GET /api/pricing/city/:city
router.get('/city/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });
  try {
    const result = await service.getCityPricingStats(req.params.city);
    res.json(result);
  } catch (err) {
    logger.error('City pricing stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/benchmark/:complexId
router.post('/benchmark/:complexId', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });
  try {
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const benchmark = await service.calculateAccurateBenchmark(complexResult.rows[0], pool);

    if (benchmark.weightedPricePerSqm) {
      await pool.query(`
        UPDATE complexes SET accurate_price_sqm = $1, price_confidence_score = $2, price_trend = $3,
          estimated_premium_price = $4, price_last_updated = NOW(), price_sources = $5
        WHERE id = $6
      `, [benchmark.weightedPricePerSqm, benchmark.confidenceScore, benchmark.priceTrend,
          benchmark.estimatedPremiumPrice, JSON.stringify(benchmark.sources), req.params.complexId]);
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
    const { street, rooms } = req.query;
    const result = await service.getYad2SoldPrices(req.params.city, street, rooms ? parseInt(rooms) : null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/index/:city
router.get('/index/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });
  try {
    const result = await service.getCBSPriceIndex(req.params.city);
    res.json(result);
  } catch (err) {
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
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/compare/:city
router.get('/compare/:city', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });
  try {
    const result = await service.compareComplexPrices(req.params.city, pool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pricing/batch
router.post('/batch', async (req, res) => {
  const service = getPricingService();
  if (!service) return res.status(503).json({ error: 'Pricing service not available' });
  try {
    const { city, limit, staleOnly } = req.body;
    res.json({ message: 'Batch pricing update started', params: { city, limit, staleOnly }, note: 'Running in background' });
    (async () => {
      try { await service.batchUpdatePricing(pool, { city, limit, staleOnly }); }
      catch (err) { logger.error('Background pricing update failed', { error: err.message }); }
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
        CASE WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0 
          THEN ROUND(((c.city_avg_price_sqm - c.accurate_price_sqm) / c.city_avg_price_sqm * 100)::numeric, 1)
          ELSE NULL END as discount_pct
      FROM complexes c
      WHERE c.accurate_price_sqm IS NOT NULL AND c.iai_score >= 50
    `;
    const params = [];
    let paramIndex = 1;
    if (city) { query += ` AND c.city = $${paramIndex++}`; params.push(city); }
    query += ` ORDER BY discount_pct DESC NULLS LAST, c.iai_score DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 20);

    const result = await pool.query(query, params);
    res.json({
      total: result.rows.length,
      opportunities: result.rows.map(c => ({
        id: c.id, name: c.name, city: c.city, address: c.address,
        pricePerSqm: c.accurate_price_sqm, cityAvg: c.city_avg_price_sqm,
        discountPct: c.discount_pct, iaiScore: c.iai_score, status: c.status,
        confidenceScore: c.price_confidence_score
      }))
    });
  } catch (err) {
    logger.error('Top opportunities query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
