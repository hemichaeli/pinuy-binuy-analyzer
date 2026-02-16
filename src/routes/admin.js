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

    // v4.15.0: Messaging system columns
    const msgCols = [
      ["deal_status", "VARCHAR(50) DEFAULT 'חדש'"],
      ["message_status", "VARCHAR(50) DEFAULT 'לא נשלחה'"],
      ["last_message_sent_at", "TIMESTAMP"],
      ["last_reply_at", "TIMESTAMP"],
      ["last_reply_text", "TEXT"],
      ["notes", "TEXT"]
    ];
    for (const [col, type] of msgCols) {
      try {
        await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS ${col} ${type}`);
        migrations.push(`listings.${col} ensured`);
      } catch (e) {
        migrations.push(`listings.${col}: ${e.message}`);
      }
    }

    // v4.15.0: Create listing_messages table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS listing_messages (
          id SERIAL PRIMARY KEY,
          listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
          direction VARCHAR(10) NOT NULL DEFAULT 'sent',
          message_text TEXT NOT NULL,
          sent_at TIMESTAMP DEFAULT NOW(),
          status VARCHAR(30) DEFAULT 'pending',
          yad2_conversation_id VARCHAR(100),
          error_message TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      migrations.push('listing_messages table created');
    } catch (e) {
      migrations.push(`listing_messages: ${e.message}`);
    }

    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_messages_listing ON listing_messages(listing_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_messages_direction ON listing_messages(direction)`);
      migrations.push('listing_messages indexes created');
    } catch (e) {
      migrations.push(`indexes: ${e.message}`);
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
    const allowed = /^(SELECT|ALTER|CREATE (INDEX|TABLE)|UPDATE complexes SET|UPDATE listings SET|DELETE FROM complexes|DELETE FROM alerts|DELETE FROM listings)/i;
    if (!allowed.test(query.trim())) {
      return res.status(403).json({ error: 'Only SELECT, ALTER, CREATE, UPDATE, and DELETE (complexes/alerts/listings) queries allowed' });
    }
    const result = await pool.query(query, params || []);
    res.json({ rowCount: result.rowCount, rows: result.rows?.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-cities - Normalize city name variants and remove duplicates
router.post('/cleanup-cities', async (req, res) => {
  try {
    const { dryRun } = req.body;
    const isDryRun = dryRun !== false;
    const results = [];

    // City normalization map
    const CITY_MAP = {
      'ראשלצ': 'ראשון לציון',
      'ראשון-לציון': 'ראשון לציון',
      'ראשון לציון (כפילות)': 'ראשון לציון',
      'ת"א': 'תל אביב',
      'תל-אביב': 'תל אביב',
      'תל אביב יפו': 'תל אביב',
      'תל אביב-יפו': 'תל אביב',
      'פ"ת': 'פתח תקווה',
      'פתח-תקווה': 'פתח תקווה',
      'ר"ג': 'רמת גן',
      'רמת-גן': 'רמת גן',
      'ב"ב': 'בני ברק',
      'בני-ברק': 'בני ברק',
      'ק. אונו': 'קריית אונו',
      'קרית אונו': 'קריית אונו',
      'ק. ביאליק': 'קריית ביאליק',
      'קרית ביאליק': 'קריית ביאליק',
      'ק. ים': 'קריית ים',
      'קרית ים': 'קריית ים',
      'ק. מוצקין': 'קריית מוצקין',
      'קרית מוצקין': 'קריית מוצקין',
      'ק. אתא': 'קריית אתא',
      'קרית אתא': 'קריית אתא'
    };

    // Find non-standard cities
    const allCities = await pool.query('SELECT DISTINCT city FROM complexes ORDER BY city');
    const toNormalize = [];
    for (const row of allCities.rows) {
      const canonical = CITY_MAP[row.city];
      if (canonical) {
        const count = await pool.query('SELECT COUNT(*) FROM complexes WHERE city = $1', [row.city]);
        toNormalize.push({ from: row.city, to: canonical, count: parseInt(count.rows[0].count) });
      }
    }

    if (isDryRun) {
      return res.json({
        mode: 'DRY RUN',
        cities_to_normalize: toNormalize,
        note: 'Send { "dryRun": false } to execute. Will normalize cities then run dedup.'
      });
    }

    // Step 1: Drop unique index temporarily
    try {
      await pool.query('DROP INDEX IF EXISTS idx_complexes_name_city');
      results.push('Dropped unique index idx_complexes_name_city');
    } catch (e) {
      results.push(`Index drop: ${e.message}`);
    }

    // Step 2: Normalize cities
    for (const item of toNormalize) {
      const upd = await pool.query('UPDATE complexes SET city = $1 WHERE city = $2', [item.to, item.from]);
      results.push(`${item.from} → ${item.to}: ${upd.rowCount} updated`);
    }

    // Step 3: Run dedup (same logic as /dedup endpoint)
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
    `);

    for (const row of toDelete.rows) {
      const kept = await pool.query(
        'SELECT id FROM complexes WHERE name = $1 AND city = $2 AND id != $3 ORDER BY updated_at DESC LIMIT 1',
        [row.name, row.city, row.id]
      );
      if (kept.rows.length > 0) {
        const keptId = kept.rows[0].id;
        await pool.query('UPDATE listings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE transactions SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE alerts SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        try { await pool.query('UPDATE buildings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]); } catch (e) {}
      }
    }

    const deleteResult = await pool.query('DELETE FROM complexes WHERE id = ANY($1)', [toDelete.rows.map(r => r.id)]);
    results.push(`Dedup: deleted ${deleteResult.rowCount} duplicates`);

    // Step 4: Recreate unique index
    try {
      await pool.query('CREATE UNIQUE INDEX idx_complexes_name_city ON complexes(name, city)');
      results.push('Recreated unique index idx_complexes_name_city');
    } catch (e) {
      results.push(`Index recreate: ${e.message}`);
    }

    const finalCount = await pool.query('SELECT COUNT(*) FROM complexes');
    res.json({
      mode: 'EXECUTED',
      results,
      remaining_complexes: parseInt(finalCount.rows[0].count)
    });

    logger.info('City cleanup completed', { results });
  } catch (err) {
    logger.error('City cleanup failed', { error: err.message });
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
    const isDryRun = dryRun !== false;

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

    const ids = toDelete.rows.map(r => r.id);
    if (ids.length === 0) {
      return res.json({ message: 'No duplicates found', deleted: 0 });
    }

    for (const row of toDelete.rows) {
      const kept = await pool.query(
        'SELECT id FROM complexes WHERE name = $1 AND city = $2 AND id != $3 ORDER BY updated_at DESC LIMIT 1',
        [row.name, row.city, row.id]
      );
      if (kept.rows.length > 0) {
        const keptId = kept.rows[0].id;
        await pool.query('UPDATE listings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE transactions SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        await pool.query('UPDATE alerts SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        try {
          await pool.query('UPDATE buildings SET complex_id = $1 WHERE complex_id = $2', [keptId, row.id]);
        } catch (e) { /* might not have FK */ }
      }
    }

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
