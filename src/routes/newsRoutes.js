/**
 * News & Regulation Routes - Phase 4.5
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getNewsService() {
  try {
    return require('../services/newsMonitorService');
  } catch (e) {
    logger.warn('News monitor service not available', { error: e.message });
    return null;
  }
}

// GET /api/news/status
router.get('/status', (req, res) => {
  const service = getNewsService();
  res.json({
    version: '4.5.0',
    service: 'News & Regulation Monitoring',
    available: !!service,
    rssFeedsConfigured: service ? Object.keys(service.RSS_FEEDS).length : 0,
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  });
});

// GET /api/news/rss
router.get('/rss', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const { filter, limit } = req.query;
    let items = await service.fetchAllRSSFeeds();
    if (filter === 'relevant') items = service.filterRelevantNews(items);
    if (limit) items = items.slice(0, parseInt(limit));
    res.json({ total: items.length, items });
  } catch (err) {
    logger.error('RSS fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/search/complex/:id
router.get('/search/complex/:id', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const complexId = parseInt(req.params.id);
    const complexResult = await pool.query('SELECT name, city FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const { name, city } = complexResult.rows[0];
    const result = await service.searchNewsForComplex(name, city);

    await pool.query(`UPDATE complexes SET last_news_check = NOW(), news_sentiment = $1, has_negative_news = $2 WHERE id = $3`,
      [result.overallSentiment || 'unknown', result.articles?.some(a => a.sentiment === 'negative') || false, complexId]);

    res.json(result);
  } catch (err) {
    logger.error('Complex news search failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/search/developer
router.post('/search/developer', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const { developerName } = req.body;
    if (!developerName) return res.status(400).json({ error: 'Developer name required' });
    const result = await service.searchNewsForDeveloper(developerName);
    res.json(result);
  } catch (err) {
    logger.error('Developer news search failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/regulation
router.get('/regulation', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const result = await service.getRegulationUpdates();
    res.json(result);
  } catch (err) {
    logger.error('Regulation fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/tama38
router.get('/tama38', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const result = await service.checkTama38Updates();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/pinuy-binuy-law
router.get('/pinuy-binuy-law', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const result = await service.checkPinuyBinuyLaw();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/tax-changes
router.get('/tax-changes', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const result = await service.checkTaxChanges();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/alerts/:complexId
router.post('/alerts/:complexId', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });

    const alerts = await service.generateNewsAlerts(complexResult.rows[0], pool);
    res.json({ complexId, alertsGenerated: alerts.length, alerts });
  } catch (err) {
    logger.error('News alert generation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/scan
router.post('/scan', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    res.json({ message: 'Daily news scan started', note: 'Running in background' });
    (async () => {
      try {
        await service.runDailyNewsScan(pool);
      } catch (err) {
        logger.error('Background news scan failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/alerts
router.get('/alerts', async (req, res) => {
  try {
    const { type, limit, unreadOnly } = req.query;
    let query = `SELECT * FROM alerts WHERE alert_type LIKE 'news%' OR alert_type IN ('developer_warning', 'negative_news')`;
    const params = [];
    let paramIndex = 1;
    if (type) { query += ` AND alert_type = $${paramIndex++}`; params.push(type); }
    if (unreadOnly === 'true') { query += ` AND is_read = FALSE`; }
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 50);

    const result = await pool.query(query, params);
    res.json({ total: result.rows.length, alerts: result.rows });
  } catch (err) {
    logger.error('News alerts query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
