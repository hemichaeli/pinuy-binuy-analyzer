const cron = require('node-cron');
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
 *   Event-driven:              ~$20-50/mo
 *   TOTAL: ~$260-290/month (~$3,100-3,500/year)
 */

// ============================================================
// STATE MANAGEMENT
// ============================================================
const schedulerState = {
  activeJobs: {},        // jobId -> { tier, mode, count, startedAt, estimatedCost }
  chainQueue: [],        // [{ afterJob, tier, mode }, ...]
  lastRuns: {},          // tier -> { jobId, enriched, total, fields, errors, cost, duration, completedAt }
  lastPSSRank: null,     // { timestamp, tiers, top5 }
  biweeklyToggle: false, // alternates for Tier 2
  stats: { totalScans: 0, totalCost: 0, lastMonth: null },
  scheduledTasks: []
};

// ============================================================
// HELPERS
// ============================================================
function isEnrichmentDay() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = israelTime.getDay();

  if (day === 5 || day === 6) {
    logger.info('[SCHEDULER] Skipping enrichment: Shabbat');
    return false;
  }

  const holidayCheck = shouldSkipToday();
  if (holidayCheck.shouldSkip) {
    logger.info(`[SCHEDULER] Skipping enrichment: ${holidayCheck.reason || 'Jewish holiday'}`);
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

  try {
    // Get PSS-ranked complexes
    const ranking = await scanPriority.calculateAllPriorities();
    
    let ids = [];
    let mode = modeOverride;
    let tierLabel = '';
    const costPerComplex = { full: 1.23, standard: 0.26, fast: 0.15, turbo: 0.05 };

    switch (tier) {
      case '1':
      case '1standard':
        ids = ranking.top_50.map(c => c.id);
        mode = mode || 'standard';
        tierLabel = 'Tier 1 HOT';
        break;
      case '1full':
        ids = ranking.top_50.map(c => c.id);
        mode = mode || 'full';
        tierLabel = 'Tier 1 HOT (FULL)';
        break;
      case '2':
        ids = ranking.active.map(c => c.id);
        mode = mode || 'standard';
        tierLabel = 'Tier 2 ACTIVE';
        break;
      case '3':
        ids = ranking.dormant.map(c => c.id);
        mode = mode || 'fast';
        tierLabel = 'Tier 3 DORMANT';
        break;
      default:
        logger.warn(`[SCHEDULER] Unknown tier: ${tier}`);
        return null;
    }

    if (ids.length === 0) {
      logger.warn(`[SCHEDULER] No complexes found for ${tierLabel}`);
      return null;
    }

    const estimatedCost = (ids.length * (costPerComplex[mode] || 0.26)).toFixed(2);
    logger.info(`[SCHEDULER] Launching ${tierLabel}: ${ids.length} complexes, mode=${mode}, est. $${estimatedCost}`);

    const result = await smartBatch.enrichByIds(ids, mode);
    
    if (result.jobId) {
      schedulerState.activeJobs[result.jobId] = {
        tier,
        mode,
        count: ids.length,
        startedAt: new Date().toISOString(),
        estimatedCost: parseFloat(estimatedCost)
      };
      schedulerState.stats.totalScans++;
      logger.info(`[SCHEDULER] Job ${result.jobId} started for ${tierLabel}`);
    }

    return result;
  } catch (err) {
    logger.error(`[SCHEDULER] Failed to launch tier ${tier}`, { error: err.message });
    return null;
  }
}

// ============================================================
// CHAIN MANAGEMENT
// ============================================================
function chainAfter(afterJobId, tier, mode) {
  schedulerState.chainQueue.push({ afterJob: afterJobId, tier, mode });
  logger.info(`[SCHEDULER] Chained tier ${tier} (${mode}) after job ${afterJobId}. Queue size: ${schedulerState.chainQueue.length}`);
  return schedulerState.chainQueue.length;
}

