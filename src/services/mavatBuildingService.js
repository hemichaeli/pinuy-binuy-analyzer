/**
 * Mavat Building Details Service v2.4
 * 
 * Uses Gemini + Google Search Grounding to extract per-building
 * unit counts from planning documents, news articles, and municipal sites.
 * 
 * Three-phase approach:
 * Phase A: Find missing plan_numbers via Gemini search
 * Phase B: Extract building-level details with FOCUSED unit-count prompts
 *          Now with combined-address splitting for better granularity
 * Phase C: Smart estimation fallback if exact per-building counts unavailable
 *          Falls back to existing DB buildings if Phase B fails entirely
 * 
 * v2.4 fixes: combined address splitting, robust DB fallback with logging,
 *             improved Gemini prompts, better truncated JSON recovery
 * 
 * Engine: Gemini 2.5 Flash (with Google Search grounding)
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryGemini, sleep } = require('./geminiEnrichmentService');

const DELAY_BETWEEN_CALLS = 2000;

/**
 * Sanitize value to integer for PostgreSQL
 * Handles: ranges "6-15" -> max, strings "~20" -> 20, null/undefined -> null
 */
function sanitizeInt(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : Math.round(val);
  const str = String(val).trim();
  if (!str) return null;
  // Handle ranges like "6-15" or "6\u201315" -> take max
  const rangeMatch = str.match(/(\d+)\s*[-\u2013\u2014]\s*(\d+)/);
  if (rangeMatch) return Math.max(parseInt(rangeMatch[1]), parseInt(rangeMatch[2]));
  // Handle simple numbers possibly with text like "~20" or "about 30"
  const numMatch = str.match(/(\d+)/);
  if (numMatch) return parseInt(numMatch[1]);
  return null;
}

/**
 * Sanitize plan_number - extract clean identifier from Gemini response
 * Rejects full sentences, keeps only plan number patterns
 */
function sanitizePlanNumber(val) {
  if (!val || val === 'null' || val === 'None') return null;
  const str = String(val).trim();
  if (str.length > 80) return null;
  if (/\b(not|found|explicitly|process|known|project|the)\b/i.test(str)) return null;
  if (/\u05dc\u05d0 \u05e0\u05de\u05e6\u05d0|\u05dc\u05d0 \u05d9\u05d3\u05d5\u05e2|\u05d1\u05ea\u05d4\u05dc\u05d9\u05da|\u05d4\u05ea\u05d5\u05db\u05e0\u05d9\u05ea/.test(str)) return null;
  return str;
}

/**
 * Split a combined address entry into individual buildings
 * 
 * Handles patterns like:
 * - "בן צבי 13, 14, 15, 16" -> ["בן צבי 13", "בן צבי 14", ...]
 * - "כצנלסון 14-28" -> ["כצנלסון 14", "כצנלסון 16", ...] (even numbers)
 * - "מתחם בן צבי (כתובות: בן צבי 13, 24, 26)" -> ["בן צבי 13", "בן צבי 24", ...]
 * - "בן צבי 13; כצנלסון 14, 16" -> ["בן צבי 13", "כצנלסון 14", "כצנלסון 16"]
 */
function splitCombinedAddress(addressStr) {
  if (!addressStr) return [];
  
  const results = [];
  let text = addressStr;
  
  // Remove parenthetical labels like "(כתובות קיימות:...)"
  text = text.replace(/\([^)]*\)\s*/g, '');
  // Remove "מתחם" prefix
  text = text.replace(/^\u05de\u05ea\u05d7\u05dd\s+/i, '');
  
  // Split by semicolons first (different streets)
  const segments = text.split(/[;]/);
  
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    
    // Check if this is "street name number, number, number..."
    // Hebrew street pattern: letters + numbers
    const streetMatch = trimmed.match(/^([^\d]+?)(\d[\d\s,\-\u2013\u2014]*)/);
    
    if (streetMatch) {
      const streetName = streetMatch[1].trim();
      const numbersStr = streetMatch[2].trim();
      
      // Split the numbers by commas
      const numberParts = numbersStr.split(/[,]/);
      
      for (const numPart of numberParts) {
        const cleaned = numPart.trim();
        if (!cleaned) continue;
        
        // Check for range like "14-28"
        const rangeMatch = cleaned.match(/^(\d+)\s*[-\u2013\u2014]\s*(\d+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = parseInt(rangeMatch[2]);
          // Generate even numbers (common for Israeli streets)
          const step = (end - start > 4) ? 2 : 1;
          for (let n = start; n <= end; n += step) {
            results.push(`${streetName} ${n}`);
          }
        } else {
          // Single number
          const num = cleaned.match(/\d+/);
          if (num) {
            results.push(`${streetName} ${num[0]}`);
          }
        }
      }
    } else {
      // No pattern found, keep as-is
      results.push(trimmed);
    }
  }
  
  return results;
}

