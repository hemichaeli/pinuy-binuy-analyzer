/**
 * Smart Batch Enrichment v2 - Deploy-safe with DB persistence
 * 
 * Jobs survive Railway deploys by persisting state to PostgreSQL.
 * On restart, interrupted jobs auto-resume from last completed complex.
 */
const pool = require('../db/pool');
const { logger } = require('./logger');
const { deepEnrichComplex, getBatchStatus, getAllBatchJobs } = require('./deepEnrichmentService');

const BETWEEN_COMPLEX_MS = 5000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// In-memory tracking (rebuilt from DB on resume)
const smartBatchJobs = {};

// ============================================================
// DB MIGRATION - runs once on startup
// ============================================================
let migrationDone = false;
async function ensureTable() {
  if (migrationDone) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_jobs (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) UNIQUE NOT NULL,
        tier VARCHAR(20) NOT NULL DEFAULT 'manual',
        mode VARCHAR(20) NOT NULL DEFAULT 'standard',
        status VARCHAR(20) NOT NULL DEFAULT 'running',
        all_complex_ids INTEGER[] NOT NULL,
        completed_complex_ids INTEGER[] DEFAULT ARRAY[]::INTEGER[],
        total_count INTEGER NOT NULL,
        enriched_count INTEGER DEFAULT 0,
        fields_updated INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        estimated_cost DECIMAL(10,2) DEFAULT 0,
        chain_queue JSONB DEFAULT '[]'::jsonb,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        resume_count INTEGER DEFAULT 0
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scan_jobs_job_id ON scan_jobs(job_id)');
    migrationDone = true;
    logger.info('[SMART BATCH] scan_jobs table ready');
  } catch (err) {
    logger.warn('[SMART BATCH] Migration warning (non-fatal)', { error: err.message });
    migrationDone = true;
  }
}

// ============================================================
// DB OPERATIONS
// ============================================================
async function saveJobToDB(jobId, tier, mode, allIds, chainQueue, estimatedCost) {
  try {
    await ensureTable();
    await pool.query(`
      INSERT INTO scan_jobs (job_id, tier, mode, all_complex_ids, total_count, chain_queue, estimated_cost)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (job_id) DO UPDATE SET
        status = 'running',
        updated_at = NOW()
    `, [jobId, tier, mode, allIds, allIds.length, JSON.stringify(chainQueue || []), estimatedCost || 0]);
  } catch (err) {
    logger.warn(`[SMART BATCH] DB save failed for ${jobId} (non-fatal)`, { error: err.message });
  }
}

async function updateJobProgress(jobId, completedId, fieldsUpdated, errorOccurred) {
  try {
    await pool.query(`
      UPDATE scan_jobs SET
        completed_complex_ids = array_append(completed_complex_ids, $2),
        enriched_count = enriched_count + 1,
        fields_updated = fields_updated + $3,
        error_count = error_count + $4,
        updated_at = NOW()
      WHERE job_id = $1
    `, [jobId, completedId, fieldsUpdated || 0, errorOccurred ? 1 : 0]);
  } catch (err) {
    logger.warn(`[SMART BATCH] DB progress update failed for ${jobId}`, { error: err.message });
  }
}

async function markJobComplete(jobId) {
  try {
    await pool.query(`
      UPDATE scan_jobs SET
        status = 'completed',
        completed_at = NOW(),
        updated_at = NOW()
      WHERE job_id = $1
    `, [jobId]);
  } catch (err) {
    logger.warn(`[SMART BATCH] DB complete update failed for ${jobId}`, { error: err.message });
  }
}

async function markJobInterrupted(jobId) {
  try {
    await pool.query(`
      UPDATE scan_jobs SET
        status = 'interrupted',
        updated_at = NOW()
      WHERE job_id = $1 AND status = 'running'
    `, [jobId]);
  } catch (err) {
    // Ignore - server is shutting down
  }
}

// ============================================================
// INTERRUPTED JOB DETECTION
// ============================================================
async function findInterruptedJobs() {
  try {
    await ensureTable();
    const result = await pool.query(`
      SELECT job_id, tier, mode, all_complex_ids, completed_complex_ids,
             total_count, enriched_count, fields_updated, error_count,
             chain_queue, estimated_cost, started_at, resume_count
      FROM scan_jobs
      WHERE status IN ('running', 'interrupted')
      ORDER BY started_at DESC
      LIMIT 5
    `);
    return result.rows;
  } catch (err) {
    logger.warn('[SMART BATCH] Could not check for interrupted jobs', { error: err.message });
    return [];
  }
}

