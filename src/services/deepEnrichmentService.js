const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Deep Enrichment Service v3.0 - TRUE DUAL ENGINE
 * 
 * Architecture:
 *   ENGINE A - Perplexity sonar-pro (Phases 1-4): Focused web research queries
 *   ENGINE B - Claude Sonnet 4.5 + web_search (Phases 5-6): Independent deep research
 *   SYNTHESIS - Claude Opus 4.6 (Phase 7): Cross-validates & synthesizes BOTH engines
 *   DATA      - nadlan.gov.il (Phase 8): Actual transaction prices (overrides estimates)
 *   CALC      - City average (Phase 9): From DB transactions
 * 
 * Both research engines work INDEPENDENTLY on the same complex.
 * Opus 4.6 receives ALL outputs and produces a unified, cross-validated result.
 * 
 * v3.0: Both engines research independently, Opus 4.6 synthesizes
 * v2.0: Perplexity researched, Sonnet synthesized
 * v1.x: Perplexity-only with basic sonar
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_RESEARCH_MODEL = 'claude-sonnet-4-5-20250929';
const CLAUDE_SYNTHESIS_MODEL = 'claude-opus-4-6';
const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const DELAY_MS = 8000;
const CLAUDE_DELAY_MS = 30000;  // 30s between Claude phases to avoid rate limits
const BETWEEN_COMPLEX_MS = 15000;  // 15s between complexes
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 30000;  // 30s base backoff for rate limits

const batchJobs = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getBatchStatus(jobId) {
  return batchJobs[jobId] || null;
}

function getAllBatchJobs() {
  return Object.entries(batchJobs).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    progress: `${job.enriched}/${job.total}`,
    fieldsUpdated: job.totalFieldsUpdated,
    errors: job.errors,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    engine: 'v3.0: sonar-pro + sonnet-4.5-research + opus-4.6-synthesis'
  }));
}

// ============================================================
// ENGINE A: Perplexity sonar-pro - Web Research
// ============================================================
async function queryPerplexity(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  try {
    const response = await axios.post(PERPLEXITY_API_URL, {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000,
      search_recency_filter: 'year'
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 90000
    });

    return response.data.choices[0].message.content;
  } catch (err) {
    if (err.response && err.response.status === 429 && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Perplexity rate limited (429), retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryPerplexity(prompt, systemPrompt, retryCount + 1);
    }
    throw err;
  }
}

// ============================================================
// ENGINE B: Claude Sonnet 4.5 + Web Search - Independent Research
// ============================================================
async function queryClaudeResearch(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  try {
    const response = await axios.post(ANTHROPIC_API_URL, {
      model: CLAUDE_RESEARCH_MODEL,
      max_tokens: 16000,
      system: systemPrompt,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ],
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 180000
    });

    const content = response.data.content;
    if (Array.isArray(content)) {
      return content.map(block => block.text || '').filter(Boolean).join('\n');
    }
    return content;
  } catch (err) {
    if (err.response && (err.response.status === 429 || err.response.status === 529) && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Claude Research rate limited, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryClaudeResearch(prompt, systemPrompt, retryCount + 1);
    }
    if (err.response) {
      logger.error(`Claude Research API error ${err.response.status}`, { 
        status: err.response.status, 
        data: JSON.stringify(err.response.data).substring(0, 500) 
      });
    }
    throw err;
  }
}

// ============================================================
// SYNTHESIS: Claude Opus 4.6 (No web search, pure reasoning)
// ============================================================
async function queryClaudeSynthesis(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  try {
    const response = await axios.post(ANTHROPIC_API_URL, {
      model: CLAUDE_SYNTHESIS_MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 180000
    });

    const content = response.data.content;
    if (Array.isArray(content)) {
      return content.map(block => block.text || '').filter(Boolean).join('\n');
    }
    return content;
  } catch (err) {
    if (err.response && (err.response.status === 429 || err.response.status === 529) && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Opus Synthesis rate limited, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryClaudeSynthesis(prompt, systemPrompt, retryCount + 1);
    }
    if (err.response) {
      logger.error(`Opus Synthesis API error ${err.response.status}`, { 
        status: err.response.status, 
        data: JSON.stringify(err.response.data).substring(0, 500) 
      });
    }
    throw err;
  }
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch(e) {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) try { return JSON.parse(m[1].trim()); } catch(e) {}
  const o = text.match(/\{[\s\S]*\}/);
  if (o) try { return JSON.parse(o[0]); } catch(e) {}
  return null;
}

// ============================================================
// ENGINE A PROMPTS: Perplexity sonar-pro (Phases 1-4)
// ============================================================

const PERPLEXITY_SYSTEM = `You are an expert Israeli real estate researcher specializing in Pinuy-Binuy (urban renewal) projects.
Return ONLY valid JSON. No explanations, no markdown, no text outside JSON.
If you don't have data, use null (not "null" string). Numbers as numbers, not strings.
All prices in ILS. Search Hebrew AND English sources for maximum accuracy.
IMPORTANT: Do not invent data. If unsure, use null. Prefer specific data over estimates.
When searching, cross-reference multiple sources to verify facts.`;

