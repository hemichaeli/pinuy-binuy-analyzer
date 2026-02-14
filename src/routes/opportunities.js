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

// GET /api/dashboard-json - Combined dashboard data (JSON API)
// NOTE: renamed from /dashboard to avoid conflict with HTML dashboard at /api/dashboard/
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
