const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// GET /api/opportunities - Top investment opportunities
router.get('/opportunities', async (req, res) => {
  try {
    const { min_iai, city, limit: limitParam } = req.query;
    const minIai = parseInt(min_iai) || 30;
    const limitVal = Math.min(parseInt(limitParam) || 50, 200);

    let conditions = ['c.iai_score >= $1'];
    let params = [minIai];
    let paramCount = 1;

    if (city) {
      paramCount++;
      conditions.push(`c.city = $${paramCount}`);
      params.push(city);
    }

    const result = await pool.query(`
      SELECT 
        c.id, c.name, c.city, c.status, c.developer, c.developer_strength,
        c.iai_score, c.multiplier,
        c.planned_units, c.existing_units,
        c.theoretical_premium_min, c.theoretical_premium_max,
        c.actual_premium, c.premium_gap,
        c.slug,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE) as active_listings,
        COUNT(DISTINCT t.id) as transactions_count,
        AVG(l.ssi_score) FILTER (WHERE l.is_active = TRUE) as avg_ssi,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE AND l.deal_status = 'new') as new_leads,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE AND l.message_status = 'sent') as messages_sent,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE AND l.message_status = 'replied') as messages_replied
      FROM complexes c
      LEFT JOIN listings l ON l.complex_id = c.id
      LEFT JOIN transactions t ON t.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY c.id
      ORDER BY c.iai_score DESC NULLS LAST
      LIMIT $${paramCount + 1}
    `, [...params, limitVal]);

    res.json({
      total: result.rows.length,
      opportunities: result.rows.map(row => ({
        ...row,
        iai_category: row.iai_score >= 70 ? 'excellent'
          : row.iai_score >= 50 ? 'good'
          : 'moderate',
        recommendation: row.iai_score >= 70
          ? 'השקעה מצוינת - פוטנציאל תשואה גבוה'
          : row.iai_score >= 50
          ? 'השקעה טובה - יחס סיכוי-סיכון חיובי'
          : 'השקעה סבירה - נדרש ניתוח נוסף'
      }))
    });
  } catch (error) {
    logger.error('Opportunities error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stressed-sellers - Stressed sellers list
router.get('/stressed-sellers', async (req, res) => {
  try {
    const { city, min_ssi, sort_by } = req.query;
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
        l.deal_status, l.message_status,
        c.id as complex_id, c.slug as complex_slug,
        c.name as complex_name, c.city as complex_city,
        c.status as complex_status,
        c.iai_score,
        c.developer
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = TRUE AND l.ssi_score >= $1
    `;
    const params = [parseInt(min_ssi) || 20];
    let paramCount = 1;

    if (city) {
      paramCount++;
      query += ` AND l.city = $${paramCount}`;
      params.push(city);
    }

    const sortOptions = {
      'ssi': 'l.ssi_score DESC',
      'price': 'l.asking_price ASC',
      'days': 'l.days_on_market DESC',
      'price_drop': 'l.total_price_drop_percent DESC'
    };
    query += ` ORDER BY ${sortOptions[sort_by] || 'l.ssi_score DESC'}`;
    query += ' LIMIT 50';

    const result = await pool.query(query, params);
    res.json({
      total: result.rows.length,
      stressed_sellers: result.rows.map(row => ({
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
      }))
    });
  } catch (error) {
    logger.error('Stressed sellers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/listings/filter-options - Available filter values
router.get('/listings/filter-options', async (req, res) => {
  try {
    const cities = await pool.query(`
      SELECT city, COUNT(*) as count
      FROM listings WHERE is_active = TRUE AND city IS NOT NULL
      GROUP BY city ORDER BY count DESC
    `);
    const priceRange = await pool.query(`
      SELECT MIN(asking_price) as min_price, MAX(asking_price) as max_price,
             AVG(asking_price) as avg_price
      FROM listings WHERE is_active = TRUE AND asking_price > 0
    `);
    const roomsRange = await pool.query(`
      SELECT MIN(rooms) as min_rooms, MAX(rooms) as max_rooms
      FROM listings WHERE is_active = TRUE AND rooms > 0
    `);
    const areaRange = await pool.query(`
      SELECT MIN(area_sqm) as min_area, MAX(area_sqm) as max_area
      FROM listings WHERE is_active = TRUE AND area_sqm > 0
    `);
    const dealStatuses = await pool.query(`
      SELECT deal_status, COUNT(*) as count
      FROM listings WHERE is_active = TRUE
      GROUP BY deal_status ORDER BY count DESC
    `);
    const messageStatuses = await pool.query(`
      SELECT message_status, COUNT(*) as count
      FROM listings WHERE is_active = TRUE
      GROUP BY message_status ORDER BY count DESC
    `);
    res.json({
      cities: cities.rows,
      price_range: priceRange.rows[0],
      rooms_range: roomsRange.rows[0],
      area_range: areaRange.rows[0],
      deal_statuses: dealStatuses.rows,
      message_statuses: messageStatuses.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/listings/search - Full listings search with comprehensive filters
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
      deal_status, message_status,
      sort_by,
      sort_order,
      limit, offset
    } = req.query;

    const limitVal = Math.min(parseInt(limit) || 50, 200);
    const offsetVal = parseInt(offset) || 0;

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
    if (deal_status) {
      paramCount++;
      conditions.push(`l.deal_status = $${paramCount}`);
      params.push(deal_status);
    }
    if (message_status) {
      paramCount++;
      conditions.push(`l.message_status = $${paramCount}`);
      params.push(message_status);
    }

    const whereClause = conditions.join(' AND ');

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

    const countQuery = `
      SELECT COUNT(*) as total
      FROM listings l
      JOIN complexes c ON l.complex_id = c.id
      WHERE ${whereClause}
    `;

    const dataQuery = `
      SELECT 
        l.id as listing_id,
        l.source, l.url, l.source_listing_id,
        l.asking_price, l.area_sqm, l.rooms, l.floor,
        l.price_per_sqm,
        l.days_on_market, l.price_changes, l.total_price_drop_percent,
        l.original_price,
        l.has_urgent_keywords, l.urgent_keywords_found,
        l.is_foreclosure, l.is_inheritance,
        l.ssi_score, l.ssi_time_score, l.ssi_price_score, l.ssi_indicator_score,
        l.address, l.city,
        l.first_seen, l.last_seen,
        l.deal_status, l.message_status,
        l.last_message_sent_at, l.last_reply_at, l.last_reply_text, l.notes,
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
      total: parseInt(countResult.rows[0].total),
      showing: listings.length,
      offset: offsetVal,
      listings
    });
  } catch (error) {
    logger.error('Listings search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
