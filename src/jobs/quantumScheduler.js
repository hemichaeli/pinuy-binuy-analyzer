const cron = require('node-cron');
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { shouldSkipToday } = require('../config/israeliHolidays');

// Lazy-load services to avoid circular deps
function getScanPriority() { try { return require('../services/scanPriorityService'); } catch(e) { return null; } }
function getSmartBatch() { try { return require('../services/smartBatchService'); } catch(e) { return null; } }
function getDeepEnrichment() { try { return require('../services/deepEnrichmentService'); } catch(e) { return null; } }

/**
 * QUANTUM Intelligent Scan Scheduler v1.0
 * 
 * ENRICHMENT SCANS (Sun-Thu only, skips Shabbat + Jewish holidays):
 * +---------------------------------------------------------+
 * |  TIER 1 (HOT ~50)   | STANDARD weekly (Sun 08:00)      |
 * |                      | FULL monthly (1st Sun 06:00)     |
 * |  TIER 2 (ACTIVE)     | STANDARD bi-weekly (Mon 08:00)   |
 * |  TIER 3 (DORMANT)    | FAST monthly (1st Tue 08:00)     |
 * |  EVENT-DRIVEN        | Auto-FULL on significant changes |
 * +---------------------------------------------------------+
 * 
 * LISTINGS SCANS (Daily including weekends):
 * +---------------------------------------------------------+
 * |  Yad2 + Kones        | Daily 07:00 (7 days/week)        |
 * |  SSI recalc          | Daily 09:00 after listings update |
 * |  IAI recalc          | After every enrichment batch      |
 * +---------------------------------------------------------+
 * 
 * MONTHLY COST ESTIMATE:
 *   Tier 1 STANDARD weekly:    50 x $0.26 x 4  = $52/mo
 *   Tier 1 FULL monthly:       50 x $1.23 x 1  = $62/mo
 *   Tier 2 STANDARD bi-weekly: ~187 x $0.26 x 2 = $97/mo
 *   Tier 3 FAST monthly:       ~199 x $0.15 x 1 = $30/mo
 *   Event-driven (est):                          = $20-50/mo
 *   --------------------------------------------------------
 *   TOTAL:                                      ~$260-290/mo
 */

const SCAN_CONFIG = {
  tier1: { mode: 'standard', limit: 50 },
  tier1Full: { mode: 'full', limit: 50 },
  tier2: { mode: 'standard', limit: 200 },
  tier3: { mode: 'fast', limit: 250 },
};

// State tracking
const schedulerState = {
  isRunning: false,
  activeJobs: {},
  lastRuns: {},
  pendingChain: null,
  biweeklyToggle: true,
  scheduledTasks: [],
  stats: { totalScans: 0, totalCost: 0, lastMonth: 0 },
  lastPSSRank: null
};

// ============================================================
// CORE: Is today a scan day? (enrichment only)
// ============================================================
function isEnrichmentDay() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = israelTime.getDay();

  if (day === 5 || day === 6) {
    logger.info('[SCHEDULER] Skipping enrichment: Shabbat');
    return false;
  }

  if (shouldSkipToday()) {
    logger.info('[SCHEDULER] Skipping enrichment: Jewish holiday');
    return false;
  }

  return true;
}

function isFirstSundayOfMonth() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return israelTime.getDate() <= 7 && israelTime.getDay() === 0;
}

function isFirstOrThirdWeek() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const d = israelTime.getDate();
  return (d >= 1 && d <= 7) || (d >= 15 && d <= 21);
}

// ============================================================
// SCAN LAUNCHER
// ============================================================
async function launchTierScan(tier, modeOverride = null) {
  const smartBatch = getSmartBatch();
  const scanPriority = getScanPriority();
  if (!smartBatch || !scanPriority) {
    logger.error('[SCHEDULER] Services not available');
    return null;
  }

  const config = tier === '1full' ? SCAN_CONFIG.tier1Full
    : tier === '1' ? SCAN_CONFIG.tier1
    : tier === '2' ? SCAN_CONFIG.tier2
    : SCAN_CONFIG.tier3;

  const mode = modeOverride || config.mode;
  const tierNum = tier === '1full' ? 1 : parseInt(tier);

  try {
    const priorities = await scanPriority.calculateAllPriorities();
    const tierKey = tierNum === 1 ? 'hot' : tierNum === 2 ? 'active' : 'dormant';
    const ids = priorities.tiers[tierKey].complexes.slice(0, config.limit).map(c => c.id);

    if (ids.length === 0) {
      logger.info(`[SCHEDULER] No complexes for tier ${tier}`);
      return null;
    }

    const job = await smartBatch.enrichByIds(ids, mode);
    
    const costPer = mode === 'full' ? 1.23 : mode === 'standard' ? 0.26 : 0.15;
    const cost = ids.length * costPer;

    schedulerState.activeJobs[job.jobId] = {
      tier, mode, count: ids.length,
      startedAt: new Date().toISOString(),
      estimatedCost: Math.round(cost * 100) / 100
    };
    schedulerState.stats.totalScans++;
    schedulerState.stats.totalCost += cost;

    logger.info(`[SCHEDULER] Launched tier ${tier} (${mode}): ${ids.length} complexes, ~$${cost.toFixed(2)} | Job: ${job.jobId}`);
    return job;
  } catch (err) {
    logger.error(`[SCHEDULER] Failed to launch tier ${tier}`, { error: err.message });
    return null;
  }
}

