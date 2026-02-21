/**
 * Enhanced Data Sources Routes - Phase 4.5
 * 
 * Integrates:
 * - Madlan (madlan.co.il) - Enhanced transaction data
 * - Urban Renewal Authority (gov.il) - Official complex status
 * - Committee Protocols (mavat.iplan.gov.il) - Planning decisions
 * - Company Registry (data.gov.il) - Developer verification
 * - Nadlan.gov.il - Government transaction data
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// Lazy load services to handle missing dependencies gracefully
function getService(name) {
  try {
    switch(name) {
      case 'madlan': return require('../services/madlanService');
      case 'urbanRenewal': return require('../services/urbanRenewalAuthorityService');
      case 'committee': return require('../services/committeeProtocolService');
      case 'developer': return require('../services/developerInfoService');
      case 'nadlan': return require('../services/nadlanScraper');
      default: return null;
    }
  } catch (e) {
    logger.warn(`Service ${name} not available: ${e.message}`);
    return null;
  }
}

// =====================================================
// STATUS ENDPOINT
// =====================================================

/**
 * GET /api/enhanced/status
 * Get status of all enhanced data sources
 */
router.get('/status', (req, res) => {
  const madlan = getService('madlan');
  const urbanRenewal = getService('urbanRenewal');
  const committee = getService('committee');
  const developer = getService('developer');
  const nadlan = getService('nadlan');

  res.json({
    version: '4.28.1',
    phase: 'Enhanced Data Sources Integration',
    sources: {
      madlan: {
        available: !!madlan,
        description: 'נתוני עסקאות ומחירים מ-madlan.co.il',
        features: ['transaction_history', 'area_statistics', 'price_trends', 'comparables']
      },
      nadlan: {
        available: !!nadlan,
        description: 'עסקאות מרשות המיסים - nadlan.gov.il',
        features: ['government_transactions', 'price_per_sqm', 'neighborhood_avg']
      },
      urbanRenewalAuthority: {
        available: !!urbanRenewal,
        description: 'מידע רשמי מהרשות הממשלתית להתחדשות עירונית',
        features: ['official_status', 'declaration_verification', 'track_info', 'certainty_score']
      },
      committeeProtocols: {
        available: !!committee,
        description: 'פרוטוקולים והחלטות ועדות תכנון',
        features: ['decision_tracking', 'price_triggers', 'upcoming_meetings']
      },
      developerInfo: {
        available: !!developer,
        description: 'מידע על יזמים מרשם החברות',
        features: ['company_verification', 'risk_assessment', 'status_check']
      }
    },
    allAvailable: !!(madlan && urbanRenewal && committee && developer && nadlan),
    dataGovIntegration: {
      companiesRegistry: 'https://data.gov.il/dataset/ica_companies',
      description: 'Open API for company data'
    }
  });
});

// =====================================================
// MADLAN ROUTES
// =====================================================

/**
 * GET /api/enhanced/madlan/area/:city
 * Get area statistics from Madlan
 */