// ============================================================
// JOB MONITOR (runs every 2 min)
// ============================================================
async function monitorJobs() {
  const smartBatch = getSmartBatch();
  if (!smartBatch) return;

  for (const [jobId, meta] of Object.entries(schedulerState.activeJobs)) {
    try {
      const status = smartBatch.getSmartBatchStatus(jobId);
      if (!status) continue;

      if (status.status === 'completed' || status.status === 'error') {
        // Job finished - record results
        schedulerState.lastRuns[meta.tier] = {
          jobId,
          enriched: status.enriched,
          total: status.total,
          fields: status.totalFieldsUpdated,
          errors: status.errors,
          cost: meta.estimatedCost,
          duration: status.completedAt ? 
            ((new Date(status.completedAt) - new Date(status.startedAt)) / 60000).toFixed(1) + 'min' : '?',
          completedAt: status.completedAt
        };
        schedulerState.stats.totalCost += meta.estimatedCost;

        logger.info(`[SCHEDULER] Job ${jobId} completed: ${status.enriched}/${status.total}, ${status.totalFieldsUpdated} fields, ~$${meta.estimatedCost}`);

        // Check chain queue
        const chainIdx = schedulerState.chainQueue.findIndex(c => c.afterJob === jobId);
        if (chainIdx >= 0) {
          const chain = schedulerState.chainQueue[chainIdx];
          schedulerState.chainQueue.splice(chainIdx, 1);
          
          logger.info(`[SCHEDULER] Chain trigger: tier ${chain.tier} (${chain.mode}) after ${jobId}`);
          const nextJob = await launchTierScan(chain.tier, chain.mode);
          
          // Re-point remaining chains that referenced this job to the new job
          if (nextJob && nextJob.jobId) {
            for (const remaining of schedulerState.chainQueue) {
              if (remaining.afterJob === jobId) {
                remaining.afterJob = nextJob.jobId;
                logger.info(`[SCHEDULER] Re-pointed chain tier ${remaining.tier} to new job ${nextJob.jobId}`);
              }
            }
          }
        }

        // Recalculate IAI after enrichment
        try {
          const pool = require('../db/pool');
          await pool.query(`
            UPDATE complexes SET 
              iai_score = COALESCE(
                CASE 
                  WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0 
                  THEN LEAST(100, GREATEST(0,
                    (CASE WHEN price_vs_city_avg < -10 THEN 25 WHEN price_vs_city_avg < 0 THEN 15 ELSE 5 END) +
                    (CASE WHEN plan_stage IN ('approved','permit') THEN 30 WHEN plan_stage = 'deposit' THEN 20 WHEN plan_stage = 'committee' THEN 10 ELSE 5 END) +
                    (CASE WHEN developer_reputation_score >= 80 THEN 20 WHEN developer_reputation_score >= 60 THEN 10 ELSE 5 END) +
                    (CASE WHEN news_sentiment = 'positive' THEN 15 WHEN news_sentiment = 'neutral' THEN 10 ELSE 0 END) +
                    (CASE WHEN is_receivership THEN 10 ELSE 0 END)
                  ))
                  ELSE iai_score
                END, iai_score),
              updated_at = NOW()
            WHERE updated_at > NOW() - INTERVAL '1 hour'
          `);
          logger.info('[SCHEDULER] IAI recalculated for recently enriched complexes');
        } catch (e) { logger.warn('[SCHEDULER] IAI recalc failed', { error: e.message }); }

        // Remove from active
        delete schedulerState.activeJobs[jobId];
      }
    } catch (err) {
      logger.error(`[SCHEDULER] Monitor error for job ${jobId}`, { error: err.message });
    }
  }
}

// ============================================================
// CRON INITIALIZATION
// ============================================================
function initScheduler() {
  logger.info('[SCHEDULER] QUANTUM Intelligent Scan Scheduler v1.0 initializing...');

  // JOB MONITOR: Every 2 minutes
  schedulerState.scheduledTasks.push(
    cron.schedule('*/2 * * * *', async () => {
      await monitorJobs();
    }, { timezone: 'Asia/Jerusalem' })
  );

  // TIER 1 (HOT): Sunday 08:00 Israel, weekly STANDARD / monthly FULL
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 0', async () => {
      if (!isEnrichmentDay()) return;
      
      if (isFirstSundayOfMonth()) {
        logger.info('[SCHEDULER] Monthly FULL scan for Tier 1 (HOT)');
        const job = await launchTierScan('1full');
        if (job) {
          // Chain: FULL -> Tier 2 STANDARD -> Tier 3 FAST
          schedulerState.chainQueue.push(
            { afterJob: job.jobId, tier: '2', mode: 'standard' }
          );
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
        logger.info('[SCHEDULER] SSI recalculation complete');
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
  logger.info('    Job monitor:    Every 2 min');
}

// ============================================================
// STATUS
// ============================================================
function getSchedulerStatus() {
  return {
    version: '1.0',
    activeJobs: Object.keys(schedulerState.activeJobs).length,
    activeJobDetails: schedulerState.activeJobs,
    chainQueue: schedulerState.chainQueue,
    lastRuns: schedulerState.lastRuns,
    lastPSSRank: schedulerState.lastPSSRank,
    stats: schedulerState.stats,
    biweeklyToggle: schedulerState.biweeklyToggle,
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
