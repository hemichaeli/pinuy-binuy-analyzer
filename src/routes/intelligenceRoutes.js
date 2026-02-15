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
    // 1. Overview stats
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

    // 2. Top opportunities
    const topOpps = await pool.query(`
      SELECT name, city, status, iai_score, actual_premium, 
        existing_units, planned_units, developer
      FROM complexes 
      WHERE iai_score >= 50 
      ORDER BY iai_score DESC 
      LIMIT 15
    `);

    // 3. City breakdown
    const cities = await pool.query(`
      SELECT city, 
        COUNT(*) as complexes,
        ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
        COUNT(*) FILTER (WHERE iai_score >= 70) as excellent,
        COUNT(*) FILTER (WHERE iai_score >= 50) as investable
      FROM complexes 
      GROUP BY city 
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
    `);

    // 4. Recent alerts
    const alerts = await pool.query(`
      SELECT a.alert_type, a.severity, a.title, a.message, 
        a.created_at, c.name as complex_name, c.city
      FROM alerts a
      LEFT JOIN complexes c ON a.complex_id = c.id
      WHERE a.created_at > NOW() - INTERVAL '7 days'
      ORDER BY a.created_at DESC
      LIMIT 20
    `);

    // 5. Listings stats
    const listings = await pool.query(`
      SELECT 
        COUNT(*) as total_listings,
        COUNT(DISTINCT source) as sources,
        COUNT(*) FILTER (WHERE is_urgent = true) as urgent,
        COUNT(*) FILTER (WHERE source = 'yad2') as yad2,
        COUNT(*) FILTER (WHERE source = 'facebook') as facebook,
        COUNT(*) FILTER (WHERE source = 'kones') as kones,
        ROUND(AVG(price) FILTER (WHERE price > 100000), 0) as avg_price
      FROM listings WHERE is_active = true
    `);

    // 6. Last scan info
    const lastScan = await pool.query(`
      SELECT scan_type, started_at, completed_at, status, summary
      FROM scan_logs ORDER BY id DESC LIMIT 1
    `);

    // 7. Stressed sellers
    const stressed = await pool.query(`
      SELECT c.name, c.city, c.iai_score,
        l.price, l.days_on_market, l.price_drops, l.source
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true 
        AND (l.days_on_market > 90 OR l.price_drops >= 2 OR l.is_urgent = true)
      ORDER BY l.days_on_market DESC NULLS LAST
      LIMIT 15
    `);

    const s = stats.rows[0];
    const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    res.json({
      _meta: {
        description: 'QUANTUM Real Estate Intelligence - Pinuy Binuy (Urban Renewal) Israel',
        generated_at: israelTime,
        version: '4.20.1',
        usage: 'This data is from a live database tracking Israeli urban renewal projects. Ask me anything about opportunities, cities, or market trends.'
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
        name: o.name,
        city: o.city,
        iai_score: o.iai_score,
        status: o.status,
        actual_premium_percent: o.actual_premium,
        existing_units: o.existing_units,
        planned_units: o.planned_units,
        developer: o.developer
      })),
      cities_analysis: cities.rows.map(c => ({
        city: c.city,
        total_complexes: parseInt(c.complexes),
        avg_iai: parseFloat(c.avg_iai) || 0,
        excellent_opportunities: parseInt(c.excellent),
        investable_opportunities: parseInt(c.investable)
      })),
      active_listings: {
        total: parseInt(listings.rows[0]?.total_listings) || 0,
        sources: parseInt(listings.rows[0]?.sources) || 0,
        urgent: parseInt(listings.rows[0]?.urgent) || 0,
        by_source: {
          yad2: parseInt(listings.rows[0]?.yad2) || 0,
          facebook: parseInt(listings.rows[0]?.facebook) || 0,
          kones_receivership: parseInt(listings.rows[0]?.kones) || 0
        },
        average_price_ils: parseInt(listings.rows[0]?.avg_price) || 0
      },
      stressed_sellers: stressed.rows.map(s => ({
        complex: s.name,
        city: s.city,
        iai_score: s.iai_score,
        price_ils: s.price,
        days_on_market: s.days_on_market,
        price_drops: s.price_drops,
        source: s.source
      })),
      recent_alerts: alerts.rows.map(a => ({
        type: a.alert_type,
        severity: a.severity,
        title: a.title,
        message: a.message,
        complex: a.complex_name,
        city: a.city,
        date: a.created_at
      })),
      last_scan: lastScan.rows[0] ? {
        type: lastScan.rows[0].scan_type,
        started: lastScan.rows[0].started_at,
        completed: lastScan.rows[0].completed_at,
        status: lastScan.rows[0].status,
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
 * Top investment opportunities with full details
 */
router.get('/opportunities', async (req, res) => {
  try {
    const { city, min_iai = 30, limit = 30 } = req.query;
    
    let query = `
      SELECT c.name, c.city, c.status, c.iai_score, c.actual_premium,
        c.existing_units, c.planned_units, c.developer, c.addresses,
        c.plan_number, c.local_committee_date, c.district_committee_date,
        c.is_receivership, c.discovery_source,
        COUNT(l.id) FILTER (WHERE l.is_active = true) as active_listings,
        MIN(l.price) FILTER (WHERE l.is_active = true AND l.price > 100000) as min_price,
        MAX(l.price) FILTER (WHERE l.is_active = true AND l.price > 100000) as max_price
      FROM complexes c
      LEFT JOIN listings l ON l.complex_id = c.id
      WHERE c.iai_score >= $1
    `;
    const params = [min_iai];
    
    if (city) {
      query += ` AND c.city = $2`;
      params.push(city);
    }
    
    query += ` GROUP BY c.id ORDER BY c.iai_score DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      _meta: {
        description: `Investment opportunities with IAI >= ${min_iai}${city ? ` in ${city}` : ''}`,
        count: result.rows.length,
        generated_at: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      },
      opportunities: result.rows.map(r => ({
        name: r.name,
        city: r.city,
        iai_score: r.iai_score,
        status: r.status,
        actual_premium_percent: r.actual_premium,
        existing_units: r.existing_units,
        planned_units: r.planned_units,
        developer: r.developer,
        addresses: r.addresses,
        plan_number: r.plan_number,
        local_committee_date: r.local_committee_date,
        district_committee_date: r.district_committee_date,
        is_receivership: r.is_receivership,
        active_listings: parseInt(r.active_listings),
        price_range_ils: r.min_price ? { min: parseInt(r.min_price), max: parseInt(r.max_price) } : null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/intelligence/city/:cityName
 * Deep dive into a specific city
 */
router.get('/city/:cityName', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.cityName);

    const complexes = await pool.query(`
      SELECT name, status, iai_score, actual_premium, 
        existing_units, planned_units, developer, addresses,
        is_receivership
      FROM complexes 
      WHERE city = $1
      ORDER BY iai_score DESC NULLS LAST
    `, [city]);

    const listingStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_urgent = true) as urgent,
        ROUND(AVG(price) FILTER (WHERE price > 100000), 0) as avg_price,
        MIN(price) FILTER (WHERE price > 100000) as min_price,
        MAX(price) FILTER (WHERE price > 100000) as max_price
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE c.city = $1 AND l.is_active = true
    `, [city]);

    const statusBreakdown = await pool.query(`
      SELECT status, COUNT(*) as cnt
      FROM complexes WHERE city = $1
      GROUP BY status ORDER BY cnt DESC
    `, [city]);

    res.json({
      _meta: {
        city: city,
        total_complexes: complexes.rows.length,
        generated_at: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      },
      status_breakdown: statusBreakdown.rows.reduce((acc, r) => {
        acc[r.status] = parseInt(r.cnt);
        return acc;
      }, {}),
      listings: {
        total_active: parseInt(listingStats.rows[0]?.total) || 0,
        urgent: parseInt(listingStats.rows[0]?.urgent) || 0,
        avg_price_ils: parseInt(listingStats.rows[0]?.avg_price) || 0,
        price_range: listingStats.rows[0]?.min_price ? {
          min: parseInt(listingStats.rows[0].min_price),
          max: parseInt(listingStats.rows[0].max_price)
        } : null
      },
      complexes: complexes.rows.map(c => ({
        name: c.name,
        status: c.status,
        iai_score: c.iai_score,
        actual_premium_percent: c.actual_premium,
        existing_units: c.existing_units,
        planned_units: c.planned_units,
        developer: c.developer,
        addresses: c.addresses,
        is_receivership: c.is_receivership
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/intelligence/stressed-sellers
 * Properties with motivated/distressed sellers
 */
router.get('/stressed-sellers', async (req, res) => {
  try {
    const sellers = await pool.query(`
      SELECT c.name as complex_name, c.city, c.iai_score, c.status,
        l.price, l.rooms, l.area_sqm, l.floor,
        l.days_on_market, l.price_drops, l.original_price,
        l.source, l.is_urgent, l.source_url,
        CASE 
          WHEN l.original_price > 0 AND l.price > 0 
          THEN ROUND(((l.original_price - l.price)::numeric / l.original_price * 100), 1)
          ELSE 0 
        END as total_drop_percent
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true 
        AND (l.days_on_market > 60 OR l.price_drops >= 1 OR l.is_urgent = true OR c.is_receivership = true)
      ORDER BY 
        CASE WHEN c.is_receivership THEN 0 ELSE 1 END,
        l.price_drops DESC NULLS LAST,
        l.days_on_market DESC NULLS LAST
      LIMIT 30
    `);

    // Receivership properties
    const receivership = await pool.query(`
      SELECT c.name, c.city, c.iai_score,
        ds.distress_type, ds.distress_score, ds.details
      FROM distressed_sellers ds
      LEFT JOIN complexes c ON ds.complex_id = c.id
      WHERE ds.source = 'konesisrael'
      ORDER BY ds.created_at DESC
      LIMIT 20
    `);

    res.json({
      _meta: {
        description: 'Motivated sellers - long time on market, price drops, urgent listings, receivership',
        count: sellers.rows.length,
        receivership_count: receivership.rows.length,
        generated_at: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      },
      stressed_listings: sellers.rows.map(s => ({
        complex: s.complex_name,
        city: s.city,
        iai_score: s.iai_score,
        complex_status: s.status,
        price_ils: s.price,
        rooms: s.rooms,
        area_sqm: s.area_sqm,
        floor: s.floor,
        days_on_market: s.days_on_market,
        price_drops: s.price_drops,
        original_price_ils: s.original_price,
        total_drop_percent: parseFloat(s.total_drop_percent),
        is_urgent: s.is_urgent,
        source: s.source,
        url: s.source_url
      })),
      receivership_properties: receivership.rows.map(r => ({
        complex: r.name,
        city: r.city,
        iai_score: r.iai_score,
        distress_type: r.distress_type,
        score: r.distress_score,
        details: r.details
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/intelligence/query
 * Free-form SQL-like query (read-only, safe)
 * Usage: ?q=complexes in bat yam with iai above 60
 */
router.get('/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    
    if (!q) {
      return res.json({
        _meta: { description: 'Free-form query endpoint' },
        usage: {
          examples: [
            '/api/intelligence/query?q=complexes in bat yam',
            '/api/intelligence/query?q=top opportunities',
            '/api/intelligence/query?q=stressed sellers in ramat gan',
            '/api/intelligence/query?q=receivership properties',
            '/api/intelligence/query?q=approved projects'
          ]
        }
      });
    }

    // Parse intent from natural language
    let sqlQuery, params = [];
    
    // City filter
    const cityMatch = q.match(/(?:in|ב)\s*(.+?)(?:\s+with|\s+above|\s+where|$)/);
    const iaiMatch = q.match(/(?:iai|score)\s*(?:above|>=?|over)\s*(\d+)/);
    const statusMatch = q.match(/(?:status|סטטוס)\s*(?:=|is|:)\s*(\w+)/);

    if (q.includes('stressed') || q.includes('seller') || q.includes('motivated') || q.includes('לחוץ')) {
      sqlQuery = `
        SELECT c.name, c.city, c.iai_score, c.status,
          l.price, l.days_on_market, l.price_drops, l.source
        FROM listings l JOIN complexes c ON l.complex_id = c.id
        WHERE l.is_active = true AND (l.days_on_market > 60 OR l.price_drops >= 1 OR l.is_urgent = true)
      `;
      if (cityMatch) { sqlQuery += ` AND c.city ILIKE $1`; params.push(`%${cityMatch[1].trim()}%`); }
      sqlQuery += ` ORDER BY l.days_on_market DESC NULLS LAST LIMIT 20`;
    } else if (q.includes('receiv') || q.includes('כונס') || q.includes('kones')) {
      sqlQuery = `
        SELECT c.name, c.city, c.iai_score, ds.distress_type, ds.details
        FROM distressed_sellers ds LEFT JOIN complexes c ON ds.complex_id = c.id
        WHERE ds.source = 'konesisrael'
        ORDER BY ds.created_at DESC LIMIT 20
      `;
    } else if (q.includes('opportunit') || q.includes('top') || q.includes('best') || q.includes('הזדמנ')) {
      sqlQuery = `SELECT name, city, status, iai_score, actual_premium, existing_units, planned_units, developer
        FROM complexes WHERE iai_score >= $1 ORDER BY iai_score DESC LIMIT 20`;
      params.push(parseInt(iaiMatch?.[1]) || 50);
    } else if (q.includes('approved') || q.includes('אושר')) {
      sqlQuery = `SELECT name, city, iai_score, actual_premium, developer, planned_units
        FROM complexes WHERE status = 'approved' ORDER BY iai_score DESC LIMIT 30`;
    } else {
      // Default: search by city or name
      const searchTerm = cityMatch ? cityMatch[1].trim() : q;
      sqlQuery = `
        SELECT name, city, status, iai_score, actual_premium, existing_units, planned_units, developer
        FROM complexes WHERE city ILIKE $1 OR name ILIKE $1
        ORDER BY iai_score DESC NULLS LAST LIMIT 30
      `;
      params.push(`%${searchTerm}%`);
    }

    const result = await pool.query(sqlQuery, params);

    res.json({
      _meta: {
        query: q,
        results: result.rows.length,
        generated_at: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      },
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