router.get('/madlan/area/:city', async (req, res) => {
  const madlan = getService('madlan');
  if (!madlan) {
    return res.status(503).json({ error: 'Madlan service not available' });
  }

  try {
    const { city } = req.params;
    const { neighborhood } = req.query;
    const stats = await madlan.getAreaStatistics(city, neighborhood || null);
    res.json(stats || { message: 'No data available for this area' });
  } catch (err) {
    logger.error('Madlan area stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/madlan/enrich/:complexId
 * Enrich a complex with Madlan data (uses Perplexity AI)
 */
router.post('/madlan/enrich/:complexId', async (req, res) => {
  const madlan = getService('madlan');
  if (!madlan) {
    return res.status(503).json({ error: 'Madlan service not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    
    // fetchMadlanData does SELECT * internally and handles everything
    const result = await madlan.fetchMadlanData(complexId);
    res.json(result);
  } catch (err) {
    logger.error('Madlan enrich error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/madlan/scan-batch
 * Batch scan complexes via Madlan/Perplexity for transaction data
 * Body: { limit, city, onlyMissing }
 */
router.post('/madlan/scan-batch', async (req, res) => {
  const madlan = getService('madlan');
  if (!madlan) {
    return res.status(503).json({ error: 'Madlan service not available' });
  }

  const { limit = 10, city, onlyMissing = true } = req.body;
  const jobId = `madlan_batch_${Date.now()}`;

  // Store job status in memory
  if (!global._madlanJobs) global._madlanJobs = {};
  global._madlanJobs[jobId] = { 
    status: 'running', started: new Date().toISOString(),
    total: 0, processed: 0, succeeded: 0, failed: 0, results: []
  };

  res.json({ 
    message: 'Madlan batch scan started',
    jobId,
    params: { limit, city, onlyMissing }
  });

  // Run in background
  (async () => {
    try {
      let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (onlyMissing) {
        query += ' AND (madlan_avg_price_sqm IS NULL OR last_madlan_update IS NULL)';
      }
      if (city) {
        query += ` AND city = $${paramIndex++}`;
        params.push(city);
      }
      query += ' ORDER BY iai_score DESC NULLS LAST';
      query += ` LIMIT $${paramIndex}`;
      params.push(parseInt(limit));

      const complexes = await pool.query(query, params);
      const job = global._madlanJobs[jobId];
      job.total = complexes.rows.length;

      for (const complex of complexes.rows) {
        try {
          const result = await madlan.fetchMadlanData(complex.id);
          job.processed++;
          if (result.status === 'success') {
            job.succeeded++;
          } else {
            job.failed++;
          }
          job.results.push({ id: complex.id, name: complex.name, status: result.status, transactions: result.transactions || 0 });
          
          // Rate limit: 3 seconds between Perplexity calls
          await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          job.processed++;
          job.failed++;
          job.results.push({ id: complex.id, name: complex.name, status: 'error', error: e.message });
        }
      }

      job.status = 'complete';
      job.completed = new Date().toISOString();

      // After batch, recalculate neighborhood averages
      await recalcNeighborhoodAverages();

      logger.info(`Madlan batch complete: ${job.succeeded}/${job.total} succeeded`);
    } catch (err) {
      global._madlanJobs[jobId].status = 'error';
      global._madlanJobs[jobId].error = err.message;
      logger.error('Madlan batch failed', { error: err.message });
    }
  })();
});

/**
 * GET /api/enhanced/madlan/job/:jobId
 * Check batch job status
 */
router.get('/madlan/job/:jobId', (req, res) => {
  const job = (global._madlanJobs || {})[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// =====================================================
// NADLAN.GOV.IL ROUTES
// =====================================================

/**
 * POST /api/enhanced/nadlan/scan/:complexId
 * Scan a single complex for nadlan.gov.il transactions
 */
router.post('/nadlan/scan/:complexId', async (req, res) => {
  const nadlan = getService('nadlan');
  if (!nadlan) {
    return res.status(503).json({ error: 'Nadlan scraper not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    const result = await nadlan.scanComplex(complexId);
    res.json(result);
  } catch (err) {
    logger.error('Nadlan scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/nadlan/scan-batch
 * Batch scan complexes via nadlan.gov.il
 * Body: { limit, city, staleOnly }
 */
router.post('/nadlan/scan-batch', async (req, res) => {
  const nadlan = getService('nadlan');
  if (!nadlan) {
    return res.status(503).json({ error: 'Nadlan scraper not available' });
  }

  const { limit = 10, city, staleOnly = false } = req.body;
  
  try {
    res.json({ 
      message: 'Nadlan batch scan started',
      params: { limit, city, staleOnly },
      note: 'Running in background - check /api/enhanced/enrichment-stats for progress'
    });

    // Run in background
    (async () => {
      try {
        const result = await nadlan.scanAll({ city, limit: parseInt(limit), staleOnly });
        
        // After batch, recalculate neighborhood averages
        await recalcNeighborhoodAverages();
        
        logger.info('Nadlan batch complete', { succeeded: result.succeeded, total: result.total, newTransactions: result.totalNew });
      } catch (err) {
        logger.error('Nadlan batch failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// NEIGHBORHOOD AVERAGE CALCULATION
// =====================================================

/**
 * POST /api/enhanced/recalc-neighborhood-avg
 * Recalculate neighborhood averages from transaction data
 */
router.post('/recalc-neighborhood-avg', async (req, res) => {
  try {
    const result = await recalcNeighborhoodAverages();
    res.json(result);
  } catch (err) {
    logger.error('Recalc neighborhood avg error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Recalculate neighborhood averages from stored transactions
 */
async function recalcNeighborhoodAverages() {
  try {
    // Ensure columns exist
    await pool.query(`
      ALTER TABLE complexes ADD COLUMN IF NOT EXISTS nadlan_neighborhood_avg_sqm NUMERIC(10,2);
      ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_neighborhood_avg_sqm NUMERIC(10,2);
      ALTER TABLE complexes ADD COLUMN IF NOT EXISTS neighborhood_avg_sqm NUMERIC(10,2);
      ALTER TABLE complexes ADD COLUMN IF NOT EXISTS transaction_count INTEGER DEFAULT 0;
    `);

    // Calculate per-complex average from transactions table
    const txAvg = await pool.query(`
      SELECT 
        complex_id,
        COUNT(*) as tx_count,
        ROUND(AVG(price_per_sqm)) as avg_price_sqm,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_per_sqm)) as median_price_sqm,
        source
      FROM transactions
      WHERE price_per_sqm IS NOT NULL 
        AND price_per_sqm > 3000 
        AND price_per_sqm < 200000
      GROUP BY complex_id, source
    `);

    let updated = 0;
    for (const row of txAvg.rows) {
      const col = row.source === 'madlan' ? 'madlan_neighborhood_avg_sqm' : 'nadlan_neighborhood_avg_sqm';
      await pool.query(`
        UPDATE complexes SET 
          ${col} = $1,
          transaction_count = GREATEST(COALESCE(transaction_count, 0), $2)
        WHERE id = $3
      `, [row.median_price_sqm || row.avg_price_sqm, row.tx_count, row.complex_id]);
      updated++;
    }

    // Calculate combined neighborhood_avg_sqm (prefer nadlan, fallback to madlan)
    const combined = await pool.query(`
      UPDATE complexes SET
        neighborhood_avg_sqm = COALESCE(nadlan_neighborhood_avg_sqm, madlan_neighborhood_avg_sqm)
      WHERE nadlan_neighborhood_avg_sqm IS NOT NULL OR madlan_neighborhood_avg_sqm IS NOT NULL
      RETURNING id
    `);

    // Also update accurate_price_sqm where missing, from neighborhood data
    const priceFill = await pool.query(`
      UPDATE complexes SET
        accurate_price_sqm = neighborhood_avg_sqm
      WHERE accurate_price_sqm IS NULL 
        AND neighborhood_avg_sqm IS NOT NULL
      RETURNING id
    `);

    // Recalculate actual_premium where we now have price data
    const premiumCalc = await pool.query(`
      UPDATE complexes SET
        actual_premium = ROUND(((accurate_price_sqm - city_avg_price_sqm) / NULLIF(city_avg_price_sqm, 0)) * 100, 2)
      WHERE accurate_price_sqm IS NOT NULL 
        AND city_avg_price_sqm IS NOT NULL
        AND city_avg_price_sqm > 0
        AND actual_premium IS NULL
      RETURNING id
    `);

    const result = {
      message: 'Neighborhood averages recalculated',
      transactionGroups: txAvg.rows.length,
      complexesUpdated: updated,
      combinedAvgSet: combined.rowCount,
      pricesFilled: priceFill.rowCount,
      premiumsCalculated: premiumCalc.rowCount
    };

    logger.info('Neighborhood averages recalculated', result);
    return result;
  } catch (err) {
    logger.error('Recalc neighborhood averages failed', { error: err.message });
    throw err;
  }
}

// =====================================================
// URBAN RENEWAL AUTHORITY ROUTES
// =====================================================

/**
 * GET /api/enhanced/official/list
 * Get all officially declared complexes
 */
router.get('/official/list', async (req, res) => {
  const urbanRenewal = getService('urbanRenewal');
  if (!urbanRenewal) {
    return res.status(503).json({ error: 'Urban Renewal Authority service not available' });
  }

  try {
    const complexes = await urbanRenewal.fetchAllDeclaredComplexes();
    res.json({
      total: complexes.length,
      complexes,
      source: 'הרשות הממשלתית להתחדשות עירונית'
    });
  } catch (err) {
    logger.error('Official list error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/official/verify/:complexId
 * Verify a complex against official records
 */
router.post('/official/verify/:complexId', async (req, res) => {
  const urbanRenewal = getService('urbanRenewal');
  if (!urbanRenewal) {
    return res.status(503).json({ error: 'Urban Renewal Authority service not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query(
      'SELECT id, name, city FROM complexes WHERE id = $1',
      [complexId]
    );

    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const complex = complexResult.rows[0];
    const status = await urbanRenewal.getComplexOfficialStatus(complex.name, complex.city);

    // Update database
    if (status.isOfficial) {
      await pool.query(`
        UPDATE complexes SET
          is_officially_declared = TRUE,
          official_track = $1,
          official_declaration_date = $2,
          official_plan_number = $3,
          official_certainty_score = $4,
          official_last_verified = NOW()
        WHERE id = $5
      `, [
        status.track,
        status.declarationDate,
        status.planNumber,
        status.certaintyScore,
        complexId
      ]);
    }

    res.json({
      complex: complex.name,
      verification: status
    });
  } catch (err) {
    logger.error('Official verify error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/official/sync
 * Sync all complexes with official data
 */
router.post('/official/sync', async (req, res) => {
  const urbanRenewal = getService('urbanRenewal');
  if (!urbanRenewal) {
    return res.status(503).json({ error: 'Urban Renewal Authority service not available' });
  }

  try {
    res.json({ message: 'Official sync started', note: 'Running in background' });

    // Run in background
    (async () => {
      try {
        const result = await urbanRenewal.syncWithDatabase(pool);
        logger.info('Official sync complete', result);
      } catch (err) {
        logger.error('Official sync failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// COMMITTEE PROTOCOL ROUTES
// =====================================================

/**
 * GET /api/enhanced/committee/upcoming
 * Get upcoming committee meetings
 */
router.get('/committee/upcoming', async (req, res) => {
  const committee = getService('committee');
  if (!committee) {
    return res.status(503).json({ error: 'Committee Protocol service not available' });
  }

  try {
    const { city, days } = req.query;
    const meetings = city 
      ? await committee.getUpcomingMeetings(city)
      : await committee.getRecentDecisions(null, parseInt(days) || 30);
    
    res.json({
      total: meetings.length,
      meetings,
      days: parseInt(days) || 30
    });
  } catch (err) {
    logger.error('Committee upcoming error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/committee/triggers/:complexId
 * Check price triggers for a complex
 */
router.post('/committee/triggers/:complexId', async (req, res) => {
  const committee = getService('committee');
  if (!committee) {
    return res.status(503).json({ error: 'Committee Protocol service not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query(
      'SELECT id, name, city, plan_number, addresses, address FROM complexes WHERE id = $1',
      [complexId]
    );

    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const complex = complexResult.rows[0];
    const triggers = await committee.checkPriceTriggers(complex);

    // Update database if triggers found
    if (triggers.hasTriggers && triggers.triggers.length > 0) {
      const latestTrigger = triggers.triggers[0];
      await pool.query(`
        UPDATE complexes SET
          price_trigger_detected = TRUE,
          last_committee_decision = $1,
          last_committee_date = $2,
          price_trigger_impact = $3,
          committee_last_checked = NOW()
        WHERE id = $4
      `, [
        latestTrigger.decision,
        latestTrigger.date,
        latestTrigger.impact?.level,
        complexId
      ]);
    }

    res.json({
      complex: complex.name,
      ...triggers
    });
  } catch (err) {
    logger.error('Committee triggers error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DEVELOPER/COMPANY ROUTES
// =====================================================

/**
 * POST /api/enhanced/developer/verify
 * Verify a developer/company
 */
router.post('/developer/verify', async (req, res) => {
  const developer = getService('developer');
  if (!developer) {
    return res.status(503).json({ error: 'Developer Info service not available' });
  }

  try {
    const { name, companyNumber } = req.body;
    if (!name && !companyNumber) {
      return res.status(400).json({ error: 'Developer name or company number required' });
    }

    let result;
    if (companyNumber) {
      result = await developer.getCompanyDetails(companyNumber);
    } else {
      result = await developer.verifyDeveloper(name);
    }

    res.json(result);
  } catch (err) {
    logger.error('Developer verify error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/developer/check/:complexId
 * Check the developer of a specific complex
 */
router.post('/developer/check/:complexId', async (req, res) => {
  const developer = getService('developer');
  if (!developer) {
    return res.status(503).json({ error: 'Developer Info service not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query(
      'SELECT id, name, developer FROM complexes WHERE id = $1',
      [complexId]
    );

    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const complex = complexResult.rows[0];
    if (!complex.developer) {
      return res.json({ 
        complex: complex.name, 
        message: 'No developer assigned to this complex' 
      });
    }

    const verification = await developer.verifyDeveloper(complex.developer);

    // Update database
    if (verification.found && verification.company) {
      await pool.query(`
        UPDATE complexes SET
          developer_company_number = $1,
          developer_status = $2,
          developer_risk_score = $3,
          developer_risk_level = $4,
          developer_last_verified = NOW()
        WHERE id = $5
      `, [
        verification.company.companyNumber,
        verification.company.status,
        verification.company.riskAssessment?.score,
        verification.company.riskAssessment?.level,
        complexId
      ]);
    }

    res.json({
      complex: complex.name,
      developer: complex.developer,
      verification
    });
  } catch (err) {
    logger.error('Developer check error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/enhanced/developer/risk-report
 * Get report of all high-risk developers
 */
router.get('/developer/risk-report', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        developer,
        developer_risk_score,
        developer_risk_level,
        developer_status,
        COUNT(*) as complex_count,
        array_agg(name) as complexes
      FROM complexes
      WHERE developer IS NOT NULL 
        AND developer_risk_score IS NOT NULL
        AND developer_risk_score >= 50
      GROUP BY developer, developer_risk_score, developer_risk_level, developer_status
      ORDER BY developer_risk_score DESC
    `);

    res.json({
      high_risk_developers: result.rows,
      total: result.rows.length
    });
  } catch (err) {
    logger.error('Risk report error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BATCH ENRICHMENT
// =====================================================

/**
 * POST /api/enhanced/enrich-all
 * Enrich all complexes with enhanced data (background job)
 */
router.post('/enrich-all', async (req, res) => {
  const { limit, city, source } = req.body;

  try {
    res.json({ 
      message: 'Batch enrichment started',
      params: { limit, city, source },
      note: 'Running in background'
    });

    // Run enrichment in background
    (async () => {
      const madlan = getService('madlan');
      const urbanRenewal = getService('urbanRenewal');
      const committee = getService('committee');
      const developer = getService('developer');

      try {
        // Build query - use addresses instead of street
        let query = 'SELECT id, name, city, addresses, address, developer, plan_number FROM complexes WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (city) {
          query += ` AND city = $${paramIndex++}`;
          params.push(city);
        }
        if (limit) {
          query += ` LIMIT $${paramIndex}`;
          params.push(parseInt(limit));
        }

        const complexes = await pool.query(query, params);
        logger.info(`Starting enrichment for ${complexes.rows.length} complexes`);

        let enriched = 0;
        for (const complex of complexes.rows) {
          try {
            // Run requested enrichment source(s)
            if (!source || source === 'all' || source === 'madlan') {
              if (madlan) await madlan.fetchMadlanData(complex.id);
            }
            if (!source || source === 'all' || source === 'official') {
              if (urbanRenewal) await urbanRenewal.getComplexOfficialStatus(complex.name, complex.city);
            }
            if (!source || source === 'all' || source === 'committee') {
              if (committee) await committee.checkPriceTriggers(complex);
            }
            if (!source || source === 'all' || source === 'developer') {
              if (developer && complex.developer) await developer.verifyDeveloper(complex.developer);
            }
            enriched++;

            // Rate limiting
            await new Promise(r => setTimeout(r, 3000));
          } catch (e) {
            logger.warn(`Enrichment failed for ${complex.name}`, { error: e.message });
          }
        }

        // Recalculate neighborhood averages after batch
        await recalcNeighborhoodAverages();

        logger.info(`Enrichment complete: ${enriched}/${complexes.rows.length}`);
      } catch (err) {
        logger.error('Batch enrichment failed', { error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/enhanced/enrichment-stats
 * Get statistics on data enrichment coverage
 */
router.get('/enrichment-stats', async (req, res) => {
  try {
    // Use COALESCE to handle missing columns gracefully
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_complexes,
        COUNT(*) FILTER (WHERE last_madlan_update IS NOT NULL) as madlan_enriched,
        COUNT(*) FILTER (WHERE is_officially_declared = TRUE) as officially_declared,
        COUNT(*) FILTER (WHERE official_last_verified IS NOT NULL) as official_verified,
        COUNT(*) FILTER (WHERE developer_last_verified IS NOT NULL) as developer_verified,
        COUNT(*) FILTER (WHERE committee_last_checked IS NOT NULL) as committee_checked,
        COUNT(*) FILTER (WHERE price_trigger_detected = TRUE) as with_price_triggers,
        COUNT(*) FILTER (WHERE developer_risk_score >= 75) as high_risk_developers,
        COUNT(*) FILTER (WHERE nadlan_neighborhood_avg_sqm IS NOT NULL) as nadlan_enriched,
        COUNT(*) FILTER (WHERE neighborhood_avg_sqm IS NOT NULL) as has_neighborhood_avg,
        AVG(madlan_avg_price_sqm) FILTER (WHERE madlan_avg_price_sqm IS NOT NULL) as avg_price_sqm,
        AVG(official_certainty_score) FILTER (WHERE official_certainty_score IS NOT NULL) as avg_certainty
      FROM complexes
    `);

    const row = stats.rows[0];
    const total = parseInt(row.total_complexes) || 1;
    
    res.json({
      total: parseInt(row.total_complexes),
      coverage: {
        madlan: {
          count: parseInt(row.madlan_enriched) || 0,
          percentage: Math.round(((parseInt(row.madlan_enriched) || 0) / total) * 100)
        },
        nadlan: {
          count: parseInt(row.nadlan_enriched) || 0,
          percentage: Math.round(((parseInt(row.nadlan_enriched) || 0) / total) * 100)
        },
        neighborhoodAvg: {
          count: parseInt(row.has_neighborhood_avg) || 0,
          percentage: Math.round(((parseInt(row.has_neighborhood_avg) || 0) / total) * 100)
        },
        official: {
          declared: parseInt(row.officially_declared) || 0,
          verified: parseInt(row.official_verified) || 0,
          percentage: Math.round(((parseInt(row.official_verified) || 0) / total) * 100)
        },
        developer: {
          verified: parseInt(row.developer_verified) || 0,
          highRisk: parseInt(row.high_risk_developers) || 0,
          percentage: Math.round(((parseInt(row.developer_verified) || 0) / total) * 100)
        },
        committee: {
          checked: parseInt(row.committee_checked) || 0,
          withTriggers: parseInt(row.with_price_triggers) || 0,
          percentage: Math.round(((parseInt(row.committee_checked) || 0) / total) * 100)
        }
      },
      averages: {
        pricePerSqm: Math.round(parseFloat(row.avg_price_sqm) || 0),
        certaintyScore: Math.round(parseFloat(row.avg_certainty) || 0)
      }
    });
  } catch (err) {
    logger.error('Enrichment stats error', { error: err.message });
    // Return basic stats if columns don't exist yet
    try {
      const basicStats = await pool.query('SELECT COUNT(*) as total FROM complexes');
      res.json({
        total: parseInt(basicStats.rows[0].total),
        coverage: {
          madlan: { count: 0, percentage: 0 },
          nadlan: { count: 0, percentage: 0 },
          neighborhoodAvg: { count: 0, percentage: 0 },
          official: { declared: 0, verified: 0, percentage: 0 },
          developer: { verified: 0, highRisk: 0, percentage: 0 },
          committee: { checked: 0, withTriggers: 0, percentage: 0 }
        },
        averages: { pricePerSqm: 0, certaintyScore: 0 },
        note: 'Enhanced columns not yet created - run enrichment to initialize'
      });
    } catch (e) {
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
