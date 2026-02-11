/**
 * Enhanced Data Sources Routes - Phase 4.5
 * 
 * Integrates:
 * - Madlan (madlan.co.il) - Enhanced transaction data
 * - Urban Renewal Authority (gov.il) - Official complex status
 * - Committee Protocols (mavat.iplan.gov.il) - Planning decisions
 * - Company Registry (data.gov.il) - Developer verification
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

  res.json({
    version: '4.5.0',
    phase: 'Enhanced Data Sources Integration',
    sources: {
      madlan: {
        available: !!madlan,
        description: 'נתוני עסקאות ומחירים מ-madlan.co.il',
        features: ['transaction_history', 'area_statistics', 'price_trends', 'comparables']
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
    allAvailable: !!(madlan && urbanRenewal && committee && developer),
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
 * Enrich a complex with Madlan data
 */
router.post('/madlan/enrich/:complexId', async (req, res) => {
  const madlan = getService('madlan');
  if (!madlan) {
    return res.status(503).json({ error: 'Madlan service not available' });
  }

  try {
    const complexId = parseInt(req.params.complexId);
    const complexResult = await pool.query(
      'SELECT id, name, city, street, address FROM complexes WHERE id = $1',
      [complexId]
    );

    if (complexResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complex not found' });
    }

    const complex = complexResult.rows[0];
    const enriched = await madlan.enrichComplexData(complex);
    
    // Save to database if data was found
    if (enriched.madlanData?.areaStats?.avgPricePerSqm) {
      await pool.query(`
        UPDATE complexes SET
          madlan_avg_price_sqm = $1,
          madlan_price_trend = $2,
          last_madlan_update = NOW()
        WHERE id = $3
      `, [
        enriched.madlanData.areaStats.avgPricePerSqm,
        enriched.madlanData.priceTrend?.trend || null,
        complexId
      ]);
    }

    res.json(enriched);
  } catch (err) {
    logger.error('Madlan enrich error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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
      'SELECT id, name, city, plan_number, street FROM complexes WHERE id = $1',
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
        // Build query
        let query = 'SELECT id, name, city, street, address, developer, plan_number FROM complexes WHERE 1=1';
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
              if (madlan) await madlan.enrichComplexData(complex);
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
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            logger.warn(`Enrichment failed for ${complex.name}`, { error: e.message });
          }
        }

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
 * Note: Uses dynamic column detection to handle migration state
 */
router.get('/enrichment-stats', async (req, res) => {
  try {
    // First check which columns exist
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'complexes' 
      AND column_name IN (
        'last_madlan_update', 'is_officially_declared', 'official_last_verified',
        'developer_last_verified', 'committee_last_checked', 'price_trigger_detected',
        'developer_risk_score', 'madlan_avg_price_sqm', 'official_certainty_score'
      )
    `);
    
    const existingColumns = columnCheck.rows.map(r => r.column_name);
    
    // Get basic count
    const basicStats = await pool.query('SELECT COUNT(*) as total_complexes FROM complexes');
    const total = parseInt(basicStats.rows[0].total_complexes);
    
    // Build dynamic stats query based on available columns
    const stats = {
      total,
      coverage: {
        madlan: { count: 0, percentage: 0 },
        official: { declared: 0, verified: 0, percentage: 0 },
        developer: { verified: 0, highRisk: 0, percentage: 0 },
        committee: { checked: 0, withTriggers: 0, percentage: 0 }
      },
      averages: { pricePerSqm: 0, certaintyscore: 0 },
      migrationStatus: {
        columnsAvailable: existingColumns.length,
        columnsExpected: 9,
        migrationComplete: existingColumns.length >= 9
      }
    };
    
    // If migration has run, get full stats
    if (existingColumns.length > 0) {
      const queries = [];
      
      if (existingColumns.includes('last_madlan_update')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE last_madlan_update IS NOT NULL`));
      }
      if (existingColumns.includes('is_officially_declared')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE is_officially_declared = TRUE`));
      }
      if (existingColumns.includes('official_last_verified')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE official_last_verified IS NOT NULL`));
      }
      if (existingColumns.includes('developer_last_verified')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE developer_last_verified IS NOT NULL`));
      }
      if (existingColumns.includes('committee_last_checked')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE committee_last_checked IS NOT NULL`));
      }
      if (existingColumns.includes('price_trigger_detected')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE price_trigger_detected = TRUE`));
      }
      if (existingColumns.includes('developer_risk_score')) {
        queries.push(pool.query(`SELECT COUNT(*) as c FROM complexes WHERE developer_risk_score >= 75`));
      }
      if (existingColumns.includes('madlan_avg_price_sqm')) {
        queries.push(pool.query(`SELECT AVG(madlan_avg_price_sqm) as avg FROM complexes WHERE madlan_avg_price_sqm IS NOT NULL`));
      }
      if (existingColumns.includes('official_certainty_score')) {
        queries.push(pool.query(`SELECT AVG(official_certainty_score) as avg FROM complexes WHERE official_certainty_score IS NOT NULL`));
      }
      
      const results = await Promise.all(queries);
      let idx = 0;
      
      if (existingColumns.includes('last_madlan_update')) {
        stats.coverage.madlan.count = parseInt(results[idx++].rows[0].c);
        stats.coverage.madlan.percentage = Math.round((stats.coverage.madlan.count / total) * 100);
      }
      if (existingColumns.includes('is_officially_declared')) {
        stats.coverage.official.declared = parseInt(results[idx++].rows[0].c);
      }
      if (existingColumns.includes('official_last_verified')) {
        stats.coverage.official.verified = parseInt(results[idx++].rows[0].c);
        stats.coverage.official.percentage = Math.round((stats.coverage.official.verified / total) * 100);
      }
      if (existingColumns.includes('developer_last_verified')) {
        stats.coverage.developer.verified = parseInt(results[idx++].rows[0].c);
        stats.coverage.developer.percentage = Math.round((stats.coverage.developer.verified / total) * 100);
      }
      if (existingColumns.includes('committee_last_checked')) {
        stats.coverage.committee.checked = parseInt(results[idx++].rows[0].c);
        stats.coverage.committee.percentage = Math.round((stats.coverage.committee.checked / total) * 100);
      }
      if (existingColumns.includes('price_trigger_detected')) {
        stats.coverage.committee.withTriggers = parseInt(results[idx++].rows[0].c);
      }
      if (existingColumns.includes('developer_risk_score')) {
        stats.coverage.developer.highRisk = parseInt(results[idx++].rows[0].c);
      }
      if (existingColumns.includes('madlan_avg_price_sqm')) {
        stats.averages.pricePerSqm = Math.round(parseFloat(results[idx++].rows[0].avg) || 0);
      }
      if (existingColumns.includes('official_certainty_score')) {
        stats.averages.certaintyscore = Math.round(parseFloat(results[idx++].rows[0].avg) || 0);
      }
    }

    res.json(stats);
  } catch (err) {
    logger.error('Enrichment stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/run-migration
 * Manually trigger migration 007 if needed
 */
router.post('/run-migration', async (req, res) => {
  try {
    // Run essential column additions
    const migrations = [
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_avg_price_sqm INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_price_trend DECIMAL(5,2)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_madlan_update TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_officially_declared BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_track VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_declaration_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_plan_number VARCHAR(100)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_certainty_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_last_verified TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS committee_last_checked TIMESTAMP',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_detected BOOLEAN DEFAULT FALSE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_decision TEXT',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_date DATE',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_impact VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_company_number VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_status VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_score INTEGER',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_level VARCHAR(50)',
      'ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_last_verified TIMESTAMP'
    ];
    
    let success = 0;
    let failed = 0;
    
    for (const sql of migrations) {
      try {
        await pool.query(sql);
        success++;
      } catch (e) {
        // Column already exists - that's fine
        if (!e.message.includes('already exists')) {
          logger.warn('Migration step failed', { sql, error: e.message });
          failed++;
        } else {
          success++;
        }
      }
    }
    
    res.json({
      message: 'Migration complete',
      success,
      failed,
      total: migrations.length
    });
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
