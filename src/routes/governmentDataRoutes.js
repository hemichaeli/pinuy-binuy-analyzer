/**
 * Government Data Routes
 * Exposes real Israeli government data APIs
 * Version: 1.0.1
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
 * GET /api/gov/bankruptcy/search/:term
 * Search bankruptcy registry (חדלות פירעון)
 */
router.get('/bankruptcy/search/:term', async (req, res) => {
  try {
    const { term } = req.params;
    const type = req.query.type || 'individual'; // 'individual' or 'company'
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
    res.json({
      success: true,
      data: result
    });
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
    const { city, dateFrom, dateTo } = req.query;
    const result = await govService.monitorReceivershipAnnouncements({ city, dateFrom, dateTo });
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
      datasets: datasets.slice(0, 100) // Limit to first 100
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
    
    const resourceIds = govService.RESOURCE_IDS || {};
    const resourceId = resourceIds[resource];
    
    if (!resourceId) {
      return res.status(400).json({ 
        success: false, 
        error: `Unknown resource. Available: ${Object.keys(resourceIds).join(', ')}` 
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
    version: '1.0.1',
    sources: {
      dataGovIL: govService.DATA_GOV_BASE,
      insolvency: govService.INSOLVENCY_BASE,
      resourceIds: govService.RESOURCE_IDS
    },
    endpoints: {
      status: 'GET /api/gov/status - Test connectivity',
      liensSearch: 'GET /api/gov/liens/search/:term - Search liens',
      inheritanceSearch: 'GET /api/gov/inheritance/search/:term - Search inheritance',
      bankruptcySearch: 'GET /api/gov/bankruptcy/search/:term - Search bankruptcy',
      check: 'POST /api/gov/check - Comprehensive check (body: {name, ...})',
      receivership: 'GET /api/gov/receivership - Monitor announcements',
      datasets: 'GET /api/gov/datasets - List available datasets',
      query: 'GET /api/gov/query/:resource - Query specific resource'
    }
  });
});

module.exports = router;
