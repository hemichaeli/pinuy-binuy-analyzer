/**
 * Intelligence API - Public readable endpoints for AI assistants (Perplexity, ChatGPT, etc.)
 * 
 * Returns QUANTUM database intelligence as structured, readable JSON
 * Designed to be fetched by AI assistants via URL
 * 
 * Usage in Perplexity/ChatGPT:
 *   "Read this URL and analyze: https://pinuy-binuy-analyzer-production.up.railway.app/api/intelligence"
 *   "Fetch https://pinuy-binuy-analyzer-production.up.railway.app/api/intelligence/opportunities"
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * GET /api/intelligence
 * Full database summary - all key metrics in one call
 */
router.get('/', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_complexes,
        COUNT(DISTINCT city) as total_cities,
        COUNT(*) FILTER (WHERE iai_score >= 70) as excellent_opportunities,
        COUNT(*) FILTER (WHERE iai_score >= 50 AND iai_score < 70) as good_opportunities,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'deposited') as deposited,
        COUNT(*) FILTER (WHERE status = 'planning') as planning,
        COUNT(*) FILTER (WHERE status = 'construction') as construction,
        COUNT(*) FILTER (WHERE status = 'declared') as declared,
        ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
        MAX(iai_score) as max_iai,
        COUNT(*) FILTER (WHERE is_receivership = true) as receivership_count
      FROM complexes
    `);

    const topOpps = await pool.query(`
      SELECT name, city, status, iai_score, actual_premium, 
        existing_units, planned_units, developer
      FROM complexes WHERE iai_score >= 50 ORDER BY iai_score DESC LIMIT 15
    `);

    const cities = await pool.query(`
      SELECT city, COUNT(*) as complexes,
        ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
        COUNT(*) FILTER (WHERE iai_score >= 70) as excellent,
        COUNT(*) FILTER (WHERE iai_score >= 50) as investable
      FROM complexes GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC
    `);

    const alerts = await pool.query(`
      SELECT a.alert_type, a.severity, a.title, a.message, 
        a.created_at, c.name as complex_name, c.city
      FROM alerts a LEFT JOIN complexes c ON a.complex_id = c.id
      WHERE a.created_at > NOW() - INTERVAL '7 days'
      ORDER BY a.created_at DESC LIMIT 20
    `);

    const listings = await pool.query(`
      SELECT 
        COUNT(*) as total_listings,
        COUNT(DISTINCT source) as sources,
        COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent,
        COUNT(*) FILTER (WHERE source = 'yad2') as yad2,
        COUNT(*) FILTER (WHERE source = 'facebook') as facebook,
        COUNT(*) FILTER (WHERE source = 'kones') as kones,
        ROUND(AVG(asking_price) FILTER (WHERE asking_price > 100000), 0) as avg_price
      FROM listings WHERE is_active = true
    `);

    const lastScan = await pool.query(`
      SELECT scan_type, started_at, completed_at, status, summary
      FROM scan_logs ORDER BY id DESC LIMIT 1
    `);

    const stressed = await pool.query(`
      SELECT c.name, c.city, c.iai_score,
        l.asking_price, l.days_on_market, l.price_changes, l.source
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true 
        AND (l.days_on_market > 90 OR l.price_changes >= 2 OR l.has_urgent_keywords = true)
      ORDER BY l.days_on_market DESC NULLS LAST LIMIT 15
    `);

    const s = stats.rows[0];
    const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    res.json({
      _meta: {
        description: 'QUANTUM Real Estate Intelligence - Pinuy Binuy (Urban Renewal) Israel',
        generated_at: israelTime,
        version: '4.20.2',
        endpoints: {
          full_summary: '/api/intelligence',
          opportunities: '/api/intelligence/opportunities',
          city_deep_dive: '/api/intelligence/city/{cityName}',
          stressed_sellers: '/api/intelligence/stressed-sellers',
          natural_query: '/api/intelligence/query?q={question}'
        }
      },
      overview: {
        total_complexes: parseInt(s.total_complexes),
        total_cities: parseInt(s.total_cities),
        excellent_opportunities_iai_70_plus: parseInt(s.excellent_opportunities),
        good_opportunities_iai_50_plus: parseInt(s.good_opportunities),
        average_iai_score: parseFloat(s.avg_iai) || 0,
        max_iai_score: parseInt(s.max_iai) || 0,
        receivership_properties: parseInt(s.receivership_count),
        status_breakdown: {
          approved: parseInt(s.approved),
          deposited: parseInt(s.deposited),
          planning: parseInt(s.planning),
          construction: parseInt(s.construction),
          declared: parseInt(s.declared)
        }
      },
      top_investment_opportunities: topOpps.rows.map(o => ({
        name: o.name, city: o.city, iai_score: o.iai_score, status: o.status,
        actual_premium_percent: o.actual_premium, existing_units: o.existing_units,
        planned_units: o.planned_units, developer: o.developer
      })),
      cities_analysis: cities.rows.map(c => ({
        city: c.city, total_complexes: parseInt(c.complexes),
        avg_iai: parseFloat(c.avg_iai) || 0,
        excellent_opportunities: parseInt(c.excellent),
        investable_opportunities: parseInt(c.investable)
      })),
      active_listings: {
        total: parseInt(listings.rows[0]?.total_listings) || 0,
        urgent: parseInt(listings.rows[0]?.urgent) || 0,
        by_source: {
          yad2: parseInt(listings.rows[0]?.yad2) || 0,
          facebook: parseInt(listings.rows[0]?.facebook) || 0,
          kones_receivership: parseInt(listings.rows[0]?.kones) || 0
        },
        average_price_ils: parseInt(listings.rows[0]?.avg_price) || 0
      },
      stressed_sellers: stressed.rows.map(s => ({
        complex: s.name, city: s.city, iai_score: s.iai_score,
        asking_price_ils: s.asking_price ? parseInt(s.asking_price) : null,
        days_on_market: s.days_on_market, price_changes: s.price_changes, source: s.source
      })),
      recent_alerts: alerts.rows.map(a => ({
        type: a.alert_type, severity: a.severity, title: a.title,
        message: a.message, complex: a.complex_name, city: a.city, date: a.created_at
      })),
      last_scan: lastScan.rows[0] ? {
        type: lastScan.rows[0].scan_type, started: lastScan.rows[0].started_at,
        completed: lastScan.rows[0].completed_at, status: lastScan.rows[0].status,
        summary: lastScan.rows[0].summary
      } : null
    });
  } catch (err) {
    logger.error('Intelligence API error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/intelligence/opportunities
 */
router.get('/opportunities', async (req, res) => {
  try {
    const { city, min_iai = 30, limit = 30 } = req.query;
    let query = `
      SELECT c.name, c.city, c.status, c.iai_score, c.actual_premium,
        c.existing_units, c.planned_units, c.developer, c.addresses,
        c.plan_number, c.local_committee_date, c.district_committee_date,
        c.is_receivership,
        COUNT(l.id) FILTER (WHERE l.is_active = true) as active_listings,
        MIN(l.asking_price) FILTER (WHERE l.is_active = true AND l.asking_price > 100000) as min_price,
        MAX(l.asking_price) FILTER (WHERE l.is_active = true AND l.asking_price > 100000) as max_price
      FROM complexes c LEFT JOIN listings l ON l.complex_id = c.id
      WHERE c.iai_score >= $1
    `;
    const params = [min_iai];
    if (city) { query += ` AND c.city = $2`; params.push(city); }
    query += ` GROUP BY c.id ORDER BY c.iai_score DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json({
      _meta: { description: `Opportunities IAI >= ${min_iai}${city ? ` in ${city}` : ''}`, count: result.rows.length },
      opportunities: result.rows.map(r => ({
        name: r.name, city: r.city, iai_score: r.iai_score, status: r.status,
        actual_premium_percent: r.actual_premium, existing_units: r.existing_units,
        planned_units: r.planned_units, developer: r.developer, addresses: r.addresses,
        plan_number: r.plan_number, is_receivership: r.is_receivership,
        active_listings: parseInt(r.active_listings),
        price_range_ils: r.min_price ? { min: parseInt(r.min_price), max: parseInt(r.max_price) } : null
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/intelligence/city/:cityName
 */
router.get('/city/:cityName', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.cityName);
    const complexes = await pool.query(`
      SELECT name, status, iai_score, actual_premium, existing_units, planned_units, developer, addresses, is_receivership
      FROM complexes WHERE city = $1 ORDER BY iai_score DESC NULLS LAST
    `, [city]);

    const listingStats = await pool.query(`
      SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent,
        ROUND(AVG(asking_price) FILTER (WHERE asking_price > 100000), 0) as avg_price,
        MIN(asking_price) FILTER (WHERE asking_price > 100000) as min_price,
        MAX(asking_price) FILTER (WHERE asking_price > 100000) as max_price
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE c.city = $1 AND l.is_active = true
    `, [city]);

    const statusBreakdown = await pool.query(`
      SELECT status, COUNT(*) as cnt FROM complexes WHERE city = $1 GROUP BY status ORDER BY cnt DESC
    `, [city]);

    res.json({
      _meta: { city, total_complexes: complexes.rows.length },
      status_breakdown: statusBreakdown.rows.reduce((acc, r) => { acc[r.status] = parseInt(r.cnt); return acc; }, {}),
      listings: {
        total_active: parseInt(listingStats.rows[0]?.total) || 0,
        urgent: parseInt(listingStats.rows[0]?.urgent) || 0,
        avg_price_ils: parseInt(listingStats.rows[0]?.avg_price) || 0,
        price_range: listingStats.rows[0]?.min_price ? { min: parseInt(listingStats.rows[0].min_price), max: parseInt(listingStats.rows[0].max_price) } : null
      },
      complexes: complexes.rows.map(c => ({
        name: c.name, status: c.status, iai_score: c.iai_score,
        actual_premium_percent: c.actual_premium, existing_units: c.existing_units,
        planned_units: c.planned_units, developer: c.developer, addresses: c.addresses,
        is_receivership: c.is_receivership
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/intelligence/stressed-sellers
 */
router.get('/stressed-sellers', async (req, res) => {
  try {
    const sellers = await pool.query(`
      SELECT c.name as complex_name, c.city, c.iai_score, c.status,
        l.asking_price, l.rooms, l.area_sqm, l.floor,
        l.days_on_market, l.price_changes, l.original_price,
        l.source, l.has_urgent_keywords, l.url,
        l.total_price_drop_percent
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true 
        AND (l.days_on_market > 60 OR l.price_changes >= 1 OR l.has_urgent_keywords = true OR c.is_receivership = true)
      ORDER BY 
        CASE WHEN c.is_receivership THEN 0 ELSE 1 END,
        l.price_changes DESC NULLS LAST,
        l.days_on_market DESC NULLS LAST
      LIMIT 30
    `);

    res.json({
      _meta: { description: 'Motivated sellers - long DOM, price drops, urgent, receivership', count: sellers.rows.length },
      stressed_listings: sellers.rows.map(s => ({
        complex: s.complex_name, city: s.city, iai_score: s.iai_score, status: s.status,
        asking_price_ils: s.asking_price ? parseInt(s.asking_price) : null,
        rooms: s.rooms ? parseFloat(s.rooms) : null, area_sqm: s.area_sqm ? parseFloat(s.area_sqm) : null,
        floor: s.floor, days_on_market: s.days_on_market, price_changes: s.price_changes,
        original_price_ils: s.original_price ? parseInt(s.original_price) : null,
        total_drop_percent: s.total_price_drop_percent ? parseFloat(s.total_price_drop_percent) : 0,
        has_urgent_keywords: s.has_urgent_keywords, source: s.source, url: s.url
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/intelligence/query?q=
 */
router.get('/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) {
      return res.json({
        usage: {
          examples: [
            '/api/intelligence/query?q=בת ים',
            '/api/intelligence/query?q=top opportunities',
            '/api/intelligence/query?q=stressed sellers',
            '/api/intelligence/query?q=approved projects',
            '/api/intelligence/query?q=receivership'
          ]
        }
      });
    }

    let sqlQuery, params = [];
    
    if (q.includes('stressed') || q.includes('seller') || q.includes('לחוץ')) {
      sqlQuery = `SELECT c.name, c.city, c.iai_score, l.asking_price, l.days_on_market, l.price_changes, l.source
        FROM listings l JOIN complexes c ON l.complex_id = c.id
        WHERE l.is_active = true AND (l.days_on_market > 60 OR l.price_changes >= 1)
        ORDER BY l.days_on_market DESC NULLS LAST LIMIT 20`;
    } else if (q.includes('receiv') || q.includes('כונס') || q.includes('kones')) {
      sqlQuery = `SELECT name, city, iai_score, status FROM complexes WHERE is_receivership = true ORDER BY iai_score DESC LIMIT 20`;
    } else if (q.includes('opportunit') || q.includes('top') || q.includes('best') || q.includes('הזדמנ')) {
      sqlQuery = `SELECT name, city, status, iai_score, actual_premium, developer FROM complexes WHERE iai_score >= 50 ORDER BY iai_score DESC LIMIT 20`;
    } else if (q.includes('approved') || q.includes('אושר')) {
      sqlQuery = `SELECT name, city, iai_score, actual_premium, developer, planned_units FROM complexes WHERE status = 'approved' ORDER BY iai_score DESC LIMIT 30`;
    } else {
      sqlQuery = `SELECT name, city, status, iai_score, actual_premium, existing_units, planned_units, developer
        FROM complexes WHERE city ILIKE $1 OR name ILIKE $1
        ORDER BY iai_score DESC NULLS LAST LIMIT 30`;
      params.push(`%${q}%`);
    }

    const result = await pool.query(sqlQuery, params);
    res.json({ _meta: { query: q, results: result.rows.length }, data: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