function buildAddressQuery(complex) {
  return `Search for precise information about Pinuy-Binuy complex "${complex.name}" in ${complex.city}.
Known addresses: ${complex.addresses || 'unknown'}
Plan number: ${complex.plan_number || 'unknown'}
Developer: ${complex.developer || 'unknown'}

Search multiple sources and return precise JSON:
{
  "precise_addresses": [
    {"street": "street name", "building_numbers": [1,3,5], "num_units": 12}
  ],
  "neighborhood": "neighborhood name",
  "num_buildings": 0,
  "total_existing_units": 0,
  "area_dunam": 0,
  "signature_percent": null,
  "plan_stage": "plan stage (declared/deposited/approved/permit/construction)",
  "permit_expected": "YYYY-MM-DD or null",
  "objections_count": 0,
  "has_objections": false,
  "objections_status": "brief description or null",
  "sources_checked": ["list of sources checked"]
}

Search in: mavat.iplan.gov.il, dira.moch.gov.il, ${complex.city} municipality, globes, calcalist, themarker, madlan.co.il
Return JSON only without additional text.`;
}

function buildDeveloperQuery(complex) {
  return `Search for comprehensive information about "${complex.developer}" (real estate developer in Israel).
Check all following sources and return full picture:

{
  "company_number": "company registration number or null",
  "developer_status": "active/troubled/dissolved/unknown",
  "risk_level": "low/medium/high",
  "risk_score": 0,
  "reputation_score": 0,
  "red_flags": ["list of red flags if any"],
  "active_projects_count": 0,
  "completed_projects_count": 0,
  "news_sentiment": "positive/neutral/negative/mixed",
  "recent_news": "summary of recent news about the company",
  "financial_stability": "stable/concerning/critical/unknown",
  "years_in_business": 0,
  "notable_projects": ["notable project names"],
  "sources_checked": ["list of sources"]
}

Search in: Companies Registrar, globes.co.il, calcalist.co.il, themarker.com, madlan.co.il
Return JSON only.`;
}

function buildPricingQuery(complex) {
  const addr = complex.addresses || complex.name;
  return `Search for current real estate prices in the area of "${addr}" in ${complex.city}.
Neighborhood: ${complex.neighborhood || 'unknown'}
Developer: ${complex.developer || 'unknown'}

Search for real transactions, not estimates. Priority for prices from nadlan.gov.il and madlan.co.il.

{
  "avg_price_sqm_old_buildings": 0,
  "avg_price_sqm_new_buildings": 0,
  "city_avg_price_sqm": 0,
  "price_trend": "rising/stable/falling",
  "yearly_price_change_percent": 0,
  "comparable_new_projects": [
    {"name": "name", "price_per_sqm": 0, "developer": "developer"}
  ],
  "estimated_new_price_sqm": 0,
  "estimated_old_price_sqm": 0,
  "actual_premium_percent": 0,
  "premium_calculation": "premium calculation explanation",
  "recent_transactions": [
    {"date": "YYYY-MM", "price": 0, "area_sqm": 0, "price_per_sqm": 0}
  ],
  "data_freshness": "YYYY-MM",
  "sources_checked": ["list of sources"]
}

Premium = (new_price - old_price) / old_price * 100
Search in: nadlan.gov.il, madlan.co.il, yad2.co.il, homegate.co.il
Return JSON only.`;
}

function buildNewsQuery(complex) {
  return `Search for news and legal information about Pinuy-Binuy complex "${complex.name}" in ${complex.city}.
Developer: ${complex.developer || 'unknown'}

Search in the last 12 months. Also check legal proceedings, receiverships, and lawsuits.

{
  "has_negative_news": false,
  "news_sentiment": "positive/neutral/negative/mixed",
  "news_summary": "comprehensive news summary",
  "key_events": [
    {"date": "YYYY-MM-DD", "event": "description", "source": "source", "impact": "positive/negative/neutral"}
  ],
  "enforcement_cases": false,
  "bankruptcy_proceedings": false,
  "property_liens": false,
  "receivership": false,
  "inheritance_property": false,
  "court_cases": [],
  "municipal_approvals": [],
  "community_sentiment": "supportive/opposed/mixed/unknown",
  "sources_checked": ["list of sources"]
}

Search in: globes, calcalist, themarker, ynet, mako, courts, psakdin, nevo
Return JSON only.`;
}

// ============================================================
// ENGINE B PROMPTS: Claude Sonnet 4.5 + Web Search (Phases 5-6)
// ============================================================

const CLAUDE_RESEARCH_SYSTEM = `You are an elite Israeli real estate intelligence analyst for QUANTUM.
Your specialty: Pinuy-Binuy (urban renewal) projects in Israel.

CRITICAL INSTRUCTIONS:
1. Use your web_search tool to find real, current information. Search in BOTH Hebrew and English.
2. Search multiple times with different queries to get comprehensive data.
3. Cross-reference findings across sources.
4. Return ONLY valid JSON - no markdown, no explanations outside JSON.
5. If you cannot find data, use null. NEVER invent numbers or facts.
6. All prices in ILS (Israeli Shekels).

You have access to the web - USE IT. Search aggressively for:
- Israeli government databases (mavat.iplan.gov.il, dira.moch.gov.il)
- Real estate sites (nadlan.gov.il, madlan.co.il, yad2.co.il)
- Israeli news (globes.co.il, calcalist.co.il, themarker.com)
- Legal databases (nevo.co.il, psakdin.co.il)
- Municipal websites`;

