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

// Daily scan at 8:00 AM Israel time
const DAILY_CRON = process.env.SCAN_CRON || '0 8 * * *';

let isRunning = false;
let lastRunResult = null;
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
        </ul>
      ` : ''}
      
      <hr style="margin: 20px 0;">
      <p style="color: #6c757d; font-size: 12px;">
        QUANTUM - Pinuy Binuy Investment Analyzer<br>
        סריקה אוטומטית יומית ב-08:00
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
        logger.info('Step 1/8: Running Unified AI scan (Perplexity + Claude)...');
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
      logger.info('Step 1/8: Running Perplexity scan (Claude not available)...');
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
      logger.info('Step 2/8: Running nadlan.gov.il scan...');
      nadlanResults = await nadlanScraper.scanAll({ staleOnly, limit: 50 });
    } catch (e) { logger.warn('Nadlan failed', { error: e.message }); }

    // Step 3: Benchmarks
    let benchmarkResults = { calculated: 0 };
    try {
      logger.info('Step 3/8: Calculating benchmarks...');
      benchmarkResults = await calculateAllBenchmarks({ limit: 50 });
    } catch (e) { logger.warn('Benchmark failed', { error: e.message }); }

    // Step 4: yad2 listings
    let yad2Results = { totalNew: 0, totalUpdated: 0, totalPriceChanges: 0 };
    try {
      logger.info('Step 4/8: Running yad2 scan...');
      yad2Results = await yad2Scraper.scanAll({ staleOnly, limit: 50 });
    } catch (e) { logger.warn('yad2 failed', { error: e.message }); }

    // Step 5: SSI calculation
    let ssiResults = { stressed: 0, very_stressed: 0 };
    try {
      logger.info('Step 5/8: Calculating SSI scores...');
      ssiResults = await calculateAllSSI();
    } catch (e) { logger.warn('SSI failed', { error: e.message }); }

    // Step 6: IAI recalculation
    try {
      logger.info('Step 6/8: Recalculating IAI scores...');
      await calculateAllIAI();
    } catch (e) { logger.warn('IAI failed', { error: e.message }); }

    // Step 7: Discovery - SCAN ALL TARGET CITIES DAILY
    let discoveryResults = { citiesScanned: 0, newAdded: 0, alreadyExisted: 0 };
    if (includeDiscovery) {
      const discoveryService = getDiscoveryService();
      if (discoveryService) {
        const allCities = discoveryService.ALL_TARGET_CITIES;
        logger.info(`Step 7/8: 🔍 Discovery scan for ALL ${allCities.length} target cities...`);
        
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
        logger.info('Step 7/8: Discovery service not available');
      }
    } else {
      logger.info('Step 7/8: Discovery disabled');
    }

    // Step 8: Generate alerts
    logger.info('Step 8/8: Generating alerts...');
    const alertCount = await generateAlerts(beforeSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Daily scan: Unified AI ${unifiedResults.succeeded}/${unifiedResults.total} ok, ` +
      `${unifiedResults.changes} changes. Nadlan: ${nadlanResults.totalNew} tx. ` +
      `yad2: ${yad2Results.totalNew} new. ` +
      `Discovery: ${discoveryResults.citiesScanned} cities, ${discoveryResults.newAdded} new. ` +
      `${alertCount} alerts. ${duration}s`;

    lastRunResult = {
      scanId, completedAt: new Date().toISOString(), duration: `${duration}s`,
      unified: unifiedResults,
      nadlan: { newTransactions: nadlanResults.totalNew || 0 },
      benchmarks: { calculated: benchmarkResults.calculated || 0 },
      yad2: { newListings: yad2Results.totalNew || 0, updated: yad2Results.totalUpdated || 0 },
      ssi: ssiResults,
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
        yad2Results.totalNew || 0,
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
    logger.info(`Daily scan triggered: ${DAILY_CRON}`);
    await runWeeklyScan();
  }, { timezone: 'Asia/Jerusalem' });
  logger.info(`Daily scanner scheduled: ${DAILY_CRON} (08:00 Israel time)`);
}

function stopScheduler() {
  if (scheduledTask) { scheduledTask.stop(); logger.info('Scheduler stopped'); }
}

function getSchedulerStatus() {
  const orchestrator = getClaudeOrchestrator();
  const discoveryService = getDiscoveryService();
  
  return {
    enabled: !!scheduledTask, 
    cron: DAILY_CRON, 
    schedule: 'Daily at 08:00 Israel time',
    timezone: 'Asia/Jerusalem',
    isRunning, 
    lastRun: lastRunResult, 
    perplexityConfigured: !!process.env.PERPLEXITY_API_KEY,
    claudeConfigured: orchestrator?.isClaudeConfigured() || false,
    notificationsConfigured: notificationService.isConfigured(),
    discoveryEnabled: !!discoveryService,
    discoverySchedule: 'Daily - ALL cities',
    targetCities: discoveryService?.ALL_TARGET_CITIES?.length || 0,
    targetRegions: discoveryService?.TARGET_REGIONS ? Object.keys(discoveryService.TARGET_REGIONS) : [],
    minHousingUnits: discoveryService?.MIN_HOUSING_UNITS || 12
  };
}

module.exports = { startScheduler, stopScheduler, runWeeklyScan, getSchedulerStatus, createAlert };
