const cron = require('node-cron');
const pool = require('../db/pool');
// ========== DIRECT JSON APIs - NO PERPLEXITY ==========
const directApi = require('../services/directApiService');
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
 * Step tracker for scan notifications
 */
function createStepTracker() {
  const steps = [];
  return {
    add(name, nameHe, success, detail, error = null) {
      steps.push({ name, nameHe, success, detail, error: error ? String(error).slice(0, 120) : null });
    },
    getSteps() { return steps; },
    failedCount() { return steps.filter(s => !s.success).length; },
    successCount() { return steps.filter(s => s.success).length; },
    totalCount() { return steps.length; }
  };
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
        QUANTUM v4.8.2 - Direct API Mode (No Perplexity)
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
 * Build step status rows for email
 */
function buildStepRows(steps) {
  return steps.map((step, i) => {
    const icon = step.success ? '✅' : '❌';
    const bgColor = step.success ? '#f0fdf4' : '#fef2f2';
    const detailColor = step.success ? '#166534' : '#991b1b';
    const errorLine = step.error ? `<br><span style="color: #dc2626; font-size: 11px;">שגיאה: ${step.error}</span>` : '';
    
    return `
      <tr style="background: ${i % 2 === 0 ? bgColor : '#ffffff'};">
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: center; font-size: 18px; width: 40px;">${icon}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; font-weight: 600;">${step.nameHe}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; color: ${detailColor}; font-size: 13px;">${step.detail}${errorLine}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Send scan status notification with per-step breakdown
 */
async function sendScanStatusNotification(result) {
  if (!notificationService.isConfigured()) return;

  const steps = result.steps || [];
  const failedCount = steps.filter(s => !s.success).length;
  const totalSteps = steps.length;
  const hasCriticalFailure = !!result.error;
  
  // Determine overall status
  let statusIcon, statusText, statusColor;
  if (hasCriticalFailure) {
    statusIcon = '❌';
    statusText = 'סריקה יומית נכשלה';
    statusColor = '#dc2626';
  } else if (failedCount > 0) {
    statusIcon = '⚠️';
    statusText = `סריקה הושלמה עם ${failedCount} שגיאות`;
    statusColor = '#d97706';
  } else {
    statusIcon = '✅';
    statusText = 'סריקה יומית הושלמה בהצלחה';
    statusColor = '#16a34a';
  }

  const subject = `${statusIcon} [QUANTUM] ${statusText}`;

  const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const durationMin = result.duration ? Math.round(parseInt(result.duration) / 60) : '?';

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto;">
      <h2 style="color: ${statusColor}; margin-bottom: 4px;">${statusIcon} ${statusText}</h2>
      <p style="color: #6b7280; margin: 0 0 16px; font-size: 13px;">
        ${israelTime} &nbsp;|&nbsp; ${durationMin} דקות &nbsp;|&nbsp; סריקה #${result.scanId || '?'}
      </p>
      
      ${hasCriticalFailure ? `
        <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 12px; margin: 0 0 16px;">
          <strong style="color: #dc2626;">שגיאה קריטית:</strong> ${result.error}
        </div>
      ` : ''}
      
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: center; width: 40px;">סטטוס</th>
            <th style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: right;">שלב</th>
            <th style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: right;">פירוט</th>
          </tr>
        </thead>
        <tbody>
          ${buildStepRows(steps)}
        </tbody>
      </table>
      
      ${!hasCriticalFailure ? `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; font-size: 13px;">
          <strong>סיכום:</strong> 
          ${result.directApi?.succeeded || 0} מתחמים נסרקו,
          ${result.directApi?.totalNewTransactions || 0} עסקאות חדשות,
          ${result.directApi?.totalNewListings || 0} מודעות חדשות,
          ${result.discovery?.newAdded || 0} מתחמים חדשים,
          ${result.alertsGenerated || 0} התראות
        </div>
      ` : ''}
      
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
      <p style="font-size: 11px; color: #9ca3af; text-align: center;">
        QUANTUM v4.8.2 - Direct API Mode (nadlan + yad2 + mavat)<br>
        סריקה אוטומטית יומית ב-08:00 (ראשון-חמישי, לא בחגים)
      </p>
    </div>
  `;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    logger.info(`Scan notification sent: ${statusIcon} ${failedCount}/${totalSteps} failed`);
  } catch (err) {
    logger.warn('Failed to send scan status notification', { error: err.message });
  }
}

/**
 * Run the daily scan with DIRECT JSON APIs (no Perplexity!)
 * v4.8.2: Direct API mode - nadlan.gov.il, yad2, mavat
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
  const tracker = createStepTracker();
  
  logger.info(`=== Daily scan started [DIRECT API MODE] (forceAll: ${forceAll}, discovery: ${includeDiscovery}) ===`);

  try {
    const scanLog = await pool.query(
      `INSERT INTO scan_logs (scan_type, started_at, status) VALUES ('daily_direct_api', NOW(), 'running') RETURNING id`
    );
    const scanId = scanLog.rows[0].id;
    const beforeSnapshot = await snapshotStatuses();

    // Step 1: Direct API Scan (nadlan + yad2 + mavat)
    let directApiResults = { total: 0, scanned: 0, succeeded: 0, totalNewTransactions: 0, totalNewListings: 0 };
    try {
      logger.info('Step 1/8: Running Direct API scan (nadlan + yad2 + mavat)...');
      directApiResults = await directApi.scanAll({ staleOnly, limit: 129 });
      logger.info(`Direct API: ${directApiResults.succeeded}/${directApiResults.total} ok, ${directApiResults.totalNewTransactions} tx, ${directApiResults.totalNewListings} listings`);
      tracker.add('direct_api', 'סריקת API ישיר (nadlan + yad2 + mavat)', true, 
        `${directApiResults.succeeded}/${directApiResults.total} מתחמים, ${directApiResults.totalNewTransactions} עסקאות, ${directApiResults.totalNewListings} מודעות`);
    } catch (e) {
      logger.warn('Direct API scan failed', { error: e.message });
      tracker.add('direct_api', 'סריקת API ישיר', false, 'נכשל', e.message);
    }

    // Step 2: Nadlan transactions (dedicated scraper)
    let nadlanResults = { totalNew: 0 };
    try {
      logger.info('Step 2/8: Running nadlan.gov.il scan...');
      nadlanResults = await nadlanScraper.scanAll({ staleOnly, limit: 50 });
      tracker.add('nadlan', 'עסקאות נדל"ן (nadlan.gov.il)', true,
        `${nadlanResults.totalNew || 0} עסקאות חדשות`);
    } catch (e) {
      logger.warn('Nadlan failed', { error: e.message });
      tracker.add('nadlan', 'עסקאות נדל"ן (nadlan.gov.il)', false, 'נכשל', e.message);
    }

    // Step 3: Benchmarks
    let benchmarkResults = { calculated: 0 };
    try {
      logger.info('Step 3/8: Calculating benchmarks...');
      benchmarkResults = await calculateAllBenchmarks({ limit: 50 });
      tracker.add('benchmarks', 'חישוב benchmarks', true,
        `${benchmarkResults.calculated || 0} חושבו`);
    } catch (e) {
      logger.warn('Benchmark failed', { error: e.message });
      tracker.add('benchmarks', 'חישוב benchmarks', false, 'נכשל', e.message);
    }

    // Step 4: SSI calculation
    let ssiResults = { stressed: 0, very_stressed: 0 };
    try {
      logger.info('Step 4/8: Calculating SSI scores...');
      ssiResults = await calculateAllSSI();
      tracker.add('ssi', 'חישוב SSI (לחץ מוכרים)', true,
        `${ssiResults.total || ssiResults.updated || 0} דורגו, ${ssiResults.highStress || 0} לחץ גבוה`);
    } catch (e) {
      logger.warn('SSI failed', { error: e.message });
      tracker.add('ssi', 'חישוב SSI (לחץ מוכרים)', false, 'נכשל', e.message);
    }

    // Step 5: IAI recalculation
    try {
      logger.info('Step 5/8: Recalculating IAI scores...');
      await calculateAllIAI();
      tracker.add('iai', 'חישוב IAI (אטרקטיביות)', true, 'הושלם');
    } catch (e) {
      logger.warn('IAI failed', { error: e.message });
      tracker.add('iai', 'חישוב IAI (אטרקטיביות)', false, 'נכשל', e.message);
    }

    // Step 6: Discovery
    let discoveryResults = { citiesScanned: 0, newAdded: 0, alreadyExisted: 0 };
    if (includeDiscovery) {
      const discoveryService = getDiscoveryService();
      if (discoveryService) {
        const allCities = discoveryService.ALL_TARGET_CITIES;
        logger.info(`Step 6/8: 🔍 Discovery scan for ALL ${allCities.length} target cities...`);
        
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
                  if (complex.existing_units && complex.existing_units < discoveryService.MIN_HOUSING_UNITS) {
                    continue;
                  }
                  
                  const newId = await discoveryService.addNewComplex(complex, city, 'discovery-daily');
                  if (newId) {
                    totalNew++;
                    logger.info(`  ✨ NEW: ${complex.name} (${city}) - ${complex.existing_units || '?'} units`);
                    
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
          tracker.add('discovery', 'גילוי מתחמים חדשים', true,
            `${citiesScanned}/${allCities.length} ערים, ${totalNew} מתחמים חדשים`);
        } catch (e) { 
          logger.warn('Discovery failed', { error: e.message });
          tracker.add('discovery', 'גילוי מתחמים חדשים', false, 'נכשל', e.message);
        }
      } else {
        logger.info('Step 6/8: Discovery service not available');
        tracker.add('discovery', 'גילוי מתחמים חדשים', false, 'שירות לא זמין');
      }
    } else {
      logger.info('Step 6/8: Discovery disabled');
      tracker.add('discovery', 'גילוי מתחמים חדשים', true, 'מושבת');
    }

    // Step 7: KonesIsrael receivership data scan
    let konesResults = { totalListings: 0, matchedComplexes: 0, ssiUpdated: 0, errors: null };
    const konesService = getKonesIsraelService();
    if (konesService) {
      try {
        logger.info('Step 7/8: 🏛️ Scanning KonesIsrael receivership listings...');
        
        const listings = await konesService.fetchWithLogin(true);
        konesResults.totalListings = listings.length;
        logger.info(`KonesIsrael: Fetched ${listings.length} receivership listings`);
        
        if (listings.length > 0) {
          const complexes = await pool.query('SELECT id, name, city, street, address FROM complexes');
          const matches = await konesService.matchWithComplexes(complexes.rows);
          konesResults.matchedComplexes = matches.length;
          
          logger.info(`KonesIsrael: ${matches.length} matches found with existing complexes`);
          
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
                    null,
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
        
        tracker.add('kones_israel', 'כונס נכסים (KonesIsrael)', true,
          `${konesResults.totalListings} מודעות, ${konesResults.matchedComplexes} התאמות`);
      } catch (e) {
        konesResults.errors = e.message;
        logger.warn('KonesIsrael scan failed', { error: e.message });
        tracker.add('kones_israel', 'כונס נכסים (KonesIsrael)', false, 'נכשל', e.message);
      }
    } else {
      logger.info('Step 7/8: KonesIsrael service not available');
      tracker.add('kones_israel', 'כונס נכסים (KonesIsrael)', false, 'שירות לא זמין');
    }

    // Step 8: Generate alerts
    logger.info('Step 8/8: Generating alerts...');
    let alertCount = 0;
    try {
      alertCount = await generateAlerts(beforeSnapshot);
      tracker.add('alerts', 'יצירת התראות', true, `${alertCount} התראות נוצרו`);
    } catch (e) {
      logger.warn('Alert generation failed', { error: e.message });
      tracker.add('alerts', 'יצירת התראות', false, 'נכשל', e.message);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary = `Daily scan [DIRECT API]: ${directApiResults.succeeded}/${directApiResults.total} ok, ` +
      `${directApiResults.totalNewTransactions} tx, ${directApiResults.totalNewListings} listings. ` +
      `Nadlan: ${nadlanResults.totalNew} tx. ` +
      `KonesIsrael: ${konesResults.totalListings} listings, ${konesResults.matchedComplexes} matches. ` +
      `Discovery: ${discoveryResults.citiesScanned} cities, ${discoveryResults.newAdded} new. ` +
      `${alertCount} alerts. ${duration}s. Steps: ${tracker.successCount()}✅ ${tracker.failedCount()}❌`;

    lastRunResult = {
      scanId, completedAt: new Date().toISOString(), duration: `${duration}s`,
      mode: 'direct_api',
      directApi: directApiResults,
      nadlan: { newTransactions: nadlanResults.totalNew || 0 },
      benchmarks: { calculated: benchmarkResults.calculated || 0 },
      ssi: ssiResults,
      konesIsrael: konesResults,
      discovery: discoveryResults,
      alertsGenerated: alertCount,
      steps: tracker.getSteps(),
      summary
    };

    await pool.query(
      `UPDATE scan_logs SET 
        completed_at = NOW(), status = 'completed', complexes_scanned = $1,
        new_transactions = $2, new_listings = $3, status_changes = $4,
        alerts_sent = $5, summary = $6
       WHERE id = $7`,
      [directApiResults.scanned || directApiResults.total,
        (directApiResults.totalNewTransactions || 0) + (nadlanResults.totalNew || 0),
        (directApiResults.totalNewListings || 0) + (konesResults.totalListings || 0),
        discoveryResults.newAdded || 0,
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

    logger.info(`=== Daily scan completed in ${duration}s (${tracker.successCount()}✅ ${tracker.failedCount()}❌) [DIRECT API MODE] ===`);
    return lastRunResult;

  } catch (err) {
    logger.error('Daily scan failed', { error: err.message });
    tracker.add('critical', 'שגיאה קריטית', false, 'הסריקה קרסה', err.message);
    lastRunResult = { 
      error: err.message, 
      completedAt: new Date().toISOString(),
      steps: tracker.getSteps()
    };
    await sendScanStatusNotification(lastRunResult);
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  // No longer requires PERPLEXITY_API_KEY - using direct APIs!
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
  logger.info(`Daily scanner scheduled: ${DAILY_CRON} (08:00 Israel time, Sun-Thu, no holidays) [DIRECT API MODE]`);
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
    mode: 'DIRECT_API', // No Perplexity!
    skipWeekends: true,
    skipHolidays: true,
    todayStatus: todaySkipCheck.shouldSkip 
      ? `⏸️ SKIP: ${todaySkipCheck.reasonHe}` 
      : '✅ Active - will run',
    upcomingHolidays: upcoming,
    isRunning, 
    lastRun: lastRunResult,
    lastSkip: lastSkipResult,
    directApiMode: true,
    perplexityRequired: false,
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