function buildClaudeResearchQuery_ComplexProfile(complex) {
  return `RESEARCH MISSION: Comprehensive intelligence on Pinuy-Binuy complex "${complex.name}" in ${complex.city}.

Known data:
- Addresses: ${complex.addresses || 'unknown'}
- Plan number: ${complex.plan_number || 'unknown'}
- Developer: ${complex.developer || 'unknown'}
- Current plan stage: ${complex.plan_stage || 'unknown'}

Search the web thoroughly for this complex. Use multiple search queries in Hebrew:
1. "${complex.name} pinui binui ${complex.city}"
2. "${complex.name} ${complex.developer || ''} plan"
3. "${complex.addresses || complex.name} ${complex.city} urban renewal"
4. "${complex.plan_number || ''} mavat" (if plan number known)
5. "${complex.developer || ''} real estate projects"

After searching, compile ALL findings into this JSON:
{
  "complex_overview": {
    "precise_addresses": ["full street addresses with building numbers"],
    "neighborhood": "neighborhood name",
    "num_buildings": null,
    "total_existing_units": null,
    "total_planned_units": null,
    "area_dunam": null
  },
  "planning_status": {
    "plan_stage": "current planning stage",
    "plan_number": "plan number if found",
    "committee_approvals": ["list of approvals with dates"],
    "next_milestone": "what is expected next",
    "permit_expected": "YYYY-MM-DD or null",
    "objections": {"count": 0, "status": "description", "has_objections": false}
  },
  "developer_profile": {
    "name": "developer name",
    "status": "active/troubled/dissolved",
    "financial_health": "stable/concerning/critical/unknown",
    "risk_level": "low/medium/high",
    "reputation_score": null,
    "active_projects": 0,
    "completed_projects": 0,
    "years_active": 0,
    "red_flags": [],
    "notable_projects": []
  },
  "signature_status": {
    "percent": null,
    "source_type": "protocol/press/estimate/unknown",
    "last_updated": "date or unknown",
    "holdout_issues": "description or null"
  },
  "sources_found": ["list of all URLs and sources checked"],
  "search_queries_used": ["list of queries searched"],
  "data_gaps": ["list of information NOT found"]
}

Return ONLY the JSON.`;
}

function buildClaudeResearchQuery_MarketIntel(complex) {
  return `RESEARCH MISSION: Market intelligence and risk analysis for Pinuy-Binuy complex "${complex.name}" in ${complex.city}.

Known data:
- Neighborhood: ${complex.neighborhood || 'unknown'}
- Developer: ${complex.developer || 'unknown'}
- Address area: ${complex.addresses || complex.name}

Search the web thoroughly. Use multiple queries:
1. "apartment prices ${complex.neighborhood || complex.city} ${complex.city} 2025 2026"
2. "${complex.name} ${complex.city} prices transactions"
3. "${complex.developer || ''} lawsuits receivership bankruptcy"
4. "${complex.name} ${complex.city} news"
5. "pinui binui ${complex.city} committee approval 2025 2026"
6. "${complex.addresses || complex.name} ${complex.city} nadlan"

After searching, compile ALL findings into this JSON:
{
  "pricing_intelligence": {
    "avg_price_sqm_old": null,
    "avg_price_sqm_new": null,
    "city_avg_price_sqm": null,
    "price_trend": "rising/stable/falling",
    "yearly_change_percent": null,
    "premium_percent": null,
    "comparable_projects": [
      {"name": "project name", "price_per_sqm": 0, "developer": "dev name", "status": "status"}
    ],
    "recent_transactions": [
      {"date": "YYYY-MM", "price": 0, "area_sqm": 0, "price_per_sqm": 0, "source": "source"}
    ]
  },
  "legal_status": {
    "enforcement_cases": false,
    "bankruptcy_proceedings": false,
    "receivership": false,
    "property_liens": false,
    "inheritance_property": false,
    "court_cases": [],
    "significant_legal_issues": "description or null"
  },
  "news_analysis": {
    "sentiment": "positive/neutral/negative/mixed",
    "summary": "Hebrew summary of recent news",
    "key_events": [
      {"date": "YYYY-MM-DD", "event": "description", "source": "source", "impact": "positive/negative/neutral"}
    ],
    "community_sentiment": "supportive/opposed/mixed/unknown"
  },
  "distress_signals": {
    "seller_stress_indicators": [],
    "price_drops_detected": false,
    "motivated_sellers": false,
    "opportunity_signals": []
  },
  "sources_found": ["list of all URLs and sources"],
  "search_queries_used": ["list of queries"],
  "data_gaps": ["what was NOT found"]
}

Return ONLY the JSON.`;
}

// ============================================================
// SYNTHESIS PROMPT: Claude Opus 4.6 (Phase 7)
// ============================================================

const OPUS_SYNTHESIS_SYSTEM = `You are QUANTUM's supreme intelligence engine - the most advanced real estate analysis system in Israel.

You receive raw research data from TWO independent research engines:
- ENGINE A (Perplexity sonar-pro): 4 focused web research queries
- ENGINE B (Claude Sonnet 4.5 + web search): 2 comprehensive web research missions

Your mission:
1. CROSS-VALIDATE: Compare findings between Engine A and Engine B. Where they agree, confidence is HIGH. Where they disagree, investigate why and pick the most reliable.
2. SYNTHESIZE: Merge ALL data into a single unified intelligence report.
3. FILL GAPS: Where one engine found data the other missed, incorporate it with appropriate confidence.
4. DETECT CONTRADICTIONS: Flag any conflicts between the two engines.
5. SCORE EVERYTHING: Assign confidence scores (0-100) based on:
   - Both engines agree = 80-100
   - One engine only, strong source = 50-70
   - One engine only, weak source = 20-40
   - Inferred/estimated = 10-20
6. IDENTIFY: Red flags, opportunities, and investment signals others would miss.

Return ONLY valid JSON. All prices in ILS. Hebrew content expected where natural.
Be precise. Be conservative. Never invent specific numbers.
You are the final authority - your output directly updates the investment database.`;

