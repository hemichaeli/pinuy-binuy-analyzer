const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let scheduler;
try {
  scheduler = require('../jobs/quantumScheduler');
} catch (err) {
  logger.warn('Quantum scheduler not available', { error: err.message });
}

// GET /api/scheduler/v2 - Full scheduler status
router.get('/', (req, res) => {
  if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
  res.json(scheduler.getSchedulerStatus());
});

// POST /api/scheduler/v2/scan - Manual tier scan trigger
// Body: { tier: '1'|'1full'|'2'|'3', mode?: 'full'|'standard'|'fast' }
router.post('/scan', async (req, res) => {
  if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
  try {
    const { tier = '1', mode } = req.body;
    const job = await scheduler.launchTierScan(tier, mode);
    if (!job) return res.status(400).json({ error: 'Failed to launch scan' });
    res.json({ status: 'launched', ...job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scheduler/v2/chain - Chain a scan after current job
// Body: { afterJobId: 'smart_xxx', tier: '2', mode: 'standard' }
router.post('/chain', (req, res) => {
  if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
  const { afterJobId, tier, mode } = req.body;
  if (!afterJobId || !tier) return res.status(400).json({ error: 'afterJobId and tier required' });
  const result = scheduler.chainAfter(afterJobId, tier, mode || 'standard');
  res.json(result);
});

// POST /api/scheduler/v2/monitor - Force job monitor check
router.post('/monitor', async (req, res) => {
  if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
  await scheduler.monitorJobs();
  res.json({ status: 'checked', activeJobs: scheduler.schedulerState.activeJobs });
});

module.exports = router;
