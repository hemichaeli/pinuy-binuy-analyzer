/**
 * Smart Batch Enrichment - extends deepEnrichmentService with ID-based enrichment
 * Used by the smart-scan tier system to enrich specific complex IDs
 */
const pool = require('../db/pool');
const { logger } = require('./logger');
const { deepEnrichComplex, getBatchStatus, getAllBatchJobs } = require('./deepEnrichmentService');

const BETWEEN_COMPLEX_MS = 5000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const smartBatchJobs = {};

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
    engine: job.engine
  }));
  return [...deepJobs, ...smartJobs];
}

/**
 * Enrich specific complex IDs with a given mode
 * Returns job info for async tracking
 */
async function enrichByIds(complexIds, mode = 'standard') {
  if (!complexIds || complexIds.length === 0) {
    return { status: 'empty', message: 'No complex IDs provided' };
  }

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

  logger.info(`[SMART SCAN] Batch ${jobId}: ${complexes.rows.length} complexes by ID (mode: ${mode})`);

  // Process in background
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

async function processSmartBatch(jobId, complexes, mode) {
  const job = smartBatchJobs[jobId];

  for (const c of complexes) {
    try {
      job.currentComplex = `${c.name} (${c.city})`;
      const result = await deepEnrichComplex(c.id, { mode });
      job.enriched++;
      job.totalFieldsUpdated += result.fieldsUpdated;
      if (result.errors) job.errors++;
      job.details.push(result);
      await sleep(BETWEEN_COMPLEX_MS);
    } catch (err) {
      job.errors++;
      job.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
      logger.error(`Smart enrichment failed for ${c.name}`, { error: err.message });
      await sleep(BETWEEN_COMPLEX_MS);
    }
  }

  job.status = 'completed';
  job.currentComplex = null;
  job.completedAt = new Date().toISOString();
  logger.info(`[SMART SCAN] Batch ${jobId} complete: ${job.enriched}/${job.total}, ${job.totalFieldsUpdated} fields (${mode})`);
}

module.exports = { enrichByIds, getSmartBatchStatus, getAllSmartBatchJobs };
