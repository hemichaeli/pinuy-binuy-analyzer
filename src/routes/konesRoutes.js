/**
 * KonesIsrael Routes - Receivership Property Data API
 * Phase 4.7: Integration with konesisrael.co.il for distressed property data
 */

const express = require('express');
const router = express.Router();
const konesIsraelService = require('../services/konesIsraelService');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * GET /api/kones/status
 * Get service status and statistics
 */
router.get('/status', async (req, res) => {
  try {
    const status = await konesIsraelService.getStatus();
    res.json({
      success: true,
      message: 'KonesIsrael receivership data service status',
      data: status
    });
  } catch (error) {
    logger.error(`KonesIsrael status error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/listings
 * Get all receivership listings
 */
router.get('/listings', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const listings = await konesIsraelService.fetchListings(forceRefresh);
    
    res.json({
      success: true,
      total: listings.length,
      showing: Math.min(limit, listings.length - offset),
      offset,
      data: listings.slice(offset, offset + limit)
    });
  } catch (error) {
    logger.error(`KonesIsrael listings error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/stats
 * Get detailed statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await konesIsraelService.getStatistics();
    
    res.json({
      success: true,
      data: {
        totalListings: stats.total,
        byPropertyType: stats.byPropertyType,
        byRegion: stats.byRegion,
        topCities: Object.entries(stats.byCity)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .reduce((acc, [city, count]) => ({ ...acc, [city]: count }), {}),
        urgentDeadlinesCount: stats.urgentDeadlines.length,
        urgentDeadlines: stats.urgentDeadlines.slice(0, 10)
      }
    });
  } catch (error) {
    logger.error(`KonesIsrael stats error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/search/city/:city
 * Search listings by city
 */
router.get('/search/city/:city', async (req, res) => {
  try {
    const { city } = req.params;
    const listings = await konesIsraelService.searchByCity(city);
    
    res.json({
      success: true,
      city,
      count: listings.length,
      data: listings
    });
  } catch (error) {
    logger.error(`KonesIsrael city search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/search/region/:region
 * Search listings by region
 */
router.get('/search/region/:region', async (req, res) => {
  try {
    const { region } = req.params;
    const listings = await konesIsraelService.searchByRegion(region);
    
    res.json({
      success: true,
      region,
      count: listings.length,
      data: listings
    });
  } catch (error) {
    logger.error(`KonesIsrael region search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/search/gush/:gush
 * Search listings by gush (and optionally helka)
 */
router.get('/search/gush/:gush', async (req, res) => {
  try {
    const gush = parseInt(req.params.gush);
    const helka = req.query.helka ? parseInt(req.query.helka) : null;
    
    const listings = await konesIsraelService.searchByGushHelka(gush, helka);
    
    res.json({
      success: true,
      gush,
      helka,
      count: listings.length,
      data: listings
    });
  } catch (error) {
    logger.error(`KonesIsrael gush search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/kones/check-address
 * Check if an address appears in receivership listings
 */
router.post('/check-address', async (req, res) => {
  try {
    const { city, street } = req.body;
    
    if (!city || !street) {
      return res.status(400).json({
        success: false,
        error: 'Both city and street are required'
      });
    }
    
    const matches = await konesIsraelService.checkAddress(city, street);
    
    res.json({
      success: true,
      query: { city, street },
      found: matches.length > 0,
      count: matches.length,
      data: matches,
      ssiImplication: matches.length > 0 ? {
        isReceivership: true,
        ssiBoost: 30,
        message: 'Property found in receivership listings - high distress indicator'
      } : null
    });
  } catch (error) {
    logger.error(`KonesIsrael address check error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/match-complexes
 * Match receivership listings with QUANTUM complexes
 */
router.get('/match-complexes', async (req, res) => {
  try {
    // Get all complexes from database
    const complexesResult = await pool.query(`
      SELECT id, city, street, address, name 
      FROM complexes 
      WHERE city IS NOT NULL
    `);
    
    const matches = await konesIsraelService.matchWithComplexes(complexesResult.rows);
    
    res.json({
      success: true,
      totalComplexes: complexesResult.rows.length,
      matchedComplexes: matches.length,
      matches: matches.slice(0, 50), // Limit response size
      summary: {
        message: matches.length > 0 
          ? `Found ${matches.length} complexes with potential receivership properties`
          : 'No matches found between complexes and receivership listings',
        ssiImplication: 'Matched properties should have their SSI boosted by 30 points'
      }
    });
  } catch (error) {
    logger.error(`KonesIsrael match complexes error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/kones/enhance-ssi/:complexId
 * Enhance SSI score for a complex if found in receivership listings
 */
router.post('/enhance-ssi/:complexId', async (req, res) => {
  try {
    const complexId = parseInt(req.params.complexId);
    
    // Get complex data
    const complexResult = await pool.query(
      'SELECT * FROM complexes WHERE id = $1',
      [complexId]
    );
    
    if (complexResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Complex not found'
      });
    }
    
    const complex = complexResult.rows[0];
    
    // Check if any units in this complex are in receivership
    const matches = await konesIsraelService.checkAddress(
      complex.city || '', 
      complex.street || complex.address || ''
    );
    
    if (matches.length > 0) {
      // Update complex with receivership data
      const currentSSI = complex.enhanced_ssi_score || complex.ssi_score || 0;
      const newSSI = Math.min(100, currentSSI + 30); // Add receivership boost, max 100
      
      await pool.query(`
        UPDATE complexes SET
          is_receivership = TRUE,
          enhanced_ssi_score = $1,
          ssi_enhancement_factors = COALESCE(ssi_enhancement_factors, '{}'::jsonb) || $2,
          ssi_last_enhanced = NOW(),
          distress_indicators = COALESCE(distress_indicators, '{}'::jsonb) || $3
        WHERE id = $4
      `, [
        newSSI,
        JSON.stringify({ konesisrael_matches: matches.length }),
        JSON.stringify({ 
          receivership_listings: matches.map(m => ({
            source: m.source,
            propertyType: m.propertyType,
            deadline: m.submissionDeadline,
            contact: m.contactPerson
          }))
        }),
        complexId
      ]);
      
      res.json({
        success: true,
        message: 'SSI enhanced with receivership data',
        complexId,
        previousSSI: currentSSI,
        newSSI,
        matchesFound: matches.length,
        receivershipListings: matches
      });
    } else {
      res.json({
        success: true,
        message: 'No receivership listings found for this complex',
        complexId,
        matchesFound: 0
      });
    }
  } catch (error) {
    logger.error(`KonesIsrael enhance SSI error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/kones/scan-all
 * Scan all complexes and update SSI with receivership data
 */
router.post('/scan-all', async (req, res) => {
  try {
    logger.info('KonesIsrael: Starting full complex scan...');
    
    // Get all complexes
    const complexesResult = await pool.query(`
      SELECT id, city, street, address, name, enhanced_ssi_score, ssi_score
      FROM complexes 
      WHERE city IS NOT NULL
    `);
    
    const matches = await konesIsraelService.matchWithComplexes(complexesResult.rows);
    
    let updated = 0;
    for (const match of matches) {
      try {
        const currentSSI = complexesResult.rows
          .find(c => c.id === match.complexId)?.enhanced_ssi_score || 
          complexesResult.rows.find(c => c.id === match.complexId)?.ssi_score || 0;
        
        const newSSI = Math.min(100, currentSSI + match.ssiBoost);
        
        await pool.query(`
          UPDATE complexes SET
            is_receivership = TRUE,
            enhanced_ssi_score = $1,
            ssi_enhancement_factors = COALESCE(ssi_enhancement_factors, '{}'::jsonb) || $2,
            ssi_last_enhanced = NOW()
          WHERE id = $3
        `, [
          newSSI,
          JSON.stringify({ konesisrael_matches: match.matchedListings }),
          match.complexId
        ]);
        
        updated++;
      } catch (err) {
        logger.warn(`Failed to update complex ${match.complexId}: ${err.message}`);
      }
    }
    
    res.json({
      success: true,
      message: 'Full scan completed',
      totalComplexes: complexesResult.rows.length,
      matchesFound: matches.length,
      complexesUpdated: updated
    });
  } catch (error) {
    logger.error(`KonesIsrael scan-all error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kones/urgent
 * Get urgent deadline listings (within 7 days)
 */
router.get('/urgent', async (req, res) => {
  try {
    const stats = await konesIsraelService.getStatistics();
    
    res.json({
      success: true,
      count: stats.urgentDeadlines.length,
      data: stats.urgentDeadlines,
      message: stats.urgentDeadlines.length > 0 
        ? `${stats.urgentDeadlines.length} receivership auctions closing within 7 days`
        : 'No urgent deadlines'
    });
  } catch (error) {
    logger.error(`KonesIsrael urgent error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/kones/login
 * Attempt login to KonesIsrael (for authenticated access)
 */
router.post('/login', async (req, res) => {
  try {
    const success = await konesIsraelService.login();
    
    res.json({
      success,
      message: success 
        ? 'Login successful - authenticated access enabled'
        : 'Login failed or not configured - using public access'
    });
  } catch (error) {
    logger.error(`KonesIsrael login error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
