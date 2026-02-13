/**
 * Distressed Seller Routes - Phase 4.10 SSI Enhancement
 * API endpoints for identifying distressed sellers
 * NEW: batch-aggregate (listing->complex), gov-enrich, dashboard data
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getDistressedSellerService() {
  try {
    return require('../services/distressedSellerService');
  } catch (e) {
    logger.warn('Distressed seller service not available', { error: e.message });
    return null;
  }
}

function getGovernmentService() {
  try {
    return require('../services/governmentDataService');
  } catch (e) {
    logger.warn('Government data service not available', { error: e.message });
    return null;
  }
}

// =====================================================
// NEW: POST /api/ssi/batch-aggregate
// Aggregate listing-level SSI scores to complex level
// No external APIs needed - just DB operations
// =====================================================
router.post('/batch-aggregate', async (req, res) => {
  try {
    const { minListings = 1, limit = 500 } = req.body || {};

    // Get all complexes with active listings that have SSI data
    const result = await pool.query(`
      SELECT 
        c.id, c.name, c.city, c.addresses, c.iai_score,
        c.enhanced_ssi_score as current_ssi,
        COUNT(l.id) as listing_count,
        MAX(l.ssi_score) as max_listing_ssi,
        AVG(l.ssi_score) FILTER (WHERE l.ssi_score > 0) as avg_listing_ssi,
        SUM(CASE WHEN l.has_urgent_keywords = true THEN 1 ELSE 0 END) as urgent_count,
        SUM(CASE WHEN l.is_foreclosure = true THEN 1 ELSE 0 END) as foreclosure_count,
        SUM(CASE WHEN l.is_inheritance = true THEN 1 ELSE 0 END) as inheritance_count,
        SUM(CASE WHEN l.price_changes >= 2 THEN 1 ELSE 0 END) as multi_price_drop_count,
        SUM(CASE WHEN l.days_on_market > 60 THEN 1 ELSE 0 END) as long_listing_count,
        MAX(l.total_price_drop_percent) as max_price_drop,
        MAX(l.days_on_market) as max_days_on_market,
        AVG(l.ssi_time_score) FILTER (WHERE l.ssi_time_score > 0) as avg_time_score,
        AVG(l.ssi_price_score) FILTER (WHERE l.ssi_price_score > 0) as avg_price_score,
        AVG(l.ssi_indicator_score) FILTER (WHERE l.ssi_indicator_score > 0) as avg_indicator_score,
        STRING_AGG(DISTINCT l.urgent_keywords_found, ', ') FILTER (WHERE l.urgent_keywords_found IS NOT NULL) as all_urgent_keywords
      FROM complexes c
      INNER JOIN listings l ON l.complex_id = c.id AND l.is_active = true
      GROUP BY c.id
      HAVING COUNT(l.id) >= $1
      ORDER BY MAX(l.ssi_score) DESC NULLS LAST
      LIMIT $2
    `, [minListings, limit]);

    const complexes = result.rows;
    let updated = 0;
    let alertsCreated = 0;
    const results = [];

    for (const c of complexes) {
      // Calculate enhanced SSI from listing data
      let enhancedSSI = 0;
      const factors = [];

      // Base: max listing SSI
      const maxSSI = parseFloat(c.max_listing_ssi) || 0;
      enhancedSSI += maxSSI;

      // Bonus: multiple distressed listings (5 pts per additional)
      const listingCount = parseInt(c.listing_count);
      if (listingCount > 1 && maxSSI > 0) {
        const bonus = Math.min((listingCount - 1) * 3, 15);
        enhancedSSI += bonus;
        factors.push(`${listingCount} מודעות פעילות (+${bonus})`);
      }

      // Bonus: urgent keywords
      const urgentCount = parseInt(c.urgent_count) || 0;
      if (urgentCount > 0) {
        const bonus = Math.min(urgentCount * 5, 15);
        enhancedSSI += bonus;
        factors.push(`שפה דחופה: ${c.all_urgent_keywords} (+${bonus})`);
      }

      // Bonus: foreclosure flags
      const foreclosureCount = parseInt(c.foreclosure_count) || 0;
      if (foreclosureCount > 0) {
        enhancedSSI += 30;
        factors.push(`כינוס נכסים (+30)`);
      }

      // Bonus: inheritance flags
      const inheritanceCount = parseInt(c.inheritance_count) || 0;
      if (inheritanceCount > 0) {
        enhancedSSI += 10;
        factors.push(`נכס ירושה (+10)`);
      }

      // Bonus: multiple price drops
      const priceDropCount = parseInt(c.multi_price_drop_count) || 0;
      if (priceDropCount > 0) {
        const bonus = Math.min(priceDropCount * 5, 15);
        enhancedSSI += bonus;
        factors.push(`${priceDropCount} מודעות עם הורדות מחיר (+${bonus})`);
      }

      // Bonus: significant price drop
      const maxDrop = parseFloat(c.max_price_drop) || 0;
      if (maxDrop > 10) {
        const bonus = Math.min(Math.round(maxDrop / 2), 15);
        enhancedSSI += bonus;
        factors.push(`ירידת מחיר ${maxDrop.toFixed(1)}% (+${bonus})`);
      }

      // Cap at 100
      enhancedSSI = Math.min(Math.round(enhancedSSI), 100);

      // Determine urgency
      let urgencyLevel = 'low';
      if (enhancedSSI >= 80) urgencyLevel = 'critical';
      else if (enhancedSSI >= 60) urgencyLevel = 'high';
      else if (enhancedSSI >= 40) urgencyLevel = 'medium';

      // Only update if meaningful SSI
      if (enhancedSSI >= 5) {
        await pool.query(`
          UPDATE complexes 
          SET enhanced_ssi_score = $1, 
              ssi_enhancement_factors = $2, 
              ssi_last_enhanced = NOW(),
              distress_indicators = $3,
              is_receivership = COALESCE(is_receivership, $4),
              is_inheritance_property = COALESCE(is_inheritance_property, $5)
          WHERE id = $6
        `, [
          enhancedSSI,
          JSON.stringify(factors),
          JSON.stringify({ urgencyLevel, listingCount, maxSSI, urgentCount, foreclosureCount, inheritanceCount, priceDropCount, maxDrop }),
          foreclosureCount > 0,
          inheritanceCount > 0,
          c.id
        ]);
        updated++;

        // Create alert for high distress
        if (urgencyLevel === 'critical' || urgencyLevel === 'high') {
          try {
            await pool.query(`
              INSERT INTO alerts (complex_id, alert_type, title, description, severity, metadata)
              VALUES ($1, 'ssi_high', $2, $3, $4, $5)
              ON CONFLICT DO NOTHING
            `, [
              c.id,
              `SSI ${enhancedSSI} - ${c.name || c.addresses}`,
              `מתחם ב${c.city} עם ${factors.length} סימני מצוקה: ${factors.join(', ')}`,
              urgencyLevel === 'critical' ? 'high' : 'medium',
              JSON.stringify({ enhancedSSI, factors, urgencyLevel, iai_score: c.iai_score })
            ]);
            alertsCreated++;
          } catch (e) { /* duplicate */ }
        }

        results.push({
          id: c.id,
          name: c.name || c.addresses,
          city: c.city,
          enhancedSSI,
          urgencyLevel,
          factors,
          listings: listingCount,
          iai_score: c.iai_score
        });
      }
    }

    // Sort by SSI descending
    results.sort((a, b) => b.enhancedSSI - a.enhancedSSI);

    res.json({
      success: true,
      summary: {
        complexesAnalyzed: complexes.length,
        complexesUpdated: updated,
        alertsCreated,
        ssiDistribution: {
          critical_80plus: results.filter(r => r.enhancedSSI >= 80).length,
          high_60to79: results.filter(r => r.enhancedSSI >= 60 && r.enhancedSSI < 80).length,
          medium_40to59: results.filter(r => r.enhancedSSI >= 40 && r.enhancedSSI < 60).length,
          low_20to39: results.filter(r => r.enhancedSSI >= 20 && r.enhancedSSI < 40).length,
          minimal_below20: results.filter(r => r.enhancedSSI < 20).length
        }
      },
      topDistressed: results.slice(0, 30)
    });

    logger.info('SSI batch aggregate complete', { analyzed: complexes.length, updated, alertsCreated });

  } catch (err) {
    logger.error('SSI batch aggregate failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// NEW: POST /api/ssi/gov-enrich
// Enrich SSI with government data (liens + inheritance)
// =====================================================
router.post('/gov-enrich', async (req, res) => {
  const govService = getGovernmentService();
  if (!govService) return res.status(503).json({ error: 'Government data service not available' });

  try {
    const { city, limit = 20 } = req.body || {};

    // Get top complexes to enrich (prioritize those with existing SSI or high IAI)
    let query = `
      SELECT id, name, city, addresses, iai_score, enhanced_ssi_score,
             ssi_enhancement_factors, distress_indicators
      FROM complexes 
      WHERE addresses IS NOT NULL AND city IS NOT NULL`;
    const params = [];
    let paramIdx = 1;

    if (city) {
      query += ` AND city = $${paramIdx++}`;
      params.push(city);
    }

    query += ` ORDER BY COALESCE(enhanced_ssi_score, 0) DESC, iai_score DESC NULLS LAST LIMIT $${paramIdx}`;
    params.push(limit);

    const complexes = await pool.query(query, params);
    
    // Return immediately, process in background
    res.json({ 
      message: 'Government enrichment started', 
      complexes: complexes.rows.length,
      note: 'Processing in background. Check /api/ssi/high-distress for results.'
    });

    // Background processing
    (async () => {
      let enriched = 0;
      let liensFound = 0;
      let inheritanceFound = 0;

      for (const complex of complexes.rows) {
        try {
          const address = complex.addresses || complex.name;
          const city = complex.city;
          if (!address || !city) continue;

          let additionalSSI = 0;
          const newFactors = [];

          // Check liens registry
          try {
            const liensResult = await govService.searchLiensRegistry(`${address} ${city}`, { limit: 10 });
            if (liensResult.success && liensResult.records && liensResult.records.length > 0) {
              const lienCount = liensResult.records.length;
              if (lienCount >= 3) {
                additionalSSI += 15;
                newFactors.push(`${lienCount} שעבודים ברשם המשכונות (+15)`);
                liensFound++;
              } else if (lienCount >= 1) {
                additionalSSI += 5;
                newFactors.push(`${lienCount} שעבודים ברשם המשכונות (+5)`);
                liensFound++;
              }
            }
          } catch (e) {
            logger.warn(`Liens check failed for ${complex.name}`, { error: e.message });
          }

          // Check inheritance registry
          try {
            const inheritResult = await govService.searchInheritanceRegistry(`${address} ${city}`, { limit: 10 });
            if (inheritResult.success && inheritResult.records && inheritResult.records.length > 0) {
              additionalSSI += 10;
              newFactors.push(`צו ירושה קשור ברשם הירושות (+10)`);
              inheritanceFound++;

              await pool.query('UPDATE complexes SET is_inheritance_property = true WHERE id = $1', [complex.id]);
            }
          } catch (e) {
            logger.warn(`Inheritance check failed for ${complex.name}`, { error: e.message });
          }

          // Update SSI if we found something
          if (additionalSSI > 0) {
            const currentSSI = complex.enhanced_ssi_score || 0;
            const newSSI = Math.min(currentSSI + additionalSSI, 100);
            const existingFactors = complex.ssi_enhancement_factors ? 
              (typeof complex.ssi_enhancement_factors === 'string' ? JSON.parse(complex.ssi_enhancement_factors) : complex.ssi_enhancement_factors) : [];
            const combinedFactors = [...existingFactors, ...newFactors];

            await pool.query(`
              UPDATE complexes 
              SET enhanced_ssi_score = $1, ssi_enhancement_factors = $2, ssi_last_enhanced = NOW()
              WHERE id = $3
            `, [newSSI, JSON.stringify(combinedFactors), complex.id]);
            enriched++;
          }

          // Rate limit: 500ms between government API calls
          await new Promise(r => setTimeout(r, 500));

        } catch (e) {
          logger.warn(`Gov enrichment failed for complex ${complex.id}`, { error: e.message });
        }
      }

      logger.info('Government SSI enrichment complete', { 
        total: complexes.rows.length, enriched, liensFound, inheritanceFound 
      });
    })();

  } catch (err) {
    logger.error('SSI gov-enrich failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// NEW: GET /api/ssi/dashboard-data
// Aggregated data for the QUANTUM dashboard
// =====================================================
router.get('/dashboard-data', async (req, res) => {
  try {
    const [stats, topSSI, topIAI, recentAlerts, cityBreakdown, ssiDistribution] = await Promise.all([
      // Overall stats
      pool.query(`
        SELECT 
          COUNT(*) as total_complexes,
          COUNT(*) FILTER (WHERE iai_score >= 30) as opportunities,
          COUNT(*) FILTER (WHERE iai_score >= 70) as excellent,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed_sellers,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 60) as high_stress,
          COUNT(DISTINCT city) as cities,
          ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
          ROUND(AVG(enhanced_ssi_score) FILTER (WHERE enhanced_ssi_score > 0), 1) as avg_ssi
        FROM complexes
      `),
      // Top SSI complexes
      pool.query(`
        SELECT id, name, city, addresses, iai_score, enhanced_ssi_score,
               ssi_enhancement_factors, status, developer
        FROM complexes 
        WHERE enhanced_ssi_score > 0
        ORDER BY enhanced_ssi_score DESC 
        LIMIT 15
      `),
      // Top IAI complexes
      pool.query(`
        SELECT id, name, city, addresses, iai_score, enhanced_ssi_score, status, developer
        FROM complexes 
        WHERE iai_score >= 50
        ORDER BY iai_score DESC 
        LIMIT 15
      `),
      // Recent alerts
      pool.query(`
        SELECT a.*, c.name as complex_name, c.city
        FROM alerts a
        LEFT JOIN complexes c ON a.complex_id = c.id
        ORDER BY a.created_at DESC 
        LIMIT 20
      `),
      // City breakdown
      pool.query(`
        SELECT city, 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE iai_score >= 30) as opportunities,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed,
          ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai
        FROM complexes 
        WHERE city IS NOT NULL
        GROUP BY city 
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC
        LIMIT 20
      `),
      // SSI distribution
      pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 80) as critical,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 60 AND enhanced_ssi_score < 80) as high,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40 AND enhanced_ssi_score < 60) as medium,
          COUNT(*) FILTER (WHERE enhanced_ssi_score >= 20 AND enhanced_ssi_score < 40) as low,
          COUNT(*) FILTER (WHERE enhanced_ssi_score > 0 AND enhanced_ssi_score < 20) as minimal,
          COUNT(*) FILTER (WHERE COALESCE(enhanced_ssi_score, 0) = 0) as none
        FROM complexes
      `)
    ]);

    // Listing stats
    let listingStats = {};
    try {
      const ls = await pool.query(`
        SELECT COUNT(*) as total, 
          COUNT(*) FILTER (WHERE is_active = true) as active,
          COUNT(*) FILTER (WHERE ssi_score > 0) as with_ssi,
          COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent
        FROM listings
      `);
      listingStats = ls.rows[0];
    } catch (e) {}

    // Kones stats
    let konesStats = {};
    try {
      const ks = await pool.query('SELECT COUNT(*) as total FROM kones_listings WHERE is_active = true');
      konesStats = ks.rows[0];
    } catch (e) {}

    res.json({
      stats: stats.rows[0],
      ssiDistribution: ssiDistribution.rows[0],
      topSSI: topSSI.rows,
      topIAI: topIAI.rows,
      recentAlerts: recentAlerts.rows,
      cityBreakdown: cityBreakdown.rows,
      listingStats,
      konesStats,
      lastUpdated: new Date().toISOString()
    });

  } catch (err) {
    logger.error('Dashboard data failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// EXISTING ROUTES
// =====================================================

// GET /api/ssi/status
router.get('/status', (req, res) => {
  const service = getDistressedSellerService();
  res.json({
    version: '4.10.0',
    service: 'SSI Enhancement - Distressed Seller Identification',
    available: !!service,
    weights: service?.SSI_WEIGHTS || null,
    sources: [
      { name: 'הוצאה לפועל', description: 'תיקים פתוחים ועיקולים', weight: 20 },
      { name: 'פשיטות רגל', description: 'הליכי פש"ר ופירוק', weight: 25 },
      { name: 'שעבודים', description: 'משכנתאות ושעבודים', weight: 15 },
      { name: 'כינוס נכסים', description: 'מכירות בכינוס', weight: 30 },
      { name: 'ירושות', description: 'עיזבונות מרובי יורשים', weight: 10 },
      { name: 'ניתוח מודעות', description: 'שפה דחופה, הורדות מחיר', weight: 20 }
    ],
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY,
    governmentApiAvailable: !!getGovernmentService()
  });
});

// POST /api/ssi/enhance/:complexId
router.post('/enhance/:complexId', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const complexId = parseInt(req.params.complexId);
    const { deepScan } = req.body;
    const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
    if (complexResult.rows.length === 0) return res.status(404).json({ error: 'Complex not found' });
    const complex = complexResult.rows[0];
    const listingsResult = await pool.query('SELECT * FROM listings WHERE complex_id = $1 AND is_active = TRUE', [complexId]);
    const enhancedSSI = await service.calculateEnhancedSSI(complex, listingsResult.rows, { deepScan: !!deepScan });
    if (enhancedSSI.ssiIncrease >= 10) {
      await pool.query('UPDATE complexes SET enhanced_ssi_score = $1, ssi_enhancement_factors = $2, ssi_last_enhanced = NOW() WHERE id = $3',
        [enhancedSSI.finalSSI, JSON.stringify(enhancedSSI.distressIndicators), complexId]);
    }
    res.json(enhancedSSI);
  } catch (err) {
    logger.error('SSI enhancement failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ssi/receivership/:city
router.get('/receivership/:city', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const { city } = req.params;
    const result = await service.findReceivershipListings(city, req.query.street || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ssi/check-owner
router.post('/check-owner', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const { ownerName, companyName, idNumber } = req.body;
    if (!ownerName && !companyName) return res.status(400).json({ error: 'Owner name or company name required' });
    const results = { searchedName: ownerName || companyName, checks: [], totalDistressScore: 0 };
    const enforcement = await service.checkEnforcementOffice(ownerName, idNumber);
    results.checks.push(enforcement);
    results.totalDistressScore += enforcement.score;
    const bankruptcy = await service.checkBankruptcyProceedings(ownerName, companyName);
    results.checks.push(bankruptcy);
    results.totalDistressScore += bankruptcy.score;
    results.distressLevel = results.totalDistressScore >= 40 ? 'high' : results.totalDistressScore >= 20 ? 'medium' : results.totalDistressScore > 0 ? 'low' : 'none';
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ssi/check-property
router.post('/check-property', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const { address, city, gush, helka } = req.body;
    if (!address || !city) return res.status(400).json({ error: 'Address and city required' });
    const liens = await service.checkPropertyLiens(address, city, gush, helka);
    const inheritance = await service.checkInheritanceRegistry(address, city);
    res.json({ property: { address, city, gush, helka }, checks: [liens, inheritance], totalDistressScore: liens.score + inheritance.score, hasDistressIndicators: (liens.score + inheritance.score) > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ssi/scan-city
router.post('/scan-city', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const { city } = req.body;
    if (!city) return res.status(400).json({ error: 'City required' });
    res.json({ message: `Distressed seller scan started for ${city}`, note: 'Running in background' });
    (async () => {
      try {
        const results = await service.scanCityForDistressedSellers(city, pool);
        logger.info('City distress scan complete', { city, highDistressCount: results.highDistressComplexes.length });
      } catch (err) { logger.error('Background city scan failed', { error: err.message, city }); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ssi/high-distress
router.get('/high-distress', async (req, res) => {
  try {
    const { minScore, city, limit } = req.query;
    const threshold = parseInt(minScore) || 10;
    let query = `
      SELECT c.id, c.name, c.city, c.addresses, c.status, c.iai_score,
        c.enhanced_ssi_score, c.ssi_enhancement_factors, c.ssi_last_enhanced,
        COUNT(l.id) as active_listings
      FROM complexes c 
      LEFT JOIN listings l ON l.complex_id = c.id AND l.is_active = TRUE
      WHERE c.enhanced_ssi_score >= $1`;
    const params = [threshold];
    let paramIndex = 2;
    if (city) { query += ` AND c.city = $${paramIndex++}`; params.push(city); }
    query += ` GROUP BY c.id ORDER BY c.enhanced_ssi_score DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 50);
    const result = await pool.query(query, params);
    res.json({
      total: result.rows.length,
      threshold,
      complexes: result.rows.map(c => ({
        id: c.id, name: c.name, city: c.city, addresses: c.addresses,
        enhancedSSI: c.enhanced_ssi_score, activeListings: parseInt(c.active_listings),
        status: c.status, iaiScore: c.iai_score,
        enhancementFactors: c.ssi_enhancement_factors, lastEnhanced: c.ssi_last_enhanced
      }))
    });
  } catch (err) {
    logger.error('High distress query failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ssi/enhance-all
router.post('/enhance-all', async (req, res) => {
  const service = getDistressedSellerService();
  if (!service) return res.status(503).json({ error: 'Distressed seller service not available' });
  try {
    const { city, limit, deepScan } = req.body;
    res.json({ message: 'Batch SSI enhancement started', params: { city, limit, deepScan }, note: 'Running in background' });
    (async () => {
      try {
        let query = 'SELECT c.* FROM complexes c WHERE EXISTS (SELECT 1 FROM listings l WHERE l.complex_id = c.id AND l.is_active = TRUE)';
        const params = [];
        let paramIndex = 1;
        if (city) { query += ` AND c.city = $${paramIndex++}`; params.push(city); }
        query += ` ORDER BY c.enhanced_ssi_score DESC NULLS LAST, c.iai_score DESC LIMIT $${paramIndex}`;
        params.push(parseInt(limit) || 50);
        const complexes = await pool.query(query, params);
        let enhanced = 0;
        for (const complex of complexes.rows) {
          try {
            const listings = await pool.query('SELECT * FROM listings WHERE complex_id = $1 AND is_active = TRUE', [complex.id]);
            const result = await service.calculateEnhancedSSI(complex, listings.rows, { deepScan: !!deepScan, skipReceivership: !deepScan });
            if (result.ssiIncrease >= 5) {
              await pool.query('UPDATE complexes SET enhanced_ssi_score = $1, ssi_enhancement_factors = $2, ssi_last_enhanced = NOW() WHERE id = $3',
                [result.finalSSI, JSON.stringify(result.distressIndicators), complex.id]);
              enhanced++;
            }
            await new Promise(r => setTimeout(r, 1000));
          } catch (e) { logger.warn(`SSI enhancement failed for ${complex.name}`, { error: e.message }); }
        }
        logger.info('Batch SSI enhancement complete', { total: complexes.rows.length, enhanced });
      } catch (err) { logger.error('Batch SSI enhancement failed', { error: err.message }); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
