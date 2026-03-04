/**
 * Dual AI Service v2.1
 *
 * Fast enrichment mode that uses Perplexity for web search
 * and Claude for validation/reasoning.
 *
 * FIXED v2.1: dualScanAll now saves enriched data to DB + logging
 */

const { queryPerplexity, queryClaude } = require('./claudeOrchestrator');
const { logger } = require('./logger');

const PERPLEXITY_MODEL_SCAN = 'sonar-pro';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

function isClaudeConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
}

function isPerplexityConfigured() {
  return !!process.env.PERPLEXITY_API_KEY;
}

function getAvailableModels() {
  return {
    perplexity: isPerplexityConfigured() ? PERPLEXITY_MODEL_SCAN : null,
    claude: isClaudeConfigured() ? CLAUDE_MODEL : null
  };
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

/**
 * Save enriched fields to complexes table
 */
async function saveEnrichedFields(complexId, fields) {
  const pool = require('../db/pool');
  const updates = [];
  const values = [];
  let idx = 1;

  const fieldMap = {
    developer: 'developer',
    accurate_price_sqm: 'accurate_price_sqm',
    perplexity_summary: 'perplexity_summary',
    news_sentiment: 'news_sentiment',
    plan_stage: 'plan_stage',
    developer_risk_level: 'developer_risk_level',
    price_trend: 'price_trend',
    news_summary: 'news_summary'
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key] !== undefined && fields[key] !== null) {
      updates.push(`${col} = $${idx}`);
      values.push(fields[key]);
      idx++;
    }
  }

  if (updates.length === 0) return false;

  updates.push(`last_perplexity_update = NOW()`);
  values.push(complexId);

  await pool.query(
    `UPDATE complexes SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );
  return true;
}

/**
 * Fast enrichment: Perplexity search + Claude validation
 */
async function fastEnrich(complex) {
  const results = { fields: {}, sources: [], confidence: 'low' };

  const webPrompt = `חפש מידע עדכני על פרויקט פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}

מצא: סטטוס, יזם, מחיר למ"ר, חדשות.
החזר JSON: {
  "status": "planning|deposited|approved|permit|construction",
  "developer": "שם או null",
  "price_per_sqm": number or null,
  "news": "חדשות קצרות",
  "sentiment": "positive|neutral|negative"
}`;

  const pResult = await queryPerplexity(webPrompt);
  if (pResult?.content) {
    const data = parseJson(pResult.content);
    if (data) {
      if (data.developer) results.fields.developer = data.developer;
      if (data.price_per_sqm) results.fields.accurate_price_sqm = parseFloat(data.price_per_sqm);
      if (data.news) results.fields.perplexity_summary = data.news.substring(0, 2000);
      if (data.sentiment) results.fields.news_sentiment = data.sentiment;
      if (data.status) results.fields.plan_stage = data.status;
      results.sources.push('perplexity');
    }
  }

  if (Object.keys(results.fields).length > 0) {
    try {
      const validatePrompt = `אמת את המידע הבא על פרויקט "${complex.name}" ב${complex.city}:
${JSON.stringify(results.fields, null, 2)}

האם המידע סביר? החזר JSON: { "valid": true/false, "corrections": {} }`;

      const cResult = await queryClaude(validatePrompt);
      const validation = parseJson(cResult?.content);
      if (validation?.valid) {
        results.confidence = 'medium';
        if (validation.corrections) {
          Object.assign(results.fields, validation.corrections);
        }
        results.sources.push('claude');
      }
    } catch (err) {
      logger.debug(`Claude validation skipped: ${err.message}`);
    }
  }

  return results;
}

/**
 * Standard enrichment with detailed Claude analysis
 */
async function standardEnrich(complex) {
  const fast = await fastEnrich(complex);

  try {
    const analysisPrompt = `נתח את פרויקט הפינוי-בינוי "${complex.name}" ב${complex.city}:
