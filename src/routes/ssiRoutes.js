/**
 * Distressed Seller Routes - Phase 4.5 SSI Enhancement
 * API endpoints for identifying distressed sellers
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

// GET /api/ssi/status
router.get('/status', (req, res) => {
  const service = getDistressedSellerService();
  res.json({
    version: '4.5.0',
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
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY
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
      await pool.query(`
        UPDATE complexes SET enhanced_ssi_score = $1, ssi_enhancement_factors = $2, ssi_last_enhanced = NOW()
        WHERE id = $3
      `, [enhancedSSI.finalSSI, JSON.stringify(enhancedSSI.distressIndicators), complexId]);

      if (enhancedSSI.urgencyLevel === 'critical' || enhancedSSI.urgencyLevel === 'high') {
        await pool.query(`
          INSERT INTO alerts (complex_id, alert_type, title, description, severity, metadata)
          VALUES ($1, 'distress_detected', $2, $3, $4, $5) ON CONFLICT DO NOTHING
        `, [complexId, `מוכר לחוץ זוהה: ${complex.name}`, enhancedSSI.recommendation,
            enhancedSSI.urgencyLevel === 'critical' ? 'high' : 'medium',
            JSON.stringify({ baseSSI: enhancedSSI.baseSSI, enhancedSSI: enhancedSSI.finalSSI, indicators: enhancedSSI.distressIndicators })]);
      }
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
    const { street } = req.query;
    const result = await service.findReceivershipListings(city, street || null);
    res.json(result);
  } catch (err) {
    logger.error('Receivership search failed', { error: err.message });
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

    const results = { searchedName: ownerName || companyName, checks: [], totalDistressScore: 0, distressLevel: 'unknown' };

    const enforcement = await service.checkEnforcementOffice(ownerName, idNumber);
    results.checks.push(enforcement);
    results.totalDistressScore += enforcement.score;

    const bankruptcy = await service.checkBankruptcyProceedings(ownerName, companyName);
    results.checks.push(bankruptcy);
    results.totalDistressScore += bankruptcy.score;

    results.distressLevel = results.totalDistressScore >= 40 ? 'high' : results.totalDistressScore >= 20 ? 'medium' : results.totalDistressScore > 0 ? 'low' : 'none';

    res.json(results);
  } catch (err) {
    logger.error('Owner check failed', { error: err.message });
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

    const results = { property: { address, city, gush, helka }, checks: [] };
    const liens = await service.checkPropertyLiens(address, city, gush, helka);
    results.checks.push(liens);
    const inheritance = await service.checkInheritanceRegistry(address, city);
    results.checks.push(inheritance);

    results.totalDistressScore = liens.score + inheritance.score;
    results.hasDistressIndicators = results.totalDistressScore > 0;

    res.json(results);
  } catch (err) {
    logger.error('Property check failed', { error: err.message });
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
        for (const alert of results.alerts) {
          await pool.query(`
            INSERT INTO alerts (complex_id, alert_type, title, description, severity, metadata)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
          `, [alert.complexId, alert.type, `מוכר לחוץ: ${alert.complexName}`, alert.recommendation, alert.ssi >= 80 ? 'high' : 'medium', JSON.stringify(alert)]);
        }
        logger.info('City distress scan complete', { city, highDistressCount: results.highDistressComplexes.length });
      } catch (err) {
        logger.error('Background city scan failed', { error: err.message, city });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ssi/high-distress
router.get('/high-distress', async (req, res) => {
  try {
    const { minScore, city, limit } = req.query;
    
    // Get high SSI complexes based on enhanced_ssi_score or ssi_score
    let query = `
      SELECT c.*, 
        COALESCE(c.enhanced_ssi_score, c.ssi_score, 0) as effective_ssi,
        (SELECT COUNT(*) FROM listings l WHERE l.complex_id = c.id AND l.is_active = TRUE) as active_listings
      FROM complexes c 
      WHERE COALESCE(c.enhanced_ssi_score, c.ssi_score, 0) >= $1`;
    
    const params = [parseInt(minScore) || 50];
    let paramIndex = 2;
    
    if (city) { 
      query += ` AND c.city = $${paramIndex++}`; 
      params.push(city); 
    }
    
    query += ` ORDER BY effective_ssi DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 50);

    const result = await pool.query(query, params);
    
    res.json({
      total: result.rows.length,
      complexes: result.rows.map(c => ({
        id: c.id, 
        name: c.name, 
        city: c.city, 
        enhancedSSI: c.enhanced_ssi_score,
        effectiveSSI: parseInt(c.effective_ssi) || 0, 
        activeListings: parseInt(c.active_listings), 
        status: c.status, 
        iaiScore: c.iai_score,
        enhancementFactors: c.ssi_enhancement_factors
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
        let query = `SELECT c.* FROM complexes c WHERE EXISTS (SELECT 1 FROM listings l WHERE l.complex_id = c.id AND l.is_active = TRUE)`;
        const params = [];
        let paramIndex = 1;
        if (city) { query += ` AND c.city = $${paramIndex++}`; params.push(city); }
        query += ` ORDER BY c.enhanced_ssi_score DESC NULLS LAST, c.iai_score DESC LIMIT $${paramIndex}`;
        params.push(parseInt(limit) || 50);

        const complexes = await pool.query(query, params);
        let enhanced = 0, alertsCreated = 0;

        for (const complex of complexes.rows) {
          try {
            const listings = await pool.query('SELECT * FROM listings WHERE complex_id = $1 AND is_active = TRUE', [complex.id]);
            const result = await service.calculateEnhancedSSI(complex, listings.rows, { deepScan: !!deepScan, skipReceivership: !deepScan });

            if (result.ssiIncrease >= 5) {
              await pool.query(`UPDATE complexes SET enhanced_ssi_score = $1, ssi_enhancement_factors = $2, ssi_last_enhanced = NOW() WHERE id = $3`,
                [result.finalSSI, JSON.stringify(result.distressIndicators), complex.id]);
              enhanced++;
              if (result.urgencyLevel === 'critical' || result.urgencyLevel === 'high') {
                await pool.query(`INSERT INTO alerts (complex_id, alert_type, title, description, severity, metadata) VALUES ($1, 'distress_detected', $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
                  [complex.id, `מוכר לחוץ: ${complex.name}`, result.recommendation, result.urgencyLevel === 'critical' ? 'high' : 'medium', JSON.stringify(result)]);
                alertsCreated++;
              }
            }
            await new Promise(r => setTimeout(r, 1000));
          } catch (e) {
            logger.warn(`SSI enhancement failed for ${complex.name}`, { error: e.message });
          }
        }
        logger.info('Batch SSI enhancement complete', { total: complexes.rows.length, enhanced, alertsCreated });
      } catch (err) {
        logger.error('Batch SSI enhancement failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