async function resumeInterruptedJob(interruptedJob) {
  const { job_id, tier, mode, all_complex_ids, completed_complex_ids,
          enriched_count, fields_updated, error_count, chain_queue, 
          estimated_cost, resume_count } = interruptedJob;

  const completedSet = new Set(completed_complex_ids || []);
  const remainingIds = all_complex_ids.filter(id => !completedSet.has(id));

  if (remainingIds.length === 0) {
    logger.info(`[SMART BATCH] Job ${job_id} was actually complete (${all_complex_ids.length}/${all_complex_ids.length})`);
    await markJobComplete(job_id);
    return null;
  }

  logger.info(`[SMART BATCH] RESUMING job ${job_id}: ${completedSet.size}/${all_complex_ids.length} done, ${remainingIds.length} remaining (resume #${(resume_count || 0) + 1})`);

  await pool.query(
    'UPDATE scan_jobs SET resume_count = resume_count + 1, status = $2, updated_at = NOW() WHERE job_id = $1',
    [job_id, 'running']
  );

  const placeholders = remainingIds.map((_, i) => `$${i + 1}`).join(',');
  const complexes = await pool.query(
    `SELECT id, name, city, iai_score FROM complexes WHERE id IN (${placeholders}) ORDER BY iai_score DESC NULLS LAST`,
    remainingIds
  );

  const modeLabel = {
    'full': 'v5.0 APEX: parallel + opus-4.6-extended-thinking + web-search',
    'standard': 'v5.0: parallel + sonnet-4.5-synthesis',
    'fast': 'v5.0: perplexity + sonnet-4.5-synthesis',
    'turbo': 'v5.0: perplexity-only (no synthesis)'
  }[mode] || 'v5.0-standard';

  smartBatchJobs[job_id] = {
    status: 'running',
    total: all_complex_ids.length,
    enriched: enriched_count || 0,
    totalFieldsUpdated: fields_updated || 0,
    errors: error_count || 0,
    currentComplex: null,
    mode,
    engine: modeLabel,
    details: [],
    startedAt: interruptedJob.started_at,
    completedAt: null,
    resumed: true,
    resumeCount: (resume_count || 0) + 1,
    chainQueue: chain_queue || []
  };

  processSmartBatch(job_id, complexes.rows, mode).catch(err => {
    logger.error(`[SMART BATCH] Resumed batch ${job_id} crashed`, { error: err.message });
    smartBatchJobs[job_id].status = 'error';
    smartBatchJobs[job_id].completedAt = new Date().toISOString();
  });

  return {
    jobId: job_id,
    status: 'resumed',
    remaining: remainingIds.length,
    completed: completedSet.size,
    total: all_complex_ids.length,
    mode,
    engine: modeLabel,
    resumeCount: (resume_count || 0) + 1,
    chainQueue: chain_queue
  };
}

// ============================================================
// STANDARD API
// ============================================================
function getSmartBatchStatus(jobId) {
  return smartBatchJobs[jobId] || getBatchStatus(jobId) || null;
}

function getAllSmartBatchJobs() {
  const deepJobs = getAllBatchJobs();
  const smartJobs = Object.entries(smartBatchJobs).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    progress: `${job.enriched}/${job.total}`,
    fieldsUpdated: job.totalFieldsUpdated,
    errors: job.errors,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    mode: job.mode,
    engine: job.engine,
    resumed: job.resumed || false,
    resumeCount: job.resumeCount || 0
  }));
  return [...deepJobs, ...smartJobs];
}

/**
 * Enrich specific complex IDs with a given mode
 * Now persists to DB for deploy-safe operation
 */
