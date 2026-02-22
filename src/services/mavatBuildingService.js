/**
 * Mavat Building Details Service v2.1
 * 
 * Uses Gemini + Google Search Grounding to extract per-building
 * unit counts from planning documents, news articles, and municipal sites.
 * 
 * Three-phase approach:
 * Phase A: Find missing plan_numbers via Gemini search
 * Phase B: Extract building-level details with FOCUSED unit-count prompts
 * Phase C: Smart estimation fallback if exact per-building counts unavailable
 *          Now also falls back to existing DB buildings if Phase B fails
 * 
 * Engine: Gemini 2.5 Flash (with Google Search grounding)
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryGemini, sleep } = require('./geminiEnrichmentService');

const DELAY_BETWEEN_CALLS = 2000;

/**
 * Auto-create building_details table if not exists
 */
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS building_details (
      id SERIAL PRIMARY KEY,
      complex_id INTEGER NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
      building_address TEXT,
      building_number TEXT,
      existing_units INTEGER,
      planned_units INTEGER,
      floors_existing INTEGER,
      floors_planned INTEGER,
      notes TEXT,
      source TEXT DEFAULT 'gemini_mavat',
      confidence TEXT DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_building_details_complex ON building_details(complex_id)`);
  
  try {
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_building_scan TIMESTAMP`);
  } catch (e) { /* exists */ }
}

/**
 * Robust JSON parser for Gemini responses
 * Handles: markdown backticks, truncated JSON, partial arrays
 */
function parseGeminiJsonRobust(text) {
  if (!text) return null;

  // Strip markdown backticks first
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (e) { /* continue */ }

  // Try extracting largest JSON object
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (e) { /* continue */ }
  }

  // TRUNCATED JSON RECOVERY: try to fix common truncation patterns
  // Find the start of JSON
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    let partial = cleaned.substring(jsonStart);
    
    // Try progressively closing brackets
    // Count open/close braces and brackets
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escaped = false;
    let lastValidPos = 0;

    for (let i = 0; i < partial.length; i++) {
      const c = partial[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') braceCount++;
      if (c === '}') braceCount--;
      if (c === '[') bracketCount++;
      if (c === ']') bracketCount--;
      if (braceCount >= 0 && bracketCount >= 0) lastValidPos = i;
    }

    // If we're in a truncated string, close it
    if (inString) {
      partial = partial.substring(0, lastValidPos + 1) + '"';
      inString = false;
    }

    // Close open brackets and braces
    let suffix = '';
    // If we're inside a buildings array, close current object and array
    if (partial.includes('"buildings"') && bracketCount > 0) {
      // We're likely inside a truncated building entry
      // Try to find the last complete building entry
      const buildingsMatch = partial.match(/"buildings"\s*:\s*\[/);
      if (buildingsMatch) {
        const arrayStart = partial.indexOf('[', buildingsMatch.index);
        // Find last complete object (ends with })
        let lastCompleteObj = arrayStart;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = arrayStart + 1; i < partial.length; i++) {
          const ch = partial[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') depth++;
          if (ch === '}') { depth--; if (depth === 0) lastCompleteObj = i; }
        }
        
        if (lastCompleteObj > arrayStart) {
          // Truncate to last complete building, close array and object
          partial = partial.substring(0, lastCompleteObj + 1);
          // Count remaining open structures
          let ob = 0, cb = 0;
          inString = false;
          escaped = false;
          for (const ch of partial) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') ob++;
            if (ch === '}') cb++;
            if (ch === '[') bracketCount++;
            if (ch === ']') bracketCount--;
          }
          // Recount brackets from scratch
          let openBraces = 0, openBrackets = 0;
          inString = false;
          escaped = false;
          for (const ch of partial) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') openBraces++;
            if (ch === '}') openBraces--;
            if (ch === '[') openBrackets++;
            if (ch === ']') openBrackets--;
          }
          suffix = ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
        }
      }
    } else {
      // Generic: close remaining structures
      let openBraces = 0, openBrackets = 0;
      inString = false;
      escaped = false;
      for (const ch of partial) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
      }
      suffix = ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
    }

    const recovered = partial + suffix;
    try {
      const parsed = JSON.parse(recovered);
      logger.info(`[MavatBuilding] Recovered truncated JSON (${partial.length} chars + ${suffix.length} closing)`);
      return parsed;
    } catch (e) {
      logger.warn(`[MavatBuilding] JSON recovery failed: ${e.message}`);
    }
  }

  logger.warn('[MavatBuilding] Could not parse JSON from Gemini response', { preview: (text || '').substring(0, 300) });
  return null;
}

