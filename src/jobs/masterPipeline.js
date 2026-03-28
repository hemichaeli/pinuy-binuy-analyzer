/**
 * QUANTUM Master Pipeline v1.0
 * ==============================
 * Full automated daily pipeline:
 *
 * PHASE 1 — SCAN ALL PLATFORMS (sequential, rate-limited)
 *   yad2 → yad1 → winwin → homeless → dira → komo → banknadlan → bidspirit → madlan → facebook
 *
 * PHASE 2 — STATUTORY ENRICHMENT (Perplexity + Gemini)
 *   For each complex with new/updated listings:
 *   - Committee status: ועדה מקומית, ועדה מחוזית, ועדה ארצית
 *   - TAMAL / תמ"ל status
 *   - Planning stage progression
 *   - Objections & hearings
 *   - Estimated realization timeline
 *
 * PHASE 3 — CLAUDE SYNTHESIS
 *   Claude synthesizes all enriched data per complex into:
 *   - Premium potential score (%)
 *   - Realization speed estimate (months)
 *   - Investment thesis summary (Hebrew)
 *   - Risk flags
 *
 * PHASE 4 — IAI RECALCULATION
 *   Recalculate IAI scores using enriched statutory + synthesis data
 *   → Final ranked list: highest premium × fastest realization
 *
 * Schedule: Daily at 06:00 Israel time (04:00 UTC)
 */

'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');
const { logger } = require('../services/logger');
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { logger.warn('[MasterPipeline] @anthropic-ai/sdk not installed — Claude synthesis disabled'); }

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PIPELINE_CRON = process.env.MASTER_PIPELINE_CRON || '0 6 * * *'; // 06:00 daily Israel time
const STATUTORY_BATCH_SIZE = parseInt(process.env.STATUTORY_BATCH_SIZE) || 30; // complexes per run
const SYNTHESIS_BATCH_SIZE = parseInt(process.env.SYNTHESIS_BATCH_SIZE) || 20;
const SLEEP_BETWEEN_SCRAPERS_MS = 3000;
const SLEEP_BETWEEN_ENRICHMENTS_MS = 1500;

let isRunning = false;
let lastResult = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PHASE 1: PLATFORM SCRAPERS ──────────────────────────────────────────────

const SCRAPER_SEQUENCE = [
  { name: 'yad2',       nameHe: 'יד2',          fn: () => require('../services/yad2Scraper').scanAll({ staleOnly: false }) },
  { name: 'yad1',       nameHe: 'יד1',          fn: () => require('../services/yad1Scraper').scanAll() },
  { name: 'winwin',     nameHe: 'WinWin',        fn: () => require('../services/winwinScraper').scanAll() },
  { name: 'homeless',   nameHe: 'Homeless',      fn: () => require('../services/homelessScraper').scanAll() },
  { name: 'dira',       nameHe: 'דירה',          fn: () => require('../services/diraScraper').scanAll() },
  { name: 'komo',       nameHe: 'Komo',          fn: () => require('../services/komoScraper').scanAll() },
  { name: 'banknadlan', nameHe: 'בנק נדלן',      fn: () => require('../services/bankNadlanScraper').scanAll() },
  { name: 'bidspirit',  nameHe: 'BidSpirit',     fn: () => require('../services/bidspiritScraper').scanAll() },
  { name: 'madlan',     nameHe: 'מדלן',          fn: () => require('../services/madlanService').scanAll().catch(() => require('../services/madlanService').fetchMarketData()) },
  { name: 'facebook',   nameHe: 'פייסבוק',       fn: () => require('../services/facebookGroupsScraper').scanAll().catch(() => ({ new: 0, updated: 0 })) },
];

async function runAllScrapers() {
  const results = {};
  let totalNew = 0, totalUpdated = 0;

  for (const scraper of SCRAPER_SEQUENCE) {
    try {
      logger.info(`[MasterPipeline] Scraping ${scraper.nameHe}...`);
      const r = await scraper.fn();
      const newCount = r.totalNew || r.new || r.found || r.count || 0;
      const updatedCount = r.totalUpdated || r.updated || 0;
      results[scraper.name] = { success: true, new: newCount, updated: updatedCount };
      totalNew += newCount;
      totalUpdated += updatedCount;
      logger.info(`[MasterPipeline] ${scraper.nameHe}: ${newCount} new, ${updatedCount} updated`);
    } catch (err) {
      results[scraper.name] = { success: false, error: err.message };
      logger.warn(`[MasterPipeline] ${scraper.nameHe} failed: ${err.message}`);
    }
    await sleep(SLEEP_BETWEEN_SCRAPERS_MS);
  }

  return { results, totalNew, totalUpdated };
}

