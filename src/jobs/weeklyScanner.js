const cron = require('node-cron');
const pool = require('../db/pool');
const { scanAll } = require('../services/perplexityService');
const { calculateAllIAI } = require('../services/iaiCalculator');
const { calculateAllSSI } = require('../services/ssiCalculator');
const nadlanScraper = require('../services/nadlanScraper');
const { calculateAllBenchmarks } = require('../services/benchmarkService');
const yad2Scraper = require('../services/yad2Scraper');
const mavatScraper = require('../services/mavatScraper');
const notificationService = require('../services/notificationService');
const { logger } = require('../services/logger');
const { shouldSkipToday, getUpcomingHolidays } = require('../config/israeliHolidays');

// Daily scan at 8:00 AM Israel time
const DAILY_CRON = process.env.SCAN_CRON || '0 8 * * *';

let isRunning = false;
let lastRunResult = null;
let lastSkipResult = null;
let scheduledTask = null;

// Lazy load services
function getClaudeOrchestrator() {
  try {
    return require('../services/claudeOrchestrator');
  } catch (e) {
    return null;
  }
}

function getDiscoveryService() {
  try {
    return require('../services/discoveryService');
  } catch (e) {
    logger.debug('Discovery service not available', { error: e.message });
    return null;
  }
}

function getKonesIsraelService() {
  try {
    return require('../services/konesIsraelService');
  } catch (e) {
    logger.debug('KonesIsrael service not available', { error: e.message });
    return null;
  }
}

/**
 * Send notification that today's scan was skipped
 */
