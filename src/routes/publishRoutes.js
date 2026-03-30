/**
 * Publish Routes — Multi-platform listing publication
 * POST /api/publish/multi   — publish listing to multiple platforms
 * GET  /api/publish/history — get publish history
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration ──────────────────────────────────────────────────────────
async function ensurePublishTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS publish_history (
      id SERIAL PRIMARY KEY,
      platform VARCHAR(50),
      listing_data JSONB,
      status VARCHAR(50) DEFAULT 'queued',
      result JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  logger.info('[Publish] Tables ready');
}
ensurePublishTables().catch(e => logger.error('[Publish] Migration error:', e.message));

// POST /api/publish/multi — publish to multiple platforms
router.post('/multi', async (req, res) => {
  try {
    const { platforms = [], listing = {} } = req.body;
    if (!platforms.length) {
      return res.status(400).json({ success: false, error: 'No platforms selected' });
    }

    const results = [];
    for (const platform of platforms) {
      // Insert into publish_history
      const { rows } = await pool.query(
        `INSERT INTO publish_history (platform, listing_data, status) VALUES ($1, $2, $3) RETURNING id`,
        [platform, JSON.stringify(listing), 'queued']
      );
      results.push({ platform, status: 'queued', id: rows[0].id });
      logger.info(`[Publish] Queued for ${platform}: ${listing.title || listing.address || 'untitled'}`);
    }

    res.json({ success: true, results });
  } catch (e) {
    logger.error('[Publish] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/publish/history — last 50 publish attempts
router.get('/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, platform, listing_data->>'title' as title, listing_data->>'address' as address,
              status, result, created_at
       FROM publish_history ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ success: true, data: rows, total: rows.length });
  } catch (e) {
    logger.error('[Publish] History error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