function buildOpusSynthesisPrompt(complex, perplexityResults, claudeResearchResults) {
  return `DUAL-ENGINE SYNTHESIS for Pinuy-Binuy complex:

COMPLEX: "${complex.name}" in ${complex.city}
DEVELOPER: ${complex.developer || 'Unknown'}
PLAN NUMBER: ${complex.plan_number || 'Unknown'}

CURRENT DATABASE STATE:
${JSON.stringify({
    addresses: complex.addresses,
    plan_number: complex.plan_number,
    neighborhood: complex.neighborhood,
    plan_stage: complex.plan_stage,
    signature_percent: complex.signature_percent,
    price_per_sqm: complex.price_per_sqm,
    accurate_price_sqm: complex.accurate_price_sqm,
    iai_score: complex.iai_score,
    developer_status: complex.developer_status,
    news_sentiment: complex.news_sentiment,
    developer_risk_level: complex.developer_risk_level
  }, null, 2)}

===== ENGINE A: PERPLEXITY sonar-pro RESEARCH =====
Phase 1 (Address & Planning): ${JSON.stringify(perplexityResults.phase1)}
Phase 2 (Developer Intelligence): ${JSON.stringify(perplexityResults.phase2)}
Phase 3 (Pricing & Market): ${JSON.stringify(perplexityResults.phase3)}
Phase 4 (News & Legal): ${JSON.stringify(perplexityResults.phase4)}

===== ENGINE B: CLAUDE SONNET 4.5 RESEARCH =====
Research A (Complex Profile): ${JSON.stringify(claudeResearchResults.profileResearch)}
Research B (Market Intelligence): ${JSON.stringify(claudeResearchResults.marketResearch)}

===== YOUR TASK =====
Cross-validate Engine A and Engine B findings. Produce the definitive intelligence report.

Return JSON:
{
  "neighborhood": {"value": "string or null", "confidence": 0-100, "source": "engine_a/engine_b/both", "notes": "any discrepancy"},
  "num_buildings": {"value": "number or null", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "total_existing_units": {"value": "number or null", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "total_planned_units": {"value": "number or null", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "plan_stage": {"value": "string or null", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "permit_expected": {"value": "date or null", "confidence": 0-100},
  "signature_percent": {"value": "number or null", "confidence": 0-100, "source_type": "protocol/press/estimate"},
  "developer_status": {"value": "string", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "developer_risk": {"value": "low/medium/high", "confidence": 0-100},
  "developer_reputation": {"value": 0-100, "confidence": 0-100},
  "developer_financial_health": {"value": "stable/concerning/critical/unknown", "confidence": 0-100},
  "news_sentiment": {"value": "positive/neutral/negative/mixed", "confidence": 0-100},
  "news_summary": {"value": "Hebrew string", "confidence": 0-100},
  "has_negative_news": {"value": true, "confidence": 0-100},
  "price_per_sqm_old": {"value": "number or null", "confidence": 0-100, "source": "engine_a/engine_b/both"},
  "price_per_sqm_new": {"value": "number or null", "confidence": 0-100},
  "city_avg_price_sqm": {"value": "number or null", "confidence": 0-100},
  "price_trend": {"value": "rising/stable/falling", "confidence": 0-100},
  "yearly_price_change": {"value": "number or null", "confidence": 0-100},
  "actual_premium": {"value": "number or null", "confidence": 0-100},
  "has_enforcement": {"value": false, "confidence": 0-100},
  "has_receivership": {"value": false, "confidence": 0-100},
  "has_bankruptcy": {"value": false, "confidence": 0-100},
  "has_property_liens": {"value": false, "confidence": 0-100},
  "is_inheritance": {"value": false, "confidence": 0-100},
  "address_refined": {"value": "most precise address string", "confidence": 0-100},
  "distress_signals": {
    "seller_stress_indicators": [],
    "motivated_sellers_detected": false,
    "opportunity_signals": []
  },
  "engine_agreement": {
    "fields_both_agree": ["list of fields where both engines found matching data"],
    "fields_engine_a_only": ["fields only Perplexity found"],
    "fields_engine_b_only": ["fields only Claude found"],
    "contradictions": [{"field": "field_name", "engine_a_value": "x", "engine_b_value": "y", "resolution": "which was chosen and why"}]
  },
  "red_flags": ["list of concerns"],
  "opportunities": ["list of positive investment signals"],
  "validation_notes": ["data quality issues, contradictions found"],
  "overall_data_quality": 0-100,
  "synthesis_summary": "3-4 sentence Hebrew summary: complex status, investment potential, key findings from both engines"
}`;
}