/**
 * Enhanced Gemini query with higher token limit for building details
 */
async function queryGeminiBuildings(prompt, systemPrompt) {
  const axios = require('axios');
  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16384  // Much higher limit for building detail responses
    },
    tools: [{ google_search: {} }]
  };

  logger.info(`[Gemini] Calling ${model} (grounding=true, maxTokens=16384)`);
  
  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 90000  // 90s timeout for complex queries
  });

  const candidates = response.data.candidates || [];
  if (candidates.length === 0) return null;

  const parts = candidates[0].content?.parts || [];
  const textParts = parts.filter(p => p.text).map(p => p.text);
  
  if (textParts.length > 0) {
    logger.info(`[Gemini] ${model}: success (${textParts.join('').length} chars)`);
    return textParts.join('\n');
  }
  return null;
}

/**
 * Phase A: Find plan_number for a complex using Gemini Google Search
 */
async function findPlanNumber(complex) {
  const prompt = `Search for the Israeli planning number (taba) of this Pinuy-Binuy project:

Name: "${complex.name}"
City: ${complex.city}
${complex.address ? `Address: ${complex.address}` : ''}
${complex.developer ? `Developer: ${complex.developer}` : ''}

Search mavat.iplan.gov.il, iplan.gov.il, and ${complex.city} municipality website.
Plan numbers look like: XXX-XXXXXXX or תמל/XXXX or city/mk/XXXX

Return ONLY valid JSON (no markdown):
{
  "plan_number": "the plan number or null",
  "plan_name": "official plan name",
  "source": "where found",
  "confidence": "high/medium/low"
}`;

  const systemPrompt = 'Israeli urban planning specialist. Find official plan numbers. Return ONLY valid JSON, no markdown backticks.';

  try {
    const raw = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJsonRobust(raw);
  } catch (err) {
    logger.warn(`[MavatBuilding] findPlanNumber failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Phase B: Extract per-building details with FOCUSED prompts
 * Uses higher token limit and structured prompt for better results
 */
async function fetchBuildingDetails(complex) {
  const planRef = complex.plan_number ? `Plan number: ${complex.plan_number}` : '';
  
  const knownInfo = [];
  if (complex.existing_units) knownInfo.push(`${complex.existing_units} existing units`);
  if (complex.planned_units) knownInfo.push(`${complex.planned_units} planned units`);
  if (complex.num_buildings) knownInfo.push(`${complex.num_buildings} buildings`);
  if (complex.developer) knownInfo.push(`Developer: ${complex.developer}`);

  const prompt = `Find per-building unit breakdown for this Israeli Pinuy-Binuy project:

Project: "${complex.name}"
City: ${complex.city}
${planRef}
${complex.address ? `Area: ${complex.address}` : ''}
Known info: ${knownInfo.join(', ') || 'none'}

I need a SEPARATE entry for EACH building address. Do NOT combine all addresses into one entry.

For each building, find:
- How many apartments exist today (before demolition)
- How many apartments are planned (after construction)  
- How many floors planned

Search these sources:
- News: ynet, calcalist, globes, TheMarker, nadlancenter.co.il, magdilim.co.il
- Municipal: ${complex.city} municipality website
- Developer: ${complex.developer || ''} website
- Planning: mavat.iplan.gov.il area tables (טבלאות שטחים)
- Real estate: madlan.co.il, yad2.co.il

CRITICAL RULES:
1. Each building = separate JSON entry with ONE address (e.g. "בן צבי 13", NOT "בן צבי 13,14,15...")
2. If source says "320 units in 13 buildings" and you can't find per-building, set existing_units to null
3. Include floors_planned if available (e.g. "5-16 floors" means different buildings have different heights)

Return ONLY valid JSON (NO markdown backticks, NO \`\`\`):
{
  "buildings": [
    {
      "address": "street name and number",
      "existing_units": null,
      "planned_units": null,
      "floors_existing": null,
      "floors_planned": null,
      "building_type": "tower/midrise/lowrise",
      "notes": ""
    }
  ],
  "total_existing_units": 0,
  "total_planned_units": 0,
  "plan_number": "${complex.plan_number || 'null'}",
  "source": "sources used",
  "data_quality": "high/medium/low"
}`;

  const systemPrompt = `You are an Israeli real estate data specialist. Find SPECIFIC per-building unit counts. Each building MUST be a SEPARATE entry with its own address. Return ONLY raw JSON - absolutely no markdown code fences or backticks. If you write \`\`\`json you have FAILED.`;

  try {
    const raw = await queryGeminiBuildings(prompt, systemPrompt);
    return parseGeminiJsonRobust(raw);
  } catch (err) {
    logger.warn(`[MavatBuilding] fetchBuildingDetails failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Phase C: Smart estimation - distribute known totals across buildings
 * Uses building typology (floors/type) to estimate per-building unit counts
 */
function estimateBuildingUnits(buildings, totalExisting, totalPlanned) {
  if (!buildings || buildings.length === 0) return buildings;
  if (!totalExisting && !totalPlanned) return buildings;

  const hasExisting = buildings.some(b => b.existing_units && b.existing_units > 0);
  const hasPlanned = buildings.some(b => b.planned_units && b.planned_units > 0);

  // Estimate EXISTING units if we have total but not per-building
  if (totalExisting && !hasExisting) {
    const numBuildings = buildings.length;
    
    // First pass: use floor count for proportional distribution
    buildings.forEach(b => {
      if (b.floors_existing) {
        b.existing_units = b.floors_existing * 4; // ~4 units/floor for old Israeli buildings
      } else {
        b.existing_units = Math.round(totalExisting / numBuildings);
      }
    });

    // Normalize to match total exactly
    const sum = buildings.reduce((s, b) => s + (b.existing_units || 0), 0);
    if (sum !== totalExisting && sum > 0) {
      const ratio = totalExisting / sum;
      let runningTotal = 0;
      buildings.forEach((b, i) => {
        if (i < buildings.length - 1) {
          b.existing_units = Math.round((b.existing_units || 0) * ratio);
          runningTotal += b.existing_units;
        } else {
          b.existing_units = totalExisting - runningTotal;
        }
      });
    }
    buildings.forEach(b => { b.confidence = 'estimated'; });
  }

  // Estimate PLANNED units if we have total but not per-building
  if (totalPlanned && !hasPlanned) {
    const hasFloorData = buildings.some(b => b.floors_planned && b.floors_planned > 0);
    
    if (hasFloorData) {
      const totalWeight = buildings.reduce((s, b) => {
        const floors = b.floors_planned || 8;
        const unitsPerFloor = floors > 15 ? 8 : 6;
        return s + (floors * unitsPerFloor);
      }, 0);

      let distributed = 0;
      buildings.forEach((b, i) => {
        const floors = b.floors_planned || 8;
        const unitsPerFloor = floors > 15 ? 8 : 6;
        const weight = (floors * unitsPerFloor) / totalWeight;
        
        if (i < buildings.length - 1) {
          b.planned_units = Math.round(totalPlanned * weight);
          distributed += b.planned_units;
        } else {
          b.planned_units = totalPlanned - distributed;
        }
        b.confidence = 'estimated';
      });
    } else {
      // Even distribution
      let distributed = 0;
      const avg = Math.round(totalPlanned / buildings.length);
      buildings.forEach((b, i) => {
        if (i < buildings.length - 1) {
          b.planned_units = avg;
          distributed += avg;
        } else {
          b.planned_units = totalPlanned - distributed;
        }
        b.confidence = 'estimated';
      });
    }
  }

  return buildings;
}

/**
 * Get existing buildings from DB for fallback estimation
 */
async function getExistingBuildingsFromDB(complexId) {
  try {
    const result = await pool.query(
      `SELECT building_address, building_number, existing_units, planned_units,
              floors_existing, floors_planned, notes, confidence
       FROM building_details WHERE complex_id = $1
       ORDER BY building_address`,
      [complexId]
    );
    return result.rows.map(r => ({
      address: r.building_address,
      building_number: r.building_number,
      existing_units: r.existing_units,
      planned_units: r.planned_units,
      floors_existing: r.floors_existing,
      floors_planned: r.floors_planned,
      notes: r.notes,
      confidence: r.confidence
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Save building details to database
 */
async function saveBuildingDetails(complexId, buildings, source) {
  if (!buildings || buildings.length === 0) return 0;

  await pool.query('DELETE FROM building_details WHERE complex_id = $1', [complexId]);

  let saved = 0;
  for (const b of buildings) {
    try {
      await pool.query(
        `INSERT INTO building_details 
         (complex_id, building_address, building_number, existing_units, planned_units, 
          floors_existing, floors_planned, notes, source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          complexId,
          b.address || null,
          b.building_id || b.building_number || null,
          b.existing_units || null,
          b.planned_units || null,
          b.floors_existing || null,
          b.floors_planned || null,
          b.notes || null,
          source || 'gemini_mavat',
          b.confidence || 'medium'
        ]
      );
      saved++;
    } catch (err) {
      logger.warn(`[MavatBuilding] save failed for building ${b.address}: ${err.message}`);
    }
  }

  await pool.query(
    'UPDATE complexes SET last_building_scan = NOW() WHERE id = $1',
    [complexId]
  );

  return saved;
}

/**
 * Full enrichment for a single complex
 * Phase A -> Phase B -> Phase C (estimation fallback, including DB fallback)
 */
async function enrichComplex(complexId) {
  await ensureTable();

  const result = await pool.query(
    `SELECT id, name, city, address, addresses, plan_number, developer, 
            neighborhood, num_buildings, existing_units, planned_units, status
     FROM complexes WHERE id = $1`,
    [complexId]
  );

  if (result.rows.length === 0) {
    return { status: 'error', error: 'Complex not found' };
  }

  const complex = result.rows[0];
  logger.info(`[MavatBuilding] Enriching: ${complex.name} (${complex.city})`);

  // Phase A: Find plan_number if missing
  let planUpdated = false;
  if (!complex.plan_number) {
    logger.info(`[MavatBuilding] Phase A: Finding plan_number for ${complex.name}`);
    const planData = await findPlanNumber(complex);
    
    if (planData && planData.plan_number && planData.plan_number !== 'null' && planData.plan_number !== null) {
      await pool.query(
        'UPDATE complexes SET plan_number = $1 WHERE id = $2 AND plan_number IS NULL',
        [planData.plan_number, complexId]
      );
      complex.plan_number = planData.plan_number;
      planUpdated = true;
      logger.info(`[MavatBuilding] Found plan_number: ${planData.plan_number} (${planData.confidence})`);
    }
    
    await sleep(DELAY_BETWEEN_CALLS);
  }

  // Phase B: Get building details with focused prompt
  logger.info(`[MavatBuilding] Phase B: Fetching building details for ${complex.name}`);
  const buildingData = await fetchBuildingDetails(complex);

  let buildings = [];
  let dataSource = 'gemini_mavat';
  let phaseUsed = 'B';

  if (buildingData && buildingData.buildings && buildingData.buildings.length > 0) {
    buildings = buildingData.buildings;
    
    // Filter out combined entries (address contains comma or semicolon with multiple numbers)
    const validBuildings = buildings.filter(b => {
      if (!b.address) return false;
      // Reject entries that list multiple addresses
      const commaCount = (b.address.match(/,/g) || []).length;
      const semicolonCount = (b.address.match(/;/g) || []).length;
      return commaCount < 2 && semicolonCount < 1;
    });

    if (validBuildings.length > 0) {
      buildings = validBuildings;
    } else if (buildings.length === 1 && buildings[0].address && buildings[0].address.length > 50) {
      // Single combined entry - Gemini lumped everything together. Discard and use DB fallback.
      logger.warn(`[MavatBuilding] Gemini returned combined address entry, discarding`);
      buildings = [];
    }
  }

  // FALLBACK: If Phase B returned no valid buildings, use existing DB buildings
  if (buildings.length === 0) {
    const dbBuildings = await getExistingBuildingsFromDB(complexId);
    if (dbBuildings.length > 0) {
      logger.info(`[MavatBuilding] Using ${dbBuildings.length} existing DB buildings for estimation fallback`);
      buildings = dbBuildings;
      dataSource = 'db_fallback+estimation';
      phaseUsed = 'C_db_fallback';
    }
  }

  // If still no buildings at all, return no_data
  if (buildings.length === 0) {
    await pool.query('UPDATE complexes SET last_building_scan = NOW() WHERE id = $1', [complexId]);
    return {
      status: 'no_building_data',
      complexId,
      name: complex.name,
      city: complex.city,
      plan_number_found: planUpdated ? complex.plan_number : null,
      data_quality: buildingData?.data_quality || 'none'
    };
  }

  // Phase C: Smart estimation if per-building units are missing
  const totalExisting = (buildingData && buildingData.total_existing_units) || complex.existing_units;
  const totalPlanned = (buildingData && buildingData.total_planned_units) || complex.planned_units;
  
  const hadUnitsBeforeEstimation = buildings.some(b => (b.existing_units && b.existing_units > 0) || (b.planned_units && b.planned_units > 0));
  
  if (!hadUnitsBeforeEstimation && (totalExisting || totalPlanned)) {
    logger.info(`[MavatBuilding] Phase C: Estimating units for ${buildings.length} buildings (total: ${totalExisting}->${totalPlanned})`);
    buildings = estimateBuildingUnits(buildings, totalExisting, totalPlanned);
    if (dataSource === 'gemini_mavat') dataSource = 'gemini_mavat+estimation';
  }

  // Determine data quality
  let dataQuality = (buildingData && buildingData.data_quality) || 'medium';
  if (!hadUnitsBeforeEstimation && buildings.some(b => b.confidence === 'estimated')) {
    dataQuality = 'estimated';
  }

  // Save buildings
  const savedCount = await saveBuildingDetails(complexId, buildings, dataSource);

  // Update complex totals if we got better data
  if (buildingData && buildingData.total_existing_units && !complex.existing_units) {
    await pool.query(
      'UPDATE complexes SET existing_units = $1 WHERE id = $2',
      [buildingData.total_existing_units, complexId]
    );
  }
  if (buildingData && buildingData.total_planned_units && !complex.planned_units) {
    await pool.query(
      'UPDATE complexes SET planned_units = $1 WHERE id = $2',
      [buildingData.total_planned_units, complexId]
    );
  }
  if (buildingData && buildingData.plan_number && buildingData.plan_number !== 'null' && !complex.plan_number) {
    await pool.query(
      'UPDATE complexes SET plan_number = $1 WHERE id = $2',
      [buildingData.plan_number, complexId]
    );
  }

  // Summary stats
  const sumExisting = buildings.reduce((s, b) => s + (b.existing_units || 0), 0);
  const sumPlanned = buildings.reduce((s, b) => s + (b.planned_units || 0), 0);

  return {
    status: 'success',
    complexId,
    name: complex.name,
    city: complex.city,
    plan_number: complex.plan_number || (buildingData && buildingData.plan_number),
    plan_number_found: planUpdated,
    buildings_found: buildings.length,
    buildings_saved: savedCount,
    total_existing: sumExisting || totalExisting,
    total_planned: sumPlanned || totalPlanned,
    estimation_used: !hadUnitsBeforeEstimation,
    phase_used: phaseUsed,
    data_quality: dataQuality,
    source: dataSource
  };
}

/**
 * Batch scan: enrich all complexes missing building data
 */
async function batchEnrich(options = {}) {
  await ensureTable();
  
  const { city, limit = 10, staleOnly = true } = options;

  let query = `SELECT id, name, city FROM complexes 
               WHERE status NOT IN ('unknown')
               AND num_buildings IS NOT NULL AND num_buildings > 0`;
  const params = [];
  let idx = 1;

  if (staleOnly) {
    query += ` AND (last_building_scan IS NULL OR last_building_scan < NOW() - INTERVAL '7 days')`;
  }

  if (city) {
    query += ` AND city = $${idx}`;
    params.push(city);
    idx++;
  }

  query += ` ORDER BY CASE status
    WHEN 'deposited' THEN 1 WHEN 'approved' THEN 2 
    WHEN 'pre_deposit' THEN 3 WHEN 'permit' THEN 4
    WHEN 'planning' THEN 5 ELSE 6 END,
    last_building_scan ASC NULLS FIRST`;

  query += ` LIMIT $${idx}`;
  params.push(limit);

  const result = await pool.query(query, params);
  logger.info(`[MavatBuilding] Batch: ${result.rows.length} complexes to scan`);

  const results = {
    total: result.rows.length,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    plan_numbers_found: 0,
    buildings_found: 0,
    estimation_used: 0,
    details: []
  };

  for (const complex of result.rows) {
    try {
      const scanResult = await enrichComplex(complex.id);
      results.scanned++;

      if (scanResult.status === 'success') {
        results.succeeded++;
        results.buildings_found += scanResult.buildings_saved || 0;
        if (scanResult.plan_number_found) results.plan_numbers_found++;
        if (scanResult.estimation_used) results.estimation_used++;
      } else {
        results.failed++;
      }

      results.details.push(scanResult);
      await sleep(DELAY_BETWEEN_CALLS);
    } catch (err) {
      results.scanned++;
      results.failed++;
      logger.error(`[MavatBuilding] Error: ${complex.name}`, { error: err.message });
      results.details.push({ status: 'error', name: complex.name, error: err.message });
    }
  }

  logger.info(`[MavatBuilding] Batch complete: ${results.succeeded}/${results.total} succeeded, ${results.buildings_found} buildings, ${results.estimation_used} estimated`);
  return results;
}

/**
 * Get building details for a complex from DB
 */
async function getBuildingDetails(complexId) {
  await ensureTable();
  
  const complex = await pool.query(
    `SELECT id, name, city, plan_number, num_buildings, existing_units, planned_units,
            last_building_scan
     FROM complexes WHERE id = $1`,
    [complexId]
  );

  if (complex.rows.length === 0) return null;

  const buildings = await pool.query(
    `SELECT building_address, building_number, existing_units, planned_units,
            floors_existing, floors_planned, notes, source, confidence, updated_at
     FROM building_details WHERE complex_id = $1
     ORDER BY building_address`,
    [complexId]
  );

  const summary = {
    total_existing: buildings.rows.reduce((s, b) => s + (b.existing_units || 0), 0),
    total_planned: buildings.rows.reduce((s, b) => s + (b.planned_units || 0), 0),
    buildings_with_data: buildings.rows.filter(b => b.existing_units || b.planned_units).length,
    has_exact_data: buildings.rows.some(b => b.confidence !== 'estimated'),
    estimation_used: buildings.rows.some(b => b.confidence === 'estimated')
  };

  return {
    complex: complex.rows[0],
    buildings: buildings.rows,
    total_buildings: buildings.rows.length,
    summary,
    last_scan: complex.rows[0].last_building_scan
  };
}

module.exports = {
  ensureTable,
  findPlanNumber,
  fetchBuildingDetails,
  estimateBuildingUnits,
  saveBuildingDetails,
  enrichComplex,
  batchEnrich,
  getBuildingDetails,
  parseGeminiJsonRobust
};
