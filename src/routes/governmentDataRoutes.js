/**
 * Government Data Routes
 * Exposes real Israeli government data APIs
 * Version: 1.0.0
 */

const express = require('express');
const router = express.Router();
const GovernmentDataService = require('../services/governmentDataService');

const govDataService = new GovernmentDataService();

/**
 * GET /api/gov/status
 * Get status of all government data sources
 */
router.get('/status', async (req, res) => {
  try {
    const summary = await govDataService.getDataSummary();
    res.json({
      success: true,
      message: 'Government data sources status',
      data: summary
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/liens/stats
 * Get liens (משכונות) statistics
 */
router.get('/liens/stats', async (req, res) => {
  try {
    const result = await govDataService.getLiensStatistics();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/inheritance/district/:district?
 * Get inheritance data by district
 */
router.get('/inheritance/district/:district?', async (req, res) => {
  try {
    const district = req.params.district || null;
    const result = await govDataService.getInheritanceByDistrict(district);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/inheritance/recent
 * Get recent inheritance activity
 */
router.get('/inheritance/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const result = await govDataService.getRecentInheritanceActivity(limit);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/receivership/news
 * Search news for receivership/foreclosure
 */
router.get('/receivership/news', async (req, res) => {
  try {
    const result = await govDataService.searchReceivershipNews();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/gov/mortgage-rates
 * Get BOI mortgage rate data URLs
 */
router.get('/mortgage-rates', (req, res) => {
  const urls = govDataService.getBOIMortgageDataUrls();
  res.json({
    success: true,
    source: 'בנק ישראל',
    data: urls
  });
});

/**
 * GET /api/gov/query/:resource
 * Generic query for any government resource
 */
router.get('/query/:resource', async (req, res) => {
  try {
    const { resource } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const resourceIds = {
      mashkonot: 'e7266a9c-fed6-40e4-a28e-8cddc9f44842',
      yerusha: '7691b4a2-fe1d-44ec-9f1b-9f2f0a15381b'
    };
    
    if (!resourceIds[resource]) {
      return res.status(400).json({ 
        success: false, 
        error: 'Unknown resource. Available: mashkonot, yerusha' 
      });
    }
    
    const result = await govDataService.queryDatastore(
      resourceIds[resource],
      {},
      limit,
      offset
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
