/**
 * Facebook Marketplace Routes (Phase 4.20 - Apify Integration)
 * 
 * API routes for Facebook Marketplace listing scanner via Apify.
 * 
 * Endpoints:
 * POST /api/facebook/scan/complex/:id  - Scan single complex
 * POST /api/facebook/scan/city         - Scan by city
 * POST /api/facebook/scan/all          - Batch scan all cities
 * GET  /api/facebook/stats             - Get scan statistics
 * GET  /api/facebook/listings          - Get Facebook listings
 * GET  /api/facebook/unmatched         - Get unmatched listings
 * GET  /api/facebook/cities            - Available cities with FB URLs
 * POST /api/facebook/match             - Manual listing→complex match
 * GET  /api/facebook/test              - Test Apify connection
 */

const express = require('express');
const router = express.Router();
const facebookScraper = require('../services/facebookScraper');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * GET /test - Test Apify API connection
 */
router.get('/test', async (req, res) => {
  try {
    const hasToken = !!process.env.APIFY_API_TOKEN;
    const tokenPrefix = hasToken ? process.env.APIFY_API_TOKEN.substring(0, 8) + '...' : 'NOT SET';
    
    if (hasToken) {
      try {
        const axios = require('axios');
        const response = await axios.get(
          `https://api.apify.com/v2/users/me`, 
          { 
            params: { token: process.env.APIFY_API_TOKEN },
            timeout: 10000 
          }
        );
        
        res.json({
          status: 'ok',
          apify: {
            connected: true,
            tokenPrefix,
            user: response.data?.data?.username || 'unknown',
            plan: response.data?.data?.plan?.id || 'unknown'
          },
          cities: facebookScraper.getAvailableCities().length,
          sampleUrl: facebookScraper.buildMarketplaceUrl('בת ים')
        });
        return;
      } catch (apiErr) {
        res.json({
          status: 'token_invalid',
          apify: {
            connected: false,
            tokenPrefix,
            error: apiErr.response?.status === 401 ? 'Invalid token' : apiErr.message
          }
        });
        return;
      }
    }

    res.json({
      status: 'no_token',
      apify: { connected: false, tokenPrefix },
      cities: facebookScraper.getAvailableCities().length,
      instructions: 'Set APIFY_API_TOKEN environment variable in Railway'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /cities - Get available cities with Facebook Marketplace URLs
 */
router.get('/cities', async (req, res) => {
  try {
    const cities = facebookScraper.getAvailableCities();
    
    const scanStatus = await pool.query(`
      SELECT city, 
        MAX(last_facebook_scan) as last_scan,
        COUNT(DISTINCT id) as complexes
      FROM complexes 
      GROUP BY city
    `);
    
    const statusMap = {};
    scanStatus.rows.forEach(r => {
      statusMap[r.city] = { last_scan: r.last_scan, complexes: r.complexes };
    });

    const enriched = cities.map(c => ({
      ...c,
      complexes: statusMap[c.city]?.complexes || 0,
      last_scan: statusMap[c.city]?.last_scan || null
    }));

    res.json({
      status: 'ok',
      total: enriched.length,
      data: enriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scan/complex/:id - Scan Facebook for a specific complex
 */
router.post('/scan/complex/:id', async (req, res) => {
  try {
    const complexId = parseInt(req.params.id);
    if (isNaN(complexId)) {
      return res.status(400).json({ error: 'Invalid complex ID' });
    }

    logger.info(`Facebook scan triggered for complex ${complexId}`);
    const result = await facebookScraper.scanComplex(complexId);

    res.json({
      status: 'ok',
      message: `Facebook scan complete for ${result.complex}`,
      data: result
    });
  } catch (err) {
    logger.error('Facebook complex scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scan/city - Scan Facebook Marketplace by city
 * Body: { city: "בת ים" }
 */
router.post('/scan/city', async (req, res) => {
  try {
    const { city } = req.body;
    if (!city) {
      return res.status(400).json({ error: 'City is required' });
    }

    const url = facebookScraper.buildMarketplaceUrl(city);
    if (!url) {
      return res.status(400).json({ 
        error: `No Facebook Marketplace URL mapping for city: ${city}`,
        available: facebookScraper.getAvailableCities().map(c => c.city)
      });
    }

    logger.info(`Facebook city scan triggered for ${city} → ${url}`);
    const result = await facebookScraper.scanCity(city);

    res.json({
      status: 'ok',
      message: `Facebook city scan complete for ${city}`,
      data: result
    });
  } catch (err) {
    logger.error('Facebook city scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scan/all - Batch scan all cities
 * Body: { staleOnly: true, limit: 10, city: null }
 */
router.post('/scan/all', async (req, res) => {
  try {
    const { staleOnly = true, limit = 10, city = null } = req.body || {};

    logger.info(`Facebook batch scan triggered: limit=${limit}, staleOnly=${staleOnly}, city=${city || 'all'}`);
    const result = await facebookScraper.scanAll({ staleOnly, limit, city });

    res.json({
      status: 'ok',
      message: `Facebook batch scan complete: ${result.succeeded}/${result.total} cities succeeded`,
      data: result
    });
  } catch (err) {
    logger.error('Facebook batch scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stats - Facebook scan statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await facebookScraper.getStats();

    res.json({
      status: 'ok',
      data: {
        overview: {
          total_listings: stats.total_listings,
          active_listings: stats.active_listings,
          matched_listings: stats.matched_listings,
          unmatched_listings: stats.unmatched_listings,
          urgent_listings: stats.urgent_listings,
          foreclosure_listings: stats.foreclosure_listings,
          cities: stats.cities,
          complexes_with_listings: stats.complexes_with_listings,
          avg_price: stats.avg_price ? Math.round(parseFloat(stats.avg_price)) : null,
          earliest_listing: stats.earliest_listing,
          latest_scan: stats.latest_scan
        },
        by_city: stats.cities_breakdown || []
      }
    });
  } catch (err) {
    logger.error('Facebook stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /listings - Get Facebook Marketplace listings
 */
router.get('/listings', async (req, res) => {
  try {
    const { 
      city, active = 'true', urgent, matched,
      limit = 50, offset = 0, sort = 'first_seen', order = 'DESC'
    } = req.query;

    let query = `
      SELECT l.*, c.name as complex_name
      FROM listings l
      LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE l.source = 'facebook'
    `;
    const params = [];
    let paramCount = 0;

    if (city) { paramCount++; query += ` AND l.city = $${paramCount}`; params.push(city); }
    if (active === 'true') query += ` AND l.is_active = TRUE`;
    if (urgent === 'true') query += ` AND (l.has_urgent_keywords = TRUE OR l.is_foreclosure = TRUE OR l.is_inheritance = TRUE)`;
    if (matched === 'true') query += ` AND l.complex_id IS NOT NULL`;
    else if (matched === 'false') query += ` AND l.complex_id IS NULL`;

    const validSorts = ['first_seen', 'asking_price', 'days_on_market', 'area_sqm', 'rooms', 'city'];
    const sortCol = validSorts.includes(sort) ? sort : 'first_seen';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY l.${sortCol} ${sortOrder} NULLS LAST`;

    paramCount++; query += ` LIMIT $${paramCount}`; params.push(parseInt(limit) || 50);
    paramCount++; query += ` OFFSET $${paramCount}`; params.push(parseInt(offset) || 0);

    const result = await pool.query(query, params);

    let countQuery = `SELECT COUNT(*) FROM listings WHERE source = 'facebook'`;
    const countParams = [];
    let countParamIdx = 0;
    if (city) { countParamIdx++; countQuery += ` AND city = $${countParamIdx}`; countParams.push(city); }
    if (active === 'true') countQuery += ` AND is_active = TRUE`;
    if (urgent === 'true') countQuery += ` AND (has_urgent_keywords = TRUE OR is_foreclosure = TRUE OR is_inheritance = TRUE)`;
    if (matched === 'true') countQuery += ` AND complex_id IS NOT NULL`;
    else if (matched === 'false') countQuery += ` AND complex_id IS NULL`;

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      status: 'ok',
      data: {
        listings: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (err) {
    logger.error('Facebook listings error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /unmatched - Get unmatched Facebook listings for manual review
 */
router.get('/unmatched', async (req, res) => {
  try {
    const { city, limit = 50 } = req.query;

    let query = `
      SELECT l.*
      FROM listings l
      WHERE l.source = 'facebook' AND l.complex_id IS NULL AND l.is_active = TRUE
    `;
    const params = [];
    let paramCount = 0;

    if (city) { paramCount++; query += ` AND l.city = $${paramCount}`; params.push(city); }
    paramCount++; query += ` ORDER BY l.first_seen DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit) || 50);

    const result = await pool.query(query, params);

    res.json({ status: 'ok', data: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Facebook unmatched error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /match - Manually match a listing to a complex
 */
router.post('/match', async (req, res) => {
  try {
    const { listingId, complexId } = req.body;
    if (!listingId || !complexId) {
      return res.status(400).json({ error: 'listingId and complexId required' });
    }

    await pool.query(
      'UPDATE listings SET complex_id = $1, updated_at = NOW() WHERE id = $2 AND source = $3',
      [complexId, listingId, 'facebook']
    );

    res.json({ status: 'ok', message: `Listing ${listingId} matched to complex ${complexId}` });
  } catch (err) {
    logger.error('Facebook match error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
