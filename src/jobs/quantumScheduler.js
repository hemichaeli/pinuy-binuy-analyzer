const cron = require('node-cron');
const { logger } = require('../services/logger');
const { shouldSkipToday } = require('../config/israeliHolidays');

// Lazy-load services to avoid circular deps
function getScanPriority() { try { return require('../services/scanPriorityService'); } catch(e) { return null; } }
function getSmartBatch() { try { return require('../services/smartBatchService'); } catch(e) { return null; } }

/**
 * QUANTUM Intelligent Scan Scheduler v2.0 - Deploy-Safe
 * 
 * NEW in v2.0: Job persistence across Railway deploys
 * - Jobs persist to PostgreSQL scan_jobs table
 * - On deploy/restart, interrupted jobs auto-resume from last completed complex
 * - Chain queue persists across restarts
 * - SIGTERM handler marks jobs as interrupted before shutdown
 * 
 * SCHEDULE:
 *   Tier 1 (HOT ~50):   STANDARD weekly Sun 08:00, FULL monthly 1st Sun
 *   Tier 2 (ACTIVE):    STANDARD bi-weekly Mon 08:00
 *   Tier 3 (DORMANT):   FAST monthly 1st Tue 08:00
 *   Listings:            Daily 07:00 (7 days/week)
 *   SSI:                 Daily 09:00
 *   PSS:                 Wed 06:00
 *   IAI:                 After every enrichment batch
 *   Job Monitor:         Every 2 minutes
 *   Est. ~$260-290/month
 */

// ============================================================
// STATE
// ============================================================
const schedulerState = {
  activeJobs: {},
  chainQueue: [],
  lastRuns: {},
  lastPSSRank: null,
  biweeklyToggle: false,
  stats: { totalScans: 0, totalCost: 0 },
  scheduledTasks: [],
  resumedJobs: []
};

