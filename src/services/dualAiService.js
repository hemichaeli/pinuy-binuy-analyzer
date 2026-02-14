/**
 * Dual AI Service - Claude + Perplexity working together
 * 
 * SCAN MODE: Both AIs scan independently with research models, results merged into DB
 * CHAT MODE: Multiple model options including Council mode
 * 
 * Perplexity Models:
 *   sonar              - Fast, basic (cheapest)
 *   sonar-pro          - Enhanced, better quality
 *   sonar-reasoning-pro - Step-by-step reasoning with citations
 *   sonar-deep-research - Multi-step deep research (slow, expensive, thorough)
 * 
 * Claude Model:
 *   claude-sonnet-4-20250514 - Anthropic research-grade
 * 
 * Council Mode:
 *   Runs query through 3 Perplexity models + Claude, synthesizes one answer
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

// === API CONFIG ===
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

// Models
const MODELS = {
  perplexity: {
    fast: 'sonar',
    pro: 'sonar-pro',
    reasoning: 'sonar-reasoning-pro',
    deep: 'sonar-deep-research'
  },
  claude: {
    default: 'claude-sonnet-4-20250514'
  }
};

// Defaults
const PERPLEXITY_MODEL_DEFAULT = MODELS.perplexity.pro;
const PERPLEXITY_MODEL_RESEARCH = MODELS.perplexity.reasoning;
const PERPLEXITY_MODEL_DEEP = MODELS.perplexity.deep;
const PERPLEXITY_MODEL_SCAN = MODELS.perplexity.reasoning; // Scans use reasoning by default
const CLAUDE_MODEL = MODELS.claude.default;

// Timeouts per model
const TIMEOUTS = {
  'sonar': 60000,
  'sonar-pro': 90000,
  'sonar-reasoning-pro': 120000,
  'sonar-deep-research': 300000, // 5 min - deep research is slow
  'claude': 90000
};

const DELAY_BETWEEN_REQUESTS_MS = 3500;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === LOW-LEVEL API CALLS ===

async function callPerplexity(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const model = opts.model || PERPLEXITY_MODEL_DEFAULT;
  const timeout = TIMEOUTS[model] || 120000;
  logger.info(`[PERPLEXITY] Model: ${model} | Timeout: ${timeout/1000}s`);

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...(opts.history || []),
      { role: 'user', content: userPrompt }
    ],
    temperature: opts.temperature || 0.1,
    max_tokens: opts.maxTokens || 4000
  };

  // Deep research specific options
  if (model === MODELS.perplexity.deep) {
    body.max_tokens = opts.maxTokens || 8000;
    // Deep research benefits from higher search context
    body.search_context_size = opts.searchContext || 'high';
  }

  const response = await axios.post(PERPLEXITY_URL, body, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout
  });

  const content = response.data.choices[0].message.content;
  const usage = response.data.usage;
  
  if (usage) {
    logger.info(`[PERPLEXITY] ${model} usage: ${usage.prompt_tokens}in/${usage.completion_tokens}out = ${usage.total_tokens} tokens`);
  }

  return content;
}

async function callClaude(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model = opts.model || CLAUDE_MODEL;
  const messages = [...(opts.history || []), { role: 'user', content: userPrompt }];

  logger.info(`[CLAUDE] Model: ${model}`);

  const response = await axios.post(CLAUDE_URL, {
    model,
    max_tokens: opts.maxTokens || 4000,
    system: systemPrompt,
    messages
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    timeout: TIMEOUTS.claude
  });

  const content = response.data.content[0].text;
  const usage = response.data.usage;

  if (usage) {
    logger.info(`[CLAUDE] ${model} usage: ${usage.input_tokens}in/${usage.output_tokens}out`);
  }

  return content;
}

function isClaudeConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function isPerplexityConfigured() { return !!process.env.PERPLEXITY_API_KEY; }

function getAvailableModels() {
  return {
    perplexity: {
      default: PERPLEXITY_MODEL_DEFAULT,
      research: PERPLEXITY_MODEL_RESEARCH,
      deep: PERPLEXITY_MODEL_DEEP,
      scan_default: PERPLEXITY_MODEL_SCAN,
      models: [
        { id: 'sonar', name: 'Fast (מהיר)', description: 'מהיר וזול, לשאלות פשוטות', tier: 'basic' },
        { id: 'sonar-pro', name: 'Pro (מומלץ)', description: 'איכות גבוהה, ברירת מחדל לצ\'אט', tier: 'standard' },
        { id: 'sonar-reasoning-pro', name: 'Reasoning (חשיבה)', description: 'חשיבה שלב-שלב עם מקורות', tier: 'research' },
        { id: 'sonar-deep-research', name: 'Deep Research (מחקר עמוק)', description: 'מחקר מעמיק, מספר דקות, עשרות מקורות', tier: 'research' },
        { id: 'council', name: 'Council (מועצה)', description: '3 מודלים במקביל + סינתוז - הכי חכם', tier: 'premium' }
      ]
    },
    claude: {
      configured: isClaudeConfigured(),
      model: CLAUDE_MODEL,
      description: 'Anthropic research-grade AI'
    },
    scan: {
      perplexity_model: PERPLEXITY_MODEL_SCAN,
      claude_model: CLAUDE_MODEL,
      dual_mode: isClaudeConfigured() && isPerplexityConfigured()
    }
  };
}

// === JSON PARSING ===

function parseJsonResponse(text) {
  try { return JSON.parse(text); } catch (e) {}
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1].trim()); } catch (e) {} }
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) { try { return JSON.parse(objectMatch[0]); } catch (e) {} }
  return null;
}

// === SCAN PROMPTS ===

const SCAN_SYSTEM = `You are a real estate data extraction assistant focused on Israeli Pinuy Binuy (urban renewal) projects.
Return ONLY valid JSON. No explanations, no markdown formatting, no text before or after the JSON.
If you don't have data for a field, use null or empty array [].
All prices should be in Israeli Shekels (ILS). Search Hebrew sources for accuracy. Be precise with numbers.`;

function buildScanPrompt(complex) {
  return `חפש מידע עדכני על מתחם פינוי בינוי "${complex.name}" ב${complex.city}.
כתובות: ${complex.addresses || ''}

החזר JSON בלבד:
{
  "status_update": {
    "current_status": "הוכרז/בתכנון/הופקד/אושר/בביצוע/null",
    "status_details": "פרטים",
    "last_update_date": "YYYY-MM-DD or null",
    "objections": "התנגדויות",
    "developer_update": "עדכון יזם"
  },
  "recent_transactions": [{"date":"YYYY-MM-DD","address":"","price":0,"rooms":0,"area_sqm":0,"floor":0,"source":""}],
  "current_market": {
    "avg_price_per_sqm": 0, "price_range_min": 0, "price_range_max": 0, "num_active_listings": 0,
    "notable_listings": [{"address":"","asking_price":0,"rooms":0,"area_sqm":0,"days_on_market":0,"source":"","url":""}]
  },
  "news": "חדשות אחרונות",
  "confidence": "high/medium/low"
}

חפש: madlan.co.il, yad2.co.il, nadlan.gov.il, globes.co.il, calcalist.co.il, themarker.com
JSON בלבד.`;
}

// === MERGE SCAN RESULTS ===

function mergeScanResults(perplexityData, claudeData) {
  if (!perplexityData && !claudeData) return null;
  if (!perplexityData) return claudeData;
  if (!claudeData) return perplexityData;

  const merged = {
    status_update: {},
    recent_transactions: [],
    current_market: { notable_listings: [] },
    news: '',
    confidence: 'medium',
    source: 'dual-ai'
  };

  const pStatus = perplexityData.status_update || {};
  const cStatus = claudeData.status_update || {};
  merged.status_update = {
    current_status: pStatus.current_status || cStatus.current_status,
    status_details: [pStatus.status_details, cStatus.status_details].filter(Boolean).join(' | '),
    last_update_date: pStatus.last_update_date || cStatus.last_update_date,
    objections: pStatus.objections || cStatus.objections,
    developer_update: [pStatus.developer_update, cStatus.developer_update].filter(Boolean).join(' | ')
  };

  const allTx = [
    ...(perplexityData.recent_transactions || []).map(t => ({ ...t, source: t.source || 'perplexity' })),
    ...(claudeData.recent_transactions || []).map(t => ({ ...t, source: t.source || 'claude' }))
  ];
  const txMap = new Map();
  for (const tx of allTx) { const key = `${tx.address}|${tx.price}`; if (!txMap.has(key)) txMap.set(key, tx); }
  merged.recent_transactions = Array.from(txMap.values());

  const pMkt = perplexityData.current_market || {};
  const cMkt = claudeData.current_market || {};
  merged.current_market.avg_price_per_sqm = pMkt.avg_price_per_sqm || cMkt.avg_price_per_sqm;
  merged.current_market.price_range_min = Math.min(pMkt.price_range_min || Infinity, cMkt.price_range_min || Infinity);
  merged.current_market.price_range_max = Math.max(pMkt.price_range_max || 0, cMkt.price_range_max || 0);
  if (merged.current_market.price_range_min === Infinity) merged.current_market.price_range_min = 0;

  const allListings = [
    ...(pMkt.notable_listings || []).map(l => ({ ...l, source: l.source || 'perplexity' })),
    ...(cMkt.notable_listings || []).map(l => ({ ...l, source: l.source || 'claude' }))
  ];
  const listMap = new Map();
  for (const l of allListings) { const key = `${l.address}|${l.asking_price}`; if (!listMap.has(key)) listMap.set(key, l); }
  merged.current_market.notable_listings = Array.from(listMap.values());
  merged.current_market.num_active_listings = Math.max(pMkt.num_active_listings || 0, cMkt.num_active_listings || 0);

  merged.news = [perplexityData.news, claudeData.news].filter(Boolean).join(' | ');

  const confMap = { high: 3, medium: 2, low: 1 };
  merged.confidence = Math.max(confMap[perplexityData.confidence] || 1, confMap[claudeData.confidence] || 1) >= 3 ? 'high' : Math.max(confMap[perplexityData.confidence] || 1, confMap[claudeData.confidence] || 1) >= 2 ? 'medium' : 'low';

  return merged;
}

// === DUAL SCAN (single complex) ===

async function dualScanComplex(complexId, options = {}) {
  const complexResult = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (complexResult.rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = complexResult.rows[0];
  const prompt = buildScanPrompt(complex);
  const scanModel = options.perplexityModel || PERPLEXITY_MODEL_SCAN;

  logger.info(`[DUAL-SCAN] ${complex.name} (${complex.city}) [Perplexity: ${scanModel} | Claude: ${isClaudeConfigured() ? 'ON' : 'OFF'}]`, { complexId });

  let perplexityData = null;
  let claudeData = null;
  const errors = [];

  // Run BOTH AIs in parallel - Perplexity research + Claude research
  const [pResult, cResult] = await Promise.allSettled([
    isPerplexityConfigured()
      ? callPerplexity(SCAN_SYSTEM, prompt, { model: scanModel }).then(r => parseJsonResponse(r))
      : Promise.resolve(null),
    isClaudeConfigured()
      ? callClaude(SCAN_SYSTEM, prompt).then(r => parseJsonResponse(r))
      : Promise.resolve(null)
  ]);

  if (pResult.status === 'fulfilled') {
    perplexityData = pResult.value;
    if (perplexityData) logger.info(`[DUAL-SCAN] Perplexity (${scanModel}): OK for ${complex.name}`);
    else logger.warn(`[DUAL-SCAN] Perplexity (${scanModel}): no parseable data for ${complex.name}`);
  } else {
    errors.push(`Perplexity: ${pResult.reason?.message || 'unknown'}`);
    logger.warn(`[DUAL-SCAN] Perplexity failed for ${complex.name}: ${pResult.reason?.message}`);
  }

  if (cResult.status === 'fulfilled') {
    claudeData = cResult.value;
    if (claudeData) logger.info(`[DUAL-SCAN] Claude: OK for ${complex.name}`);
    else logger.warn(`[DUAL-SCAN] Claude: no parseable data for ${complex.name}`);
  } else {
    errors.push(`Claude: ${cResult.reason?.message || 'unknown'}`);
    logger.warn(`[DUAL-SCAN] Claude failed for ${complex.name}: ${cResult.reason?.message}`);
  }

  const merged = mergeScanResults(perplexityData, claudeData);

  if (!merged) {
    await pool.query('UPDATE complexes SET last_perplexity_update = NOW() WHERE id = $1', [complexId]);
    return { complexId, name: complex.name, status: 'no_data', transactions: 0, listings: 0, errors };
  }

  const stored = await storeTransactionData(complexId, merged);
  await updateComplexStatus(complexId, merged);

  return {
    complexId, name: complex.name, city: complex.city, status: 'success',
    sources: [perplexityData ? `perplexity:${scanModel}` : null, claudeData ? 'claude' : null].filter(Boolean),
    model: scanModel,
    confidence: merged.confidence, transactions: stored.transactions, listings: stored.listings,
    hasStatusUpdate: !!(merged.status_update && merged.status_update.current_status),
    hasNews: !!merged.news, errors
  };
}

// === STORAGE (shared) ===

async function storeTransactionData(complexId, data) {
  if (!data) return { transactions: 0, listings: 0 };
  let newTx = 0, newListings = 0;

  for (const tx of (data.recent_transactions || [])) {
    if (!tx.price || tx.price === 0) continue;
    try {
      const dup = await pool.query(`SELECT id FROM transactions WHERE complex_id = $1 AND address = $2 AND price = $3 AND transaction_date = $4`, [complexId, tx.address, tx.price, tx.date || null]);
      if (dup.rows.length === 0) {
        const pps = tx.area_sqm > 0 ? Math.round(tx.price / tx.area_sqm) : null;
        await pool.query(`INSERT INTO transactions (complex_id, transaction_date, price, area_sqm, rooms, floor, price_per_sqm, address, city, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT city FROM complexes WHERE id = $1), $9)`,
          [complexId, tx.date || null, tx.price, tx.area_sqm || null, tx.rooms || null, tx.floor || null, pps, tx.address, tx.source || 'dual-ai']);
        newTx++;
      }
    } catch (e) { logger.warn(`Store tx error: ${e.message}`); }
  }

  for (const l of (data.current_market?.notable_listings || [])) {
    if (!l.asking_price || l.asking_price === 0) continue;
    try {
      const dup = await pool.query(`SELECT id FROM listings WHERE complex_id = $1 AND address = $2 AND asking_price = $3 AND is_active = true`, [complexId, l.address, l.asking_price]);
      if (dup.rows.length === 0) {
        const pps = l.area_sqm > 0 ? Math.round(l.asking_price / l.area_sqm) : null;
        await pool.query(`INSERT INTO listings (complex_id, source, url, asking_price, area_sqm, rooms, price_per_sqm, address, city, first_seen, last_seen, days_on_market, original_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT city FROM complexes WHERE id = $1), CURRENT_DATE, CURRENT_DATE, $9, $4)`,
          [complexId, l.source || 'dual-ai', l.url || null, l.asking_price, l.area_sqm || null, l.rooms || null, pps, l.address, l.days_on_market || 0]);
        newListings++;
      }
    } catch (e) { logger.warn(`Store listing error: ${e.message}`); }
  }

  return { transactions: newTx, listings: newListings };
}

async function updateComplexStatus(complexId, data) {
  if (!data) return;
  const updates = [];
  const params = [];
  let pi = 1;

  if (data.status_update?.current_status) {
    const map = { 'הוכרז': 'declared', 'בתכנון': 'planning', 'להפקדה': 'pre_deposit', 'הופקד': 'deposited', 'הופקדה': 'deposited', 'אושר': 'approved', 'אושרה': 'approved', 'בביצוע': 'construction', 'היתר בניה': 'permit' };
    const s = map[data.status_update.current_status];
    if (s) { updates.push(`status = $${pi}`); params.push(s); pi++; }
  }

  const parts = [];
  if (data.status_update?.status_details) parts.push(data.status_update.status_details);
  if (data.status_update?.objections) parts.push(`התנגדויות: ${data.status_update.objections}`);
  if (data.status_update?.developer_update) parts.push(`יזם: ${data.status_update.developer_update}`);
  if (data.current_market?.avg_price_per_sqm) parts.push(`מחיר/מר: ${data.current_market.avg_price_per_sqm.toLocaleString()}`);
  if (data.news) parts.push(data.news);
  if (data.source) parts.push(`[${data.source}]`);

  if (parts.length > 0) { updates.push(`perplexity_summary = $${pi}`); params.push(parts.join(' | ')); pi++; }
  updates.push(`last_perplexity_update = NOW()`);

  params.push(complexId);
  await pool.query(`UPDATE complexes SET ${updates.join(', ')} WHERE id = $${pi}`, params);
}

// === DUAL SCAN ALL ===

async function dualScanAll(options = {}) {
  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let pi = 1;

  if (options.city) { query += ` AND city = $${pi}`; params.push(options.city); pi++; }
  if (options.status) { query += ` AND status = $${pi}`; params.push(options.status); pi++; }
  if (options.staleOnly) { query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '7 days')`; }
  query += ' ORDER BY iai_score DESC, name ASC';
  if (options.limit) { query += ` LIMIT $${pi}`; params.push(options.limit); }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;
  const scanModel = options.perplexityModel || PERPLEXITY_MODEL_SCAN;
  logger.info(`[DUAL-SCAN] Starting scan of ${total} complexes [Perplexity: ${scanModel} | Claude: ${isClaudeConfigured() ? 'ON' : 'OFF'}]`);

  const results = { 
    total, scanned: 0, succeeded: 0, failed: 0, totalNewTx: 0, totalNewListings: 0, 
    perplexityModel: scanModel, claudeModel: CLAUDE_MODEL, 
    dualMode: isClaudeConfigured() && isPerplexityConfigured(),
    details: [] 
  };

  for (let i = 0; i < complexes.rows.length; i++) {
    const c = complexes.rows[i];
    try {
      const r = await dualScanComplex(c.id, { perplexityModel: scanModel });
      results.scanned++; results.succeeded++;
      results.totalNewTx += r.transactions;
      results.totalNewListings += r.listings;
      results.details.push(r);
      logger.info(`[DUAL-SCAN] [${i+1}/${total}] ${c.name}: ${r.sources?.join('+') || 'none'} | ${r.transactions}tx ${r.listings}listings`);
    } catch (e) {
      results.scanned++; results.failed++;
      results.details.push({ complexId: c.id, name: c.name, status: 'error', error: e.message });
      logger.error(`[DUAL-SCAN] [${i+1}/${total}] ${c.name}: ERROR - ${e.message}`);
    }
    if (i < complexes.rows.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  logger.info(`[DUAL-SCAN] Complete: ${results.succeeded}/${results.total} ok, ${results.totalNewTx} tx, ${results.totalNewListings} listings [${scanModel}+claude]`);
  return results;
}

// ============================================================
// === COUNCIL MODE - Multi-model query + synthesis ===
// ============================================================

async function councilChat(question, dbContext, history = []) {
  const chatSystem = `אתה יועץ השקעות נדל"ן מומחה של QUANTUM - משרד תיווך מוביל בפינוי-בינוי בישראל.
ענה בעברית. תבסס על הנתונים. תן תובנות חכמות. אל תמציא.
IAI = מדד אטרקטיביות השקעה (0-100). SSI = מדד לחץ מוכר (0-100).
IAI גבוה = הזדמנות טובה יותר. SSI גבוה = מוכר לחוץ יותר.

--- נתוני QUANTUM ---
${dbContext}`;

  logger.info(`[COUNCIL] Starting council mode - 3 Perplexity models${isClaudeConfigured() ? ' + Claude' : ''}`);
  
  const councilModels = [
    { model: 'sonar-pro', label: 'Pro' },
    { model: 'sonar-reasoning-pro', label: 'Reasoning' },
    { model: 'sonar-deep-research', label: 'Deep Research' }
  ];

  // Run all models in parallel
  const promises = councilModels.map(m => 
    isPerplexityConfigured()
      ? callPerplexity(chatSystem, question, { history, temperature: 0.3, model: m.model, maxTokens: m.model === 'sonar-deep-research' ? 8000 : 4000 })
          .then(answer => ({ label: m.label, model: m.model, answer, status: 'ok' }))
          .catch(err => ({ label: m.label, model: m.model, answer: null, status: 'error', error: err.message }))
      : Promise.resolve({ label: m.label, model: m.model, answer: null, status: 'skipped' })
  );

  // Add Claude if configured
  if (isClaudeConfigured()) {
    promises.push(
      callClaude(chatSystem, question, { history })
        .then(answer => ({ label: 'Claude', model: CLAUDE_MODEL, answer, status: 'ok' }))
        .catch(err => ({ label: 'Claude', model: CLAUDE_MODEL, answer: null, status: 'error', error: err.message }))
    );
  }

  const results = await Promise.all(promises);
  const successful = results.filter(r => r.status === 'ok' && r.answer);
  const errors = results.filter(r => r.status === 'error').map(r => `${r.label}: ${r.error}`);

  logger.info(`[COUNCIL] ${successful.length}/${results.length} models responded`);

  if (successful.length === 0) {
    return { answer: 'כל מודלי ה-AI לא זמינים כרגע. נסה שוב.', sources: [], model: 'council', errors };
  }

  if (successful.length === 1) {
    return { 
      answer: successful[0].answer, 
      sources: [successful[0].label], 
      model: `council(${successful[0].model})`, 
      errors 
    };
  }

  // Synthesize all answers into one
  const synthesisSystem = `אתה מסנתז תשובות ממספר מודלי AI לתשובה אחת מושלמת.

כללים:
- שלב את הנקודות החזקות מכל תשובה
- אם המודלים מסכימים - ציין זאת (מחזק את הביטחון)
- אם יש חוסר הסכמה - הצג את שני הצדדים
- תן עדיפות לנתונים ספציפיים (מספרים, תאריכים, שמות)
- התשובה הסופית צריכה להיות מקיפה, ברורה ומקצועית
- אל תציין שמיזגת תשובות - פשוט ענה כמומחה
- ענה בעברית`;

  const synthesisPrompt = `שאלה מקורית: "${question}"

${successful.map((r, i) => `=== תשובה ${i+1} (${r.label}) ===\n${r.answer}`).join('\n\n')}

סנתז לתשובה אחת מושלמת:`;

  try {
    let synthesized;
    if (isClaudeConfigured()) {
      // Claude synthesizes all responses
      synthesized = await callClaude(synthesisSystem, synthesisPrompt, { maxTokens: 6000 });
    } else {
      // Use sonar-pro to synthesize
      synthesized = await callPerplexity(synthesisSystem, synthesisPrompt, { model: 'sonar-pro', maxTokens: 6000 });
    }

    return {
      answer: synthesized,
      sources: successful.map(r => r.label),
      model: 'council',
      council_details: {
        models_queried: results.length,
        models_responded: successful.length,
        models: successful.map(r => r.model),
        synthesizer: isClaudeConfigured() ? 'claude' : 'sonar-pro'
      },
      errors
    };
  } catch (e) {
    // Synthesis failed, return best individual answer (prefer deep research)
    const best = successful.find(r => r.model === 'sonar-deep-research') 
      || successful.find(r => r.model === 'sonar-reasoning-pro')
      || successful[0];
    
    logger.warn(`[COUNCIL] Synthesis failed: ${e.message}, using ${best.label}`);
    return {
      answer: best.answer,
      sources: [best.label],
      model: `council-fallback(${best.model})`,
      errors: [...errors, `Synthesis: ${e.message}`]
    };
  }
}

// === DUAL CHAT (standard) ===

async function dualChat(question, dbContext, history = [], options = {}) {
  const chatModel = options.model || PERPLEXITY_MODEL_DEFAULT;

  // Council mode
  if (chatModel === 'council') {
    return councilChat(question, dbContext, history);
  }

  const chatSystem = `אתה יועץ השקעות נדל"ן מומחה של QUANTUM - משרד תיווך מוביל בפינוי-בינוי בישראל.
ענה בעברית. תבסס על הנתונים. תן תובנות חכמות. אל תמציא.
IAI = מדד אטרקטיביות השקעה (0-100). SSI = מדד לחץ מוכר (0-100).
IAI גבוה = הזדמנות טובה יותר. SSI גבוה = מוכר לחוץ יותר.

--- נתוני QUANTUM ---
${dbContext}`;

  const mergeSystem = `אתה מומחה נדל"ן של QUANTUM. קיבלת שתי תשובות מ-AI שונים על אותה שאלה.
מזג אותן לתשובה אחת מושלמת בעברית:
- קח את הנקודות הטובות מכל תשובה
- אם יש סתירות, ציין את שתי הדעות
- אם אחד נתן מידע שהשני לא - שלב
- התוצאה צריכה להיות תשובה אחת חכמה וברורה
- אל תציין שמיזגת תשובות - פשוט ענה`;

  let perplexityAnswer = null;
  let claudeAnswer = null;
  const errors = [];

  logger.info(`[CHAT] Model: ${chatModel} | Claude: ${isClaudeConfigured() ? 'ON' : 'OFF'}`);

  // Run both AIs in parallel
  const [pRes, cRes] = await Promise.allSettled([
    isPerplexityConfigured()
      ? callPerplexity(chatSystem, question, { 
          history, temperature: 0.3, model: chatModel,
          maxTokens: chatModel === 'sonar-deep-research' ? 8000 : 4000
        })
      : Promise.resolve(null),
    isClaudeConfigured()
      ? callClaude(chatSystem, question, { history })
      : Promise.resolve(null)
  ]);

  if (pRes.status === 'fulfilled' && pRes.value) {
    perplexityAnswer = pRes.value;
    logger.info(`[CHAT] Perplexity answered (${perplexityAnswer.length} chars) [${chatModel}]`);
  } else if (pRes.status === 'rejected') {
    errors.push(`Perplexity: ${pRes.reason?.message}`);
  }

  if (cRes.status === 'fulfilled' && cRes.value) {
    claudeAnswer = cRes.value;
    logger.info(`[CHAT] Claude answered (${claudeAnswer.length} chars)`);
  } else if (cRes.status === 'rejected') {
    errors.push(`Claude: ${cRes.reason?.message}`);
  }

  if (perplexityAnswer && !claudeAnswer) return { answer: perplexityAnswer, sources: ['perplexity'], model: chatModel, errors };
  if (claudeAnswer && !perplexityAnswer) return { answer: claudeAnswer, sources: ['claude'], model: chatModel, errors };
  if (!perplexityAnswer && !claudeAnswer) return { answer: 'מערכות ה-AI לא זמינות כרגע. נסה שוב.', sources: [], model: chatModel, errors };

  // Both answered - Claude merges
  try {
    const mergePrompt = `שאלה מקורית: "${question}"

=== תשובת Perplexity (${chatModel}) ===
${perplexityAnswer}

=== תשובת Claude ===
${claudeAnswer}

מזג לתשובה אחת מושלמת:`;

    const merged = await callClaude(mergeSystem, mergePrompt, { maxTokens: 4000 });
    return { answer: merged, sources: ['perplexity', 'claude', 'merged'], model: chatModel, errors };
  } catch (e) {
    logger.warn(`[CHAT] Merge failed: ${e.message}, using Perplexity answer`);
    return { answer: perplexityAnswer, sources: ['perplexity'], model: chatModel, errors: [...errors, `Merge: ${e.message}`] };
  }
}

module.exports = {
  callPerplexity,
  callClaude,
  isClaudeConfigured,
  isPerplexityConfigured,
  getAvailableModels,
  parseJsonResponse,
  dualScanComplex,
  dualScanAll,
  dualChat,
  councilChat,
  mergeScanResults,
  MODELS,
  PERPLEXITY_MODEL_DEFAULT,
  PERPLEXITY_MODEL_RESEARCH,
  PERPLEXITY_MODEL_DEEP,
  PERPLEXITY_MODEL_SCAN,
  CLAUDE_MODEL,
  queryPerplexity: callPerplexity,
  scanComplex: dualScanComplex,
  scanAll: dualScanAll,
  buildTransactionQuery: buildScanPrompt,
  SYSTEM_PROMPT: SCAN_SYSTEM
};
