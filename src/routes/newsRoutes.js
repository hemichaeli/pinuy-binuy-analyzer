/**
 * News & Regulation Routes - Phase 4.5
 * API endpoints for news monitoring and regulation updates
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
    rssSources: service ? Object.keys(service.RSS_FEEDS) : [],
    keywordCategories: service ? Object.keys(service.RELEVANT_KEYWORDS) : [],
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
  });
});

// GET /api/news/rss - Fetch latest RSS news
router.get('/rss', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const { filter, limit } = req.query;
    let items = await service.fetchAllRSSFeeds();
    
    if (filter === 'relevant') {
      items = service.filterRelevantNews(items);
    }
    
    if (limit) {
      items = items.slice(0, parseInt(limit));
    }

    res.json({ total: items.length, items });
  } catch (err) {
    logger.error('RSS fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/search/complex/:id - Search news for a complex
router.get('/search/complex/:id', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const complexId = parseInt(req.params.id);
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    
    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const complex = complexResult.rows[0];
    const news = await service.searchNewsForComplex(complex.name, complex.city);

    // Update complex with news sentiment
    if (news.overallSentiment) {
      await pool.query(`
        UPDATE complexes SET 
          last_news_check = NOW(),
          news_sentiment = $1,
          has_negative_news = $2
        WHERE id = $3
      `, [news.overallSentiment, news.overallSentiment === 'negative', complexId]);
    }

    res.json({ complexId, complexName: complex.name, city: complex.city, ...news });
  } catch (err) {
    logger.error('Complex news search failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/search/developer - Search news for a developer
router.post('/search/developer', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const { developerName } = req.body;
    if (!developerName) return res.status(400).json({ error: 'Developer name required' });

    const news = await service.searchNewsForDeveloper(developerName);
    res.json(news);
  } catch (err) {
    logger.error('Developer news search failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/regulation - Get regulation updates
router.get('/regulation', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const updates = await service.getRegulationUpdates();
    res.json(updates);
  } catch (err) {
    logger.error('Regulation fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/tama38 - Get Tama 38 status
router.get('/tama38', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const status = await service.checkTama38Updates();
    res.json(status);
  } catch (err) {
    logger.error('Tama 38 check failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/pinuy-binuy-law - Get Pinuy Binuy law updates
router.get('/pinuy-binuy-law', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const law = await service.checkPinuyBinuyLaw();
    res.json(law);
  } catch (err) {
    logger.error('Pinuy Binuy law check failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/tax-changes - Get tax law changes
router.get('/tax-changes', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const taxes = await service.checkTaxChanges();
    res.json(taxes);
  } catch (err) {
    logger.error('Tax changes check failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/alerts/:complexId - Generate news alerts for a complex
router.post('/alerts/:complexId', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    
    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const alerts = await service.generateNewsAlerts(complexResult.rows[0], pool);
    res.json({ complexId, alertsGenerated: alerts.length, alerts });
  } catch (err) {
    logger.error('News alert generation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/scan - Trigger daily news scan
router.post('/scan', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });

  try {
    res.json({ message: 'Daily news scan started', note: 'Running in background' });

    (async () => {
      try {
        const results = await service.runDailyNewsScan(pool);
        logger.info('Manual news scan complete', results);
      } catch (err) {
        logger.error('Background news scan failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/alerts - Get recent news alerts
router.get('/alerts', async (req, res) => {
  try {
    const { limit, severity, type } = req.query;
    let query = `SELECT * FROM alerts WHERE alert_type LIKE 'news_%' OR alert_type IN ('negative_news', 'developer_warning')`;
    const params = [];
    let paramIndex = 1;

    if (severity) {
      query += ` AND severity = $${paramIndex++}`;
      params.push(severity);
    }

    if (type) {
      query += ` AND alert_type = $${paramIndex++}`;
      params.push(type);
    }

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
