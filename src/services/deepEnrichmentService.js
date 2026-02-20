/**
 * Deep Enrichment Service v5.0
 * 
 * Central orchestrator for complex enrichment using multiple AI engines.
 * Exports: deepEnrichComplex, getBatchStatus, getAllBatchJobs, enrichAll
 * 
 * Used by smartBatchService.js for batch processing with DB persistence.
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { scanComplexUnified, queryPerplexity, queryClaude } = require('./claudeOrchestrator');
const { recalculateComplex } = require('./iaiCalculator');

// In-memory batch tracking
const batchJobs = {};

/**
 * Deep enrich a single complex using multi-engine approach
 * @param {number} complexId 
 * @param {object} options - { mode: 'full'|'standard'|'fast'|'turbo' }
 * @returns {object} enrichment result
 */
async function deepEnrichComplex(complexId, options = {}) {
  const mode = options.mode || 'standard';
  const startTime = Date.now();
  
  const { rows } = await pool.query(
    `SELECT id, name, city, addresses, plan_number, status, developer,
            iai_score, actual_premium, accurate_price_sqm, city_avg_price_sqm,
            num_buildings, signature_percent, plan_stage, neighborhood,
            price_trend, developer_status, developer_risk_level,
            news_sentiment, last_perplexity_update
     FROM complexes WHERE id = $1`, [complexId]
  );

  if (rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = rows[0];
  logger.info(`[DEEP ENRICH] Starting ${complex.name} (${complex.city}) [mode: ${mode}]`);

  let fieldsUpdated = 0;
  const errors = [];
  const updates = {};

  try {
    if (mode === 'turbo') {
      fieldsUpdated += await enrichWithPerplexityOnly(complex, updates);
    } else if (mode === 'fast') {
      fieldsUpdated += await enrichFastMode(complex, updates);
    } else if (mode === 'standard' || mode === 'full') {
      const scanResult = await scanComplexUnified(complexId);
      if (scanResult.status === 'success') {
        fieldsUpdated += scanResult.updatedFields?.length || 0;
      }
      if (mode === 'full') {
        fieldsUpdated += await enrichPricingData(complex, updates);
        fieldsUpdated += await enrichDeveloperData(complex, updates);
      }
    }
  } catch (err) {
    errors.push(err.message);
    logger.warn(`[DEEP ENRICH] Partial failure for ${complex.name}: ${err.message}`);
  }

  if (Object.keys(updates).length > 0) {
    try {
      const setClauses = Object.keys(updates).map((k, i) => `"${k}" = $${i + 1}`);
      const values = Object.values(updates);
      values.push(complexId);
      await pool.query(
        `UPDATE complexes SET ${setClauses.join(', ')}, 
         last_perplexity_update = NOW(), updated_at = NOW()
         WHERE id = $${values.length}`,
        values
      );
      fieldsUpdated += Object.keys(updates).length;
    } catch (dbErr) {
      errors.push(`DB update: ${dbErr.message}`);
    }
  }

  try {
    await recalculateComplex(complexId);
  } catch (iaiErr) {
    errors.push(`IAI recalc: ${iaiErr.message}`);
  }

  const durationMs = Date.now() - startTime;
  logger.info(`[DEEP ENRICH] ${complex.name}: ${fieldsUpdated} fields in ${(durationMs/1000).toFixed(1)}s [${mode}]`);

  return {
    complexId, name: complex.name, city: complex.city,
    status: errors.length === 0 ? 'success' : 'partial',
    mode, fieldsUpdated,
    errors: errors.length > 0 ? errors : undefined,
    durationMs
  };
}

async function enrichWithPerplexityOnly(complex, updates) {
  let fields = 0;
  const prompt = `מצא מידע עדכני על פרויקט פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}
${complex.plan_number ? `תכנית: ${complex.plan_number}` : ''}

החזר JSON בלבד:
{
  "status": "declared|planning|deposited|approved|permit|construction",
  "developer": "שם היזם",
  "developer_strength": "strong|medium|weak",
  "plan_stage": "תכנון|הפקדה|אישור|היתר|ביצוע",
  "news": "חדשות אחרונות בשורה אחת",
  "sentiment": "positive|neutral|negative",
  "price_per_sqm": null or number,
  "num_buildings": null or number
}`;

  const result = await queryPerplexity(prompt);
  if (!result?.content) return fields;
  const data = parseJson(result.content);
  if (!data) return fields;

  if (data.developer && !complex.developer) { updates.developer = data.developer; fields++; }
  if (data.developer_strength) { updates.developer_status = data.developer_strength; fields++; }
  if (data.plan_stage && !complex.plan_stage) { updates.plan_stage = data.plan_stage; fields++; }
  if (data.news) { updates.perplexity_summary = data.news.substring(0, 2000); fields++; }
  if (data.sentiment) { updates.news_sentiment = data.sentiment; fields++; }
  if (data.num_buildings && !complex.num_buildings) { updates.num_buildings = parseInt(data.num_buildings); fields++; }
  if (data.price_per_sqm && !complex.accurate_price_sqm) { 
    updates.accurate_price_sqm = parseFloat(data.price_per_sqm); fields++; 
  }
  return fields;
}

async function enrichFastMode(complex, updates) {
  let fields = await enrichWithPerplexityOnly(complex, updates);
  if (complex.developer || updates.developer) {
    const dev = updates.developer || complex.developer;
    try {
      const claudeResult = await queryClaude(
        `מה הסטטוס של יזם הנדל"ן "${dev}" בישראל? האם חזק/בינוני/חלש? האם יש בעיות ידועות?
החזר JSON: { "risk_level": "low|medium|high", "status": "active|problematic|unknown", "notes": "הערה קצרה" }`
      );
      const devData = parseJson(claudeResult?.content);
      if (devData) {
        if (devData.risk_level) { updates.developer_risk_level = devData.risk_level; fields++; }
        if (devData.status) { updates.developer_status = devData.status; fields++; }
      }
    } catch (err) {
      logger.debug(`Developer validation failed for ${dev}: ${err.message}`);
    }
  }
  return fields;
}

async function enrichPricingData(complex, updates) {
  let fields = 0;
  if (complex.accurate_price_sqm && complex.city_avg_price_sqm) return fields;

  const prompt = `מהו מחיר למ"ר עדכני של דירות ישנות (לפני פינוי בינוי) ב${complex.city}?
${complex.addresses ? `ספציפית באזור ${complex.addresses}` : ''}
${complex.neighborhood ? `שכונה: ${complex.neighborhood}` : ''}

החזר JSON:
{
  "price_per_sqm_area": number or null,
  "price_per_sqm_city_avg": number or null,
  "price_trend": "rising|stable|declining",
  "confidence": "high|medium|low"
}`;

  const result = await queryPerplexity(prompt);
  const data = parseJson(result?.content);
  if (!data) return fields;

  if (data.price_per_sqm_area && !complex.accurate_price_sqm) {
    updates.accurate_price_sqm = parseFloat(data.price_per_sqm_area); fields++;
  }
  if (data.price_per_sqm_city_avg && !complex.city_avg_price_sqm) {
    updates.city_avg_price_sqm = parseFloat(data.price_per_sqm_city_avg); fields++;
  }
  if (data.price_trend && !complex.price_trend) {
    updates.price_trend = data.price_trend; fields++;
  }

  const priceSqm = updates.accurate_price_sqm || complex.accurate_price_sqm;
  const cityAvg = updates.city_avg_price_sqm || complex.city_avg_price_sqm;
  if (priceSqm && cityAvg && !complex.actual_premium) {
    updates.actual_premium = Math.round(((priceSqm - cityAvg) / cityAvg) * 100); fields++;
  }
  return fields;
}

async function enrichDeveloperData(complex, updates) {
  let fields = 0;
  const dev = complex.developer || updates.developer;
  if (!dev) return fields;
  try {
    const result = await queryClaude(
      `נתח את יזם הנדל"ן "${dev}" בישראל:
1. האם פעיל? כמה פרויקטים?
2. רמת סיכון (low/medium/high)
3. חוזק פיננסי (strong/medium/weak)
4. בעיות ידועות?

החזר JSON: {
  "risk_level": "low|medium|high",
  "strength": "strong|medium|weak",
  "active_projects": number,
  "known_issues": "תיאור קצר או null"
}`
    );
    const data = parseJson(result?.content);
    if (data) {
      if (data.risk_level && !complex.developer_risk_level) { 
        updates.developer_risk_level = data.risk_level; fields++; 
      }
    }
  } catch (err) {
    logger.debug(`Developer enrichment failed: ${err.message}`);
  }
  return fields;
}

function parseJson(content) {
  if (!content) return null;
  try {
    let cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch (e) { return null; }
}

async function enrichAll(options = {}) {
  const { limit = 20, city, minIai = 0, staleOnly = true, mode = 'standard' } = options;
  let query = `SELECT id, name, city FROM complexes WHERE 1=1`;
  const params = [];
  let idx = 1;
  if (city) { query += ` AND city = $${idx}`; params.push(city); idx++; }
  if (minIai > 0) { query += ` AND iai_score >= $${idx}`; params.push(minIai); idx++; }
  if (staleOnly) {
    query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '5 days')`;
  }
  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${idx}`;
  params.push(limit);
  const { rows: complexes } = await pool.query(query, params);

  const jobId = `batch_${Date.now()}`;
  batchJobs[jobId] = {
    status: 'running', total: complexes.length, enriched: 0,
    totalFieldsUpdated: 0, errors: 0, currentComplex: null,
    mode, details: [], startedAt: new Date().toISOString(), completedAt: null
  };

  setImmediate(async () => {
    const job = batchJobs[jobId];
    for (const c of complexes) {
      try {
        job.currentComplex = `${c.name} (${c.city})`;
        const result = await deepEnrichComplex(c.id, { mode });
        job.enriched++;
        job.totalFieldsUpdated += (result.fieldsUpdated || 0);
        if (result.errors) job.errors++;
        job.details.push(result);
        await new Promise(r => setTimeout(r, 5000));
      } catch (err) {
        job.errors++;
        job.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    job.status = 'completed';
    job.currentComplex = null;
    job.completedAt = new Date().toISOString();
    logger.info(`[BATCH] ${jobId} complete: ${job.enriched}/${job.total}`);
  });

  return {
    jobId, status: 'started', total: complexes.length, mode,
    message: `Batch started. Track: GET /api/enrichment/batch/${jobId}`
  };
}

function getBatchStatus(jobId) { return batchJobs[jobId] || null; }
function getAllBatchJobs() {
  return Object.entries(batchJobs).map(([id, job]) => ({
    jobId: id, status: job.status, progress: `${job.enriched}/${job.total}`,
    fieldsUpdated: job.totalFieldsUpdated, errors: job.errors,
    startedAt: job.startedAt, completedAt: job.completedAt, mode: job.mode
  }));
}

module.exports = { deepEnrichComplex, enrichAll, getBatchStatus, getAllBatchJobs };
