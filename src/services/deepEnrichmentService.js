/**
 * Deep Enrichment Service v6.0
 * 
 * CHANGES v6.0:
 * - enrichPricingData now runs in STANDARD mode (not just full)
 * - NEW: enrichSignatureData - queries for tenant signing percentages
 * - NEW: enrichTargeted - batch enrich only missing fields (pricing/signatures)
 * - Pricing + Signature run in standard, fast gets pricing too
 * 
 * Exports: deepEnrichComplex, getBatchStatus, getAllBatchJobs, enrichAll, enrichTargeted
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { scanComplexUnified, queryPerplexity, queryClaude } = require('./claudeOrchestrator');
const { recalculateComplex } = require('./iaiCalculator');

const batchJobs = {};
const DELAY_BETWEEN_COMPLEXES = 5000;
const DELAY_BETWEEN_AI_CALLS = 2000;

// ==========================================
// MAIN ENRICHMENT FUNCTION
// ==========================================
async function deepEnrichComplex(complexId, options = {}) {
  const mode = options.mode || 'standard';
  const targetFields = options.targetFields || null; // ['pricing', 'signatures'] for targeted
  const startTime = Date.now();
  
  const { rows } = await pool.query(
    `SELECT id, name, city, addresses, plan_number, status, developer,
            iai_score, actual_premium, accurate_price_sqm, city_avg_price_sqm,
            num_buildings, signature_percent, signature_source, plan_stage, neighborhood,
            price_trend, developer_status, developer_risk_level,
            news_sentiment, existing_units, planned_units,
            last_perplexity_update
     FROM complexes WHERE id = $1`, [complexId]
  );

  if (rows.length === 0) throw new Error(`Complex ${complexId} not found`);
  const complex = rows[0];
  logger.info(`[DEEP ENRICH v6] ${complex.name} (${complex.city}) [mode: ${mode}${targetFields ? ', target: ' + targetFields.join(',') : ''}]`);

  let fieldsUpdated = 0;
  const errors = [];
  const updates = {};

  try {
    if (targetFields) {
      // Targeted mode: only enrich specific missing fields
      if (targetFields.includes('pricing') && (!complex.actual_premium || !complex.accurate_price_sqm)) {
        fieldsUpdated += await enrichPricingData(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
      }
      if (targetFields.includes('signatures') && !complex.signature_percent) {
        fieldsUpdated += await enrichSignatureData(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
      }
      if (targetFields.includes('buildings') && !complex.num_buildings) {
        fieldsUpdated += await enrichBuildingCount(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
      }
    } else if (mode === 'turbo') {
      fieldsUpdated += await enrichWithPerplexityOnly(complex, updates);
    } else if (mode === 'fast') {
      fieldsUpdated += await enrichFastMode(complex, updates);
      await sleep(DELAY_BETWEEN_AI_CALLS);
      // v6: fast now includes pricing
      if (!complex.actual_premium || !complex.accurate_price_sqm) {
        fieldsUpdated += await enrichPricingData(complex, updates);
      }
    } else if (mode === 'standard' || mode === 'full') {
      const scanResult = await scanComplexUnified(complexId);
      if (scanResult.status === 'success') {
        fieldsUpdated += scanResult.updatedFields?.length || 0;
      }
      await sleep(DELAY_BETWEEN_AI_CALLS);

      // v6: standard now includes pricing AND signatures
      if (!complex.actual_premium || !complex.accurate_price_sqm) {
        fieldsUpdated += await enrichPricingData(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
      }
      if (!complex.signature_percent) {
        fieldsUpdated += await enrichSignatureData(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
      }

      if (mode === 'full') {
        fieldsUpdated += await enrichDeveloperData(complex, updates);
        await sleep(DELAY_BETWEEN_AI_CALLS);
        if (!complex.num_buildings) {
          fieldsUpdated += await enrichBuildingCount(complex, updates);
        }
      }
    }
  } catch (err) {
    errors.push(err.message);
    logger.warn(`[DEEP ENRICH] Partial failure for ${complex.name}: ${err.message}`);
  }

  // Apply updates to DB
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

  // Recalculate IAI
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
    updatedFields: Object.keys(updates),
    errors: errors.length > 0 ? errors : undefined,
    durationMs
  };
}

// ==========================================
// SIGNATURE ENRICHMENT (NEW in v6)
// ==========================================
async function enrichSignatureData(complex, updates) {
  let fields = 0;
  if (complex.signature_percent) return fields;

  // Only query for complexes in early-mid stages where signatures matter
  const skipStatuses = ['construction', 'permit'];
  if (skipStatuses.includes(complex.status)) {
    // Projects in construction/permit already have 100% signatures
    updates.signature_percent = 100;
    updates.signature_source = 'inferred_from_status';
    return 2;
  }

  const prompt = `חפש מידע על אחוזי חתימה / הסכמת דיירים בפרויקט פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}
${complex.plan_number ? `תכנית: ${complex.plan_number}` : ''}
${complex.developer ? `יזם: ${complex.developer}` : ''}

חפש ב:
- פרוטוקולים של ועדות תכנון
- כתבות חדשותיות
- פורומים ורשתות חברתיות
- אתרי היזם

החזר JSON בלבד:
{
  "signature_percent": number (0-100) or null,
  "source_type": "protocol|press|social|developer|none",
  "source_detail": "תיאור קצר של המקור",
  "confidence": "high|medium|low",
  "notes": "פרטים נוספים"
}`;

  try {
    const result = await queryPerplexity(prompt, {
      systemPrompt: 'אתה חוקר נדל"ן המתמחה בהתחדשות עירונית. חפש מידע ספציפי על אחוזי חתימה של דיירים. אם אין מידע, החזר null. החזר JSON בלבד.',
      model: 'sonar-pro'
    });
    
    const data = parseJson(result?.content);
    if (!data) return fields;

    if (data.signature_percent !== null && data.signature_percent !== undefined) {
      const pct = parseInt(data.signature_percent);
      if (pct >= 0 && pct <= 100) {
        updates.signature_percent = pct;
        fields++;

        // Determine source reliability
        const sourceMap = {
          'protocol': 'official',  // Green - high confidence
          'press': 'press',        // Yellow - medium confidence
          'social': 'social',      // Yellow - lower confidence
          'developer': 'developer', // Yellow - potential bias
          'none': null
        };
        const sourceType = sourceMap[data.source_type] || 'press';
        if (sourceType) {
          updates.signature_source = sourceType;
          fields++;
        }

        logger.info(`[SIGNATURES] ${complex.name}: ${pct}% (${data.source_type}, ${data.confidence})`);
      }
    }
  } catch (err) {
    logger.debug(`Signature enrichment failed for ${complex.name}: ${err.message}`);
  }

  return fields;
}

// ==========================================
// PRICING ENRICHMENT (exists, improved prompt)
// ==========================================
async function enrichPricingData(complex, updates) {
  let fields = 0;
  if (complex.accurate_price_sqm && complex.city_avg_price_sqm && complex.actual_premium) return fields;

  const prompt = `מצא מחירי דירות ישנות (לפני פינוי בינוי) ב${complex.city}:
${complex.addresses ? `כתובת ספציפית: ${complex.addresses}` : ''}
${complex.neighborhood ? `שכונה: ${complex.neighborhood}` : ''}

חפש ב-yad2, madlan, nadlan.gov.il:
1. מחיר ממוצע למ"ר של דירות ישנות (3-4 חדרים, בניין ישן) באזור הספציפי
2. מחיר ממוצע למ"ר של דירות ישנות בעיר כולה
3. מגמת מחירים (עולה/יורד/יציב)

החזר JSON בלבד:
{
  "price_per_sqm_area": number or null,
  "price_per_sqm_city_avg": number or null,
  "price_trend": "rising|stable|declining",
  "sample_size": "כמה עסקאות/מודעות נבדקו",
  "confidence": "high|medium|low"
}`;

  try {
    const result = await queryPerplexity(prompt, {
      systemPrompt: 'אתה אנליסט נדל"ן. מצא מחירים אמיתיים ועדכניים. השתמש במקורות רשמיים כמו nadlan.gov.il. החזר JSON בלבד.',
      model: 'sonar-pro'
    });
    const data = parseJson(result?.content);
    if (!data) return fields;

    if (data.price_per_sqm_area && !complex.accurate_price_sqm) {
      const price = parseFloat(data.price_per_sqm_area);
      if (price > 5000 && price < 150000) { // sanity check
        updates.accurate_price_sqm = price;
        fields++;
      }
    }
    if (data.price_per_sqm_city_avg && !complex.city_avg_price_sqm) {
      const avg = parseFloat(data.price_per_sqm_city_avg);
      if (avg > 5000 && avg < 150000) {
        updates.city_avg_price_sqm = avg;
        fields++;
      }
    }
    if (data.price_trend && !complex.price_trend) {
      updates.price_trend = data.price_trend;
      fields++;
    }

    // Calculate actual premium if we now have both values
    const priceSqm = updates.accurate_price_sqm || complex.accurate_price_sqm;
    const cityAvg = updates.city_avg_price_sqm || complex.city_avg_price_sqm;
    if (priceSqm && cityAvg && !complex.actual_premium) {
      const premium = Math.round(((priceSqm - cityAvg) / cityAvg) * 100);
      if (premium >= -80 && premium <= 300) { // sanity check
        updates.actual_premium = premium;
        fields++;
      }
    }
  } catch (err) {
    logger.debug(`Pricing enrichment failed for ${complex.name}: ${err.message}`);
  }

  return fields;
}

// ==========================================
// BUILDING COUNT ENRICHMENT (NEW in v6)
// ==========================================
async function enrichBuildingCount(complex, updates) {
  let fields = 0;
  if (complex.num_buildings) return fields;

  const prompt = `כמה בניינים יש במתחם פינוי בינוי "${complex.name}" ב${complex.city}?
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}
${complex.plan_number ? `תכנית: ${complex.plan_number}` : ''}

החזר JSON: { "num_buildings": number or null, "existing_units": number or null, "planned_units": number or null }`;

  try {
    const result = await queryPerplexity(prompt);
    const data = parseJson(result?.content);
    if (data?.num_buildings) {
      const n = parseInt(data.num_buildings);
      if (n > 0 && n < 200) {
        updates.num_buildings = n;
        fields++;
      }
    }
    if (data?.existing_units && !complex.existing_units) {
      updates.existing_units = parseInt(data.existing_units);
      fields++;
    }
    if (data?.planned_units && !complex.planned_units) {
      updates.planned_units = parseInt(data.planned_units);
      fields++;
    }
  } catch (err) {
    logger.debug(`Building count enrichment failed: ${err.message}`);
  }
  return fields;
}

// ==========================================
// EXISTING FUNCTIONS (unchanged)
// ==========================================
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
  "num_buildings": null or number,
  "signature_percent": null or number
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
  if (data.signature_percent && !complex.signature_percent) {
    const pct = parseInt(data.signature_percent);
    if (pct >= 0 && pct <= 100) { updates.signature_percent = pct; updates.signature_source = 'press'; fields += 2; }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==========================================
// BATCH FUNCTIONS
// ==========================================
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

  processJobAsync(jobId, complexes, { mode });
  return { jobId, status: 'started', total: complexes.length, mode,
    message: `Batch started. Track: GET /api/enrichment/batch/${jobId}` };
}

/**
 * NEW: Targeted enrichment for specific missing fields
 * Only queries AI for the exact data gaps, much faster than full enrichment
 */
