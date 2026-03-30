/**
 * Settings Routes — Dashboard settings management
 * GET  /api/settings → return current settings
 * POST /api/settings → upsert settings
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration ──────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Seed defaults
    const defaults = [
      ['scan_facebook_enabled', 'true'],
      ['scan_yad2_enabled', 'true'],
      ['scan_homeless_enabled', 'true'],
      ['scan_kones_enabled', 'true'],
      ['scan_frequency_hours', '4'],
      ['scan_rate_limit_ms', '2000'],
      ['alert_email_enabled', 'true'],
      ['alert_whatsapp_enabled', 'true'],
      ['alert_trello_email', ''],
      ['profile_name', ''],
      ['profile_role', ''],
      ['profile_email', ''],
      ['profile_phone', ''],
    ];
    for (const [k, v] of defaults) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [k, v]
      );
    }
    logger.info('[Settings] Tables ready');
  } catch (e) { logger.error('[Settings] Migration error:', e.message); }
})();

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings ORDER BY key');
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/settings
router.post('/', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'body must be a JSON object' });
    }
    let count = 0;
    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== 'string' || key.length > 100) continue;
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(value)]
      );
      count++;
    }
    res.json({ success: true, updated: count });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
