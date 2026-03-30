/**
 * News & Regulation Routes - Phase 4.5
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getNewsService() {
  try { return require('../services/newsMonitorService'); }
  catch (e) { logger.warn('News service not available'); return null; }
}

// ── In-memory cache for news (1 hour TTL) ────────────────────────────────────
let newsCache = { data: null, ts: 0 };
const NEWS_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

// GET /api/news — main news feed for dashboard
router.get('/', async (req, res) => {
  try {
    const { refresh } = req.query;

    // Return cached if fresh (unless refresh requested)
    if (!refresh && newsCache.data && Date.now() - newsCache.ts < NEWS_CACHE_TTL) {
      return res.json({ success: true, data: newsCache.data, cached: true });
    }

    const allArticles = [];

    // Source 1: Perplexity
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    if (PERPLEXITY_KEY) {
      try {
        const axios = require('axios');
        const resp = await axios.post('https://api.perplexity.ai/chat/completions', {
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a real estate news aggregator for Israel. Return a JSON array of 10 news items. Each item must have: title, summary (2 sentences), source, url, category (one of: ועדות, מחירים, פינוי-בינוי, כללי), published_at (ISO date). Return ONLY valid JSON array, no markdown.' },
            { role: 'user', content: 'חדשות נדל"ן ישראל היום: פינוי בינוי, התחדשות עירונית, ועדות תכנון, אישורים חדשים, מחירי דירות. תן לי 10 כתבות עם כותרת, תקציר 2 משפטים, מקור ותאריך.' }
          ],
          max_tokens: 3000
        }, {
          headers: { 'Authorization': `Bearer ${PERPLEXITY_KEY}`, 'Content-Type': 'application/json' },
          timeout: 20000
        });
        const content = resp.data?.choices?.[0]?.message?.content || '[]';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const articles = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        allArticles.push(...articles.map(a => ({ ...a, source_type: 'perplexity' })));
      } catch (perplexityErr) {
        logger.warn('[News] Perplexity fetch failed:', perplexityErr.message);
      }
    }

    // Source 2: Committee updates from complexes (last 30 days)
    try {
      const { rows: committees } = await pool.query(`
        SELECT name, city, plan_stage, status, updated_at
        FROM complexes
        WHERE updated_at > NOW() - INTERVAL '30 days'
          AND plan_stage IS NOT NULL
        ORDER BY updated_at DESC LIMIT 10
      `);
      committees.forEach(c => {
        allArticles.push({
          title: `עדכון ועדה: ${c.name} (${c.city})`,
          summary: `המתחם ${c.name} ב${c.city} עודכן לשלב "${c.plan_stage}". סטטוס: ${c.status || 'פעיל'}.`,
          source: 'QUANTUM מעקב ועדות',
          url: null,
          category: 'ועדות',
          published_at: c.updated_at,
          source_type: 'committee'
        });
      });
    } catch (e) { logger.warn('[News] Committee query failed:', e.message); }

    // Source 3: RSS fallback
    const service = getNewsService();
    if (service) {
      try {
        let items = await service.fetchAllRSSFeeds();
        items = (service.filterRelevantNews ? service.filterRelevantNews(items) : items).slice(0, 10);
        items.forEach(item => {
          allArticles.push({
            title: item.title, summary: item.description || item.summary || '',
            source: item.source || item.feed || '', url: item.link || item.url || '',
            category: 'כללי', published_at: item.pubDate || item.date || new Date().toISOString(),
            source_type: 'rss'
          });
        });
      } catch (rssErr) {
        logger.warn('[News] RSS fallback failed:', rssErr.message);
      }
    }

    // No news source available
    // Sort by date descending
    allArticles.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

    // Cache and return
    if (allArticles.length > 0) {
      newsCache = { data: allArticles, ts: Date.now() };
    }
    res.json({ success: true, data: allArticles, total: allArticles.length });
  } catch (err) {
    logger.error('[News] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/news/status
router.get('/status', (req, res) => {
  const service = getNewsService();
  res.json({
    version: '4.5.0', service: 'News & Regulation Monitoring', available: !!service,
    rssSources: service ? Object.keys(service.RSS_FEEDS) : [],
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
    const complexResult = await pool.query('SELECT name, city FROM complexes WHERE id = $1', [req.params.id]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });
    const { name, city } = complexResult.rows[0];
    const result = await service.searchNewsForComplex(name, city);
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
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });
    const alerts = await service.generateNewsAlerts(complexResult.rows[0], pool);
    res.json({ complexId: req.params.complexId, alertsGenerated: alerts.length, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/scan
router.post('/scan', async (req, res) => {
  const service = getNewsService();
  if (!service) return res.status(503).json({ error: 'News service not available' });
  res.json({ message: 'Daily news scan started', note: 'Running in background' });
  (async () => {
    try { await service.runDailyNewsScan(pool); }
    catch (err) { logger.error('Background news scan failed', { error: err.message }); }
  })();
});

// GET /api/news/alerts
router.get('/alerts', async (req, res) => {
  try {
    const { limit, type, unreadOnly } = req.query;
    let query = `SELECT * FROM alerts WHERE alert_type LIKE 'news_%' OR alert_type IN ('developer_warning', 'negative_news')`;
    if (unreadOnly === 'true') query += ` AND is_read = FALSE`;
    if (type) query += ` AND alert_type = '${type}'`;
    query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit) || 50}`;
    const result = await pool.query(query);
    res.json({ total: result.rows.length, alerts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