// ─── PHASE 2: STATUTORY ENRICHMENT ───────────────────────────────────────────

/**
 * Build a comprehensive statutory enrichment query for Perplexity
 */
function buildStatutoryQuery(complex) {
  const name = complex.name || '';
  const city = complex.city || '';
  const addresses = complex.addresses || complex.address || '';

  return `חפש מידע סטטוטורי עדכני ומקיף על מתחם פינוי-בינוי "${name}" ב${city}.
כתובות: ${addresses}

החזר JSON בלבד עם המבנה הבא:

{
  "planning_status": {
    "current_stage": "before_declaration|declared|developer_selected|submitted|pre_deposit|deposited|approved|permit|construction|planning|unknown",
    "stage_details": "תיאור הסטטוס הנוכחי",
    "last_update_date": "YYYY-MM-DD או null",
    "plan_number": "מספר תכנית (תמ\"ל/תב\"ע) או null"
  },
  "local_committee": {
    "discussed": true/false,
    "decision": "approved|rejected|pending|unknown",
    "decision_date": "YYYY-MM-DD או null",
    "next_hearing_date": "YYYY-MM-DD או null",
    "notes": "פרטים על הדיון"
  },
  "district_committee": {
    "discussed": true/false,
    "decision": "approved|rejected|pending|unknown",
    "decision_date": "YYYY-MM-DD או null",
    "next_hearing_date": "YYYY-MM-DD או null",
    "notes": "פרטים על הדיון"
  },
  "national_committee": {
    "is_tamal": true/false,
    "discussed": true/false,
    "decision": "approved|rejected|pending|unknown",
    "decision_date": "YYYY-MM-DD או null",
    "notes": "פרטים - האם זה תמ\"ל? מה הסטטוס?"
  },
  "vatmal": {
    "is_vatmal": true/false,
    "plan_number": "מספר תכנית ות\"מל או null",
    "status": "not_submitted|submitted|in_review|approved|rejected|unknown",
    "submission_date": "YYYY-MM-DD או null",
    "approval_date": "YYYY-MM-DD או null",
    "next_hearing_date": "YYYY-MM-DD או null",
    "committee_sessions": 0,
    "objections_filed": true/false,
    "notes": "פרטים על הדיון בות\"מל (הוועדה לתכנון מתחמים מועדפים לדיור)"
  },
  "objections": {
    "filed": true/false,
    "count": 0,
    "status": "pending|resolved|rejected|unknown",
    "details": "פרטים על התנגדויות"
  },
  "realization_timeline": {
    "estimated_months_to_permit": 0,
    "estimated_months_to_construction": 0,
    "blocking_factors": ["רשימת גורמים מעכבים"],
    "accelerating_factors": ["רשימת גורמים מזרזים"]
  },
  "premium_potential": {
    "estimated_premium_pct": 0,
    "basis": "הסבר קצר לבסיס האומדן"
  },
  "confidence": "high|medium|low",
  "sources": ["מקורות המידע"]
}

חפש ב: mavat.moin.gov.il, iplan.gov.il, tamar.gov.il, vatmal.gov.il, globes.co.il, calcalist.co.il, themarker.com, ynet.co.il
שים לב: ות\"מל = הוועדה לתכנון מתחמים מועדפים לדיור (שונה מתמ\"ל). חפש אם המתחם מקודם על ידי ות\"מל.
החזר JSON בלבד.`;
}

/**
 * Enrich a single complex with statutory data via Perplexity
 */
