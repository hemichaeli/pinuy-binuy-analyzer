/**
 * Reminder Routes — Dashboard reminders widget
 * GET  /api/reminders          — list reminders (filterable by status)
 * POST /api/reminders          — create a reminder
 * PATCH /api/reminders/:id     — update reminder status
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration ──────────────────────────────────────────────────────────
async function ensureReminderTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255),
      body TEXT,
      due_at TIMESTAMPTZ,
      status VARCHAR(50) DEFAULT 'pending',
      contact_id INTEGER,
      complex_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at)`);
  logger.info('[Reminders] Tables ready');
}
ensureReminderTables().catch(e => logger.error('[Reminders] Migration error:', e.message));

// GET /api/reminders — list reminders
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM reminders';
    const params = [];
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    query += ' ORDER BY due_at ASC NULLS LAST LIMIT 200';
    const { rows } = await pool.query(query, params);
    res.json({ success: true, reminders: rows, total: rows.length });
  } catch (e) {
    logger.error('[Reminders] List error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/reminders — create reminder
router.post('/', async (req, res) => {
  try {
    const { title, body, due_at, contact_id, complex_id } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title required' });
    const { rows } = await pool.query(
      `INSERT INTO reminders (title, body, due_at, contact_id, complex_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, body || null, due_at || null, contact_id || null, complex_id || null]
    );
    res.json({ success: true, reminder: rows[0] });
  } catch (e) {
    logger.error('[Reminders] Create error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/reminders/:id — update status
router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'status required' });
    const { rows } = await pool.query(
      'UPDATE reminders SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, reminder: rows[0] });
  } catch (e) {
    logger.error('[Reminders] Update error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
