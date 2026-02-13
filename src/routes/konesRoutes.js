/**
 * KonesIsrael Routes - Receivership Property Data API
 * Phase 4.9: Dual-source scanning (Claude + Perplexity)
 * 
 * Architecture:
 * - GET /listings reads from DB (kones_listings table)
 * - POST /import adds data manually or from Claude web search
 * - POST /scan-complexes uses Perplexity AI to find receiverships near complexes
 * - POST /scan-city uses Perplexity AI to scan specific city
 * - Live scraping of konesisrael.co.il blocked by SiteGround CAPTCHA
 */

const express = require('express');
const router = express.Router();
const konesIsraelService = require('../services/konesIsraelService');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * GET /api/kones/status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await konesIsraelService.getStatus();
    res.json({ success: true, message: 'KonesIsrael receivership data service', data: status });
  } catch (error) {
    logger.error(`KonesIsrael status error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/listings
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
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kones/import
 * Import receivership listings into database
 * Body: { listings: [{ propertyType, city, address, region, submissionDeadline, ... }] }
 * 
 * Use this to manually add data from konesisrael.co.il or Perplexity searches
 */
router.post('/import', async (req, res) => {
  try {
    const { listings } = req.body;
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Body must contain "listings" array with at least one item',
        example: {
          listings: [{
            propertyType: 'דירה',
            city: 'תל אביב',
            address: 'רחוב הרצל 10',
            region: 'מרכז',
            submissionDeadline: '2026-03-15',
            gushHelka: 'גוש 1234 חלקה 56',
            contactPerson: 'עו"ד כהן',
            email: 'lawyer@example.com',
            phone: '03-1234567'
          }]
        }
      });
    }

    const result = await konesIsraelService.importListings(listings);
    
    logger.info(`KonesIsrael: Imported ${result.imported} listings (${result.skipped} skipped)`);
    
    res.json({
      success: true,
      message: `Imported ${result.imported} listings`,
      ...result
    });
  } catch (error) {
    logger.error(`KonesIsrael import error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/kones/listings/:id
 * Deactivate a listing (soft delete)
 */
router.delete('/listings/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    const result = await pool.query(
      'UPDATE kones_listings SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }
    
    // Clear cache
    konesIsraelService.listingsCache.data = null;
    
    res.json({ success: true, message: `Listing ${id} deactivated` });
  } catch (error) {
    logger.error(`KonesIsrael delete error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/stats
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
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/search/city/:city
 */
router.get('/search/city/:city', async (req, res) => {
  try {
    const { city } = req.params;
    const listings = await konesIsraelService.searchByCity(city);
    res.json({ success: true, city, count: listings.length, data: listings });
  } catch (error) {
    logger.error(`KonesIsrael city search error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/search/region/:region
 */
router.get('/search/region/:region', async (req, res) => {
  try {
    const { region } = req.params;
    const listings = await konesIsraelService.searchByRegion(region);
    res.json({ success: true, region, count: listings.length, data: listings });
  } catch (error) {
    logger.error(`KonesIsrael region search error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/search/gush/:gush
 */
router.get('/search/gush/:gush', async (req, res) => {
  try {
    const gush = parseInt(req.params.gush);
    const helka = req.query.helka ? parseInt(req.query.helka) : null;
    const listings = await konesIsraelService.searchByGushHelka(gush, helka);
    res.json({ success: true, gush, helka, count: listings.length, data: listings });
  } catch (error) {
    logger.error(`KonesIsrael gush search error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kones/check-address
 */
router.post('/check-address', async (req, res) => {
  try {
    const { city, street } = req.body;
    if (!city || !street) {
      return res.status(400).json({ success: false, error: 'Both city and street are required' });
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
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/match-complexes
 */
router.get('/match-complexes', async (req, res) => {
  try {
    const complexesResult = await pool.query(`
      SELECT id, city, addresses, name 
      FROM complexes WHERE city IS NOT NULL
    `);
    
    const matches = await konesIsraelService.matchWithComplexes(complexesResult.rows);
    res.json({
      success: true,
      totalComplexes: complexesResult.rows.length,
      matchedComplexes: matches.length,
      matches: matches.slice(0, 50),
      summary: {
        message: matches.length > 0 
          ? `Found ${matches.length} complexes with potential receivership properties`
          : 'No matches found between complexes and receivership listings',
        ssiImplication: 'Matched properties should have their SSI boosted by 30 points'
      }
    });
  } catch (error) {
    logger.error(`KonesIsrael match complexes error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kones/enhance-ssi/:complexId
 */
router.post('/enhance-ssi/:complexId', async (req, res) => {
  try {
    const complexId = parseInt(req.params.complexId);
    
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Complex not found' });
    }
    
    const complex = complexResult.rows[0];
    const matches = await konesIsraelService.checkAddress(
      complex.city || '', complex.addresses || complex.name || ''
    );
    
    if (matches.length > 0) {
      const currentSSI = complex.enhanced_ssi_score || 0;
      const newSSI = Math.min(100, currentSSI + 30);
      
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
        JSON.stringify({ receivership_listings: matches.map(m => ({
          source: m.source, propertyType: m.propertyType,
          deadline: m.submissionDeadline, contact: m.contactPerson
        })) }),
        complexId
      ]);
      
      res.json({
        success: true, message: 'SSI enhanced with receivership data',
        complexId, previousSSI: currentSSI, newSSI,
        matchesFound: matches.length, receivershipListings: matches
      });
    } else {
      res.json({
        success: true, message: 'No receivership listings found for this complex',
        complexId, matchesFound: 0
      });
    }
  } catch (error) {
    logger.error(`KonesIsrael enhance SSI error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kones/scan-all
 */
router.post('/scan-all', async (req, res) => {
  try {
    logger.info('KonesIsrael: Starting full complex scan...');
    
    const complexesResult = await pool.query(`
      SELECT id, city, addresses, name, enhanced_ssi_score
      FROM complexes WHERE city IS NOT NULL
    `);
    
    const matches = await konesIsraelService.matchWithComplexes(complexesResult.rows);
    
    let updated = 0;
    for (const match of matches) {
      try {
        const currentSSI = complexesResult.rows
          .find(c => c.id === match.complexId)?.enhanced_ssi_score || 0;
        const newSSI = Math.min(100, currentSSI + match.ssiBoost);
        
        await pool.query(`
          UPDATE complexes SET
            is_receivership = TRUE,
            enhanced_ssi_score = $1,
            ssi_enhancement_factors = COALESCE(ssi_enhancement_factors, '{}'::jsonb) || $2,
            ssi_last_enhanced = NOW()
          WHERE id = $3
        `, [newSSI, JSON.stringify({ konesisrael_matches: match.matchedListings }), match.complexId]);
        
        updated++;
      } catch (err) {
        logger.warn(`Failed to update complex ${match.complexId}: ${err.message}`);
      }
    }
    
    res.json({
      success: true, message: 'Full scan completed',
      totalComplexes: complexesResult.rows.length,
      matchesFound: matches.length, complexesUpdated: updated
    });
  } catch (error) {
    logger.error(`KonesIsrael scan-all error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/urgent
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// RECEIVERSHIP SCANNER - Perplexity AI powered search
// Searches for כינוס נכסים near identified complexes
// =====================================================

const receivershipScanner = require('../services/receivershipScanner');

/**
 * POST /api/kones/scan-complexes
 * Scan identified complexes for receivership listings using Perplexity AI
 * 
 * Body params:
 *   limit: number of complexes to scan (default: 10)
 *   minIAI: minimum IAI score filter (default: 50)
 *   city: optional city filter
 */
router.post('/scan-complexes', async (req, res) => {
  try {
    const { limit = 10, minIAI = 50, city = null } = req.body || {};
    
    logger.info(`Starting receivership complex scan: limit=${limit}, minIAI=${minIAI}, city=${city || 'all'}`);
    
    const results = await receivershipScanner.scanComplexesForReceiverships({
      limit: Math.min(limit, 50),
      minIAI,
      cityFilter: city
    });

    res.json({
      success: true,
      message: `Scanned ${results.scannedComplexes} complex areas`,
      ...results
    });
  } catch (error) {
    logger.error(`Receivership scan error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kones/scan-city
 * Search for receivership listings in a specific city/area
 * 
 * Body params:
 *   city: city name (required)
 *   streets: comma-separated street names (optional)
 */
router.post('/scan-city', async (req, res) => {
  try {
    const { city, streets = '' } = req.body || {};
    if (!city) {
      return res.status(400).json({ success: false, error: 'City is required' });
    }

    logger.info(`Scanning city for receiverships: ${city}`);
    
    const searchResult = await receivershipScanner.searchReceiverships(
      city, streets, city
    );

    const listings = searchResult.listings || [];
    let importResult = { imported: 0, skipped: 0 };
    
    if (listings.length > 0) {
      importResult = await receivershipScanner.importListings(
        listings, 'perplexity_city_scan'
      );
    }

    res.json({
      success: true,
      city,
      listingsFound: listings.length,
      imported: importResult.imported,
      skipped: importResult.skipped,
      listings: listings
    });
  } catch (error) {
    logger.error(`City scan error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/kones/scan-status
 * Shows scanning architecture and data source status
 */
router.get('/scan-status', async (req, res) => {
  try {
    const perplexityKey = !!process.env.PERPLEXITY_API_KEY;
    const konesEmail = !!process.env.KONES_EMAIL;
    
    const dbCount = await pool.query('SELECT COUNT(*) as count FROM kones_listings WHERE deleted_at IS NULL');
    const byScanSource = await pool.query(`
      SELECT COALESCE(scan_source, source, 'unknown') as src, COUNT(*) as count 
      FROM kones_listings WHERE deleted_at IS NULL 
      GROUP BY src ORDER BY count DESC
    `).catch(() => ({ rows: [] }));

    const complexCount = await pool.query('SELECT COUNT(*) as count FROM complexes WHERE city IS NOT NULL');
    const receivershipComplexes = await pool.query(
      'SELECT COUNT(*) as count FROM complexes WHERE is_receivership = TRUE'
    ).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      success: true,
      architecture: {
        description: 'Dual-source scanning: Claude (web search + manual import) + Perplexity (automated API)',
        sources: {
          claude: {
            method: 'Web search in chat, imports via POST /api/kones/import',
            status: 'always_available',
            description: 'Claude searches web for receivership listings and imports real data'
          },
          perplexity: {
            method: 'Automated API scan via POST /api/kones/scan-complexes',
            status: perplexityKey ? 'configured' : 'missing_api_key',
            description: 'Perplexity searches for listings near identified complexes'
          },
          konesisrael: {
            method: 'Direct scraping (blocked by CAPTCHA)',
            status: konesEmail ? 'credentials_set' : 'no_credentials',
            description: 'konesisrael.co.il - SiteGround CAPTCHA blocks automation'
          },
          manual_import: {
            method: 'POST /api/kones/import with JSON body',
            status: 'always_available',
            description: 'Import listings from any source (paid subscriptions, manual research)'
          }
        }
      },
      database: {
        totalListings: parseInt(dbCount.rows[0].count),
        byScanSource: byScanSource.rows.reduce((acc, r) => { acc[r.src] = parseInt(r.count); return acc; }, {}),
        totalComplexes: parseInt(complexCount.rows[0].count),
        receivershipComplexes: parseInt(receivershipComplexes.rows[0].count)
      },
      endpoints: {
        'POST /api/kones/scan-complexes': 'Perplexity scans complex areas (body: {limit, minIAI, city})',
        'POST /api/kones/scan-city': 'Perplexity scans specific city (body: {city, streets})',
        'POST /api/kones/import': 'Import from any source (body: {listings: [...]})',
        'POST /api/kones/scan-all': 'Match existing listings to complexes + update SSI',
        'GET /api/kones/match-complexes': 'Show listing-to-complex matches',
        'GET /api/kones/listings': 'View all listings'
      }
    });
  } catch (error) {
    logger.error(`Scan status error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