async function enrichComplexStatutory(complex) {
  try {
    const perplexityService = require('../services/perplexityService');
    const query = buildStatutoryQuery(complex);
    const systemPrompt = `You are an expert in Israeli urban renewal (פינוי-בינוי) planning law and statutory processes.
Return ONLY valid JSON. Search Hebrew sources for accurate data about planning committees, TAMAL status, and project timelines.
Be precise. Use null for unknown values. All dates in YYYY-MM-DD format.`;

    const rawResponse = await perplexityService.queryPerplexity(query, systemPrompt);
    if (!rawResponse) return null;

    // Parse JSON from response
    let data = null;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) data = JSON.parse(jsonMatch[0]);
    } catch (e) {
      logger.warn(`[Statutory] JSON parse failed for ${complex.name}: ${e.message}`);
      return null;
    }

    if (!data) return null;

    // Store statutory data in DB
    await storeStatutoryData(complex.id, data);
    return data;

  } catch (err) {
    logger.warn(`[Statutory] Perplexity failed for ${complex.name}, trying Gemini: ${err.message}`);
    return await enrichComplexStatutoryGemini(complex);
  }
}

/**
 * Fallback: Gemini enrichment for statutory data
 */
async function enrichComplexStatutoryGemini(complex) {
  try {
    const geminiService = require('../services/geminiEnrichmentService');
    const query = buildStatutoryQuery(complex);
    const rawResponse = await geminiService.queryGemini(query, 
      'Return ONLY valid JSON about Israeli urban renewal planning status. No explanations.',
      true // useGrounding = true for web search
    );
    if (!rawResponse) return null;

    let data = null;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) data = JSON.parse(jsonMatch[0]);
    } catch (e) { return null; }

    if (data) await storeStatutoryData(complex.id, data);
    return data;
  } catch (err) {
    logger.warn(`[Statutory] Gemini also failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Store statutory enrichment data in DB
 */
async function storeStatutoryData(complexId, data) {
  const updates = [];
  const params = [];
  let idx = 1;

  // Planning status
  if (data.planning_status?.current_stage && data.planning_status.current_stage !== 'unknown') {
    const stageMap = {
      'before_declaration': 'before_declaration', 'declared': 'declared',
      'developer_selected': 'developer_selected', 'submitted': 'submitted',
      'pre_deposit': 'pre_deposit', 'deposited': 'deposited',
      'approved': 'approved', 'permit': 'permit', 'construction': 'construction',
      'planning': 'planning'
    };
    const stage = stageMap[data.planning_status.current_stage];
    if (stage) { updates.push(`status = $${idx++}`); params.push(stage); }
  }

  // Local committee
  if (data.local_committee?.decision_date) {
    updates.push(`local_committee_date = $${idx++}`);
    params.push(data.local_committee.decision_date);
  }
  if (data.local_committee?.decision) {
    updates.push(`local_committee_status = $${idx++}`);
    params.push(data.local_committee.decision);
  }

  // District committee
  if (data.district_committee?.decision_date) {
    updates.push(`district_committee_date = $${idx++}`);
    params.push(data.district_committee.decision_date);
  }
  if (data.district_committee?.decision) {
    updates.push(`district_committee_status = $${idx++}`);
    params.push(data.district_committee.decision);
  }

  // TAMAL / national committee
  if (data.national_committee?.is_tamal !== undefined) {
    updates.push(`is_tamal = $${idx++}`);
    params.push(!!data.national_committee.is_tamal);
  }

  // VATMAL (ות"מל — הוועדה לתכנון מתחמים מועדפים לדיור)
  if (data.vatmal) {
    if (data.vatmal.is_vatmal !== undefined) {
      updates.push(`is_vatmal = $${idx++}`);
      params.push(!!data.vatmal.is_vatmal);
    }
    if (data.vatmal.status && data.vatmal.status !== 'unknown') {
      updates.push(`vatmal_status = $${idx++}`);
      params.push(data.vatmal.status);
    }
    if (data.vatmal.plan_number) {
      updates.push(`vatmal_plan_number = $${idx++}`);
      params.push(data.vatmal.plan_number);
    }
    if (data.vatmal.submission_date) {
      updates.push(`vatmal_submission_date = $${idx++}`);
      params.push(data.vatmal.submission_date);
    }
    if (data.vatmal.approval_date) {
      updates.push(`vatmal_approval_date = $${idx++}`);
      params.push(data.vatmal.approval_date);
    }
    if (data.vatmal.next_hearing_date) {
      updates.push(`vatmal_next_hearing = $${idx++}`);
      params.push(data.vatmal.next_hearing_date);
    }
    if (data.vatmal.notes) {
      updates.push(`vatmal_notes = $${idx++}`);
      params.push(data.vatmal.notes);
    }
  }

  // Realization timeline
  if (data.realization_timeline?.estimated_months_to_permit) {
    updates.push(`estimated_months_to_permit = $${idx++}`);
    params.push(parseInt(data.realization_timeline.estimated_months_to_permit) || null);
  }
  if (data.realization_timeline?.estimated_months_to_construction) {
    updates.push(`estimated_months_to_construction = $${idx++}`);
    params.push(parseInt(data.realization_timeline.estimated_months_to_construction) || null);
  }

  // Premium potential
  if (data.premium_potential?.estimated_premium_pct) {
    const pct = parseFloat(data.premium_potential.estimated_premium_pct);
    if (!isNaN(pct) && pct > 0) {
      updates.push(`statutory_premium_estimate = $${idx++}`);
      params.push(pct);
    }
  }

  // Store full statutory JSON
  updates.push(`statutory_data = $${idx++}`);
  params.push(JSON.stringify(data));
  updates.push(`statutory_enriched_at = NOW()`);

  if (updates.length > 0) {
    params.push(complexId);
    await pool.query(
      `UPDATE complexes SET ${updates.join(', ')} WHERE id = $${idx}`,
      params
    ).catch(async (err) => {
      // If column doesn't exist, run migration first
      if (err.message.includes('column') && err.message.includes('does not exist')) {
        await runStatutoryMigrations();
        await pool.query(`UPDATE complexes SET ${updates.join(', ')} WHERE id = $${idx}`, params);
      } else {
        throw err;
      }
    });
  }
}

/**
 * Add statutory columns to complexes table if they don't exist
 */
async function runStatutoryMigrations() {
  const migrations = [
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS local_committee_status VARCHAR(50)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS district_committee_status VARCHAR(50)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_tamal BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS estimated_months_to_permit INTEGER`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS estimated_months_to_construction INTEGER`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS statutory_premium_estimate NUMERIC(5,2)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS statutory_data JSONB`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS statutory_enriched_at TIMESTAMPTZ`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS claude_synthesis TEXT`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS synthesis_updated_at TIMESTAMPTZ`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS premium_potential_score NUMERIC(5,2)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS realization_speed_score INTEGER`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS investment_rank INTEGER`,
    // VATMAL columns
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_vatmal BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_status VARCHAR(50)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_plan_number VARCHAR(100)`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_submission_date DATE`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_approval_date DATE`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_next_hearing DATE`,
    `ALTER TABLE complexes ADD COLUMN IF NOT EXISTS vatmal_notes TEXT`,
  ];

  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { /* ignore if already exists */ }
  }
  logger.info('[MasterPipeline] Statutory migrations applied');
}

/**
 * Run statutory enrichment for top-priority complexes
 */
async function runStatutoryEnrichment() {
  // Prioritize: complexes with new listings OR not enriched in last 7 days, ordered by IAI score
  const { rows: complexes } = await pool.query(`
    SELECT c.id, c.name, c.city, c.addresses, c.address, c.status, c.iai_score,
           c.statutory_enriched_at
    FROM complexes c
    WHERE c.status NOT IN ('construction') -- skip already built
      AND (c.statutory_enriched_at IS NULL 
           OR c.statutory_enriched_at < NOW() - INTERVAL '7 days'
           OR c.iai_score > 60)
    ORDER BY c.iai_score DESC NULLS LAST, c.statutory_enriched_at ASC NULLS FIRST
    LIMIT $1
  `, [STATUTORY_BATCH_SIZE]);

  logger.info(`[MasterPipeline] Statutory enrichment: ${complexes.length} complexes to process`);

  let enriched = 0, failed = 0;
  for (const complex of complexes) {
    const result = await enrichComplexStatutory(complex);
    if (result) enriched++;
    else failed++;
    await sleep(SLEEP_BETWEEN_ENRICHMENTS_MS);
  }

  return { enriched, failed, total: complexes.length };
}

// ─── PHASE 3: CLAUDE SYNTHESIS ───────────────────────────────────────────────

/**
 * Build synthesis prompt for Claude
 */
function buildSynthesisPrompt(complex) {
  const statutory = complex.statutory_data || {};
  const localCommittee = complex.local_committee_date ? `אושר בוועדה מקומית: ${complex.local_committee_date}` : 'לא אושר עדיין בוועדה מקומית';
  const districtCommittee = complex.district_committee_date ? `אושר בוועדה מחוזית: ${complex.district_committee_date}` : 'לא אושר עדיין בוועדה מחוזית';
  const tamal = complex.is_tamal ? 'כן — תמ"ל (תכנית מתאר ארצית לדיור)' : 'לא';
  const vatmal = complex.is_vatmal 
    ? `כן — ות"מל | סטטוס: ${complex.vatmal_status || 'לא ידוע'}${complex.vatmal_plan_number ? ' | תכנית: ' + complex.vatmal_plan_number : ''}${complex.vatmal_next_hearing ? ' | דיון הבא: ' + complex.vatmal_next_hearing : ''}`
    : 'לא';
  const monthsToPermit = complex.estimated_months_to_permit ? `${complex.estimated_months_to_permit} חודשים` : 'לא ידוע';
  const monthsToConstruction = complex.estimated_months_to_construction ? `${complex.estimated_months_to_construction} חודשים` : 'לא ידוע';

  return `אתה אנליסט נדל"ן מומחה בפינוי-בינוי. נתח את המתחם הבא וספק המלצת השקעה מפורטת.

## מתחם: ${complex.name} — ${complex.city}
**סטטוס תכנוני:** ${complex.status || 'לא ידוע'}
**ציון IAI נוכחי:** ${complex.iai_score || 'לא חושב'}
**פרמיה בפועל:** ${complex.actual_premium ? complex.actual_premium + '%' : 'לא ידוע'}
**פרמיה תיאורטית (סטטוטורי):** ${complex.statutory_premium_estimate ? complex.statutory_premium_estimate + '%' : 'לא ידוע'}

## סטטוס ועדות:
- ${localCommittee}
- ${districtCommittee}
- **תמ"ל:** ${tamal}
- **ות"מל:** ${vatmal}

## ציר זמן מוערך:
- עד היתר בנייה: ${monthsToPermit}
- עד תחילת בנייה: ${monthsToConstruction}

## נתוני שוק:
- מחיר ממוצע למ"ר: ${complex.city_avg_price_sqm ? '₪' + parseInt(complex.city_avg_price_sqm).toLocaleString('he-IL') : 'לא ידוע'}
- מחיר נוכחי למ"ר: ${complex.price_per_sqm ? '₪' + parseInt(complex.price_per_sqm).toLocaleString('he-IL') : 'לא ידוע'}
- יחידות מתוכננות: ${complex.planned_units || 'לא ידוע'}
- יחידות קיימות: ${complex.existing_units || 'לא ידוע'}
- אחוז חתימות: ${complex.signature_percent ? complex.signature_percent + '%' : 'לא ידוע'}

## מידע סטטוטורי נוסף:
${JSON.stringify(statutory, null, 2).slice(0, 1500)}

---
ספק ניתוח בפורמט JSON בלבד:
{
  "investment_thesis": "תיאור קצר (2-3 משפטים) של הזדמנות ההשקעה בעברית",
  "premium_potential_score": 0-100,
  "premium_potential_pct": 0,
  "realization_speed_score": 0-100,
  "estimated_months_to_realization": 0,
  "key_catalysts": ["זרז 1", "זרז 2"],
  "key_risks": ["סיכון 1", "סיכון 2"],
  "recommendation": "buy_now|watch|hold|avoid",
  "recommendation_reason": "הסבר קצר",
  "confidence": "high|medium|low"
}`;
}

/**
 * Synthesize a single complex using Claude
 */
async function synthesizeComplex(complex) {
  try {
    if (!Anthropic) throw new Error('@anthropic-ai/sdk not installed');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const client = new Anthropic({ apiKey });
    const prompt = buildSynthesisPrompt(complex);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content[0]?.text || '';
    let data = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) data = JSON.parse(jsonMatch[0]);
    } catch (e) {
      logger.warn(`[Synthesis] JSON parse failed for ${complex.name}`);
      return null;
    }

    if (!data) return null;

    // Store synthesis results
    await pool.query(`
      UPDATE complexes SET
        claude_synthesis = $1,
        synthesis_updated_at = NOW(),
        premium_potential_score = $2,
        realization_speed_score = $3,
        estimated_months_to_construction = COALESCE($4, estimated_months_to_construction)
      WHERE id = $5
    `, [
      JSON.stringify(data),
      parseFloat(data.premium_potential_score) || null,
      parseInt(data.realization_speed_score) || null,
      parseInt(data.estimated_months_to_realization) || null,
      complex.id
    ]);

    return data;
  } catch (err) {
    logger.warn(`[Synthesis] Claude failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Run Claude synthesis for top complexes
 */
async function runClaudeSynthesis() {
  const { rows: complexes } = await pool.query(`
    SELECT c.id, c.name, c.city, c.status, c.iai_score,
           c.actual_premium, c.statutory_premium_estimate,
           c.city_avg_price_sqm, c.price_per_sqm,
           c.planned_units, c.existing_units, c.signature_percent,
           c.local_committee_date, c.district_committee_date,
           c.is_tamal, c.is_vatmal, c.vatmal_status, c.vatmal_plan_number, c.vatmal_next_hearing,
           c.estimated_months_to_permit, c.estimated_months_to_construction,
           c.statutory_data
    FROM complexes c
    WHERE c.statutory_enriched_at IS NOT NULL
      AND (c.synthesis_updated_at IS NULL 
           OR c.synthesis_updated_at < NOW() - INTERVAL '3 days')
      AND c.status NOT IN ('construction')
    ORDER BY c.iai_score DESC NULLS LAST
    LIMIT $1
  `, [SYNTHESIS_BATCH_SIZE]);

  logger.info(`[MasterPipeline] Claude synthesis: ${complexes.length} complexes to process`);

  let synthesized = 0, failed = 0;
  for (const complex of complexes) {
    const result = await synthesizeComplex(complex);
    if (result) synthesized++;
    else failed++;
    await sleep(2000); // Rate limit Claude API
  }

  return { synthesized, failed, total: complexes.length };
}

// ─── PHASE 4: IAI RECALCULATION + INVESTMENT RANKING ─────────────────────────

async function runIAIAndRanking() {
  try {
    const { calculateAllIAI } = require('../services/iaiCalculator');
    await calculateAllIAI();

    // Compute investment_rank: composite of IAI + premium_potential_score + realization_speed_score
    await pool.query(`
      UPDATE complexes SET investment_rank = ranked.rank
      FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            ORDER BY 
              (COALESCE(iai_score, 0) * 0.4 + 
               COALESCE(premium_potential_score, 0) * 0.35 + 
               COALESCE(realization_speed_score, 0) * 0.25) DESC
          ) AS rank
        FROM complexes
        WHERE status NOT IN ('construction')
      ) ranked
      WHERE complexes.id = ranked.id
    `);

    logger.info('[MasterPipeline] IAI recalculated and investment ranking updated');
    return { success: true };
  } catch (err) {
    logger.warn(`[MasterPipeline] IAI/ranking failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── PHASE 1c: LINK UNLINKED LISTINGS TO COMPLEXES BY ADDRESS ──────────────────────────────

