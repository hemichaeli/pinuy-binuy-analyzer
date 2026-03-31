/**
 * Template Routes — DB-backed message template CRUD
 * GET    /api/templates        → list all templates
 * GET    /api/templates/:id    → get single template
 * POST   /api/templates        → create template
 * PATCH  /api/templates/:id    → update template
 * DELETE /api/templates/:id    → soft delete
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration + seed ────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'general',
        body TEXT NOT NULL,
        max_length INTEGER DEFAULT 480,
        inforu_template_id VARCHAR(50),
        inforu_template_text TEXT,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed from hardcoded templates (if table is empty)
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM message_templates');
    if (parseInt(count) === 0) {
      const seeds = [
        { key: 'seller_initial', name: 'פנייה ראשונית למוכר', category: 'sellers',
          body: 'שלום {name},\nראיתי שיש לך נכס למכירה ב{address}, {city}.\nאני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\nיש לנו קונים רציניים לאזור שלך.\nאשמח לשוחח - {agent_phone}\nQUANTUM Real Estate',
          max_length: 480 },
        { key: 'seller_followup', name: 'מעקב למוכר', category: 'sellers',
          body: 'שלום {name},\nפניתי אליך לפני מספר ימים בנוגע לנכס ב{address}.\nעדיין יש לנו עניין רב מצד קונים.\nנשמח לעזור - {agent_phone}\nQUANTUM',
          max_length: 320 },
        { key: 'buyer_opportunity', name: 'הזדמנות לקונה', category: 'buyers',
          body: 'שלום {name},\nיש לנו הזדמנות חדשה שמתאימה לך:\n{complex_name}, {city}\nמכפיל: x{multiplier} | סטטוס: {status}\nלפרטים: {agent_phone}\nQUANTUM',
          max_length: 320 },
        { key: 'kones_inquiry', name: 'פנייה לכונס', category: 'kones',
          body: 'לכבוד עו"ד {name},\nבנוגע לנכס בכינוס ב{address}, {city}.\nאנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\nיש לנו קונים פוטנציאליים מיידיים.\nנשמח לשיתוף פעולה - {agent_phone}',
          max_length: 480 },
      ];
      for (const s of seeds) {
        await pool.query(
          `INSERT INTO message_templates (key, name, category, body, max_length) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
          [s.key, s.name, s.category, s.body, s.max_length]
        );
      }
      logger.info('[Templates] Seeded 4 default templates');
    }
    logger.info('[Templates] Tables ready');
  } catch (e) { logger.error('[Templates] Migration error:', e.message); }
})();

// GET /api/templates
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM message_templates WHERE deleted_at IS NULL ORDER BY category, name`
    );
    res.json({ success: true, templates: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/templates/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM message_templates WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, template: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/templates
router.post('/', async (req, res) => {
  try {
    const { name, category, body, max_length, key, inforu_template_id, inforu_template_text } = req.body;
    if (!name || !body) return res.status(400).json({ success: false, error: 'name and body required' });
    const { rows } = await pool.query(
      `INSERT INTO message_templates (key, name, category, body, max_length, inforu_template_id, inforu_template_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [key || name.replace(/\s+/g, '_').toLowerCase(), name, category || 'general', body, max_length || 480,
       inforu_template_id || null, inforu_template_text || null]
    );
    res.json({ success: true, template: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/templates/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, category, body, max_length, inforu_template_id, inforu_template_text } = req.body;
    const sets = []; const params = []; let n = 1;
    if (name !== undefined) { sets.push(`name = $${n++}`); params.push(name); }
    if (category !== undefined) { sets.push(`category = $${n++}`); params.push(category); }
    if (body !== undefined) { sets.push(`body = $${n++}`); params.push(body); }
    if (max_length !== undefined) { sets.push(`max_length = $${n++}`); params.push(max_length); }
    if (inforu_template_id !== undefined) { sets.push(`inforu_template_id = $${n++}`); params.push(inforu_template_id); }
    if (inforu_template_text !== undefined) { sets.push(`inforu_template_text = $${n++}`); params.push(inforu_template_text); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'nothing to update' });
    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE message_templates SET ${sets.join(', ')} WHERE id = $${n} AND deleted_at IS NULL RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, template: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/templates/:id (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE message_templates SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, deleted: rows[0].id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
