/**
 * Government Data Routes
 * Exposes real Israeli government data APIs
 * Version: 2.0.0
 */

const express = require('express');
const router = express.Router();
const govService = require('../services/governmentDataService');

/**
 * GET /api/gov/status
 * Test connectivity to all government data sources
 */
router.get('/status', async (req, res) => {
  try {
    const result = await govService.testGovernmentConnectivity();
    res.json({
      success: true,
      message: 'Government data sources status',
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/summary
 * Get comprehensive data summary
 */
router.get('/summary', async (req, res) => {
  try {
    const result = await govService.getDataSummary();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/liens/search/:term
 * Search liens registry (רשם המשכונות)
 */
router.get('/liens/search/:term', async (req, res) => {
  try {
    const { term } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const result = await govService.searchLiensRegistry(term, { limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/liens/stats
 * Get liens registry statistics
 */
router.get('/liens/stats', async (req, res) => {
  try {
    const result = await govService.queryDatastore(govService.RESOURCE_IDS.mashkonot, { limit: 1 });
    res.json({
      success: true,
      source: 'data.gov.il - רשם המשכונות',
      totalRecords: result.total || 0,
      fields: result.fields?.map(f => ({ id: f.id, type: f.type })) || [],
      sampleRecord: result.records?.[0] || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/inheritance/search/:term
 * Search inheritance registry (רשם הירושות)
 */
router.get('/inheritance/search/:term', async (req, res) => {
  try {
    const { term } = req.params;
    const limit = parseInt(req.query.limit) || 30;
    const result = await govService.searchInheritanceRegistry(term, { limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/inheritance/stats
 * Get inheritance registry statistics
 */
router.get('/inheritance/stats', async (req, res) => {
  try {
    const result = await govService.queryDatastore(govService.RESOURCE_IDS.yerusha, { limit: 100 });
    
    const byDistrict = {};
    const byStatus = {};
    
    for (const record of result.records || []) {
      const district = (record['מחוז'] || 'לא ידוע').trim();
      const status = (record['החלטת רשם'] || 'לא ידוע').trim();
      byDistrict[district] = (byDistrict[district] || 0) + 1;
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    
    res.json({
      success: true,
      source: 'data.gov.il - רשם הירושות',
      totalRecords: result.total || 0,
      sampleSize: result.records?.length || 0,
      byDistrict,
      byStatus,
      fields: result.fields?.map(f => ({ id: f.id, type: f.type })) || []
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/bankruptcy/search/:term
 * Search bankruptcy registry (חדלות פירעון)
 */
router.get('/bankruptcy/search/:term', async (req, res) => {
  try {
    const { term } = req.params;
    const type = req.query.type || 'individual';
    const result = await govService.searchBankruptcyRegistry(term, type);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/gov/check
 * Comprehensive government check for an entity
 * Body: { name, idNumber?, companyNumber?, address?, city? }
 */
router.post('/check', async (req, res) => {
  try {
    const entity = req.body;
    if (!entity.name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const result = await govService.comprehensiveGovernmentCheck(entity);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/receivership
 * Monitor receivership announcements
 */
router.get('/receivership', async (req, res) => {
  try {
    const { city, searchTerm, dateFrom, dateTo } = req.query;
    const result = await govService.monitorReceivershipAnnouncements({ city, searchTerm, dateFrom, dateTo });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/datasets
 * Get list of available data.gov.il datasets
 */
router.get('/datasets', async (req, res) => {
  try {
    const datasets = await govService.getAvailableDatasets();
    res.json({
      success: true,
      count: datasets.length,
      datasets: datasets.slice(0, 100)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/query/:resource
 * Generic query for any data.gov.il resource
 */
router.get('/query/:resource', async (req, res) => {
  try {
    const { resource } = req.params;
    const { q, limit = 100, offset = 0 } = req.query;
    
    const resourceId = govService.RESOURCE_IDS[resource];
    
    if (!resourceId) {
      return res.status(400).json({ 
        success: false, 
        error: `Unknown resource. Available: ${Object.keys(govService.RESOURCE_IDS).join(', ')}` 
      });
    }
    
    const result = await govService.searchDataGovIL(resourceId, {
      q,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/info
 * Get API information and resource IDs
 */
router.get('/info', (req, res) => {
  res.json({
    success: true,
    version: '2.0.0',
    sources: {
      dataGovIL: govService.DATA_GOV_BASE,
      insolvency: govService.INSOLVENCY_BASE,
      resourceIds: govService.RESOURCE_IDS,
      newsSources: Object.keys(govService.NEWS_SOURCES)
    },
    endpoints: {
      status: 'GET /api/gov/status - Test connectivity',
      summary: 'GET /api/gov/summary - Data summary',
      liensSearch: 'GET /api/gov/liens/search/:term - Search liens',
      liensStats: 'GET /api/gov/liens/stats - Liens statistics',
      inheritanceSearch: 'GET /api/gov/inheritance/search/:term - Search inheritance',
      inheritanceStats: 'GET /api/gov/inheritance/stats - Inheritance statistics',
      bankruptcySearch: 'GET /api/gov/bankruptcy/search/:term - Search bankruptcy',
      check: 'POST /api/gov/check - Comprehensive check (body: {name, ...})',
      receivership: 'GET /api/gov/receivership - Monitor announcements',
      datasets: 'GET /api/gov/datasets - List available datasets',
      query: 'GET /api/gov/query/:resource - Query specific resource'
    },
    notes: {
      liens: 'רשם המשכונות - 8M+ records, contains registration metadata',
      inheritance: 'רשם הירושות - 1.2M+ records, contains request metadata',
      bankruptcy: 'חדלות פירעון - Requires browser access due to SSL',
      receivership: 'Monitored via news RSS feeds'
    }
  });
});

module.exports = router;