// ============================================================
// JOB MONITOR - checks active jobs, triggers chains
// ============================================================
async function monitorJobs() {
  const smartBatch = getSmartBatch();
  const deepEnrich = getDeepEnrichment();
  if (!smartBatch && !deepEnrich) return;

  for (const [jobId, meta] of Object.entries(schedulerState.activeJobs)) {
    try {
      const status = smartBatch?.getSmartBatchStatus(jobId) 
        || deepEnrich?.getBatchStatus(jobId);
      
      if (!status) continue;
      
      if (status.status === 'completed' || status.status === 'error') {
        const result = {
          jobId,
          tier: meta.tier,
          mode: meta.mode,
          enriched: status.enriched,
          total: status.total,
          fields: status.totalFieldsUpdated,
          errors: status.errors,
          cost: meta.estimatedCost,
          duration: status.completedAt ? Math.round((new Date(status.completedAt) - new Date(meta.startedAt)) / 60000) : null
        };

        schedulerState.lastRuns[meta.tier] = {
          ...result,
          completedAt: status.completedAt
        };

        delete schedulerState.activeJobs[jobId];
        
        logger.info(`[SCHEDULER] Job ${jobId} completed: ${result.enriched}/${result.total} (${result.fields} fields, ${result.duration}min, ~$${result.cost})`);

        // Trigger chained job if pending
        if (schedulerState.pendingChain && schedulerState.pendingChain.afterJob === jobId) {
          const chain = schedulerState.pendingChain;
          schedulerState.pendingChain = null;
          logger.info(`[SCHEDULER] Chain trigger: launching tier ${chain.tier} (${chain.mode}) after ${jobId}`);
          await launchTierScan(chain.tier, chain.mode);
        }

        // Recalculate IAI after enrichment
        try {
          const { calculateAllIAI } = require('../services/iaiCalculator');
          await calculateAllIAI();
          logger.info('[SCHEDULER] IAI recalculated after enrichment batch');
        } catch (e) {
          logger.warn('[SCHEDULER] IAI recalc failed', { error: e.message });
        }
      }
    } catch (err) {
      logger.warn(`[SCHEDULER] Monitor error for ${jobId}`, { error: err.message });
    }
  }
}

