const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const fs = require('fs');
const path = require('path');

/**
 * POST /api/admin/migrate
 * Run database migrations
 */
router.post('/migrate', async (req, res) => {
  try {
    const { specific } = req.body;
    const migrationsDir = path.join(__dirname, '../db/migrations');
    
    let migrations = [];
    
    if (specific) {
      // Run specific migration
      migrations = [specific];
    } else {
      // Run all migrations
      migrations = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
    }
    
    const results = [];
    
    for (const file of migrations) {
      const filePath = path.join(migrationsDir, file);
      
      if (!fs.existsSync(filePath)) {
        results.push({ file, status: 'not_found' });
        continue;
      }
      
      const sql = fs.readFileSync(filePath, 'utf8');
      
      try {
        await pool.query(sql);
        results.push({ file, status: 'success' });
        logger.info(`Migration applied: ${file}`);
      } catch (err) {
        // Ignore "already exists" errors
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          results.push({ file, status: 'already_applied' });
        } else {
          results.push({ file, status: 'error', error: err.message });
          logger.error(`Migration failed: ${file}`, { error: err.message });
        }
      }
    }
    
    res.json({
      message: 'Migrations complete',
      results
    });
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/db-structure
 * Show database table structure
 */
router.get('/db-structure', async (req, res) => {
  try {
    const { table } = req.query;
    
    if (table) {
      const columns = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      
      res.json({
        table,
        columns: columns.rows
      });
    } else {
      const tables = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      
      res.json({
        tables: tables.rows.map(r => r.table_name)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/run-sql
 * Run arbitrary SQL (use with caution!)
 */
router.post('/run-sql', async (req, res) => {
  try {
    const { sql } = req.body;
    
    if (!sql) {
      return res.status(400).json({ error: 'SQL required' });
    }
    
    // Only allow safe operations
    const normalizedSql = sql.trim().toUpperCase();
    if (normalizedSql.startsWith('DROP') || normalizedSql.startsWith('TRUNCATE')) {
      return res.status(403).json({ error: 'Destructive operations not allowed' });
    }
    
    const result = await pool.query(sql);
    
    res.json({
      rowCount: result.rowCount,
      rows: result.rows?.slice(0, 100) // Limit results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/stats
 * Get comprehensive system statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const [complexes, transactions, listings, alerts, scans] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM complexes'),
      pool.query('SELECT COUNT(*) as count FROM transactions'),
      pool.query('SELECT COUNT(*) as count FROM listings'),
      pool.query('SELECT COUNT(*) as count FROM alerts'),
      pool.query('SELECT COUNT(*) as count FROM scan_logs')
    ]);
    
    const discoveredComplexes = await pool.query(
      `SELECT COUNT(*) as count FROM complexes WHERE discovery_source IS NOT NULL`
    ).catch(() => ({ rows: [{ count: 0 }] }));
    
    res.json({
      complexes: parseInt(complexes.rows[0].count),
      transactions: parseInt(transactions.rows[0].count),
      listings: parseInt(listings.rows[0].count),
      alerts: parseInt(alerts.rows[0].count),
      scans: parseInt(scans.rows[0].count),
      discoveredComplexes: parseInt(discoveredComplexes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
