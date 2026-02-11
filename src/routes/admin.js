const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// POST /api/admin/migrate - Run pending migrations
router.post('/migrate', async (req, res) => {
  try {
    const migrations = [];
    
    // Add discovery_source column
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
      migrations.push('discovery_source column added');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        migrations.push(`discovery_source: ${e.message}`);
      }
    }

    // Add created_at column if missing
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
      migrations.push('created_at column ensured');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        migrations.push(`created_at: ${e.message}`);
      }
    }

    // Add declaration_date column
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
      migrations.push('declaration_date column added');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        migrations.push(`declaration_date: ${e.message}`);
      }
    }

    res.json({ 
      message: 'Migrations completed', 
      migrations,
      timestamp: new Date().toISOString()
    });
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
    
    res.json({
      table,
      columns: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sql - Execute SQL (DANGEROUS - for dev only)
router.post('/sql', async (req, res) => {
  try {
    const { query, params } = req.body;
    
    // Only allow SELECT, ALTER, CREATE INDEX
    const allowed = /^(SELECT|ALTER|CREATE INDEX|UPDATE complexes SET)/i;
    if (!allowed.test(query.trim())) {
      return res.status(403).json({ error: 'Only SELECT, ALTER, and CREATE INDEX queries allowed' });
    }
    
    const result = await pool.query(query, params || []);
    res.json({
      rowCount: result.rowCount,
      rows: result.rows?.slice(0, 100) // Limit response
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
