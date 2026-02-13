const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// POST /api/admin/migrate - Run pending migrations
router.post('/migrate', async (req, res) => {
  try {
    const migrations = [];
    
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
      migrations.push('discovery_source column added');
    } catch (e) {
      if (!e.message.includes('already exists')) migrations.push(`discovery_source: ${e.message}`);
    }

    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
      migrations.push('created_at column ensured');
    } catch (e) {
      if (!e.message.includes('already exists')) migrations.push(`created_at: ${e.message}`);
    }

    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
      migrations.push('declaration_date column added');
    } catch (e) {
      if (!e.message.includes('already exists')) migrations.push(`declaration_date: ${e.message}`);
    }

    res.json({ message: 'Migrations completed', migrations, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/schema - View table schema
router.get('/schema/:table', async (req, res) => {
  try {
    const { table } = req.params;
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    res.json({ table, columns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sql - Execute SQL (dev only)
router.post('/sql', async (req, res) => {
  try {
    const { query, params } = req.body;
    const allowed = /^(SELECT|ALTER|CREATE INDEX|UPDATE complexes SET)/i;
    if (!allowed.test(query.trim())) {
      return res.status(403).json({ error: 'Only SELECT, ALTER, and CREATE INDEX queries allowed' });
    }
    const result = await pool.query(query, params || []);
    res.json({ rowCount: result.rowCount, rows: result.rows?.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/duplicates - Show duplicate complexes
router.get('/duplicates', async (req, res) => {
  try {
    const dupes = await pool.query(`
      SELECT name, city, COUNT(*) as cnt,
        array_agg(id ORDER BY id) as ids,
        array_agg(updated_at ORDER BY id) as updated_dates,
        array_agg(COALESCE(discovery_source, 'original') ORDER BY id) as sources
      FROM complexes
      GROUP BY name, city
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
    `);

    const uniqueCounts = await pool.query(`
      SELECT COUNT(*) as total, COUNT(DISTINCT name) as unique_names,
        COUNT(DISTINCT CONCAT(name, '|', city)) as unique_name_city
      FROM complexes
    `);

    res.json({
      total_complexes: parseInt(uniqueCounts.rows[0].total),
      unique_name_city: parseInt(uniqueCounts.rows[0].unique_name_city),
      duplicates_to_remove: parseInt(uniqueCounts.rows[0].total) - parseInt(uniqueCounts.rows[0].unique_name_city),
      duplicate_groups: dupes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/dedup - Remove duplicate complexes (keep most recently updated)
router.post('/dedup', async (req, res) => {
  try {
    const { dryRun } = req.body;
    const isDryRun = dryRun !== false; // Default to dry run for safety

    // Find IDs to delete: keep the one with most data (most recent update, or has perplexity summary)
    const toDelete = await pool.query(`
      WITH ranked AS (
        SELECT id, name, city,
          ROW_NUMBER() OVER (
            PARTITION BY name, city 
            ORDER BY 
              CASE WHEN perplexity_summary IS NOT NULL THEN 1 ELSE 0 END DESC,
              CASE WHEN iai_score > 0 THEN 1 ELSE 0 END DESC,
              updated_at DESC NULLS LAST,
              id ASC
          ) as rn
        FROM complexes
      )
      SELECT id, name, city FROM ranked WHERE rn > 1
      ORDER BY name, city
    `);

    if (isDryRun) {
      return res.json({
        mode: 'DRY RUN',
        would_delete: toDelete.rows.length,
        would_keep: (await pool.query('SELECT COUNT(*) FROM complexes')).rows[0].count - toDelete.rows.length,
        sample_deletions: toDelete.rows.slice(0, 30),
        note: 'Send { "dryRun": false } to actually delete'
      });
    }

    // Actually delete
    const ids = toDelete.rows.map(r => r.id);
    if (ids.length === 0) {
      return res.json({ message: 'No duplicates found', deleted: 0 });
    }

    // First update foreign keys to point to the kept record
    for (const row of toDelete.rows) {
      // Find the kept ID for this name+city
      const kept = await pool.query(
        'SELECT id FROM complexes WHERE name = $1 AND city = $2 AND id != $3 ORDER BY updated_at DESC LIMIT 1',
        [row.name, row.city, row.id]
      );
      if (kept.rows.length > 0) {
        const keptId = kept.rows[0].id;
        // Move related data to kept record
        await pool.query('UPDATE listings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE transactions SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE alerts SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        try {
          await pool.query('UPDATE buildings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        } catch (e) { /* might not have FK */ }
      }
    }

    // Delete duplicates
    const deleteResult = await pool.query(
      'DELETE FROM complexes WHERE id = ANY($1)',
      [ids]
    );

    const newCount = await pool.query('SELECT COUNT(*) FROM complexes');

    res.json({
      mode: 'EXECUTED',
      deleted: deleteResult.rowCount,
      remaining_complexes: parseInt(newCount.rows[0].count),
      note: 'Duplicate complexes removed, related data preserved'
    });

    logger.info(`Dedup: deleted ${deleteResult.rowCount} duplicate complexes`);
  } catch (err) {
    logger.error('Dedup failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats - Quick DB stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM complexes) as complexes,
        (SELECT COUNT(*) FROM transactions) as transactions,
        (SELECT COUNT(*) FROM listings WHERE is_active = true) as active_listings,
        (SELECT COUNT(*) FROM alerts WHERE is_read = false) as unread_alerts,
        (SELECT COUNT(*) FROM scan_logs) as total_scans,
        (SELECT COUNT(DISTINCT city) FROM complexes) as cities
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
