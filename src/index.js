require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { logger } = require('./services/logger');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Pinuy Binuy API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