/**
 * Take Gemini buildings array and split any combined-address entries
 * Returns expanded array where each entry has a single address
 */
function expandCombinedBuildings(buildings) {
  if (!buildings || buildings.length === 0) return [];
  
  const expanded = [];
  
  for (const b of buildings) {
    if (!b.address) {
      expanded.push(b);
      continue;
    }
    
    const addr = b.address;
    const commaCount = (addr.match(/,/g) || []).length;
    const semicolonCount = (addr.match(/;/g) || []).length;
    const isLong = addr.length > 50;
    
    // If it looks like a combined address, split it
    if (commaCount >= 2 || semicolonCount >= 1 || isLong) {
      const splitAddresses = splitCombinedAddress(addr);
      
      if (splitAddresses.length > 1) {
        logger.info(`[MavatBuilding] Split combined address into ${splitAddresses.length} buildings`);
        for (const splitAddr of splitAddresses) {
          expanded.push({
            address: splitAddr,
            existing_units: null, // Can't distribute without more info
            planned_units: null,
            floors_existing: b.floors_existing,
            floors_planned: b.floors_planned,
            building_type: b.building_type,
            notes: b.notes ? `Split from combined. ${b.notes}` : 'Split from combined address',
            confidence: 'low'
          });
        }
        continue;
      }
    }
    
    // Single address, keep as-is
    expanded.push(b);
  }
  
  return expanded;
}

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

  // TRUNCATED JSON RECOVERY
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    let partial = cleaned.substring(jsonStart);
    
    // If inside buildings array, find last complete building object
    if (partial.includes('"buildings"')) {
      const arrMatch = partial.match(/"buildings"\s*:\s*\[/);
      if (arrMatch) {
        const arrayStart = partial.indexOf('[', arrMatch.index);
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
          // Truncate after last complete object, close the array and root object
          const truncated = partial.substring(0, lastCompleteObj + 1) + ']}';
          try {
            const parsed = JSON.parse(truncated);
            logger.info(`[MavatBuilding] Recovered truncated JSON via last-complete-object method`);
            return parsed;
          } catch (e) { /* try next method */ }
        }
      }
    }

    // Generic: Count and close remaining open structures
    let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
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
    const suffix = ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));

    try {
      const parsed = JSON.parse(partial + suffix);
      logger.info(`[MavatBuilding] Recovered truncated JSON (${partial.length} chars + ${suffix.length} closing)`);
      return parsed;
    } catch (e) {
      logger.warn(`[MavatBuilding] JSON recovery failed: ${e.message}`);
    }
  }

  logger.warn('[MavatBuilding] Could not parse JSON from Gemini response', { preview: (text || '').substring(0, 500) });
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
      maxOutputTokens: 16384
    },
    tools: [{ google_search: {} }]
  };

  logger.info(`[Gemini] Calling ${model} (grounding=true, maxTokens=16384)`);
  
  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 90000
  });

  const candidates = response.data.candidates || [];
  if (candidates.length === 0) return null;

  const parts = candidates[0].content?.parts || [];
  const textParts = parts.filter(p => p.text).map(p => p.text);
  
  if (textParts.length > 0) {
    const fullText = textParts.join('\n');
    logger.info(`[Gemini] ${model}: success (${fullText.length} chars)`);
    return fullText;
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
Plan numbers look like: XXX-XXXXXXX or \u05EA\u05DE\u05DC/XXXX or city/mk/XXXX

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
 * v2.4: Stronger prompt for individual building separation
 */
async function fetchBuildingDetails(complex) {
  const planRef = complex.plan_number ? `Plan number: ${complex.plan_number}` : '';
  
  const knownInfo = [];
  if (complex.existing_units) knownInfo.push(`Total existing: ${complex.existing_units} units`);
  if (complex.planned_units) knownInfo.push(`Total planned: ${complex.planned_units} units`);
  if (complex.num_buildings) knownInfo.push(`Number of buildings: ${complex.num_buildings}`);
  if (complex.developer) knownInfo.push(`Developer: ${complex.developer}`);

  // v2.4: Much more explicit prompt with example
  const prompt = `Find the list of building addresses in this Israeli Pinuy-Binuy (\u05E4\u05D9\u05E0\u05D5\u05D9-\u05D1\u05D9\u05E0\u05D5\u05D9) project:

Project: "${complex.name}"
City: ${complex.city}
${planRef}
${complex.address ? `Area: ${complex.address}` : ''}
${knownInfo.join('\n')}

TASK: List EVERY building address separately. One JSON entry per building number.

EXAMPLE of correct format:
{
  "buildings": [
    {"address": "\u05D1\u05DF \u05E6\u05D1\u05D9 13", "existing_units": 24, "planned_units": 80, "floors_existing": 4, "floors_planned": 12, "building_type": "midrise", "notes": ""},
    {"address": "\u05D1\u05DF \u05E6\u05D1\u05D9 15", "existing_units": 20, "planned_units": 72, "floors_existing": 4, "floors_planned": 10, "building_type": "midrise", "notes": ""},
    {"address": "\u05DB\u05E6\u05E0\u05DC\u05E1\u05D5\u05DF 14", "existing_units": 16, "planned_units": 64, "floors_existing": 3, "floors_planned": 8, "building_type": "midrise", "notes": ""}
  ]
}

WRONG (do NOT do this):
{"address": "\u05D1\u05DF \u05E6\u05D1\u05D9 13, 15, 17, 19"} <-- WRONG! Must be separate entries

Search these sources for the building list:
- mavat.iplan.gov.il (plan ${complex.plan_number || ''})
- ${complex.city} municipality website
- News: calcalist, globes, ynet, nadlancenter.co.il
- Developer: ${complex.developer || 'unknown'}

For each building find: existing_units, planned_units, floors_existing, floors_planned.
All numbers must be integers or null. If unknown, use null.

Return ONLY raw JSON (NO \`\`\` backticks):
{
  "buildings": [...],
  "total_existing_units": ${complex.existing_units || 'null'},
  "total_planned_units": ${complex.planned_units || 'null'},
  "plan_number": "${complex.plan_number || 'null'}",
  "source": "sources used",
  "data_quality": "high/medium/low"
}`;

  const systemPrompt = `You are an Israeli real estate data specialist. CRITICAL: Return ONE entry per building address. Never combine multiple addresses into one entry. All numeric fields must be integers or null, never strings or ranges. Return raw JSON only, no markdown.`;

  try {
    const raw = await queryGeminiBuildings(prompt, systemPrompt);
    const parsed = parseGeminiJsonRobust(raw);
    
    if (parsed) {
      logger.info(`[MavatBuilding] Phase B parsed: ${parsed.buildings?.length || 0} buildings, quality: ${parsed.data_quality || 'unknown'}`);
    } else {
      logger.warn(`[MavatBuilding] Phase B: JSON parse failed for ${complex.name}`);
    }
    
    return parsed;
  } catch (err) {
    logger.warn(`[MavatBuilding] fetchBuildingDetails failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Phase C: Smart estimation - distribute known totals across buildings
 * v2.3: Handles existing and planned INDEPENDENTLY
 */
function estimateBuildingUnits(buildings, totalExisting, totalPlanned) {
  if (!buildings || buildings.length === 0) return { buildings, estimationApplied: false };
  if (!totalExisting && !totalPlanned) return { buildings, estimationApplied: false };

  const hasExisting = buildings.some(b => b.existing_units && b.existing_units > 0);
  const hasPlanned = buildings.some(b => b.planned_units && b.planned_units > 0);
  let estimationApplied = false;

  // Estimate EXISTING units if missing
  if (totalExisting && !hasExisting) {
    const numBuildings = buildings.length;
    buildings.forEach(b => {
      const floors = sanitizeInt(b.floors_existing);
      if (floors) {
        b.existing_units = floors * 4;
      } else {
        b.existing_units = Math.round(totalExisting / numBuildings);
      }
    });

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
    estimationApplied = true;
    logger.info(`[MavatBuilding] Estimated existing_units: ${totalExisting} across ${numBuildings} buildings`);
  }

  // Estimate PLANNED units if missing (independent of existing)
  if (totalPlanned && !hasPlanned) {
    const hasFloorData = buildings.some(b => {
      const f = sanitizeInt(b.floors_planned);
      return f && f > 0;
    });
    
    if (hasFloorData) {
      const totalWeight = buildings.reduce((s, b) => {
        const floors = sanitizeInt(b.floors_planned) || 8;
        const unitsPerFloor = floors > 15 ? 8 : 6;
        return s + (floors * unitsPerFloor);
      }, 0);

      let distributed = 0;
      buildings.forEach((b, i) => {
        const floors = sanitizeInt(b.floors_planned) || 8;
        const unitsPerFloor = floors > 15 ? 8 : 6;
        const weight = (floors * unitsPerFloor) / totalWeight;
        
        if (i < buildings.length - 1) {
          b.planned_units = Math.round(totalPlanned * weight);
          distributed += b.planned_units;
        } else {
          b.planned_units = totalPlanned - distributed;
        }
      });
    } else {
      let distributed = 0;
      const avg = Math.round(totalPlanned / buildings.length);
      buildings.forEach((b, i) => {
        if (i < buildings.length - 1) {
          b.planned_units = avg;
          distributed += avg;
        } else {
          b.planned_units = totalPlanned - distributed;
        }
      });
    }
    estimationApplied = true;
    logger.info(`[MavatBuilding] Estimated planned_units: ${totalPlanned} across ${buildings.length} buildings`);
  }

  // Mark confidence on buildings where estimation was applied
  if (estimationApplied) {
    buildings.forEach(b => {
      const existingWasEstimated = totalExisting && !hasExisting;
      const plannedWasEstimated = totalPlanned && !hasPlanned;
      if (existingWasEstimated && plannedWasEstimated) {
        b.confidence = 'estimated';
      } else if (existingWasEstimated || plannedWasEstimated) {
        b.confidence = b.confidence === 'medium' ? 'partial_estimated' : b.confidence;
      }
    });
  }

  return { buildings, estimationApplied };
}

/**
 * Get existing buildings from DB for fallback estimation
 * v2.4: Added explicit error logging
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
    logger.info(`[MavatBuilding] DB fallback query returned ${result.rows.length} buildings for complex ${complexId}`);
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
    logger.error(`[MavatBuilding] DB fallback query FAILED for complex ${complexId}: ${e.message}`);
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
          sanitizeInt(b.existing_units),
          sanitizeInt(b.planned_units),
          sanitizeInt(b.floors_existing),
          sanitizeInt(b.floors_planned),
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
 * v2.4: Combined address splitting + robust DB fallback
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
    
    if (planData && planData.plan_number) {
      const cleanPlan = sanitizePlanNumber(planData.plan_number);
      if (cleanPlan) {
        await pool.query(
          'UPDATE complexes SET plan_number = $1 WHERE id = $2 AND plan_number IS NULL',
          [cleanPlan, complexId]
        );
        complex.plan_number = cleanPlan;
        planUpdated = true;
        logger.info(`[MavatBuilding] Found plan_number: ${cleanPlan} (${planData.confidence})`);
      } else {
        logger.warn(`[MavatBuilding] Rejected invalid plan_number: "${String(planData.plan_number).substring(0, 80)}"`);
      }
    }
    
    await sleep(DELAY_BETWEEN_CALLS);
  }

  // Phase B: Get building details
  logger.info(`[MavatBuilding] Phase B: Fetching building details for ${complex.name}`);
  const buildingData = await fetchBuildingDetails(complex);

  let buildings = [];
  let dataSource = 'gemini_mavat';
  let phaseUsed = 'B';

  if (buildingData && buildingData.buildings && buildingData.buildings.length > 0) {
    // v2.4: EXPAND combined addresses instead of filtering them out
    buildings = expandCombinedBuildings(buildingData.buildings);
    logger.info(`[MavatBuilding] After expansion: ${buildings.length} buildings (from ${buildingData.buildings.length} Gemini entries)`);
    
    // Only discard if expansion produced nothing useful
    if (buildings.length === 0) {
      logger.warn(`[MavatBuilding] Building expansion produced 0 results`);
    }
  } else {
    logger.info(`[MavatBuilding] Phase B returned no buildings`);
  }

  // Sanitize plan_number from buildingData too
  if (buildingData && buildingData.plan_number) {
    buildingData.plan_number = sanitizePlanNumber(buildingData.plan_number);
  }

  // FALLBACK: Use existing DB buildings if Phase B failed
  if (buildings.length === 0) {
    logger.info(`[MavatBuilding] Phase B failed, trying DB fallback for complex ${complexId}`);
    const dbBuildings = await getExistingBuildingsFromDB(complexId);
    if (dbBuildings.length > 0) {
      logger.info(`[MavatBuilding] DB fallback: found ${dbBuildings.length} buildings, using for estimation`);
      buildings = dbBuildings;
      dataSource = 'db_fallback+estimation';
      phaseUsed = 'C_db_fallback';
    } else {
      logger.info(`[MavatBuilding] DB fallback: no existing buildings found`);
    }
  }

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

  // Phase C: Smart estimation - ALWAYS run, let function decide what to estimate
  const totalExisting = (buildingData && buildingData.total_existing_units) || complex.existing_units;
  const totalPlanned = (buildingData && buildingData.total_planned_units) || complex.planned_units;
  
  logger.info(`[MavatBuilding] Phase C: Estimation check - ${buildings.length} buildings, totalExisting=${totalExisting}, totalPlanned=${totalPlanned}`);
  
  const { buildings: estimatedBuildings, estimationApplied } = estimateBuildingUnits(
    buildings, totalExisting, totalPlanned
  );
  buildings = estimatedBuildings;

  if (estimationApplied && dataSource === 'gemini_mavat') {
    dataSource = 'gemini_mavat+estimation';
  }

  let dataQuality = (buildingData && buildingData.data_quality) || 'medium';
  if (estimationApplied) {
    const hasAnyExact = buildings.some(b => b.confidence !== 'estimated' && b.confidence !== 'partial_estimated');
    dataQuality = hasAnyExact ? 'mixed' : 'estimated';
  }

  const savedCount = await saveBuildingDetails(complexId, buildings, dataSource);

  // Update complex totals if we got new info
  if (buildingData && buildingData.total_existing_units && !complex.existing_units) {
    await pool.query('UPDATE complexes SET existing_units = $1 WHERE id = $2', [buildingData.total_existing_units, complexId]);
  }
  if (buildingData && buildingData.total_planned_units && !complex.planned_units) {
    await pool.query('UPDATE complexes SET planned_units = $1 WHERE id = $2', [buildingData.total_planned_units, complexId]);
  }
  if (buildingData && buildingData.plan_number && !complex.plan_number) {
    await pool.query('UPDATE complexes SET plan_number = $1 WHERE id = $2', [buildingData.plan_number, complexId]);
  }

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
    estimation_used: estimationApplied,
    phase_used: phaseUsed,
    data_quality: dataQuality,
    source: dataSource
  };
}

/**
 * Batch scan
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
 * Get building details from DB
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
    has_exact_data: buildings.rows.some(b => b.confidence !== 'estimated' && b.confidence !== 'partial_estimated'),
    estimation_used: buildings.rows.some(b => b.confidence === 'estimated' || b.confidence === 'partial_estimated')
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
  parseGeminiJsonRobust,
  sanitizeInt,
  sanitizePlanNumber,
  splitCombinedAddress,
  expandCombinedBuildings
};