// ============================================================
// NADLAN.GOV.IL - Actual transaction prices
// ============================================================
async function fetchNadlanTransactions(street, city) {
  try {
    const payload = {
      ObjectID: '', CurrentLavel: 1, PageNo: 1,
      OrderByFilled: 'DEALDATETIME', OrderByDescend: true,
      TblCity: city, TblStreet: street,
      TblHouseNum: '', TblArea: '', TblDistrict: '',
      FromDate: '', ToDate: '', Rone: '', Polygon: '',
      FromPrice: '', ToPrice: '', FromRoom: '', ToRoom: '',
      FromFloor: '', ToFloor: '', FromBuildYear: '', ToBuildYear: '',
      FromArea: '', ToArea: ''
    };

    const resp = await axios.post(NADLAN_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const results = resp.data.AllResults || resp.data.ResultLavel1 || [];
    if (!Array.isArray(results)) return [];

    return results.map(tx => ({
      date: tx.DEALDATETIME || tx.DEALDATE,
      price: parseFloat(tx.DEALAMOUNT) || 0,
      area_sqm: parseFloat(tx.ASSETAREA) || 0,
      rooms: parseFloat(tx.ASSETROOMNUM) || 0,
      floor: parseInt(tx.FLOORNO) || 0,
      address: `${tx.ASSETADDRESS || street} ${tx.ASSETHOUSENUMBER || ''}`.trim(),
      build_year: parseInt(tx.BUILDINGYEAR) || 0,
      price_per_sqm: 0
    })).map(tx => ({
      ...tx,
      price_per_sqm: tx.area_sqm > 0 ? Math.round(tx.price / tx.area_sqm) : 0
    }));
  } catch (err) {
    logger.warn(`Nadlan fetch failed for ${street}, ${city}: ${err.message}`);
    return [];
  }
}

// ============================================================
// Calculate city average from transactions DB
// ============================================================
async function calculateCityAverage(city) {
  try {
    const result = await pool.query(
      `SELECT AVG(price_per_sqm) as avg_ppsm, COUNT(*) as count
       FROM transactions 
       WHERE city = $1 AND price_per_sqm > 0 
       AND transaction_date > NOW() - INTERVAL '24 months'`,
      [city]
    );
    if (result.rows[0] && result.rows[0].count > 0) {
      return Math.round(parseFloat(result.rows[0].avg_ppsm));
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ============================================================
// MAIN: Deep Enrich a Single Complex (TRUE DUAL ENGINE v3.0)
// ============================================================
async function deepEnrichComplex(complexId) {
  const res = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (res.rows.length === 0) throw new Error(`Complex ${complexId} not found`);
  const complex = res.rows[0];

  logger.info(`[v3.0 TRUE DUAL ENGINE] Enriching: ${complex.name} (${complex.city}) [ID: ${complexId}]`);

  const updates = {};
  let errors = [];
  const perplexityResults = { phase1: null, phase2: null, phase3: null, phase4: null };
  const claudeResearchResults = { profileResearch: null, marketResearch: null };

  // =====================================================
  // ENGINE A: Perplexity sonar-pro (Phases 1-4)
  // =====================================================
  logger.info(`[ENGINE A] Perplexity sonar-pro research: ${complex.name}`);

  try {
    const raw = await queryPerplexity(buildAddressQuery(complex), PERPLEXITY_SYSTEM);
    perplexityResults.phase1 = parseJson(raw);
    logger.info(`[A.1] ${complex.name}: address data collected`);
  } catch (err) {
    errors.push(`A.1 address: ${err.message}`);
    logger.warn(`A.1 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(DELAY_MS);

  if (complex.developer) {
    try {
      const raw = await queryPerplexity(buildDeveloperQuery(complex), PERPLEXITY_SYSTEM);
      perplexityResults.phase2 = parseJson(raw);
      logger.info(`[A.2] ${complex.name}: developer data collected`);
    } catch (err) {
      errors.push(`A.2 developer: ${err.message}`);
      logger.warn(`A.2 failed for ${complex.name}`, { error: err.message });
    }
  }

  await sleep(DELAY_MS);

  try {
    const raw = await queryPerplexity(buildPricingQuery(complex), PERPLEXITY_SYSTEM);
    perplexityResults.phase3 = parseJson(raw);
    logger.info(`[A.3] ${complex.name}: pricing data collected`);
  } catch (err) {
    errors.push(`A.3 pricing: ${err.message}`);
    logger.warn(`A.3 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(DELAY_MS);

  try {
    const raw = await queryPerplexity(buildNewsQuery(complex), PERPLEXITY_SYSTEM);
    perplexityResults.phase4 = parseJson(raw);
    logger.info(`[A.4] ${complex.name}: news data collected`);
  } catch (err) {
    errors.push(`A.4 news: ${err.message}`);
    logger.warn(`A.4 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(CLAUDE_DELAY_MS);

  // =====================================================
  // ENGINE B: Claude Sonnet 4.5 + Web Search (Phases 5-6)
  // =====================================================
  logger.info(`[ENGINE B] Claude Sonnet 4.5 web research: ${complex.name}`);

  try {
    const raw = await queryClaudeResearch(
      buildClaudeResearchQuery_ComplexProfile(complex),
      CLAUDE_RESEARCH_SYSTEM
    );
    claudeResearchResults.profileResearch = parseJson(raw);
    logger.info(`[B.5] ${complex.name}: complex profile research complete`);
  } catch (err) {
    errors.push(`B.5 Claude profile: ${err.message}`);
    logger.warn(`B.5 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(CLAUDE_DELAY_MS);

  try {
    const raw = await queryClaudeResearch(
      buildClaudeResearchQuery_MarketIntel(complex),
      CLAUDE_RESEARCH_SYSTEM
    );
    claudeResearchResults.marketResearch = parseJson(raw);
    logger.info(`[B.6] ${complex.name}: market intel research complete`);
  } catch (err) {
    errors.push(`B.6 Claude market: ${err.message}`);
    logger.warn(`B.6 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(CLAUDE_DELAY_MS);

  // =====================================================
  // SYNTHESIS: Claude Opus 4.6 (Phase 7)
  // =====================================================
  let opusSynthesis = null;
  const hasEngineA = Object.values(perplexityResults).some(v => v !== null);
  const hasEngineB = Object.values(claudeResearchResults).some(v => v !== null);

  if (hasEngineA || hasEngineB) {
    logger.info(`[OPUS SYNTHESIS] Starting for ${complex.name} (A: ${hasEngineA}, B: ${hasEngineB})`);
    try {
      const synthesisRaw = await queryClaudeSynthesis(
        buildOpusSynthesisPrompt(complex, perplexityResults, claudeResearchResults),
        OPUS_SYNTHESIS_SYSTEM
      );
      opusSynthesis = parseJson(synthesisRaw);

      const agr = opusSynthesis?.engine_agreement;
      logger.info(`[OPUS] ${complex.name}: quality=${opusSynthesis?.overall_data_quality || '?'}, ` +
        `agree=${agr?.fields_both_agree?.length || 0}, ` +
        `contradictions=${agr?.contradictions?.length || 0}`);
    } catch (err) {
      errors.push(`Opus synthesis: ${err.message}`);
      logger.warn(`Opus synthesis failed for ${complex.name}`, { error: err.message });
    }
  }

  // =====================================================
  // APPLY RESULTS
  // =====================================================

  if (opusSynthesis) {
    const os = opusSynthesis;

    if (os.neighborhood?.value) updates.neighborhood = os.neighborhood.value;
    if (os.num_buildings?.value) updates.num_buildings = os.num_buildings.value;
    if (os.plan_stage?.value) updates.plan_stage = os.plan_stage.value;
    if (os.permit_expected?.value) updates.permit_expected = os.permit_expected.value;
    if (os.signature_percent?.value) {
      updates.signature_percent = os.signature_percent.value;
      updates.signature_confidence = os.signature_percent.confidence;
      if (os.signature_percent.source_type) {
        updates.signature_source = os.signature_percent.source_type === 'protocol' ? 'protocol' : 'press';
      }
    }
    if (os.developer_status?.value) updates.developer_status = os.developer_status.value;
    if (os.developer_risk?.value) updates.developer_risk_level = os.developer_risk.value;
    if (os.developer_reputation?.value !== undefined) updates.developer_reputation_score = os.developer_reputation.value;
    if (os.developer_financial_health?.value) updates.developer_financial_health = os.developer_financial_health.value;
    if (os.news_sentiment?.value) updates.news_sentiment = os.news_sentiment.value;
    if (os.news_summary?.value) updates.news_summary = os.news_summary.value;
    if (os.has_negative_news?.value !== undefined) updates.has_negative_news = os.has_negative_news.value;
    if (os.price_per_sqm_old?.value) updates.accurate_price_sqm = os.price_per_sqm_old.value;
    if (os.city_avg_price_sqm?.value) updates.city_avg_price_sqm = os.city_avg_price_sqm.value;
    if (os.price_trend?.value) updates.price_trend = os.price_trend.value;
    if (os.yearly_price_change?.value !== undefined) updates.yearly_price_change = os.yearly_price_change.value;
    if (os.actual_premium?.value) updates.actual_premium = os.actual_premium.value;
    if (os.has_enforcement?.value !== undefined) updates.has_enforcement_cases = os.has_enforcement.value;
    if (os.has_receivership?.value !== undefined) updates.is_receivership = os.has_receivership.value;
    if (os.has_bankruptcy?.value !== undefined) updates.has_bankruptcy_proceedings = os.has_bankruptcy.value;
    if (os.has_property_liens?.value !== undefined) updates.has_property_liens = os.has_property_liens.value;
    if (os.is_inheritance?.value !== undefined) updates.is_inheritance_property = os.is_inheritance.value;
    if (os.address_refined?.value) {
      updates.address = os.address_refined.value;
      if (!complex.addresses || os.address_refined.value.length > (complex.addresses || '').length) {
        updates.addresses = os.address_refined.value;
      }
    }
    if (os.total_existing_units?.value) updates.total_existing_units = os.total_existing_units.value;
    if (os.total_planned_units?.value) updates.total_planned_units = os.total_planned_units.value;

    updates.price_confidence_score = os.overall_data_quality || 50;
    updates.price_sources = JSON.stringify(['sonar-pro', 'sonnet-4.5-research', 'opus-4.6-synthesis', 'nadlan_gov']);

    if (os.red_flags && os.red_flags.length > 0) {
      updates.developer_red_flags = JSON.stringify(os.red_flags);
    }
    if (os.synthesis_summary) {
      updates.news_summary = os.synthesis_summary;
    }
    if (os.engine_agreement) {
      updates.enrichment_metadata = JSON.stringify({
        engine: 'v3.0-dual',
        engine_agreement: os.engine_agreement,
        distress_signals: os.distress_signals || null,
        opportunities: os.opportunities || [],
        contradictions: os.engine_agreement.contradictions || []
      });
    }

    updates.developer_last_verified = new Date().toISOString();
    updates.price_last_updated = new Date().toISOString();
    updates.last_news_check = new Date().toISOString();

  } else {
    // Fallback: raw engine data
    logger.warn(`[FALLBACK] No Opus synthesis for ${complex.name}, using raw data`);

    const profile = claudeResearchResults.profileResearch;
    const market = claudeResearchResults.marketResearch;
    const p1 = perplexityResults.phase1;
    const p2 = perplexityResults.phase2;
    const p3 = perplexityResults.phase3;
    const p4 = perplexityResults.phase4;

    if (profile?.complex_overview?.neighborhood || p1?.neighborhood) {
      updates.neighborhood = profile?.complex_overview?.neighborhood || p1?.neighborhood;
    }
    if (profile?.complex_overview?.num_buildings || p1?.num_buildings) {
      updates.num_buildings = profile?.complex_overview?.num_buildings || p1?.num_buildings;
    }
    if (profile?.planning_status?.plan_stage || p1?.plan_stage) {
      updates.plan_stage = profile?.planning_status?.plan_stage || p1?.plan_stage;
    }
    if (profile?.signature_status?.percent || p1?.signature_percent) {
      updates.signature_percent = profile?.signature_status?.percent || p1?.signature_percent;
    }

    if (profile?.complex_overview?.precise_addresses?.length > 0) {
      updates.addresses = profile.complex_overview.precise_addresses.join('; ');
      updates.address = updates.addresses;
    } else if (p1?.precise_addresses?.length > 0) {
      const addrParts = p1.precise_addresses.map(a => {
        const nums = a.building_numbers ? a.building_numbers.join(',') : '';
        return `${a.street} ${nums}`.trim();
      });
      updates.address = addrParts.join('; ');
      if (!complex.addresses || complex.addresses.length < updates.address.length) {
        updates.addresses = updates.address;
      }
    }

    if (profile?.developer_profile || p2) {
      const dev = profile?.developer_profile || {};
      updates.developer_status = dev.status || p2?.developer_status;
      updates.developer_risk_level = dev.risk_level || p2?.risk_level;
      if (dev.reputation_score || p2?.reputation_score) {
        updates.developer_reputation_score = dev.reputation_score || p2?.reputation_score;
      }
      if ((dev.red_flags?.length > 0) || (p2?.red_flags?.length > 0)) {
        updates.developer_red_flags = JSON.stringify(dev.red_flags || p2?.red_flags);
      }
      updates.developer_last_verified = new Date().toISOString();
    }

    if (market?.pricing_intelligence || p3) {
      const pricing = market?.pricing_intelligence || {};
      if (pricing.avg_price_sqm_old || p3?.estimated_old_price_sqm) {
        updates.accurate_price_sqm = pricing.avg_price_sqm_old || p3?.estimated_old_price_sqm;
      }
      if (pricing.city_avg_price_sqm || p3?.city_avg_price_sqm) {
        updates.city_avg_price_sqm = pricing.city_avg_price_sqm || p3?.city_avg_price_sqm;
      }
      if (pricing.price_trend || p3?.price_trend) {
        updates.price_trend = pricing.price_trend || p3?.price_trend;
      }
      updates.price_confidence_score = 40;
      updates.price_last_updated = new Date().toISOString();
      updates.price_sources = JSON.stringify(['sonar-pro', 'sonnet-4.5-research']);
    }

    if (market?.news_analysis || p4) {
      const news = market?.news_analysis || {};
      updates.news_sentiment = news.sentiment || p4?.news_sentiment;
      updates.news_summary = news.summary || p4?.news_summary;
      updates.last_news_check = new Date().toISOString();
    }

    if (market?.legal_status || p4) {
      const legal = market?.legal_status || {};
      if (legal.enforcement_cases !== undefined || p4?.enforcement_cases !== undefined) {
        updates.has_enforcement_cases = legal.enforcement_cases ?? p4?.enforcement_cases;
      }
      if (legal.receivership !== undefined || p4?.receivership !== undefined) {
        updates.is_receivership = legal.receivership ?? p4?.receivership;
      }
      if (legal.bankruptcy_proceedings !== undefined || p4?.bankruptcy_proceedings !== undefined) {
        updates.has_bankruptcy_proceedings = legal.bankruptcy_proceedings ?? p4?.bankruptcy_proceedings;
      }
    }
  }

  // =====================================================
  // Phase 8: nadlan.gov.il direct transactions
  // =====================================================
  try {
    const streets = (complex.addresses || '').split(',').map(s => s.trim()).filter(Boolean);
    let allTx = [];
    for (const street of streets.slice(0, 3)) {
      const cleanStreet = street.replace(/\d+/g, '').replace(/[-]/g, '').trim();
      if (cleanStreet.length > 2) {
        const tx = await fetchNadlanTransactions(cleanStreet, complex.city);
        allTx.push(...tx);
        await sleep(2000);
      }
    }

    if (allTx.length > 0) {
      let newCount = 0;
      for (const tx of allTx) {
        if (!tx.price || tx.price === 0) continue;
        try {
          const existing = await pool.query(
            `SELECT id FROM transactions WHERE complex_id = $1 AND price = $2 
             AND transaction_date::text LIKE $3`,
            [complexId, tx.price, `${(tx.date || '').substring(0, 10)}%`]
          );
          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO transactions (complex_id, transaction_date, price, area_sqm, rooms, floor, price_per_sqm, address, city, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'nadlan_gov')`,
              [complexId, tx.date, tx.price, tx.area_sqm, tx.rooms, tx.floor, tx.price_per_sqm, tx.address, complex.city]
            );
            newCount++;
          }
        } catch (e) { /* skip duplicates */ }
      }

      const recentTx = allTx.filter(t => t.price_per_sqm > 0).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (recentTx.length > 0) {
        const avgPriceSqm = Math.round(recentTx.slice(0, 10).reduce((s, t) => s + t.price_per_sqm, 0) / Math.min(recentTx.length, 10));
        if (avgPriceSqm > 0) {
          updates.accurate_price_sqm = avgPriceSqm;
          updates.price_confidence_score = Math.min(95, 50 + recentTx.length * 5);
          updates.price_sources = JSON.stringify(['nadlan_gov', 'sonar-pro', 'sonnet-4.5-research', 'opus-4.6-synthesis']);
        }
      }

      logger.info(`[Phase 8 nadlan] ${complex.name}: ${newCount} new transactions`);
    }
  } catch (err) {
    errors.push(`Phase 8 nadlan: ${err.message}`);
  }

  // =====================================================
  // Phase 9: City average from DB
  // =====================================================
  try {
    const cityAvg = await calculateCityAverage(complex.city);
    if (cityAvg && !updates.city_avg_price_sqm) {
      updates.city_avg_price_sqm = cityAvg;
    }
  } catch (err) { /* non-critical */ }

  if (updates.accurate_price_sqm && updates.city_avg_price_sqm) {
    updates.price_vs_city_avg = Math.round(
      ((updates.accurate_price_sqm - updates.city_avg_price_sqm) / updates.city_avg_price_sqm) * 100
    );
  }

  // =====================================================
  // WRITE TO DB
  // =====================================================
  const validUpdates = Object.entries(updates).filter(([k, v]) => v !== undefined && v !== null);

  if (validUpdates.length > 0) {
    const setClauses = validUpdates.map(([k], i) => `${k} = $${i + 1}`);
    const values = validUpdates.map(([, v]) => v);
    values.push(complexId);

    const sql = `UPDATE complexes SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`;

    try {
      await pool.query(sql, values);
      const engineLabel = opusSynthesis ? 'DUAL ENGINE + Opus' : 'FALLBACK';
      logger.info(`[v3.0 DONE] ${complex.name}: ${validUpdates.length} fields (${engineLabel})`, {
        fields: validUpdates.map(([k]) => k)
      });
    } catch (err) {
      logger.error(`DB update failed for ${complex.name}`, { error: err.message, sql: sql.substring(0, 200) });
      errors.push(`DB update: ${err.message}`);
    }
  }

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    fieldsUpdated: validUpdates.length,
    updatedFields: validUpdates.map(([k]) => k),
    engine: opusSynthesis
      ? 'v3.0: sonar-pro + sonnet-4.5-research + opus-4.6-synthesis'
      : hasEngineB
        ? 'v3.0-partial: sonar-pro + sonnet-4.5 (no synthesis)'
        : 'v3.0-fallback: sonar-pro only',
    engineA: hasEngineA ? 'sonar-pro' : 'failed',
    engineB: hasEngineB ? 'sonnet-4.5 + web_search' : 'failed',
    synthesis: opusSynthesis ? 'opus-4.6' : 'none',
    dataQuality: opusSynthesis?.overall_data_quality || null,
    engineAgreement: opusSynthesis?.engine_agreement || null,
    redFlags: opusSynthesis?.red_flags || [],
    opportunities: opusSynthesis?.opportunities || [],
    errors: errors.length > 0 ? errors : null,
    status: errors.length === 0 ? 'success' : 'partial'
  };
}

// ============================================================
// Batch Processing
// ============================================================
async function enrichAll(options = {}) {
  const { limit = 20, city, minIai = 0, staleOnly = true } = options;

  let query = 'SELECT id, name, city, iai_score FROM complexes WHERE iai_score >= $1';
  const params = [minIai];

  if (city) {
    params.push(city);
    query += ` AND city = $${params.length}`;
  }

  if (staleOnly) {
    query += ` AND (price_last_updated IS NULL OR price_last_updated < NOW() - INTERVAL '14 days')`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';
  params.push(limit);
  query += ` LIMIT $${params.length}`;

  const complexes = await pool.query(query, params);

  const jobId = `batch_${Date.now()}`;
  batchJobs[jobId] = {
    status: 'running',
    total: complexes.rows.length,
    enriched: 0,
    totalFieldsUpdated: 0,
    errors: 0,
    currentComplex: null,
    engine: 'v3.0: sonar-pro + sonnet-4.5-research + opus-4.6-synthesis',
    details: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  logger.info(`[v3.0] Batch ${jobId}: ${complexes.rows.length} complexes (TRUE DUAL ENGINE)`);

  processEnrichmentBatch(jobId, complexes.rows).catch(err => {
    logger.error(`Batch ${jobId} crashed`, { error: err.message });
    batchJobs[jobId].status = 'error';
    batchJobs[jobId].completedAt = new Date().toISOString();
  });

  return {
    jobId,
    status: 'started',
    total: complexes.rows.length,
    engine: 'v3.0: sonar-pro + sonnet-4.5-research + opus-4.6-synthesis',
    message: `True dual-engine batch started. Track: GET /api/enrichment/batch/${jobId}`
  };
}

async function processEnrichmentBatch(jobId, complexes) {
  const job = batchJobs[jobId];

  for (const c of complexes) {
    try {
      job.currentComplex = `${c.name} (${c.city})`;
      const result = await deepEnrichComplex(c.id);
      job.enriched++;
      job.totalFieldsUpdated += result.fieldsUpdated;
      if (result.errors) job.errors++;
      job.details.push(result);
      await sleep(BETWEEN_COMPLEX_MS);
    } catch (err) {
      job.errors++;
      job.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
      logger.error(`Enrichment failed for ${c.name}`, { error: err.message });
      await sleep(BETWEEN_COMPLEX_MS);
    }
  }

  job.status = 'completed';
  job.currentComplex = null;
  job.completedAt = new Date().toISOString();
  logger.info(`[v3.0] Batch ${jobId} complete: ${job.enriched}/${job.total}, ${job.totalFieldsUpdated} fields`);
}

module.exports = { deepEnrichComplex, enrichAll, getBatchStatus, getAllBatchJobs };