// ============================================================
// SCHEDULED TASKS
// ============================================================
function initScheduler() {
  logger.info('[SCHEDULER] Initializing QUANTUM Intelligent Scan Scheduler v1.0');

  // Job Monitor: every 2 minutes
  schedulerState.scheduledTasks.push(
    cron.schedule('*/2 * * * *', monitorJobs, { timezone: 'Asia/Jerusalem' })
  );

  // TIER 1 (HOT): Sunday 08:00 Israel time
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 0', async () => {
      if (!isEnrichmentDay()) return;
      
      if (isFirstSundayOfMonth()) {
        logger.info('[SCHEDULER] Monthly FULL scan for Tier 1 (HOT)');
        const job = await launchTierScan('1full');
        if (job) {
          schedulerState.pendingChain = { 
            afterJob: job.jobId, tier: '2', mode: 'standard' 
          };
        }
      } else {
        logger.info('[SCHEDULER] Weekly STANDARD scan for Tier 1 (HOT)');
        await launchTierScan('1');
      }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // TIER 2 (ACTIVE): Monday 08:00 Israel, bi-weekly
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 1', async () => {
      if (!isEnrichmentDay()) return;
      
      schedulerState.biweeklyToggle = !schedulerState.biweeklyToggle;
      if (!schedulerState.biweeklyToggle) {
        logger.info('[SCHEDULER] Tier 2 skip week (bi-weekly)');
        return;
      }
      
      logger.info('[SCHEDULER] Bi-weekly STANDARD scan for Tier 2 (ACTIVE)');
      await launchTierScan('2');
    }, { timezone: 'Asia/Jerusalem' })
  );

  // TIER 3 (DORMANT): Tuesday 08:00 Israel, monthly
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 2', async () => {
      if (!isEnrichmentDay()) return;
      if (!isFirstOrThirdWeek()) return;
      
      logger.info('[SCHEDULER] Monthly FAST scan for Tier 3 (DORMANT)');
      await launchTierScan('3');
    }, { timezone: 'Asia/Jerusalem' })
  );

  // LISTINGS: Daily 07:00 Israel, EVERY day including Shabbat
  schedulerState.scheduledTasks.push(
    cron.schedule('0 7 * * *', async () => {
      logger.info('[SCHEDULER] Daily listings scan (runs every day)');
      try {
        const yad2 = require('../services/yad2Scraper');
        if (yad2?.scrapeAll) await yad2.scrapeAll();
      } catch (e) { logger.warn('[SCHEDULER] Yad2 scan failed', { error: e.message }); }
      
      try {
        const kones = require('../services/konesIsraelService');
        if (kones?.fetchListings) await kones.fetchListings();
      } catch (e) { logger.warn('[SCHEDULER] Kones scan failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // SSI RECALC: Daily 09:00 Israel, EVERY day
  schedulerState.scheduledTasks.push(
    cron.schedule('0 9 * * *', async () => {
      logger.info('[SCHEDULER] Daily SSI recalculation');
      try {
        const { calculateAllSSI } = require('../services/ssiCalculator');
        await calculateAllSSI();
      } catch (e) { logger.warn('[SCHEDULER] SSI recalc failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // PSS RE-RANK: Wednesday 06:00 Israel (Sun-Thu only)
  schedulerState.scheduledTasks.push(
    cron.schedule('0 6 * * 3', async () => {
      if (!isEnrichmentDay()) return;
      logger.info('[SCHEDULER] Mid-week PSS re-ranking');
      try {
        const scanPriority = getScanPriority();
        if (!scanPriority) return;
        const result = await scanPriority.calculateAllPriorities();
        
        const hot = result.tiers.hot.count;
        const active = result.tiers.active.count;
        const dormant = result.tiers.dormant.count;
        logger.info(`[SCHEDULER] PSS re-rank: HOT=${hot}, ACTIVE=${active}, DORMANT=${dormant}`);
        
        schedulerState.lastPSSRank = {
          timestamp: new Date().toISOString(),
          tiers: { hot, active, dormant },
          top5: result.top_50.slice(0, 5).map(c => ({ name: c.name, city: c.city, pss: c.pss }))
        };
      } catch (e) { logger.warn('[SCHEDULER] PSS re-rank failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  logger.info('[SCHEDULER] Scheduled tasks initialized:');
  logger.info('  Enrichment (Sun-Thu, skips Shabbat+holidays):');
  logger.info('    Tier 1 HOT:     Sun 08:00 (STANDARD weekly, FULL 1st-of-month)');
  logger.info('    Tier 2 ACTIVE:  Mon 08:00 (STANDARD bi-weekly)');
  logger.info('    Tier 3 DORMANT: Tue 08:00 (FAST monthly)');
  logger.info('  Listings (daily including weekends):');
  logger.info('    Yad2+Kones:     07:00 daily');
  logger.info('    SSI recalc:     09:00 daily');
  logger.info('  Intelligence:');
  logger.info('    PSS re-rank:    Wed 06:00');
  logger.info('    IAI recalc:     after every enrichment batch');
  logger.info('    Job monitor:    every 2 minutes');
  logger.info('  Est. monthly cost: ~$260-290');

  return schedulerState;
}

// ============================================================
// CHAIN API
// ============================================================
function chainAfter(afterJobId, tier, mode) {
  schedulerState.pendingChain = { afterJob: afterJobId, tier, mode };
  logger.info(`[SCHEDULER] Chain set: tier ${tier} (${mode}) after ${afterJobId}`);
  return { status: 'chained', afterJob: afterJobId, tier, mode };
}

// ============================================================
// STATUS API
// ============================================================
function getSchedulerStatus() {
  return {
    version: 'v1.0',
    activeJobs: Object.keys(schedulerState.activeJobs).length,
    activeJobDetails: schedulerState.activeJobs,
    pendingChain: schedulerState.pendingChain,
    lastRuns: schedulerState.lastRuns,
    lastPSSRank: schedulerState.lastPSSRank,
    biweeklyToggle: schedulerState.biweeklyToggle,
    stats: {
      ...schedulerState.stats,
      totalCost: Math.round(schedulerState.stats.totalCost * 100) / 100
    },
    schedule: {
      tier1_hot: 'Sun 08:00 STANDARD (FULL 1st-of-month)',
      tier2_active: 'Mon 08:00 STANDARD (bi-weekly)',
      tier3_dormant: 'Tue 08:00 FAST (monthly)',
      listings: 'Daily 07:00 (incl. weekends)',
      ssi: 'Daily 09:00 (incl. weekends)',
      pss_rerank: 'Wed 06:00',
      job_monitor: 'Every 2 minutes'
    },
    monthlyBudget: {
      tier1_standard_weekly: '$52',
      tier1_full_monthly: '$62',
      tier2_standard_biweekly: '$97',
      tier3_fast_monthly: '$30',
      event_driven_est: '$20-50',
      total: '~$260-290/mo'
    },
    nextEnrichmentDay: isEnrichmentDay() ? 'today' : 'next business day'
  };
}

module.exports = { 
  initScheduler, 
  launchTierScan, 
  chainAfter, 
  monitorJobs,
  getSchedulerStatus,
  schedulerState
};
