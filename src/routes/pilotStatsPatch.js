/**
 * Pilot Stats Patch — adds pilotWaSent + pilotReplied to /dashboard/api/stats
 * Loaded as middleware BEFORE dashboardRoute in index.js
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];

// Intercept /api/stats and augment with pilot data
router.get('/api/stats', async (req, res, next) => {
  // Store original json method
  const originalJson = res.json.bind(res);

  res.json = async function(data) {
    // Only augment successful stats responses
    if (data && data.success && data.data) {
      try {
        const { rows } = await pool.query(`
          SELECT
            COUNT(DISTINCT phone) FILTER (WHERE message_status = 'נשלחה') as wa_sent,
            COUNT(DISTINCT phone) FILTER (WHERE last_reply_at IS NOT NULL) as replied
          FROM listings
          WHERE complex_id = ANY($1) AND is_active = TRUE
        `, [PILOT_IDS]);
        data.data.pilotWaSent  = parseInt(rows[0]?.wa_sent)  || 0;
        data.data.pilotReplied = parseInt(rows[0]?.replied)  || 0;
      } catch (e) {
        data.data.pilotWaSent  = 0;
        data.data.pilotReplied = 0;
      }
    }
    return originalJson(data);
  };

  next();
});

module.exports = router;