/**
 * For every listing without a complex_id (yad1, dira, komo, winwin, etc.),
 * try to match it to a complex by comparing the listing's city+address against
 * each complex's city + addresses field (comma-separated street names).
 *
 * Match logic:
 *   1. City must match (case-insensitive)
 *   2. At least one street token from complex.addresses appears in listing.address
 *
 * Listings that match → UPDATE complex_id
 * Listings that don’t match any complex → DELETE (they are irrelevant to pinuy-binuy)
 */
async function linkListingsToComplexes() {
  // Load all complexes with their addresses
  const complexesResult = await pool.query(
    `SELECT id, city, addresses FROM complexes WHERE addresses IS NOT NULL AND addresses != ''`
  );
  const complexes = complexesResult.rows;

  // Build a lookup: city (lowercase) → array of { id, streetTokens[] }
  const cityMap = {};
  for (const c of complexes) {
    const cityKey = (c.city || '').trim().toLowerCase();
    if (!cityKey) continue;
    const streets = (c.addresses || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (streets.length === 0) continue;
    if (!cityMap[cityKey]) cityMap[cityKey] = [];
    cityMap[cityKey].push({ id: c.id, streets });
  }

  // Load all active listings without complex_id (non-yad2 sources)
  const listingsResult = await pool.query(
    `SELECT id, city, address FROM listings
     WHERE complex_id IS NULL AND is_active = TRUE AND source != 'yad2'
     LIMIT 5000`
  );
  const listings = listingsResult.rows;

  let linked = 0;
  let deleted = 0;
  const toLink = [];   // { listingId, complexId }
  const toDelete = []; // listingId[]

  for (const listing of listings) {
    const cityKey = (listing.city || '').trim().toLowerCase();
    const addrLower = (listing.address || '').trim().toLowerCase();
    const candidates = cityMap[cityKey] || [];

    let matched = null;
    for (const candidate of candidates) {
      // Check if any street token appears in the listing address
      const hit = candidate.streets.some(street => {
        // Extract just the street name (first word or two) for fuzzy matching
        const streetTokens = street.split(' ').filter(Boolean);
        // At least the first meaningful token must appear
        const mainToken = streetTokens.find(t => t.length > 2);
        return mainToken && addrLower.includes(mainToken);
      });
      if (hit) { matched = candidate.id; break; }
    }

    if (matched) {
      toLink.push({ listingId: listing.id, complexId: matched });
    } else {
      toDelete.push(listing.id);
    }
  }

  // Batch UPDATE linked listings
  for (const { listingId, complexId } of toLink) {
    try {
      await pool.query(`UPDATE listings SET complex_id = $1 WHERE id = $2`, [complexId, listingId]);
      linked++;
    } catch (e) { /* skip */ }
  }

  // Batch DELETE unmatched listings (irrelevant to pinuy-binuy)
  if (toDelete.length > 0) {
    await pool.query(
      `DELETE FROM listings WHERE id = ANY($1::int[])`,
      [toDelete]
    );
    deleted = toDelete.length;
  }

  logger.info(`[Phase1c] Linked ${linked} listings to complexes, deleted ${deleted} unmatched`);
  return { linked, deleted, total: listings.length };
}

// ─── MAIN PIPELINE ORCHESTRATOR ────────────────────────────────────────────────

async function runMasterPipeline(options = {}) {
  if (isRunning) {
    logger.warn('[MasterPipeline] Already running, skipping');
    return null;
  }
  isRunning = true;
  const startTime = Date.now();
  logger.info('[MasterPipeline] ===== STARTING MASTER PIPELINE =====');

  const result = {
    started_at: new Date().toISOString(),
    phase1_scrapers: null,
    phase1b_phones: null,
    phase2_statutory: null,
    phase3_synthesis: null,
    phase4_iai: null,
    duration_ms: 0,
    completed_at: null
  };

  try {
    // Ensure DB columns exist
    await runStatutoryMigrations();

    // Log pipeline start
    const { rows: [log] } = await pool.query(
      `INSERT INTO scan_logs (scan_type, status, started_at) VALUES ('master_pipeline', 'running', NOW()) RETURNING id`
    );
    const logId = log.id;

    // ── PHASE 1: Scrape all platforms ──────────────────────────────────────
    logger.info('[MasterPipeline] PHASE 1: Scraping all platforms...');
    result.phase1_scrapers = await runAllScrapers();
    logger.info(`[MasterPipeline] PHASE 1 complete: ${result.phase1_scrapers.totalNew} new, ${result.phase1_scrapers.totalUpdated} updated`);

    // ── PHASE 1b: Phone reveal (unified orchestrator — all platforms) ─────
    logger.info('[MasterPipeline] PHASE 1b: Revealing phone numbers (v2 orchestrator)...');
    try {
      const { enrichAllPhones } = require('../services/phoneRevealOrchestrator');
      result.phase1b_phones = await enrichAllPhones({ limit: 1000, useApify: !!process.env.APIFY_API_TOKEN });
      const coverage = result.phase1b_phones.total > 0
        ? ((result.phase1b_phones.enriched / result.phase1b_phones.total) * 100).toFixed(1)
        : '0';
      logger.info(`[MasterPipeline] PHASE 1b complete: ${result.phase1b_phones.enriched}/${result.phase1b_phones.total} (${coverage}%) phones revealed`);
    } catch (phoneErr) {
      logger.warn(`[MasterPipeline] PHASE 1b phone reveal failed (non-fatal): ${phoneErr.message}`);
      result.phase1b_phones = { enriched: 0, total: 0, error: phoneErr.message };
    }

    // ── PHASE 1c: Link unlinked listings to complexes by address ──────────
    logger.info('[MasterPipeline] PHASE 1c: Linking listings to complexes by address...');
    try {
      result.phase1c_linking = await linkListingsToComplexes();
      logger.info(`[MasterPipeline] PHASE 1c complete: ${result.phase1c_linking.linked} linked, ${result.phase1c_linking.deleted} unmatched deleted`);
    } catch (linkErr) {
      logger.warn(`[MasterPipeline] PHASE 1c linking failed (non-fatal): ${linkErr.message}`);
      result.phase1c_linking = { linked: 0, deleted: 0, error: linkErr.message };
    }

    // ── PHASE 2: Statutory enrichment (Perplexity + Gemini) ───────────────
    logger.info('[MasterPipeline] PHASE 2: Statutory enrichment...');
    result.phase2_statutory = await runStatutoryEnrichment();
    logger.info(`[MasterPipeline] PHASE 2 complete: ${result.phase2_statutory.enriched} enriched, ${result.phase2_statutory.failed} failed`);

    // ── PHASE 3: Claude synthesis ──────────────────────────────────────────
    logger.info('[MasterPipeline] PHASE 3: Claude synthesis...');
    result.phase3_synthesis = await runClaudeSynthesis();
    logger.info(`[MasterPipeline] PHASE 3 complete: ${result.phase3_synthesis.synthesized} synthesized`);

    // ── PHASE 4: IAI recalculation + investment ranking ────────────────────
    logger.info('[MasterPipeline] PHASE 4: IAI recalculation + ranking...');
    result.phase4_iai = await runIAIAndRanking();
    logger.info('[MasterPipeline] PHASE 4 complete');

    // ── PHASE 4b: SSI recalculation for all active listings ─────────────────
    logger.info('[MasterPipeline] PHASE 4b: Recalculating SSI scores...');
    try {
      const { calculateAllSSI } = require('../services/ssiCalculator');
      const ssiResult = await calculateAllSSI();
      result.phase4b_ssi = ssiResult;
      logger.info(`[MasterPipeline] PHASE 4b complete: ${ssiResult.updated}/${ssiResult.total} SSI scores updated, ${ssiResult.highStress} high-stress`);
    } catch (ssiErr) {
      logger.warn(`[MasterPipeline] PHASE 4b SSI failed (non-fatal): ${ssiErr.message}`);
      result.phase4b_ssi = { updated: 0, total: 0, error: ssiErr.message };
    }

    result.duration_ms = Date.now() - startTime;
    result.completed_at = new Date().toISOString();

    const summary = `Pipeline complete in ${Math.round(result.duration_ms / 1000)}s: ` +
      `${result.phase1_scrapers.totalNew} new listings | ` +
      `${(result.phase1b_phones||{}).enriched||0} phones revealed | ` +
      `${(result.phase1c_linking||{}).linked||0} linked to complexes | ` +
      `${result.phase2_statutory.enriched} statutory enriched | ` +
      `${result.phase3_synthesis.synthesized} synthesized | ` +
      `${(result.phase4b_ssi||{}).updated||0} SSI scored`;

    await pool.query(
      `UPDATE scan_logs SET status = 'completed', completed_at = NOW(), summary = $1 WHERE id = $2`,
      [summary, logId]
    );

    logger.info(`[MasterPipeline] ===== COMPLETE: ${summary} =====`);
    lastResult = result;
    return result;

  } catch (err) {
    logger.error('[MasterPipeline] Pipeline failed:', err);
    result.error = err.message;
    result.duration_ms = Date.now() - startTime;
    return result;
  } finally {
    isRunning = false;
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

let scheduledTask = null;

function startScheduler() {
  if (scheduledTask) return;

  scheduledTask = cron.schedule(PIPELINE_CRON, async () => {
    logger.info(`[MasterPipeline] Cron triggered: ${new Date().toISOString()}`);
    try {
      await runMasterPipeline();
    } catch (err) {
      logger.error('[MasterPipeline] Cron error:', err);
    }
  }, {
    timezone: 'Asia/Jerusalem'
  });

  logger.info(`[MasterPipeline] Scheduler started — cron: ${PIPELINE_CRON} (Asia/Jerusalem)`);
}

function getStatus() {
  return {
    isRunning,
    lastResult,
    cron: PIPELINE_CRON,
    nextRun: '06:00 Israel time daily'
  };
}

module.exports = {
  runMasterPipeline,
  startScheduler,
  getStatus,
  runStatutoryMigrations,
  runAllScrapers,
  runStatutoryEnrichment,
  runClaudeSynthesis,
  runIAIAndRanking
};