async function enrichByIds(complexIds, mode = 'standard', options = {}) {
  if (!complexIds || complexIds.length === 0) {
    return { status: 'empty', message: 'No complex IDs provided' };
  }

  const { tier = 'manual', chainQueue = [], estimatedCost = 0 } = options;

  const placeholders = complexIds.map((_, i) => `$${i + 1}`).join(',');
  const complexes = await pool.query(
    `SELECT id, name, city, iai_score FROM complexes WHERE id IN (${placeholders}) ORDER BY iai_score DESC NULLS LAST`,
    complexIds
  );

  const jobId = `smart_${Date.now()}`;
  const modeLabel = {
    'full': 'v5.0 APEX: parallel + opus-4.6-extended-thinking + web-search',
    'standard': 'v5.0: parallel + sonnet-4.5-synthesis',
    'fast': 'v5.0: perplexity + sonnet-4.5-synthesis',
    'turbo': 'v5.0: perplexity-only (no synthesis)'
  }[mode] || 'v5.0-standard';

  smartBatchJobs[jobId] = {
    status: 'running',
    total: complexes.rows.length,
    enriched: 0,
    totalFieldsUpdated: 0,
    errors: 0,
    currentComplex: null,
    mode,
    engine: modeLabel,
    details: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  const allIds = complexes.rows.map(c => c.id);
  await saveJobToDB(jobId, tier, mode, allIds, chainQueue, estimatedCost);

  logger.info(`[SMART SCAN] Batch ${jobId}: ${complexes.rows.length} complexes by ID (mode: ${mode}) [DB-persisted]`);

  processSmartBatch(jobId, complexes.rows, mode).catch(err => {
    logger.error(`Smart batch ${jobId} crashed`, { error: err.message });
    smartBatchJobs[jobId].status = 'error';
    smartBatchJobs[jobId].completedAt = new Date().toISOString();
  });

  return {
    jobId,
    status: 'started',
    total: complexes.rows.length,
    mode,
    engine: modeLabel,
    message: `Smart scan started (${mode}). Track: GET /api/enrichment/batch/${jobId}`
  };
}

// ============================================================
// CORE PROCESSING LOOP
// ============================================================
async function processSmartBatch(jobId, complexes, mode) {
  const job = smartBatchJobs[jobId];

  for (const c of complexes) {
    const complexStart = Date.now();
    try {
      job.currentComplex = `${c.name} (${c.city})`;
      const result = await deepEnrichComplex(c.id, { mode });
      
      job.enriched++;
      job.totalFieldsUpdated += (result.fieldsUpdated || 0);
      
      if (result.errors && result.errors.length > 0) {
        job.errors++;
        logger.warn(`[SMART SCAN] ${c.name}: enriched with ${result.errors.length} warnings`, { 
          fields: result.fieldsUpdated, warnings: result.errors 
        });
      }
      
      job.details.push({ ...result, durationMs: Date.now() - complexStart });

      // Persist progress to DB
      await updateJobProgress(jobId, c.id, result.fieldsUpdated || 0, false);

      await sleep(BETWEEN_COMPLEX_MS);
    } catch (err) {
      let dbFields = 0;
      try {
        const check = await pool.query(
          'SELECT updated_at FROM complexes WHERE id = $1 AND updated_at > NOW() - INTERVAL \'10 minutes\'',
          [c.id]
        );
        if (check.rows.length > 0) {
          job.enriched++;
          dbFields = 1;
          logger.warn(`[SMART SCAN] ${c.name}: threw but DB was updated (partial enrichment)`);
        }
      } catch (dbErr) { /* ignore */ }
      
      job.errors++;
      job.details.push({ 
        complexId: c.id, name: c.name, city: c.city,
        status: dbFields > 0 ? 'partial' : 'error', 
        error: err.message,
        durationMs: Date.now() - complexStart
      });

      await updateJobProgress(jobId, c.id, dbFields, true);

      logger.error(`[SMART SCAN] ${c.name} failed: ${err.message}`);
      await sleep(BETWEEN_COMPLEX_MS);
    }
  }

  job.status = 'completed';
  job.currentComplex = null;
  job.completedAt = new Date().toISOString();
  
  await markJobComplete(jobId);

  const duration = ((new Date(job.completedAt) - new Date(job.startedAt)) / 60000).toFixed(1);
  logger.info(`[SMART SCAN] Batch ${jobId} complete: ${job.enriched}/${job.total} enriched, ${job.errors} errors, ${job.totalFieldsUpdated} fields, ${duration}min (${mode})`);
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
async function handleShutdown() {
  const runningJobs = Object.entries(smartBatchJobs).filter(([_, j]) => j.status === 'running');
  for (const [jobId] of runningJobs) {
    logger.info(`[SMART BATCH] Marking job ${jobId} as interrupted (shutdown)`);
    await markJobInterrupted(jobId);
  }
}

process.on('SIGTERM', async () => {
  logger.info('[SMART BATCH] SIGTERM received - persisting job state');
  await handleShutdown();
});
process.on('SIGINT', async () => {
  logger.info('[SMART BATCH] SIGINT received - persisting job state');
  await handleShutdown();
});

module.exports = { 
  enrichByIds, 
  getSmartBatchStatus, 
  getAllSmartBatchJobs,
  findInterruptedJobs,
  resumeInterruptedJob,
  ensureTable,
  handleShutdown
};
