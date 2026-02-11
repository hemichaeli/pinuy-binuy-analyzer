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

// Run migration on route load (ensures columns exist)
async function ensureColumns() {
  const columns = [
    'madlan_last_updated TIMESTAMP',
    'madlan_avg_price_sqm INTEGER',
    'madlan_price_trend TEXT',
    'is_officially_declared BOOLEAN DEFAULT FALSE',
    'official_track VARCHAR(100)',
    'official_declaration_date DATE',
    'official_plan_number VARCHAR(100)',
    'official_certainty_score INTEGER',
    'official_last_verified TIMESTAMP',
    'price_trigger_detected BOOLEAN DEFAULT FALSE',
    'last_committee_decision TEXT',
    'last_committee_date DATE',
    'price_trigger_impact VARCHAR(50)',
    'committee_last_checked TIMESTAMP',
    'developer_company_number VARCHAR(50)',
    'developer_status VARCHAR(100)',
    'developer_risk_score INTEGER',
    'developer_risk_level VARCHAR(50)',
    'developer_last_verified TIMESTAMP'
  ];
  
  for (const col of columns) {
    try {
      await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (e) {
      // Column may already exist or other benign error
    }
  }
  logger.info('Enhanced data columns verified');
}

// Run on module load
ensureColumns().catch(e => logger.warn('Column check failed', { error: e.message }));

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
          madlan_last_updated = NOW()
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
    // First check if column exists
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'complexes' AND column_name = 'developer_risk_score'
    `);
    
    if (colCheck.rows.length === 0) {
      return res.json({
        high_risk_developers: [],
        total: 0,
        note: 'Developer risk tracking not yet initialized. Run enrichment first.'
      });
    }

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
 */
router.get('/enrichment-stats', async (req, res) => {
  try {
    // Get total count first
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM complexes');
    const total = parseInt(totalResult.rows[0].total);

    // Check which columns exist
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'complexes' 
      AND column_name IN ('madlan_last_updated', 'is_officially_declared', 'official_last_verified', 
                          'developer_last_verified', 'committee_last_checked', 'price_trigger_detected',
                          'developer_risk_score', 'madlan_avg_price_sqm', 'official_certainty_score')
    `);
    const existingCols = new Set(colCheck.rows.map(r => r.column_name));

    // Build dynamic query based on existing columns
    const counts = {
      madlan_enriched: 0,
      officially_declared: 0,
      official_verified: 0,
      developer_verified: 0,
      committee_checked: 0,
      with_price_triggers: 0,
      high_risk_developers: 0,
      avg_price_sqm: 0,
      avg_certainty: 0
    };

    if (existingCols.has('madlan_last_updated')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE madlan_last_updated IS NOT NULL');
      counts.madlan_enriched = parseInt(r.rows[0].c);
    }
    if (existingCols.has('is_officially_declared')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE is_officially_declared = TRUE');
      counts.officially_declared = parseInt(r.rows[0].c);
    }
    if (existingCols.has('official_last_verified')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE official_last_verified IS NOT NULL');
      counts.official_verified = parseInt(r.rows[0].c);
    }
    if (existingCols.has('developer_last_verified')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE developer_last_verified IS NOT NULL');
      counts.developer_verified = parseInt(r.rows[0].c);
    }
    if (existingCols.has('committee_last_checked')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE committee_last_checked IS NOT NULL');
      counts.committee_checked = parseInt(r.rows[0].c);
    }
    if (existingCols.has('price_trigger_detected')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE price_trigger_detected = TRUE');
      counts.with_price_triggers = parseInt(r.rows[0].c);
    }
    if (existingCols.has('developer_risk_score')) {
      const r = await pool.query('SELECT COUNT(*) as c FROM complexes WHERE developer_risk_score >= 75');
      counts.high_risk_developers = parseInt(r.rows[0].c);
    }
    if (existingCols.has('madlan_avg_price_sqm')) {
      const r = await pool.query('SELECT AVG(madlan_avg_price_sqm) as avg FROM complexes WHERE madlan_avg_price_sqm IS NOT NULL');
      counts.avg_price_sqm = Math.round(parseFloat(r.rows[0].avg) || 0);
    }
    if (existingCols.has('official_certainty_score')) {
      const r = await pool.query('SELECT AVG(official_certainty_score) as avg FROM complexes WHERE official_certainty_score IS NOT NULL');
      counts.avg_certainty = Math.round(parseFloat(r.rows[0].avg) || 0);
    }

    res.json({
      total,
      columnsInitialized: existingCols.size,
      coverage: {
        madlan: {
          count: counts.madlan_enriched,
          percentage: total > 0 ? Math.round((counts.madlan_enriched / total) * 100) : 0
        },
        official: {
          declared: counts.officially_declared,
          verified: counts.official_verified,
          percentage: total > 0 ? Math.round((counts.official_verified / total) * 100) : 0
        },
        developer: {
          verified: counts.developer_verified,
          highRisk: counts.high_risk_developers,
          percentage: total > 0 ? Math.round((counts.developer_verified / total) * 100) : 0
        },
        committee: {
          checked: counts.committee_checked,
          withTriggers: counts.with_price_triggers,
          percentage: total > 0 ? Math.round((counts.committee_checked / total) * 100) : 0
        }
      },
      averages: {
        pricePerSqm: counts.avg_price_sqm,
        certaintyScore: counts.avg_certainty
      }
    });
  } catch (err) {
    logger.error('Enrichment stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enhanced/init-columns
 * Initialize enhanced data columns (manual trigger)
 */
router.post('/init-columns', async (req, res) => {
  try {
    await ensureColumns();
    res.json({ message: 'Enhanced data columns initialized successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