async function sendSkipNotification(skipInfo) {
  if (!notificationService.isConfigured()) {
    logger.info('Skip notification not sent - no email provider configured');
    return;
  }

  const now = new Date();
  const israelTime = now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  
  const subject = `⏸️ [QUANTUM] סריקה יומית דולגה - ${skipInfo.reasonHe}`;
  
  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #f59e0b;">⏸️ הסריקה היומית דולגה</h2>
      
      <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 16px;"><strong>סיבה:</strong> ${skipInfo.reasonHe}</p>
        <p style="margin: 0; color: #92400e;"><strong>זמן:</strong> ${israelTime}</p>
      </div>
      
      <h3 style="color: #374151;">📅 חגים קרובים</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 6px 8px; text-align: right; border: 1px solid #e5e7eb;">תאריך</th>
            <th style="padding: 6px 8px; text-align: right; border: 1px solid #e5e7eb;">חג</th>
          </tr>
        </thead>
        <tbody>
          ${getUpcomingHolidays(7).map(h => `
            <tr>
              <td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${h.date}</td>
              <td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${h.name} (${h.nameEn})</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      
      <p style="margin: 16px 0 0; color: #6b7280; font-size: 12px;">
        הסריקה הבאה תרוץ ביום עבודה הקרוב (ראשון-חמישי, לא חג) בשעה 08:00.<br>
        ניתן להריץ סריקה ידנית: <code>POST /api/scheduler/run</code>
      </p>
      
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
      <p style="font-size: 11px; color: #9ca3af; text-align: center;">
        QUANTUM v4.8.0 - Pinuy Binuy Investment Analyzer
      </p>
    </div>
  `;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    logger.info(`Skip notification sent: ${skipInfo.reason}`);
  } catch (err) {
    logger.warn('Failed to send skip notification', { error: err.message });
  }
}

async function snapshotStatuses() {
  const result = await pool.query(
    'SELECT id, status, iai_score, actual_premium, local_committee_date, district_committee_date FROM complexes'
  );
  const map = {};
  for (const row of result.rows) {
    map[row.id] = {
      status: row.status, iai_score: row.iai_score,
      actual_premium: row.actual_premium,
      local_committee_date: row.local_committee_date,
      district_committee_date: row.district_committee_date
    };
  }
  return map;
}

async function generateAlerts(beforeSnapshot) {
  const afterResult = await pool.query(
    `SELECT id, name, city, status, iai_score, actual_premium,
            local_committee_date, district_committee_date FROM complexes`
  );
  let alertCount = 0;

  for (const complex of afterResult.rows) {
    const before = beforeSnapshot[complex.id];
    if (!before) continue;

    if (before.status !== complex.status) {
      await createAlert({
        complexId: complex.id, type: 'status_change', severity: 'high',
        title: `שינוי סטטוס: ${complex.name} (${complex.city})`,
        message: `הסטטוס השתנה מ-${translateStatus(before.status)} ל-${translateStatus(complex.status)}`,
        data: { old_status: before.status, new_status: complex.status }
      });
      alertCount++;
    }

    if (complex.local_committee_date && !before.local_committee_date) {
      await createAlert({
        complexId: complex.id, type: 'committee_approval', severity: 'critical',
        title: `🎯 אישור ועדה מקומית: ${complex.name} (${complex.city})`,
        message: `התכנית אושרה בוועדה מקומית ב-${complex.local_committee_date}. טריגר מחיר ראשון!`,
        data: { committee: 'local', date: complex.local_committee_date }
      });
      alertCount++;
    }

    if (complex.district_committee_date && !before.district_committee_date) {
      await createAlert({
        complexId: complex.id, type: 'committee_approval', severity: 'high',
        title: `🎯 אישור ועדה מחוזית: ${complex.name} (${complex.city})`,
        message: `התכנית אושרה בוועדה מחוזית ב-${complex.district_committee_date}. גל שני של עליית מחירים!`,
        data: { committee: 'district', date: complex.district_committee_date }
      });
      alertCount++;
    }

    if (complex.iai_score >= 70 && (before.iai_score || 0) < 70) {
      await createAlert({
        complexId: complex.id, type: 'opportunity', severity: 'high',
        title: `⭐ הזדמנות מצוינת: ${complex.name} (${complex.city})`,
        message: `ציון IAI עלה ל-${complex.iai_score} (רכישה מומלצת)`,
        data: { old_iai: before.iai_score, new_iai: complex.iai_score }
      });
      alertCount++;
    }
  }

  return alertCount;
}

async function createAlert({ complexId, type, severity, title, message, data }) {
  try {
    const existing = await pool.query(
      `SELECT id FROM alerts WHERE complex_id = $1 AND alert_type = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
      [complexId, type]
    );
    if (existing.rows.length > 0) return;
    await pool.query(
      `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)`,
      [complexId, type, severity, title, message, JSON.stringify(data || {})]
    );
  } catch (err) {
    logger.warn('Failed to create alert', { error: err.message, type, complexId });
  }
}

function translateStatus(status) {
  const map = {
    'declared': 'הוכרז', 'planning': 'בתכנון', 'pre_deposit': 'להפקדה',
    'deposited': 'הופקדה', 'approved': 'אושרה', 'construction': 'בביצוע', 'permit': 'היתר'
  };
  return map[status] || status;
}

function formatPrice(price) {
  if (!price) return 'N/A';
  return `${Number(price).toLocaleString('he-IL')} ש"ח`;
}

/**
 * Send scan status notification
 */
async function sendScanStatusNotification(result) {
  if (!notificationService.isConfigured()) return;

  const subject = result.error 
    ? `❌ [QUANTUM] סריקה יומית נכשלה` 
    : `✅ [QUANTUM] סריקה יומית הושלמה`;

  const html = `
    <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right;">
      <h2 style="color: ${result.error ? '#dc3545' : '#28a745'};">
        ${result.error ? '❌ סריקה נכשלה' : '✅ סריקה יומית הושלמה'}
      </h2>
      
      <p><strong>זמן:</strong> ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</p>
      <p><strong>משך:</strong> ${result.duration || 'N/A'}</p>
      
      ${result.error ? `<p style="color: #dc3545;"><strong>שגיאה:</strong> ${result.error}</p>` : ''}
      
      ${!result.error ? `
        <h3>📊 סיכום סריקה</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr style="background: #f8f9fa;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>מתחמים נסרקו</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.unified?.scanned || result.perplexity?.succeeded || 0}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>שינויים זוהו</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.unified?.changes || 0}</td>
          </tr>
          <tr style="background: #f8f9fa;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>עסקאות חדשות</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.nadlan?.newTransactions || 0}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>מודעות חדשות</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.yad2?.newListings || 0}</td>
          </tr>
          ${result.konesIsrael ? `
          <tr style="background: #fff3e0;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>🏛️ כונס נכסים (KonesIsrael)</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.konesIsrael.totalListings || 0} מודעות, ${result.konesIsrael.matchedComplexes || 0} התאמות למתחמים</td>
          </tr>
          ` : ''}
          ${result.discovery ? `
          <tr style="background: #e8f4fd;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>🔍 ערים נסרקו לגילוי</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.discovery?.citiesScanned || 0} ערים</td>
          </tr>
          <tr style="background: #d4edda;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>🆕 מתחמים חדשים התגלו</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.discovery?.newAdded || 0}</td>
          </tr>
          ` : ''}
          <tr style="background: #f8f9fa;">
            <td style="padding: 8px; border: 1px solid #dee2e6;"><strong>התראות נוצרו</strong></td>
            <td style="padding: 8px; border: 1px solid #dee2e6;">${result.alertsGenerated || 0}</td>
          </tr>
        </table>
        
        <h3>🤖 מקורות AI</h3>
        <ul>
          <li>Perplexity: ${result.unified?.sources?.perplexity ? '✅' : '❌'}</li>
          <li>Claude: ${result.unified?.sources?.claude ? '✅' : '⚠️ לא מוגדר'}</li>
          <li>KonesIsrael: ${result.konesIsrael ? '✅' : '⚠️ לא זמין'}</li>
        </ul>
      ` : ''}
      
      <hr style="margin: 20px 0;">
      <p style="color: #6c757d; font-size: 12px;">
        QUANTUM - Pinuy Binuy Investment Analyzer v4.8.0<br>
        סריקה אוטומטית יומית ב-08:00 (ראשון-חמישי, לא בחגים)
      </p>
    </div>
  `;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    logger.info('Scan status notification sent');
  } catch (err) {
    logger.warn('Failed to send scan status notification', { error: err.message });
  }
}

/**
 * Run the daily scan with unified AI (Perplexity + Claude)
 * NOW SCANS ALL TARGET CITIES DAILY FOR DISCOVERY
 * v4.8.0: Includes KonesIsrael + Weekend/Holiday skip
 */
async function runWeeklyScan(options = {}) {
  const { forceAll = false, includeDiscovery = true } = options;
  if (isRunning) {
    logger.warn('Scan already running, skipping');
    return null;
  }

  isRunning = true;
  const startTime = Date.now();
  const staleOnly = !forceAll;
  
  logger.info(`=== Daily scan started (forceAll: ${forceAll}, discovery: ${includeDiscovery}) ===`);

  try {
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, started_at, status) VALUES ('daily_auto', NOW(), 'running') RETURNING id`
    );
    const scanId = scanLog.rows[0].id;
    const beforeSnapshot = await snapshotStatuses();

    // Step 1: Unified AI Scan (Perplexity + Claude)
    let unifiedResults = { total: 0, scanned: 0, succeeded: 0, changes: 0, sources: {} };
    const orchestrator = getClaudeOrchestrator();
    if (orchestrator) {
      try {
        logger.info('Step 1/9: Running Unified AI scan (Perplexity + Claude)...');
        unifiedResults = await orchestrator.scanAllUnified({ staleOnly, limit: 129 });
        logger.info(`Unified AI: ${unifiedResults.succeeded}/${unifiedResults.total} ok, ${unifiedResults.changes} changes`);
      } catch (unifiedErr) {
        logger.warn('Unified AI scan failed', { error: unifiedErr.message });
        // Fallback to Perplexity only
        logger.info('Falling back to Perplexity-only scan...');
        const fallback = await scanAll({ staleOnly });
        unifiedResults = { 
          total: fallback.total, scanned: fallback.scanned, 
          succeeded: fallback.succeeded, changes: 0,
          sources: { perplexity: true, claude: false }
        };
      }
    } else {
      logger.info('Step 1/9: Running Perplexity scan (Claude not available)...');
      const results = await scanAll({ staleOnly });
      unifiedResults = { 
        total: results.total, scanned: results.scanned, 
        succeeded: results.succeeded, changes: 0,
        sources: { perplexity: true, claude: false }
      };
    }

    // Step 2: Nadlan transactions
    let nadlanResults = { totalNew: 0 };
    try {
      logger.info('Step 2/9: Running nadlan.gov.il scan...');
      nadlanResults = await nadlanScraper.scanAll({ staleOnly, limit: 50 });
    } catch (e) { logger.warn('Nadlan failed', { error: e.message }); }

    // Step 3: Benchmarks
    let benchmarkResults = { calculated: 0 };
    try {
      logger.info('Step 3/9: Calculating benchmarks...');
      benchmarkResults = await calculateAllBenchmarks({ limit: 50 });
    } catch (e) { logger.warn('Benchmark failed', { error: e.message }); }

    // Step 4: yad2 listings
    let yad2Results = { totalNew: 0, totalUpdated: 0, totalPriceChanges: 0 };
    try {
      logger.info('Step 4/9: Running yad2 scan...');
      yad2Results = await yad2Scraper.scanAll({ staleOnly, limit: 50 });
    } catch (e) { logger.warn('yad2 failed', { error: e.message }); }

    // Step 5: SSI calculation
    let ssiResults = { stressed: 0, very_stressed: 0 };
    try {
      logger.info('Step 5/9: Calculating SSI scores...');
      ssiResults = await calculateAllSSI();
    } catch (e) { logger.warn('SSI failed', { error: e.message }); }

    // Step 6: IAI recalculation
    try {
      logger.info('Step 6/9: Recalculating IAI scores...');
      await calculateAllIAI();
    } catch (e) { logger.warn('IAI failed', { error: e.message }); }

    // Step 7: Discovery - SCAN ALL TARGET CITIES DAILY
    let discoveryResults = { citiesScanned: 0, newAdded: 0, alreadyExisted: 0 };
    if (includeDiscovery) {
      const discoveryService = getDiscoveryService();
      if (discoveryService) {
        const allCities = discoveryService.ALL_TARGET_CITIES;
        logger.info(`Step 7/9: 🔍 Discovery scan for ALL ${allCities.length} target cities...`);
        
        try {
          let totalNew = 0;
          let totalExisted = 0;
          let citiesScanned = 0;
          
          for (let i = 0; i < allCities.length; i++) {
            const city = allCities[i];
            logger.info(`  [${i + 1}/${allCities.length}] Discovering in ${city}...`);
            
            try {
              const cityResult = await discoveryService.discoverInCity(city);
              citiesScanned++;
              
              if (cityResult?.discovered_complexes) {
                for (const complex of cityResult.discovered_complexes) {
                  // Skip if below minimum units
                  if (complex.existing_units && complex.existing_units < discoveryService.MIN_HOUSING_UNITS) {
                    continue;
                  }
                  
                  const newId = await discoveryService.addNewComplex(complex, city, 'discovery-daily');
                  if (newId) {
                    totalNew++;
                    logger.info(`  ✨ NEW: ${complex.name} (${city}) - ${complex.existing_units || '?'} units`);
                    
                    // Create alert for new discovery
                    await createAlert({
                      complexId: newId,
                      type: 'new_complex',
                      severity: 'high',
                      title: `🆕 מתחם חדש התגלה: ${complex.name} (${city})`,
                      message: `נמצא מתחם חדש: ${complex.existing_units || '?'} יח"ד קיימות, ` +
                        `${complex.planned_units || '?'} יח"ד מתוכננות. ` +
                        `סטטוס: ${complex.status}. יזם: ${complex.developer || 'לא ידוע'}.`,
                      data: {
                        addresses: complex.addresses,
                        source: complex.source,
                        plan_number: complex.plan_number
                      }
                    });
                  } else {
                    totalExisted++;
                  }
                }
              }
              
              // Rate limit between cities (3 seconds)
              if (i < allCities.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
              }
            } catch (cityErr) {
              logger.warn(`  Discovery failed for ${city}`, { error: cityErr.message });
            }
          }
          
          discoveryResults = {
            citiesScanned,
            totalCities: allCities.length,
            newAdded: totalNew,
            alreadyExisted: totalExisted
          };
          
          logger.info(`Discovery complete: ${citiesScanned}/${allCities.length} cities, ${totalNew} NEW complexes!`);
        } catch (e) { 
          logger.warn('Discovery failed', { error: e.message }); 
        }
      } else {
        logger.info('Step 7/9: Discovery service not available');
      }
    } else {
      logger.info('Step 7/9: Discovery disabled');
    }

    // Step 8: KonesIsrael receivership data scan
    let konesResults = { totalListings: 0, matchedComplexes: 0, ssiUpdated: 0, errors: null };
    const konesService = getKonesIsraelService();
    if (konesService) {
      try {
        logger.info('Step 8/9: 🏛️ Scanning KonesIsrael receivership listings...');
        
        // Fetch listings via headless browser
        const listings = await konesService.fetchWithLogin(true);
        konesResults.totalListings = listings.length;
        logger.info(`KonesIsrael: Fetched ${listings.length} receivership listings`);
        
        if (listings.length > 0) {
          // Match with existing complexes
          const complexes = await pool.query('SELECT id, name, city, street, address FROM complexes');
          const matches = await konesService.matchWithComplexes(complexes.rows);
          konesResults.matchedComplexes = matches.length;
          
          logger.info(`KonesIsrael: ${matches.length} matches found with existing complexes`);
          
          // Update SSI for matched complexes (receivership = +30 SSI)
          for (const match of matches) {
            try {
              await pool.query(
                `UPDATE complexes SET 
                  is_receivership = TRUE, 
                  has_property_liens = TRUE,
                  distress_indicators = COALESCE(distress_indicators, '{}'::jsonb) || $1::jsonb,
                  ssi_last_enhanced = NOW()
                WHERE id = $2`,
                [
                  JSON.stringify({
                    kones_israel: {
                      matched_listings: match.matchedListings,
                      last_scan: new Date().toISOString(),
                      listings: match.listings.slice(0, 5).map(l => ({
                        city: l.city,
                        address: l.address,
                        type: l.propertyType,
                        deadline: l.submissionDeadline
                      }))
                    }
                  }),
                  match.complexId
                ]
              );
              konesResults.ssiUpdated++;
              
              // Create alert for receivership match
              await createAlert({
                complexId: match.complexId,
                type: 'stressed_seller',
                severity: 'high',
                title: `🏛️ כונס נכסים: ${match.complexName}`,
                message: `נמצאו ${match.matchedListings} נכסים בכינוס נכסים במתחם. SSI +30 נקודות.`,
                data: {
                  source: 'konesisrael',
                  matched_listings: match.matchedListings,
                  ssi_boost: 30
                }
              });
            } catch (updateErr) {
              logger.warn(`KonesIsrael: Failed to update complex ${match.complexId}`, { error: updateErr.message });
            }
          }
          
          // Store listings summary in distressed_sellers table
          for (const listing of listings.slice(0, 100)) {
            try {
              const existingCheck = await pool.query(
                `SELECT id FROM distressed_sellers WHERE source = 'konesisrael' AND details->>'address' = $1 AND details->>'city' = $2`,
                [listing.address || '', listing.city || '']
              );
              
              if (existingCheck.rows.length === 0) {
                await pool.query(
                  `INSERT INTO distressed_sellers (complex_id, distress_type, distress_score, source, details) 
                   VALUES ($1, 'receivership', 30, 'konesisrael', $2)`,
                  [
                    null, // Will be linked if matched
                    JSON.stringify({
                      city: listing.city,
                      address: listing.address,
                      propertyType: listing.propertyType,
                      region: listing.region,
                      deadline: listing.submissionDeadline,
                      contactPerson: listing.contactPerson,
                      gush: listing.gush,
                      helka: listing.helka
                    })
                  ]
                );
              }
            } catch (insertErr) {
              // Skip duplicate or error
            }
          }
          
          logger.info(`KonesIsrael: Updated ${konesResults.ssiUpdated} complexes with receivership data`);
        }
      } catch (e) {
        konesResults.errors = e.message;
        logger.warn('KonesIsrael scan failed', { error: e.message });
      }
    } else {
      logger.info('Step 8/9: KonesIsrael service not available');
    }

    // Step 9: Generate alerts
    logger.info('Step 9/9: Generating alerts...');
    const alertCount = await generateAlerts(beforeSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Daily scan: Unified AI ${unifiedResults.succeeded}/${unifiedResults.total} ok, ` +
      `${unifiedResults.changes} changes. Nadlan: ${nadlanResults.totalNew} tx. ` +
      `yad2: ${yad2Results.totalNew} new. ` +
      `KonesIsrael: ${konesResults.totalListings} listings, ${konesResults.matchedComplexes} matches. ` +
      `Discovery: ${discoveryResults.citiesScanned} cities, ${discoveryResults.newAdded} new. ` +
      `${alertCount} alerts. ${duration}s`;

    lastRunResult = {
      scanId, completedAt: new Date().toISOString(), duration: `${duration}s`,
      unified: unifiedResults,
      nadlan: { newTransactions: nadlanResults.totalNew || 0 },
      benchmarks: { calculated: benchmarkResults.calculated || 0 },
      yad2: { newListings: yad2Results.totalNew || 0, updated: yad2Results.totalUpdated || 0 },
      ssi: ssiResults,
      konesIsrael: konesResults,
      discovery: discoveryResults,
      alertsGenerated: alertCount,
      summary
    };

    await pool.query(
      `UPDATE scan_logs SET 
        completed_at = NOW(), status = 'completed', complexes_scanned = $1,
        new_transactions = $2, new_listings = $3, status_changes = $4,
        alerts_sent = $5, summary = $6
       WHERE id = $7`,
      [unifiedResults.scanned || unifiedResults.total,
        nadlanResults.totalNew || 0,
        (yad2Results.totalNew || 0) + (konesResults.totalListings || 0),
        (unifiedResults.changes || 0) + (discoveryResults.newAdded || 0),
        alertCount, summary, scanId]
    );

    // Send scan status notification
    await sendScanStatusNotification(lastRunResult);

    // Send pending alerts
    if (notificationService.isConfigured() && alertCount > 0) {
      try {
        await notificationService.sendPendingAlerts();
      } catch (e) { logger.warn('Failed to send alerts', { error: e.message }); }
    }

    logger.info(`=== Daily scan completed in ${duration}s ===`);
    return lastRunResult;

  } catch (err) {
    logger.error('Daily scan failed', { error: err.message });
    lastRunResult = { error: err.message, completedAt: new Date().toISOString() };
    await sendScanStatusNotification(lastRunResult);
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('PERPLEXITY_API_KEY not set - scheduler disabled');
    return;
  }
  if (!cron.validate(DAILY_CRON)) {
    logger.error(`Invalid cron: ${DAILY_CRON}`);
    return;
  }
  scheduledTask = cron.schedule(DAILY_CRON, async () => {
    // Check if today should be skipped (weekend or holiday)
    const skipCheck = shouldSkipToday();
    
    if (skipCheck.shouldSkip) {
      logger.info(`⏸️ Daily scan SKIPPED: ${skipCheck.reason}`);
      lastSkipResult = {
        skippedAt: new Date().toISOString(),
        reason: skipCheck.reason,
        reasonHe: skipCheck.reasonHe
      };
      
      // Send skip notification
      await sendSkipNotification(skipCheck);
      return;
    }
    
    logger.info(`Daily scan triggered: ${DAILY_CRON}`);
    await runWeeklyScan();
  }, { timezone: 'Asia/Jerusalem' });
  logger.info(`Daily scanner scheduled: ${DAILY_CRON} (08:00 Israel time, Sun-Thu, no holidays)`);
}

function stopScheduler() {
  if (scheduledTask) { scheduledTask.stop(); logger.info('Scheduler stopped'); }
}

function getSchedulerStatus() {
  const orchestrator = getClaudeOrchestrator();
  const discoveryService = getDiscoveryService();
  const konesService = getKonesIsraelService();
  const todaySkipCheck = shouldSkipToday();
  const upcoming = getUpcomingHolidays(5);
  
  return {
    enabled: !!scheduledTask, 
    cron: DAILY_CRON, 
    schedule: 'Daily at 08:00 Israel time (Sun-Thu, no holidays)',
    timezone: 'Asia/Jerusalem',
    skipWeekends: true,
    skipHolidays: true,
    todayStatus: todaySkipCheck.shouldSkip 
      ? `⏸️ SKIP: ${todaySkipCheck.reasonHe}` 
      : '✅ Active - will run',
    upcomingHolidays: upcoming,
    isRunning, 
    lastRun: lastRunResult,
    lastSkip: lastSkipResult,
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY,
    claudeConfigured: orchestrator?.isClaudeConfigured() || false,
    notificationsConfigured: notificationService.isConfigured(),
    discoveryEnabled: !!discoveryService,
    discoverySchedule: 'Daily - ALL cities',
    targetCities: discoveryService?.ALL_TARGET_CITIES?.length || 0,
    targetRegions: discoveryService?.TARGET_REGIONS ? Object.keys(discoveryService.TARGET_REGIONS) : [],
    minHousingUnits: discoveryService?.MIN_HOUSING_UNITS || 12,
    konesIsraelEnabled: !!konesService,
    konesIsraelConfigured: konesService?.isConfigured() || false
  };
}

module.exports = { startScheduler, stopScheduler, runWeeklyScan, getSchedulerStatus, createAlert };
