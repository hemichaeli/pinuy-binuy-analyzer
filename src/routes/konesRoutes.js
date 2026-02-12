/**
 * KonesIsrael API Routes
 * Provides endpoints for receivership data from konesisrael.co.il
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let konesIsraelService;
let loadError = null;

try {
  konesIsraelService = require('../services/konesIsraelService');
  logger.info('KonesIsrael service loaded successfully');
} catch (e) {
  loadError = e.message;
  logger.error('KonesIsrael service failed to load:', { error: e.message, stack: e.stack });
}

/**
 * GET /api/kones/status
 * Get service status
 */
router.get('/status', (req, res) => {
  if (!konesIsraelService) {
    return res.json({ 
      service: 'konesIsrael',
      available: false,
      error: 'Service not initialized',
      loadError: loadError
    });
  }
  res.json(konesIsraelService.getStatus());
});

/**
 * GET /api/kones/listings
 * Get all receivership listings (filtered for target cities)
 */
router.get('/listings', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const forceRefresh = req.query.refresh === 'true';
    const listings = await konesIsraelService.fetchReceivershipListings(forceRefresh);
    
    res.json({
      success: true,
      count: listings.length,
      listings: listings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kones/stats
 * Get statistics about receivership listings
 */
router.get('/stats', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const stats = await konesIsraelService.getStatistics();
    res.json({
      success: true,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kones/search/city/:city
 * Search receivership listings by city
 */
router.get('/search/city/:city', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const city = decodeURIComponent(req.params.city);
    const listings = await konesIsraelService.searchByCity(city);
    
    res.json({
      success: true,
      city: city,
      count: listings.length,
      listings: listings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kones/search/address
 * Search receivership listings by address
 */
router.get('/search/address', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const address = req.query.q;
    if (!address) {
      return res.status(400).json({ error: 'Missing address query parameter (q)' });
    }

    const listings = await konesIsraelService.searchByAddress(address);
    
    res.json({
      success: true,
      query: address,
      count: listings.length,
      listings: listings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kones/search/gush/:gush
 * Search receivership listings by gush/helka
 */
router.get('/search/gush/:gush', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const gush = req.params.gush;
    const helka = req.query.helka;
    
    const listings = await konesIsraelService.searchByGushHelka(gush, helka);
    
    res.json({
      success: true,
      gush: gush,
      helka: helka || 'any',
      count: listings.length,
      listings: listings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/kones/check-complex
 * Check if a complex has any receivership listings
 * Used by SSI enhancement
 */
router.post('/check-complex', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const { complex } = req.body;
    if (!complex) {
      return res.status(400).json({ error: 'Missing complex data' });
    }

    const result = await konesIsraelService.findReceivershipInComplex(complex);
    
    res.json({
      success: true,
      complexId: complex.id,
      complexName: complex.name || `${complex.address}, ${complex.city}`,
      ...result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/kones/login
 * Authenticate with KonesIsrael (for admin)
 */
router.post('/login', async (req, res) => {
  try {
    if (!konesIsraelService) {
      return res.status(503).json({ error: 'KonesIsrael service not available', loadError: loadError });
    }

    const success = await konesIsraelService.login();
    
    res.json({
      success: success,
      message: success ? 'Login successful' : 'Login failed'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
