const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { getBenchmarkSummary } = require('../services/benchmarkService');

// GET /api/projects - List all projects with optional filters
router.get('/', async (req, res) => {
  try {
    const { city, status, region, sort, order, limit, offset, search } = req.query;
    
    let query = `
      SELECT 
        c.id, c.slug, c.name, c.city, c.region, c.neighborhood,
        c.status, c.planned_units, c.existing_units, c.multiplier,
        c.developer, c.developer_strength, c.iai_score,
        c.theoretical_premium_min, c.theoretical_premium_max,
        c.actual_premium, c.premium_gap,
        c.deposit_date, c.approval_date,
        c.updated_at,
        COUNT(DISTINCT l.id) FILTER (WHERE l.is_active) as active_listings,
        COUNT(DISTINCT t.id) as total_transactions,
        MAX(l.ssi_score) as max_ssi_score
      FROM complexes c
      LEFT JOIN listings l ON c.id = l.complex_id
      LEFT JOIN transactions t ON c.id = t.complex_id
    `;
    
    const conditions = [];
    const params = [];
    let paramCount = 0;
    
    if (city) {
      paramCount++;
      conditions.push(`c.city = $${paramCount}`);
      params.push(city);
    }
    if (status) {
      paramCount++;
      conditions.push(`c.status = $${paramCount}`);
      params.push(status);
    }
    if (region) {
      paramCount++;
      conditions.push(`c.region = $${paramCount}`);
      params.push(region);
    }
    if (search) {
      paramCount++;
      conditions.push(`(c.name ILIKE $${paramCount} OR c.city ILIKE $${paramCount} OR c.addresses ILIKE $${paramCount} OR c.developer ILIKE $${paramCount})`);
      params.push(`%${search}%`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY c.id';
    
    const validSorts = {
      'iai': 'c.iai_score',
      'units': 'c.planned_units',
      'name': 'c.name',
      'city': 'c.city',
      'status': 'c.status',
      'updated': 'c.updated_at',
      'premium_gap': 'c.premium_gap'
    };
    const sortField = validSorts[sort] || 'c.iai_score';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder} NULLS LAST`;
    
    const limitVal = Math.min(parseInt(limit) || 100, 200);
    const offsetVal = parseInt(offset) || 0;
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limitVal);
    paramCount++;
    query += ` OFFSET $${paramCount}`;
    params.push(offsetVal);
    
    const result = await pool.query(query, params);
    
    let countQuery = 'SELECT COUNT(*) FROM complexes c';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await pool.query(countQuery, params.slice(0, conditions.length ? paramCount - 2 : 0));
    
    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit: limitVal,
        offset: offsetVal
      }
    });
  } catch (err) {
    logger.error('Error fetching projects', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/projects/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_projects,
        COUNT(*) FILTER (WHERE status = 'deposited') as deposited,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'pre_deposit') as pre_deposit,
        COUNT(*) FILTER (WHERE status = 'planning') as planning,
        COUNT(*) FILTER (WHERE status = 'construction') as construction,
        SUM(planned_units) as total_planned_units,
        SUM(existing_units) as total_existing_units,
        AVG(iai_score) FILTER (WHERE iai_score > 0) as avg_iai,
        COUNT(*) FILTER (WHERE iai_score >= 70) as excellent_opportunities,
        COUNT(*) FILTER (WHERE iai_score >= 50 AND iai_score < 70) as good_opportunities,
        COUNT(*) FILTER (WHERE actual_premium IS NOT NULL) as benchmarked_complexes,
        AVG(actual_premium) FILTER (WHERE actual_premium IS NOT NULL) as avg_actual_premium,
        COUNT(DISTINCT city) as cities
      FROM complexes
    `);
    const cityCounts = await pool.query(`
      SELECT city, COUNT(*) as count, SUM(planned_units) as planned_units
      FROM complexes GROUP BY city ORDER BY count DESC
    `);
    res.json({ summary: stats.rows[0], by_city: cityCounts.rows });
  } catch (err) {
    logger.error('Error fetching stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/projects/cities
router.get('/cities', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT city, region, COUNT(*) as project_count
      FROM complexes GROUP BY city, region ORDER BY city
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error('Error fetching cities', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch cities' });
  }
});

// GET /api/projects/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isSlug = isNaN(id);
    const query = isSlug
      ? 'SELECT * FROM complexes WHERE slug = $1'
      : 'SELECT * FROM complexes WHERE id = $1';
    const result = await pool.query(query, [isSlug ? id : parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const project = result.rows[0];
    
    const buildings = await pool.query(
      'SELECT * FROM buildings WHERE complex_id = $1 ORDER BY address', [project.id]
    );
    const listingStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE is_active) as active_listings,
        AVG(asking_price) FILTER (WHERE is_active) as avg_asking_price,
        AVG(price_per_sqm) FILTER (WHERE is_active) as avg_price_per_sqm,
        MAX(ssi_score) as max_ssi,
        AVG(ssi_score) FILTER (WHERE ssi_score > 0) as avg_ssi,
        AVG(days_on_market) FILTER (WHERE is_active) as avg_days_on_market
      FROM listings WHERE complex_id = $1
    `, [project.id]);
    const txStats = await pool.query(`
      SELECT 
        COUNT(*) as total_transactions,
        AVG(price_per_sqm) as avg_price_per_sqm,
        MIN(transaction_date) as earliest,
        MAX(transaction_date) as latest,
        AVG(price_per_sqm) FILTER (WHERE transaction_date > NOW() - INTERVAL '1 year') as recent_avg_price_per_sqm
      FROM transactions WHERE complex_id = $1
    `, [project.id]);
    const alerts = await pool.query(`
      SELECT * FROM alerts WHERE complex_id = $1 ORDER BY created_at DESC LIMIT 5
    `, [project.id]);
    
    res.json({
      ...project,
      buildings: buildings.rows,
      listing_stats: listingStats.rows[0],
      transaction_stats: txStats.rows[0],
      recent_alerts: alerts.rows
    });
  } catch (err) {
    logger.error('Error fetching project', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// GET /api/projects/:id/transactions
router.get('/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    const { from, to, sort, limit } = req.query;
    const isSlug = isNaN(id);
    let complexId = isSlug 
      ? (await pool.query('SELECT id FROM complexes WHERE slug = $1', [id])).rows[0]?.id
      : parseInt(id);
    if (!complexId) return res.status(404).json({ error: 'Project not found' });
    
    let query = `SELECT t.*, b.address as building_address FROM transactions t
      LEFT JOIN buildings b ON t.building_id = b.id WHERE t.complex_id = $1`;
    const params = [complexId];
    let paramCount = 1;
    if (from) { paramCount++; query += ` AND t.transaction_date >= $${paramCount}`; params.push(from); }
    if (to) { paramCount++; query += ` AND t.transaction_date <= $${paramCount}`; params.push(to); }
    query += ` ORDER BY t.transaction_date ${sort === 'asc' ? 'ASC' : 'DESC'}`;
    paramCount++; query += ` LIMIT $${paramCount}`; params.push(Math.min(parseInt(limit) || 50, 200));
    
    const result = await pool.query(query, params);
    const periodSummary = await pool.query(`
      SELECT period, COUNT(*) as count, AVG(price_per_sqm) as avg_price_per_sqm,
        MIN(price_per_sqm) as min_price_per_sqm, MAX(price_per_sqm) as max_price_per_sqm
      FROM transactions WHERE complex_id = $1 AND period IS NOT NULL GROUP BY period
      ORDER BY CASE period WHEN 'before_declaration' THEN 1 WHEN 'after_declaration' THEN 2
        WHEN 'after_submission' THEN 3 WHEN 'after_deposit' THEN 4
        WHEN 'after_approval' THEN 5 WHEN 'after_permit' THEN 6 END
    `, [complexId]);
    
    res.json({ transactions: result.rows, period_summary: periodSummary.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Error fetching transactions', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/projects/:id/listings
router.get('/:id/listings', async (req, res) => {
  try {
    const { id } = req.params;
    const { active_only, min_ssi } = req.query;
    const isSlug = isNaN(id);
    let complexId = isSlug
      ? (await pool.query('SELECT id FROM complexes WHERE slug = $1', [id])).rows[0]?.id
      : parseInt(id);
    if (!complexId) return res.status(404).json({ error: 'Project not found' });
    
    let query = `SELECT l.*, b.address as building_address FROM listings l
      LEFT JOIN buildings b ON l.building_id = b.id WHERE l.complex_id = $1`;
    const params = [complexId];
    let paramCount = 1;
    if (active_only !== 'false') query += ' AND l.is_active = TRUE';
    if (min_ssi) { paramCount++; query += ` AND l.ssi_score >= $${paramCount}`; params.push(parseInt(min_ssi)); }
    query += ' ORDER BY l.ssi_score DESC, l.days_on_market DESC';
    
    const result = await pool.query(query, params);
    res.json({ listings: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Error fetching listings', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// GET /api/projects/:id/benchmark - Enhanced benchmark with service
router.get('/:id/benchmark', async (req, res) => {
  try {
    const { id } = req.params;
    const isSlug = isNaN(id);
    let complexId = isSlug
      ? (await pool.query('SELECT id FROM complexes WHERE slug = $1', [id])).rows[0]?.id
      : parseInt(id);
    if (!complexId) return res.status(404).json({ error: 'Project not found' });
    
    // Get enhanced benchmark summary from service
    const summary = await getBenchmarkSummary(complexId);
    
    // Also get building-level benchmarks if they exist
    const buildingBenchmarks = await pool.query(`
      SELECT bm.*, b.address as building_address, b.avg_price_sqm as building_price_sqm,
        CASE WHEN bm.benchmark_price_sqm > 0 
          THEN ROUND(((b.avg_price_sqm - bm.benchmark_price_sqm) / bm.benchmark_price_sqm * 100)::numeric, 1)
          ELSE NULL END as premium_percent
      FROM benchmarks bm JOIN buildings b ON bm.building_id = b.id
      WHERE bm.complex_id = $1 ORDER BY b.address
    `, [complexId]);
    
    res.json({
      summary: summary,
      building_benchmarks: buildingBenchmarks.rows,
      total_building_benchmarks: buildingBenchmarks.rows.length
    });
  } catch (err) {
    logger.error('Error fetching benchmarks', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch benchmarks' });
  }
});

module.exports = router;