// ============================================================
// HELPERS
// ============================================================
function isEnrichmentDay() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = israelTime.getDay();
  if (day === 5 || day === 6) { logger.info('[SCHEDULER] Skipping: Shabbat'); return false; }
  const holidayCheck = shouldSkipToday();
  if (holidayCheck.shouldSkip) { logger.info(`[SCHEDULER] Skipping: ${holidayCheck.reason || 'holiday'}`); return false; }
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
  if (!smartBatch || !scanPriority) { logger.error('[SCHEDULER] Services not available'); return null; }

  try {
    const ranking = await scanPriority.calculateAllPriorities();
    let ids = [], mode = modeOverride, tierLabel = '';
    const costMap = { full: 1.23, standard: 0.26, fast: 0.15, turbo: 0.05 };

    switch (tier) {
      case '1': case '1standard':
        ids = ranking.top_50.map(c => c.id); mode = mode || 'standard'; tierLabel = 'Tier 1 HOT'; break;
      case '1full':
        ids = ranking.top_50.map(c => c.id); mode = mode || 'full'; tierLabel = 'Tier 1 HOT (FULL)'; break;
      case '2':
        ids = ranking.active.map(c => c.id); mode = mode || 'standard'; tierLabel = 'Tier 2 ACTIVE'; break;
      case '3':
        ids = ranking.dormant.map(c => c.id); mode = mode || 'fast'; tierLabel = 'Tier 3 DORMANT'; break;
      default: logger.warn(`[SCHEDULER] Unknown tier: ${tier}`); return null;
    }

    if (ids.length === 0) { logger.warn(`[SCHEDULER] No complexes for ${tierLabel}`); return null; }

    const estimatedCost = parseFloat((ids.length * (costMap[mode] || 0.26)).toFixed(2));
    logger.info(`[SCHEDULER] Launching ${tierLabel}: ${ids.length} complexes, mode=${mode}, ~$${estimatedCost}`);

    const result = await smartBatch.enrichByIds(ids, mode, {
      tier,
      chainQueue: schedulerState.chainQueue.slice(),
      estimatedCost
    });
    
    if (result.jobId) {
      schedulerState.activeJobs[result.jobId] = {
        tier, mode, count: ids.length,
        startedAt: new Date().toISOString(),
        estimatedCost
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
  logger.info(`[SCHEDULER] Chained tier ${tier} (${mode}) after ${afterJobId}. Queue: ${schedulerState.chainQueue.length}`);
  return schedulerState.chainQueue.length;
}

// ============================================================
// JOB MONITOR (every 2 min)
// ============================================================
async function monitorJobs() {
  const smartBatch = getSmartBatch();
  if (!smartBatch) return;

  for (const [jobId, meta] of Object.entries(schedulerState.activeJobs)) {
    try {
      const status = smartBatch.getSmartBatchStatus(jobId);
      if (!status) continue;

      if (status.status === 'completed' || status.status === 'error') {
        schedulerState.lastRuns[meta.tier] = {
          jobId,
          enriched: status.enriched, total: status.total,
          fields: status.totalFieldsUpdated, errors: status.errors,
          cost: meta.estimatedCost,
          duration: status.completedAt ? 
            ((new Date(status.completedAt) - new Date(status.startedAt)) / 60000).toFixed(1) + 'min' : '?',
          completedAt: status.completedAt,
          resumed: status.resumed || false,
          resumeCount: status.resumeCount || 0
        };
        schedulerState.stats.totalCost += meta.estimatedCost;
        logger.info(`[SCHEDULER] Job ${jobId} done: ${status.enriched}/${status.total}, ~$${meta.estimatedCost}`);

        // Chain queue
        const chainIdx = schedulerState.chainQueue.findIndex(c => c.afterJob === jobId);
        if (chainIdx >= 0) {
          const chain = schedulerState.chainQueue[chainIdx];
          schedulerState.chainQueue.splice(chainIdx, 1);
          logger.info(`[SCHEDULER] Chain trigger: tier ${chain.tier} (${chain.mode}) after ${jobId}`);
          const nextJob = await launchTierScan(chain.tier, chain.mode);
          if (nextJob && nextJob.jobId) {
            for (const r of schedulerState.chainQueue) {
              if (r.afterJob === jobId) { r.afterJob = nextJob.jobId; }
            }
          }
        }

        // IAI recalc
        try {
          const pool = require('../db/pool');
          await pool.query(`
            UPDATE complexes SET 
              iai_score = COALESCE(
                CASE WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0 
                THEN LEAST(100, GREATEST(0,
                  (CASE WHEN price_vs_city_avg < -10 THEN 25 WHEN price_vs_city_avg < 0 THEN 15 ELSE 5 END) +
                  (CASE WHEN plan_stage IN ('approved','permit') THEN 30 WHEN plan_stage = 'deposit' THEN 20 WHEN plan_stage = 'committee' THEN 10 ELSE 5 END) +
                  (CASE WHEN developer_reputation_score >= 80 THEN 20 WHEN developer_reputation_score >= 60 THEN 10 ELSE 5 END) +
                  (CASE WHEN news_sentiment = 'positive' THEN 15 WHEN news_sentiment = 'neutral' THEN 10 ELSE 0 END) +
                  (CASE WHEN is_receivership THEN 10 ELSE 0 END)
                )) ELSE iai_score END, iai_score),
              updated_at = NOW()
            WHERE updated_at > NOW() - INTERVAL '1 hour'
          `);
          logger.info('[SCHEDULER] IAI recalculated');
        } catch (e) { logger.warn('[SCHEDULER] IAI recalc failed', { error: e.message }); }

        delete schedulerState.activeJobs[jobId];
      }
    } catch (err) {
      logger.error(`[SCHEDULER] Monitor error for ${jobId}`, { error: err.message });
    }
  }
}

// ============================================================
// AUTO-RESUME ON STARTUP (v2.0)
// ============================================================
async function resumeInterruptedJobs() {
  const smartBatch = getSmartBatch();
  if (!smartBatch || !smartBatch.findInterruptedJobs) {
    logger.info('[SCHEDULER] Smart batch v2 not available, skipping resume');
    return;
  }

  try {
    const interrupted = await smartBatch.findInterruptedJobs();
    if (interrupted.length === 0) {
      logger.info('[SCHEDULER] No interrupted jobs - clean startup');
      return;
    }

    logger.info(`[SCHEDULER] Found ${interrupted.length} interrupted job(s) - resuming...`);

    for (const job of interrupted) {
      try {
        const result = await smartBatch.resumeInterruptedJob(job);
        if (result) {
          schedulerState.activeJobs[result.jobId] = {
            tier: job.tier, mode: job.mode, count: result.total,
            startedAt: job.started_at,
            estimatedCost: parseFloat(job.estimated_cost || 0),
            resumed: true, resumeCount: result.resumeCount
          };

          // Restore chain queue
          if (result.chainQueue && result.chainQueue.length > 0) {
            for (const chain of result.chainQueue) {
              schedulerState.chainQueue.push({
                afterJob: result.jobId, tier: chain.tier, mode: chain.mode
              });
            }
            logger.info(`[SCHEDULER] Restored ${result.chainQueue.length} chain(s) for ${result.jobId}`);
          }

          schedulerState.resumedJobs.push({
            jobId: result.jobId, tier: job.tier, mode: job.mode,
            completed: result.completed, remaining: result.remaining,
            total: result.total, resumeCount: result.resumeCount,
            resumedAt: new Date().toISOString()
          });

          logger.info(`[SCHEDULER] RESUMED: ${result.jobId} - ${result.completed}/${result.total} done, ${result.remaining} left (resume #${result.resumeCount})`);
        }
      } catch (err) {
        logger.error(`[SCHEDULER] Failed to resume ${job.job_id}`, { error: err.message });
      }
    }
  } catch (err) {
    logger.error('[SCHEDULER] Resume check failed', { error: err.message });
  }
}

// ============================================================
// CRON INIT
// ============================================================
function initScheduler() {
  logger.info('[SCHEDULER] QUANTUM Scheduler v2.0 (deploy-safe) initializing...');

  // Job Monitor: every 2 min
  schedulerState.scheduledTasks.push(
    cron.schedule('*/2 * * * *', () => monitorJobs(), { timezone: 'Asia/Jerusalem' })
  );

  // Tier 1: Sun 08:00
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 0', async () => {
      if (!isEnrichmentDay()) return;
      if (isFirstSundayOfMonth()) {
        logger.info('[SCHEDULER] Monthly FULL for Tier 1');
        const job = await launchTierScan('1full');
        if (job) schedulerState.chainQueue.push({ afterJob: job.jobId, tier: '2', mode: 'standard' });
      } else {
        logger.info('[SCHEDULER] Weekly STANDARD for Tier 1');
        await launchTierScan('1');
      }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // Tier 2: Mon 08:00 bi-weekly
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 1', async () => {
      if (!isEnrichmentDay()) return;
      schedulerState.biweeklyToggle = !schedulerState.biweeklyToggle;
      if (!schedulerState.biweeklyToggle) { logger.info('[SCHEDULER] Tier 2 skip (bi-weekly)'); return; }
      logger.info('[SCHEDULER] Bi-weekly STANDARD for Tier 2');
      await launchTierScan('2');
    }, { timezone: 'Asia/Jerusalem' })
  );

  // Tier 3: Tue 08:00 monthly
  schedulerState.scheduledTasks.push(
    cron.schedule('0 8 * * 2', async () => {
      if (!isEnrichmentDay()) return;
      if (!isFirstOrThirdWeek()) return;
      logger.info('[SCHEDULER] Monthly FAST for Tier 3');
      await launchTierScan('3');
    }, { timezone: 'Asia/Jerusalem' })
  );

  // Listings: Daily 07:00
  schedulerState.scheduledTasks.push(
    cron.schedule('0 7 * * *', async () => {
      logger.info('[SCHEDULER] Daily listings scan');
      try { const y = require('../services/yad2Scraper'); if (y?.scrapeAll) await y.scrapeAll(); } catch (e) { logger.warn('[SCHEDULER] Yad2 failed', { error: e.message }); }
      try { const k = require('../services/konesIsraelService'); if (k?.fetchListings) await k.fetchListings(); } catch (e) { logger.warn('[SCHEDULER] Kones failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // SSI: Daily 09:00
  schedulerState.scheduledTasks.push(
    cron.schedule('0 9 * * *', async () => {
      logger.info('[SCHEDULER] Daily SSI recalc');
      try { const { calculateAllSSI } = require('../services/ssiCalculator'); await calculateAllSSI(); } catch (e) { logger.warn('[SCHEDULER] SSI failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  // PSS: Wed 06:00
  schedulerState.scheduledTasks.push(
    cron.schedule('0 6 * * 3', async () => {
      if (!isEnrichmentDay()) return;
      logger.info('[SCHEDULER] PSS re-ranking');
      try {
        const sp = getScanPriority(); if (!sp) return;
        const r = await sp.calculateAllPriorities();
        schedulerState.lastPSSRank = {
          timestamp: new Date().toISOString(),
          tiers: { hot: r.tiers.hot.count, active: r.tiers.active.count, dormant: r.tiers.dormant.count },
          top5: r.top_50.slice(0, 5).map(c => ({ name: c.name, city: c.city, pss: c.pss }))
        };
        logger.info(`[SCHEDULER] PSS: HOT=${r.tiers.hot.count}, ACTIVE=${r.tiers.active.count}, DORMANT=${r.tiers.dormant.count}`);
      } catch (e) { logger.warn('[SCHEDULER] PSS failed', { error: e.message }); }
    }, { timezone: 'Asia/Jerusalem' })
  );

  logger.info('[SCHEDULER] Cron registered. Auto-resume check in 15s...');

  // Auto-resume interrupted jobs after startup
  setTimeout(async () => {
    try { await resumeInterruptedJobs(); }
    catch (err) { logger.error('[SCHEDULER] Auto-resume failed', { error: err.message }); }
  }, 15000);
}

// ============================================================
// STATUS
// ============================================================
function getSchedulerStatus() {
  return {
    version: '2.0-deploy-safe',
    activeJobs: Object.keys(schedulerState.activeJobs).length,
    activeJobDetails: schedulerState.activeJobs,
    chainQueue: schedulerState.chainQueue,
    lastRuns: schedulerState.lastRuns,
    lastPSSRank: schedulerState.lastPSSRank,
    stats: schedulerState.stats,
    biweeklyToggle: schedulerState.biweeklyToggle,
    resumedJobs: schedulerState.resumedJobs,
    nextEnrichmentDay: isEnrichmentDay() ? 'today' : 'next business day',
    persistence: 'PostgreSQL scan_jobs'
  };
}

module.exports = { 
  initScheduler, launchTierScan, chainAfter, monitorJobs,
  getSchedulerStatus, schedulerState, resumeInterruptedJobs
};
