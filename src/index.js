require('dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { logger } = require('./services/logger');
const pool = require('./db/pool');
const notificationService = require('./services/notificationService');

const app = express();
const PORT = process.env.PORT || 3000;

// Version info
const VERSION = '4.8.2';
const BUILD = '2026-02-12-v4.8.2-full-perplexity-db';

async function runAutoMigrations() {
  try {
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE complexes ALTER COLUMN created_at SET DEFAULT NOW()`);
    
    // Phase 4.5: Enhanced data source columns
    const phase45Columns = [
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_avg_price_sqm INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_price_trend DECIMAL(5,2)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_madlan_update TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_officially_declared BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_track VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_declaration_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_plan_number VARCHAR(100)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_certainty_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_last_verified TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS committee_last_checked TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_detected BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_decision TEXT',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_impact VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_company_number VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_status VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_level VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_last_verified TIMESTAMP'
    ];
    
    for (const sql of phase45Columns) {
      try {
        await pool.query(sql);
      } catch (e) {
        // Column might already exist
      }
    }
    
    logger.info('Auto-migrations completed (Phase 4.5 columns)');
  } catch (error) {
    logger.error('Auto-migration error:', error.message);
  }
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '50mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});
app.use('/api/', limiter);

// Health check - always first
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      version: VERSION,
      build: BUILD
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      version: VERSION
    });
  }
});

// Debug endpoint
app.get('/api/debug', async (req, res) => {
  res.json({
    version: VERSION,
    build: BUILD,
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      hasPerplexityKey: !!process.env.PERPLEXITY_API_KEY,
      hasDbUrl: !!process.env.DATABASE_URL
    }
  });
});

// Route loading with error handling
function loadRoute(routePath, mountPath) {
  try {
    const route = require(routePath);
    app.use(mountPath, route);
    logger.info(`✅ Loaded route: ${mountPath}`);
    return true;
  } catch (error) {
    logger.error(`❌ Failed to load route ${mountPath}: ${error.message}`);
    return false;
  }
}

// Load all routes
async function loadRoutes() {
  const routes = [
    // Core routes
    ['./routes/complexes', '/api/complexes'],
    ['./routes/transactions', '/api/transactions'],
    ['./routes/scan', '/api/scan'],
    ['./routes/yad2', '/api/yad2'],
    ['./routes/kones', '/api/kones'],
    
    // Analytics routes
    ['./routes/opportunities', '/api/opportunities'],
    ['./routes/stressed-sellers', '/api/stressed-sellers'],
    ['./routes/insights', '/api/insights'],
    
    // Phase 4.5: Enhanced data sources
    ['./routes/madlan', '/api/madlan'],
    ['./routes/official-status', '/api/official-status'],
    ['./routes/committee-tracker', '/api/committee'],
    ['./routes/developer-intel', '/api/developer'],
    ['./routes/notifications', '/api/notifications'],
    
    // Phase 4.6: Mavat integration
    ['./routes/mavat', '/api/mavat'],
    
    // Phase 4.8: Perplexity DB integration
    ['./routes/perplexity-db', '/api/perplexity']
  ];
  
  let loaded = 0;
  let failed = 0;
  
  for (const [routePath, mountPath] of routes) {
    if (loadRoute(routePath, mountPath)) {
      loaded++;
    } else {
      failed++;
    }
  }
  
  logger.info(`Routes loaded: ${loaded} success, ${failed} failed`);
  return { loaded, failed };
}

// API status endpoint
app.get('/api/status', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT COUNT(*) as count FROM complexes');
    const complexCount = parseInt(dbResult.rows[0].count);
    
    res.json({
      status: 'operational',
      version: VERSION,
      build: BUILD,
      database: {
        connected: true,
        complexes: complexCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      version: VERSION,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    version: VERSION
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    version: VERSION
  });
});

async function start() {
  logger.info(`Starting QUANTUM Backend v${VERSION}`);
  logger.info(`Build: ${BUILD}`);
  
  await runAutoMigrations();
  await loadRoutes();
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
  });
}

start();

module.exports = app;