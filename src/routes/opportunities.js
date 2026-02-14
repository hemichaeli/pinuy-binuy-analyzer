const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// GET /api/opportunities - High IAI score opportunities
router.get('/opportunities', async (req, res) => {
  try {
    const { min_iai, status, city, limit } = req.query;
    const minIai = parseInt(min_iai) || 50;
    const limitVal = Math.min(parseInt(limit) || 20, 100);
    
    let query = `
      SELECT 
        c.id, c.slug, c.name, c.city, c.region, c.neighborhood,
        c.status, c.planned_units, c.existing_units,
        c.developer, c.developer_strength,
        c.iai_score, c.premium_gap,
        c.theoretical_premium_min, c.theoretical_premium_max,
        c.actual_premium,
        c.certainty_factor, c.yield_factor,
        c.deposit_date, c.approval_date,
        c.addresses,
        c.perplexity_summary,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active) as active_listings,
        MAX(l.ssi_score) as max_ssi,
        AVG(l.ssi_score) FILTER (WHERE l.ssi_score > 0) as avg_ssi
      FROM complexes c
      LEFT JOIN listings l ON c.id = l.complex_id
      WHERE c.iai_score >= $1
    `;
    const params = [minIai];
    let paramCount = 1;
    
    if (status) {
      paramCount++;
      query += ` AND c.status = $${paramCount}`;
      params.push(status);
    }
    if (city) {
      paramCount++;
      query += ` AND c.city = $${paramCount}`;
      params.push(city);
    }
    
    query += ' GROUP BY c.id ORDER BY c.iai_score DESC';
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limitVal);
    
    const result = await pool.query(query, params);
    
    const opportunities = result.rows.map(row => ({
      ...row,
      iai_category: row.iai_score >= 70 ? 'excellent' 
        : row.iai_score >= 50 ? 'good' 
        : row.iai_score >= 30 ? 'moderate' 
        : 'low',
      recommendation: row.iai_score >= 70 
        ? 'רכישה מומלצת בחום' 
        : row.iai_score >= 50 
        ? 'שווה בדיקה מעמיקה' 
        : row.iai_score >= 30 
        ? 'רק אם יש יתרון ספציפי' 
        : 'לא מומלץ'
    }));
    
    res.json({
      opportunities,
      total: opportunities.length,
      criteria: { min_iai: minIai }
    });
  } catch (err) {
    logger.error('Error fetching opportunities', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
});

// GET /api/stressed-sellers - High SSI score listings
router.get('/stressed-sellers', async (req, res) => {
  try {
    const { min_ssi, city, limit } = req.query;
    const minSsi = parseInt(min_ssi) || 50;
    const limitVal = Math.min(parseInt(limit) || 20, 100);
    
    let query = `
      SELECT 
        l.id as listing_id,
        l.source, l.url,
        l.asking_price, l.area_sqm, l.rooms, l.floor,
        l.price_per_sqm,
        l.days_on_market, l.price_changes, l.total_price_drop_percent,
        l.original_price,
        l.has_urgent_keywords, l.urgent_keywords_found,
        l.is_foreclosure, l.is_inheritance,
        l.ssi_score, l.ssi_time_score, l.ssi_price_score, l.ssi_indicator_score,
        l.address, l.city,
        l.first_seen, l.last_seen,
        c.id as complex_id, c.slug as complex_slug,
        c.name as complex_name, c.city as complex_city,
        c.status as complex_status,
        c.iai_score,
        c.developer
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE l.ssi_score >= $1 AND l.is_active = TRUE
    `;
    const params = [minSsi];
    let paramCount = 1;
    
    if (city) {
      paramCount++;
      query += ` AND l.city = $${paramCount}`;
      params.push(city);
    }
    
    query += ' ORDER BY l.ssi_score DESC';
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limitVal);
    
    const result = await pool.query(query, params);
    
    const sellers = result.rows.map(row => ({
      ...row,
      ssi_category: row.ssi_score >= 70 ? 'very_stressed'
        : row.ssi_score >= 50 ? 'stressed'
        : row.ssi_score >= 30 ? 'normal'
        : 'strong',
      strategy: row.ssi_score >= 70
        ? 'הצעה אגרסיבית 15-20% מתחת למחיר'
        : row.ssi_score >= 50
        ? 'הצעה 10-15% מתחת למחיר'
        : row.ssi_score >= 30
        ? 'משא ומתן סטנדרטי'
        : 'קשה להוריד מחיר',
      potential_discount: row.ssi_score >= 70 ? '15-20%'
        : row.ssi_score >= 50 ? '10-15%'
        : row.ssi_score >= 30 ? '5-10%'
        : '0-5%'
    }));
    
    res.json({
      stressed_sellers: sellers,
      total: sellers.length,
      criteria: { min_ssi: minSsi }
    });
  } catch (err) {
    logger.error('Error fetching stressed sellers', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stressed sellers' });
  }
});

// =====================================================
// GET /api/listings/search - Full listings search with comprehensive filters
// =====================================================
router.get('/listings/search', async (req, res) => {
  try {
    const {
      city,
      min_price, max_price,
      min_rooms, max_rooms,
      min_area, max_area,
      min_ssi, max_ssi,
      min_iai,
      min_days_on_market, max_days_on_market,
      min_price_drops,
      has_price_drop,
      is_foreclosure, is_inheritance,
      has_urgent_keywords,
      complex_status,
      sort_by,
      sort_order,
      limit, offset
    } = req.query;

    const limitVal = Math.min(parseInt(limit) || 50, 200);
    const offsetVal = parseInt(offset) || 0;

    // Build WHERE conditions separately for reuse in count query
    const conditions = ['l.is_active = TRUE'];
    const params = [];
    let paramCount = 0;

    if (city) {
      paramCount++;
      conditions.push(`l.city = $${paramCount}`);
      params.push(city);
    }
    if (min_price) {
      paramCount++;
      conditions.push(`l.asking_price >= $${paramCount}`);
      params.push(parseFloat(min_price));
    }
    if (max_price) {
      paramCount++;
      conditions.push(`l.asking_price <= $${paramCount}`);
      params.push(parseFloat(max_price));
    }
    if (min_rooms) {
      paramCount++;
      conditions.push(`l.rooms >= $${paramCount}`);
      params.push(parseFloat(min_rooms));
    }
    if (max_rooms) {
      paramCount++;
      conditions.push(`l.rooms <= $${paramCount}`);
      params.push(parseFloat(max_rooms));
    }
    if (min_area) {
      paramCount++;
      conditions.push(`l.area_sqm >= $${paramCount}`);
      params.push(parseFloat(min_area));
    }
    if (max_area) {
      paramCount++;
      conditions.push(`l.area_sqm <= $${paramCount}`);
      params.push(parseFloat(max_area));
    }
    if (min_ssi) {
      paramCount++;
      conditions.push(`l.ssi_score >= $${paramCount}`);
      params.push(parseInt(min_ssi));
    }
    if (max_ssi) {
      paramCount++;
      conditions.push(`l.ssi_score <= $${paramCount}`);
      params.push(parseInt(max_ssi));
    }
    if (min_iai) {
      paramCount++;
      conditions.push(`c.iai_score >= $${paramCount}`);
      params.push(parseInt(min_iai));
    }
    if (min_days_on_market) {
      paramCount++;
      conditions.push(`l.days_on_market >= $${paramCount}`);
      params.push(parseInt(min_days_on_market));
    }
    if (max_days_on_market) {
      paramCount++;
      conditions.push(`l.days_on_market <= $${paramCount}`);
      params.push(parseInt(max_days_on_market));
    }
    if (min_price_drops) {
      paramCount++;
      conditions.push(`l.price_changes >= $${paramCount}`);
      params.push(parseInt(min_price_drops));
    }
    if (has_price_drop === 'true') {
      conditions.push(`l.total_price_drop_percent > 0`);
    }
    if (is_foreclosure === 'true') {
      conditions.push(`l.is_foreclosure = TRUE`);
    }
    if (is_inheritance === 'true') {
      conditions.push(`l.is_inheritance = TRUE`);
    }
    if (has_urgent_keywords === 'true') {
      conditions.push(`l.has_urgent_keywords = TRUE`);
    }
    if (complex_status) {
      paramCount++;
      conditions.push(`c.status = $${paramCount}`);
      params.push(complex_status);
    }

    const whereClause = conditions.join(' AND ');

    // Sorting
    const validSorts = {
      'price': 'l.asking_price',
      'ssi': 'l.ssi_score',
      'iai': 'c.iai_score',
      'rooms': 'l.rooms',
      'area': 'l.area_sqm',
      'days': 'l.days_on_market',
      'price_drop': 'l.total_price_drop_percent',
      'price_changes': 'l.price_changes',
      'date': 'l.first_seen'
    };
    const sortCol = validSorts[sort_by] || 'l.ssi_score';
    const sortDir = sort_order === 'asc' ? 'ASC' : 'DESC';

    // Count query (no ORDER BY, no LIMIT)
    const countQuery = `
      SELECT COUNT(*) as total
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE ${whereClause}
    `;

    // Data query with sort + pagination
    const dataQuery = `
      SELECT 
        l.id as listing_id,
        l.source, l.url,
        l.asking_price, l.area_sqm, l.rooms, l.floor,
        l.price_per_sqm,
        l.days_on_market, l.price_changes, l.total_price_drop_percent,
        l.original_price,
        l.has_urgent_keywords, l.urgent_keywords_found,
        l.is_foreclosure, l.is_inheritance,
        l.ssi_score, l.ssi_time_score, l.ssi_price_score, l.ssi_indicator_score,
        l.address, l.city,
        l.first_seen, l.last_seen,
        c.id as complex_id, c.slug as complex_slug,
        c.name as complex_name, c.city as complex_city,
        c.status as complex_status,
        c.iai_score,
        c.developer
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE ${whereClause}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    const dataParams = [...params, limitVal, offsetVal];

    const [result, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, params)
    ]);

    const listings = result.rows.map(row => ({
      ...row,
      ssi_category: row.ssi_score >= 70 ? 'very_stressed'
        : row.ssi_score >= 50 ? 'stressed'
        : row.ssi_score >= 30 ? 'normal'
        : 'strong',
      strategy: row.ssi_score >= 70
        ? 'הצעה אגרסיבית 15-20% מתחת למחיר'
        : row.ssi_score >= 50
        ? 'הצעה 10-15% מתחת למחיר'
        : row.ssi_score >= 30
        ? 'משא ומתן סטנדרטי'
        : 'מחיר שוק מלא',
      potential_discount: row.ssi_score >= 70 ? '15-20%'
        : row.ssi_score >= 50 ? '10-15%'
        : row.ssi_score >= 30 ? '5-10%'
        : '0-5%'
    }));

    res.json({
      listings,
      total: parseInt(countResult.rows[0]?.total || 0),
      returned: listings.length,
      offset: offsetVal,
      limit: limitVal,
      filters_applied: Object.fromEntries(
        Object.entries(req.query).filter(([k, v]) => v && k !== 'limit' && k !== 'offset')
      )
    });
  } catch (err) {
    logger.error('Error searching listings', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to search listings' });
  }
});

// GET /api/listings/filter-options - Get available filter values
router.get('/listings/filter-options', async (req, res) => {
  try {
    const [citiesResult, statsResult, statusResult] = await Promise.all([
      pool.query(`
        SELECT l.city, COUNT(*) as count 
        FROM listings l WHERE l.is_active = TRUE AND l.city IS NOT NULL
        GROUP BY l.city ORDER BY count DESC
      `),
      pool.query(`
        SELECT 
          MIN(l.asking_price)::numeric as min_price,
          MAX(l.asking_price)::numeric as max_price,
          MIN(l.rooms)::numeric as min_rooms,
          MAX(l.rooms)::numeric as max_rooms,
          MIN(l.area_sqm)::numeric as min_area,
          MAX(l.area_sqm)::numeric as max_area,
          MIN(l.ssi_score) as min_ssi,
          MAX(l.ssi_score) as max_ssi,
          MAX(l.days_on_market) as max_days,
          COUNT(*) as total
        FROM listings l WHERE l.is_active = TRUE
      `),
      pool.query(`
        SELECT DISTINCT c.status, COUNT(*) as count
        FROM listings l JOIN complexes c ON l.complex_id = c.id
        WHERE l.is_active = TRUE AND c.status IS NOT NULL
        GROUP BY c.status ORDER BY count DESC
      `)
    ]);

    res.json({
      cities: citiesResult.rows,
      ranges: statsResult.rows[0],
      complex_statuses: statusResult.rows
    });
  } catch (err) {
    logger.error('Error fetching filter options', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
});

// GET /api/dashboard-json - Combined dashboard data (JSON API)
router.get('/dashboard-json', async (req, res) => {
  try {
    const topOpportunities = await pool.query(`
      SELECT id, slug, name, city, status, iai_score, premium_gap, developer, planned_units
      FROM complexes WHERE iai_score > 0
      ORDER BY iai_score DESC LIMIT 10
    `);
    
    const topStressed = await pool.query(`
      SELECT 
        l.id, l.address, l.asking_price, l.ssi_score, l.days_on_market,
        l.total_price_drop_percent, l.has_urgent_keywords,
        c.name as complex_name, c.city, c.slug as complex_slug
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = TRUE AND l.ssi_score > 0
      ORDER BY l.ssi_score DESC LIMIT 10
    `);
    
    const recentAlerts = await pool.query(`
      SELECT a.*, c.name as complex_name, c.city, c.slug as complex_slug
      FROM alerts a JOIN complexes c ON a.complex_id = c.id
      ORDER BY a.created_at DESC LIMIT 10
    `);
    
    const statusDist = await pool.query(`
      SELECT status, COUNT(*) as count, SUM(planned_units) as total_units
      FROM complexes GROUP BY status ORDER BY count DESC
    `);
    
    const lastScan = await pool.query(`
      SELECT * FROM scan_logs ORDER BY started_at DESC LIMIT 1
    `);
    
    res.json({
      top_opportunities: topOpportunities.rows,
      top_stressed_sellers: topStressed.rows,
      recent_alerts: recentAlerts.rows,
      status_distribution: statusDist.rows,
      last_scan: lastScan.rows[0] || null
    });
  } catch (err) {
    logger.error('Error fetching dashboard', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