async function enrichTargeted(options = {}) {
  const { target = 'pricing', limit = 50, city } = options;
  
  let whereClause = '';
  let targetFields = [];
  
  if (target === 'pricing') {
    whereClause = '(actual_premium IS NULL OR accurate_price_sqm IS NULL)';
    targetFields = ['pricing'];
  } else if (target === 'signatures') {
    whereClause = 'signature_percent IS NULL';
    targetFields = ['signatures'];
  } else if (target === 'buildings') {
    whereClause = 'num_buildings IS NULL';
    targetFields = ['buildings'];
  } else if (target === 'all_gaps') {
    whereClause = '(actual_premium IS NULL OR signature_percent IS NULL OR num_buildings IS NULL)';
    targetFields = ['pricing', 'signatures', 'buildings'];
  } else {
    throw new Error(`Invalid target: ${target}. Use: pricing, signatures, buildings, all_gaps`);
  }

  let query = `SELECT id, name, city FROM complexes WHERE ${whereClause}`;
  const params = [];
  let idx = 1;
  if (city) { query += ` AND city = $${idx}`; params.push(city); idx++; }
  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${idx}`;
  params.push(limit);

  const { rows: complexes } = await pool.query(query, params);

  const jobId = `targeted_${target}_${Date.now()}`;
  batchJobs[jobId] = {
    status: 'running', total: complexes.length, enriched: 0,
    totalFieldsUpdated: 0, errors: 0, currentComplex: null,
    mode: `targeted:${target}`, targetFields, details: [],
    startedAt: new Date().toISOString(), completedAt: null
  };

  processJobAsync(jobId, complexes, { mode: 'standard', targetFields });
  
  return {
    jobId, status: 'started', total: complexes.length,
    target, targetFields,
    message: `Targeted ${target} enrichment started for ${complexes.length} complexes. Track: GET /api/enrichment/batch/${jobId}`
  };
}

async function processJobAsync(jobId, complexes, options) {
  setImmediate(async () => {
    const job = batchJobs[jobId];
    for (const c of complexes) {
      try {
        job.currentComplex = `${c.name} (${c.city})`;
        const result = await deepEnrichComplex(c.id, options);
        job.enriched++;
        job.totalFieldsUpdated += (result.fieldsUpdated || 0);
        if (result.errors) job.errors++;
        job.details.push(result);
        await sleep(DELAY_BETWEEN_COMPLEXES);
      } catch (err) {
        job.errors++;
        job.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
        await sleep(DELAY_BETWEEN_COMPLEXES);
      }
    }
    job.status = 'completed';
    job.currentComplex = null;
    job.completedAt = new Date().toISOString();
    logger.info(`[BATCH] ${jobId} complete: ${job.enriched}/${job.total}, ${job.totalFieldsUpdated} fields updated`);
  });
}

function getBatchStatus(jobId) { return batchJobs[jobId] || null; }
function getAllBatchJobs() {
  return Object.entries(batchJobs).map(([id, job]) => ({
    jobId: id, status: job.status, progress: `${job.enriched}/${job.total}`,
    fieldsUpdated: job.totalFieldsUpdated, errors: job.errors,
    startedAt: job.startedAt, completedAt: job.completedAt, mode: job.mode
  }));
}

module.exports = { deepEnrichComplex, enrichAll, enrichTargeted, getBatchStatus, getAllBatchJobs };
