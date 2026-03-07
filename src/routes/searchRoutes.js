const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /api/search/global - cross-entity search
router.post('/global', async (req, res) => {
  try {
    const { query = '', filters = {}, limit = 20 } = req.body;
    const q = `%${query}%`;
    const results = { leads: [], complexes: [], ads: [], errors: [] };

    if (!query && Object.keys(filters).length === 0) {
      return res.json({ success: true, results, query, filters, total: 0 });
    }

    // Search leads
    try {
      let leadQuery = `SELECT id, name, phone, email, status, source, created_at, 'lead' as entity_type FROM leads WHERE 1=1`;
      const params = [];
      let pi = 1;
      if (query) { leadQuery += ` AND (name ILIKE $${pi} OR phone ILIKE $${pi+1} OR email ILIKE $${pi+2})`; params.push(q,q,q); pi+=3; }
      if (filters.status) { leadQuery += ` AND status = $${pi}`; params.push(filters.status); pi++; }
      leadQuery += ` ORDER BY created_at DESC LIMIT $${pi}`; params.push(Math.min(parseInt(limit) || 20, 50));
      const { rows } = await pool.query(leadQuery, params);
      results.leads = rows;
    } catch (e) { results.errors.push('leads: ' + e.message); }

    // Search complexes - minimal safe columns only
    try {
      let cxQuery = `SELECT id, name, city, iai_score, status, developer, neighborhood, 'complex' as entity_type FROM complexes WHERE 1=1`;
      const params = [];
      let pi = 1;
      if (query) { cxQuery += ` AND (name ILIKE $${pi} OR city ILIKE $${pi+1} OR developer ILIKE $${pi+2} OR neighborhood ILIKE $${pi+3})`; params.push(q,q,q,q); pi+=4; }
      if (filters.city) { cxQuery += ` AND city ILIKE $${pi}`; params.push(`%${filters.city}%`); pi++; }
      if (filters.min_iai) { cxQuery += ` AND iai_score >= $${pi}`; params.push(parseFloat(filters.min_iai)); pi++; }
      if (filters.status) { cxQuery += ` AND status = $${pi}`; params.push(filters.status); pi++; }
      cxQuery += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${pi}`; params.push(Math.min(parseInt(limit) || 20, 50));
      const { rows } = await pool.query(cxQuery, params);
      results.complexes = rows;
    } catch (e) { results.errors.push('complexes: ' + e.message); }

    // Search yad2 ads
    try {
      let adQuery = `SELECT id, city, neighborhood, price, rooms, 'ad' as entity_type FROM yad2_listings WHERE 1=1`;
      const params = [];
      let pi = 1;
      if (query) { adQuery += ` AND (city ILIKE $${pi} OR neighborhood ILIKE $${pi+1})`; params.push(q,q); pi+=2; }
      if (filters.city) { adQuery += ` AND city ILIKE $${pi}`; params.push(`%${filters.city}%`); pi++; }
      if (filters.min_price) { adQuery += ` AND price >= $${pi}`; params.push(parseFloat(filters.min_price)); pi++; }
      if (filters.max_price) { adQuery += ` AND price <= $${pi}`; params.push(parseFloat(filters.max_price)); pi++; }
      adQuery += ` LIMIT $${pi}`; params.push(Math.min(parseInt(limit) || 20, 50));
      const { rows } = await pool.query(adQuery, params);
      results.ads = rows;
    } catch (e) { results.errors.push('ads: ' + e.message); }

    const total = results.leads.length + results.complexes.length + results.ads.length;
    results.total = total;

    // Save to search history
    try {
      await pool.query(
        `INSERT INTO search_history (query, filters, result_count, created_at) VALUES ($1, $2, $3, NOW())`,
        [query, JSON.stringify(filters), total]
      );
    } catch (e) { /* ignore */ }

    res.json({ success: true, results, query, filters, total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/search/suggestions
router.get('/suggestions', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q || q.length < 1) return res.json({ success: true, suggestions: [] });
    const like = `%${q}%`;
    const suggestions = new Set();

    const [cities, names] = await Promise.all([
      pool.query(`SELECT DISTINCT city FROM complexes WHERE city ILIKE $1 AND city IS NOT NULL LIMIT 6`, [like]).catch(() => ({ rows: [] })),
      pool.query(`SELECT name FROM complexes WHERE name ILIKE $1 AND name IS NOT NULL ORDER BY iai_score DESC NULLS LAST LIMIT 6`, [like]).catch(() => ({ rows: [] }))
    ]);
    cities.rows.forEach(r => r.city && suggestions.add(r.city));
    names.rows.forEach(r => r.name && suggestions.add(r.name));

    res.json({ success: true, suggestions: Array.from(suggestions).slice(0, 10) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/search/history
router.get('/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, query, filters, result_count, created_at FROM search_history ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ success: true, history: rows });
  } catch (err) {
    res.json({ success: true, history: [] });
  }
});

// POST /api/search/saved
router.post('/saved', async (req, res) => {
  try {
    const { name, query, filters } = req.body;
    if (!name || !query) return res.status(400).json({ success: false, error: 'name and query required' });
    const { rows } = await pool.query(
      `INSERT INTO saved_searches (name, query, filters, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [name, query, JSON.stringify(filters || {})]
    );
    res.json({ success: true, saved: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/search/saved
router.get('/saved', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM saved_searches ORDER BY created_at DESC`);
    res.json({ success: true, saved: rows });
  } catch (err) {
    res.json({ success: true, saved: [] });
  }
});

// DELETE /api/search/saved/:id
router.delete('/saved/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM saved_searches WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
