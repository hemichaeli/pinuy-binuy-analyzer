require('dotenv').config();

// Railway private networking uses IPv6 - ensure Node.js resolves it
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

const app = express();
const PORT = process.env.PORT || 3000;

// Auto-migrate and seed on startup
async function initDatabase() {
  const maxRetries = 15;
  const retryDelay = 3000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      break;
    } catch (err) {
      logger.warn(`DB connection attempt ${i + 1}/${maxRetries} failed: ${err.message}`);
      if (i === maxRetries - 1) {
        logger.error('Could not connect to database after all retries');
        return false;
      }
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  try {
    // Check if tables exist
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'complexes'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      logger.info('Tables not found - running migration...');
      const schemaPath = path.join(__dirname, 'db', 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
      logger.info('Migration completed: all tables created');
    } else {
      logger.info('Tables already exist - skipping migration');
    }

    // Check if seed data needed
    const countCheck = await pool.query('SELECT COUNT(*) FROM complexes');
    if (parseInt(countCheck.rows[0].count) === 0) {
      logger.info('No data found - running seed...');
      const { seedWithPool } = require('./db/seed');
      await seedWithPool(pool);
      logger.info('Seed completed');
    } else {
      logger.info(`Database has ${countCheck.rows[0].count} complexes - skipping seed`);
    }
    
    return true;
  } catch (err) {
    logger.error(`Database init error: ${err.message}`);
    return false;
  }
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health') {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Routes
const projectRoutes = require('./routes/projects');
const opportunityRoutes = require('./routes/opportunities');
const scanRoutes = require('./routes/scan');
const alertRoutes = require('./routes/alerts');

app.use('/api/projects', projectRoutes);
app.use('/api', opportunityRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/alerts', alertRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM complexes');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: 'connected',
      complexes: parseInt(result.rows[0].count)
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      db: 'disconnected',
      error: err.message
    });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Pinuy Binuy Investment Analyzer API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      projects: 'GET /api/projects',
      project: 'GET /api/projects/:id',
      transactions: 'GET /api/projects/:id/transactions',
      listings: 'GET /api/projects/:id/listings',
      benchmark: 'GET /api/projects/:id/benchmark',
      opportunities: 'GET /api/opportunities',
      stressedSellers: 'GET /api/stressed-sellers',
      dashboard: 'GET /api/dashboard',
      scanRun: 'POST /api/scan/run',
      scanResults: 'GET /api/scan/results',
      alerts: 'GET /api/alerts'
    }
  });
});

// Error handler
app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start with DB init
async function start() {
  const dbReady = await initDatabase();
  if (!dbReady) {
    logger.warn('Starting without database - some features may be unavailable');
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Pinuy Binuy API running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Database: ${dbReady ? 'ready' : 'unavailable'}`);
  });
}

start();

module.exports = app;