- יזם: ${complex.developer || fast.fields.developer || 'לא ידוע'}
- סטטוס: ${complex.status || 'unknown'}
- מחיר למ"ר: ${fast.fields.accurate_price_sqm || complex.accurate_price_sqm || 'לא ידוע'}

הערך: רמת סיכון היזם, פוטנציאל השקעה, ומגמת מחירים.
החזר JSON: {
  "developer_risk": "low|medium|high",
  "investment_potential": "high|medium|low",
  "price_trend": "rising|stable|declining"
}`;

    const analysis = await queryClaude(analysisPrompt);
    const data = parseJson(analysis?.content);
    if (data) {
      if (data.developer_risk) fast.fields.developer_risk_level = data.developer_risk;
      if (data.price_trend) fast.fields.price_trend = data.price_trend;
      fast.confidence = 'high';
    }
  } catch (err) {
    logger.debug(`Standard analysis skipped: ${err.message}`);
  }

  return fast;
}

/**
 * Dual scan for a single complex (used by scan routes)
 */
async function dualScanComplex(complexId, options = {}) {
  const pool = require('../db/pool');
  const { rows } = await pool.query(
    'SELECT id, name, city, addresses, plan_number, status, developer, accurate_price_sqm FROM complexes WHERE id = $1',
    [complexId]
  );
  if (rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = rows[0];
  const mode = options.mode || 'standard';

  const result = (mode === 'fast') ? await fastEnrich(complex) : await standardEnrich(complex);

  if (Object.keys(result.fields).length > 0) {
    await saveEnrichedFields(complexId, result.fields);
  }

  return result;
}

/**
 * Dual scan for multiple complexes - FIXED v2.1: saves data to DB
 */
async function dualScanAll(options = {}) {
  const pool = require('../db/pool');
  const { limit = 20, city, staleOnly = true } = options;

  let query = `SELECT id, name, city, addresses, plan_number, status, developer, accurate_price_sqm FROM complexes WHERE 1=1`;
  const params = [];
  let idx = 1;

  if (city) { query += ` AND city = $${idx}`; params.push(city); idx++; }
  if (staleOnly) {
    query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '5 days')`;
  }
  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${idx}`;
  params.push(limit);

  const { rows: complexes } = await pool.query(query, params);
  const results = { total: complexes.length, scanned: 0, succeeded: 0, totalNewTx: 0, totalNewListings: 0, details: [] };

  logger.info(`[DUAL-AI] Starting scan of ${complexes.length} complexes`);

  for (const complex of complexes) {
    try {
      logger.info(`[DUAL-AI] Enriching: ${complex.name} (${complex.city}) [${results.scanned + 1}/${complexes.length}]`);
      const result = await standardEnrich(complex);
      results.scanned++;

      const fieldsFound = Object.keys(result.fields).length;
      if (fieldsFound > 0) {
        results.succeeded++;
        await saveEnrichedFields(complex.id, result.fields);
        logger.info(`[DUAL-AI] Saved ${fieldsFound} fields for ${complex.name}`);
      } else {
        logger.info(`[DUAL-AI] No fields found for ${complex.name}`);
      }

      results.details.push({ id: complex.id, name: complex.name, ...result });
      await new Promise(r => setTimeout(r, 3500));
    } catch (err) {
      logger.warn(`[DUAL-AI] Failed to enrich ${complex.name}: ${err.message}`);
      results.details.push({ id: complex.id, name: complex.name, error: err.message });
    }
  }

  logger.info(`[DUAL-AI] Scan complete: ${results.succeeded}/${results.total} enriched`);
  return results;
}

module.exports = {
  fastEnrich,
  standardEnrich,
  dualScanComplex,
  dualScanAll,
  isClaudeConfigured,
  isPerplexityConfigured,
  getAvailableModels,
  PERPLEXITY_MODEL_SCAN,
  CLAUDE_MODEL
};
