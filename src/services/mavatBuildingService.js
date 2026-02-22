/**
 * Mavat Building Details Service v2
 * 
 * Uses Gemini + Google Search Grounding to extract per-building
 * unit counts from planning documents, news articles, and municipal sites.
 * 
 * Three-phase approach:
 * Phase A: Find missing plan_numbers via Gemini search
 * Phase B: Extract building-level details with FOCUSED unit-count prompts
 * Phase C: Smart estimation fallback if exact per-building counts unavailable
 * 
 * Engine: Gemini 2.5 Flash (with Google Search grounding)
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryGemini, parseGeminiJson, sleep } = require('./geminiEnrichmentService');

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
 * Phase A: Find plan_number for a complex using Gemini Google Search
 */
async function findPlanNumber(complex) {
  const prompt = `חפש את מספר התכנית (תב"ע) של פרויקט פינוי-בינוי:

שם המתחם: "${complex.name}"
עיר: ${complex.city}
${complex.address ? `כתובת: ${complex.address}` : ''}
${complex.developer ? `יזם: ${complex.developer}` : ''}
${complex.neighborhood ? `שכונה: ${complex.neighborhood}` : ''}

חפש באתרים:
- mavat.iplan.gov.il
- iplan.gov.il
- אתר העירייה של ${complex.city}
- אתר הרשות להתחדשות עירונית
- כתבות חדשותיות על הפרויקט

מספרי תכניות נראים כך: XXX-XXXXXXX או תמל/XXXX או עיר/מק/XXXX

Return ONLY this JSON:
{
  "plan_number": "the plan number or null",
  "plan_name": "official plan name in Hebrew",
  "source": "where you found it",
  "confidence": "high/medium/low"
}`;

  const systemPrompt = 'You are an Israeli urban planning data specialist. Find official plan numbers. Return ONLY valid JSON, no markdown.';

  try {
    const raw = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJson(raw);
  } catch (err) {
    logger.warn(`[MavatBuilding] findPlanNumber failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Phase B: Extract per-building details with FOCUSED prompts
 * Key improvement: asks specifically for unit counts and uses Hebrew search terms
 */
async function fetchBuildingDetails(complex) {
  const planRef = complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : '';
  
  // Build a rich context string with everything we know
  const knownInfo = [];
  if (complex.existing_units) knownInfo.push(`${complex.existing_units} דירות קיימות`);
  if (complex.planned_units) knownInfo.push(`${complex.planned_units} דירות מתוכננות`);
  if (complex.num_buildings) knownInfo.push(`${complex.num_buildings} בניינים`);
  if (complex.developer) knownInfo.push(`יזם: ${complex.developer}`);
  
  const prompt = `אני צריך פירוט יחידות דיור לפי בניין בפרויקט פינוי-בינוי:

שם: "${complex.name}"
עיר: ${complex.city}
${planRef}
${complex.address ? `אזור: ${complex.address}` : ''}
מידע ידוע: ${knownInfo.join(', ') || 'אין'}

חפש את המידע הזה:
1. כמה דירות קיימות בכל בניין (לפני הריסה)
2. כמה דירות מתוכננות בכל בניין חדש (אחרי בנייה)
3. כמה קומות מתוכננות לכל בניין חדש

חפש ב:
- כתבות חדשותיות (ynet, calcalist, globes, TheMarker, מרכז הנדל"ן, מגדילים)
- אתר העירייה ${complex.city}
- אתר היזם ${complex.developer || ''}
- mavat.iplan.gov.il - טבלאות שטחים ונספח בינוי
- פרוטוקולים של ועדות תכנון
- אתרים כמו madlan.co.il

חשוב מאוד:
- אם מצאת "16 בניינים בני 5-16 קומות" - פרט כמה קומות לכל בניין
- אם מצאת "320 דירות ב-11 בניינים" - נסה לפרט כמה בכל בניין
- אם יש טבלת שטחים או נספח בינוי - חלץ ממנו את הנתונים
- אם אין פירוט מדויק, תן הערכה בהתבסס על מספר הקומות והגודל

Return ONLY this JSON (no markdown, no backticks):
{
  "buildings": [
    {
      "address": "שם רחוב ומספר בניין",
      "existing_units": <מספר דירות קיימות או null>,
      "planned_units": <מספר דירות מתוכננות או null>,
      "floors_existing": <קומות קיימות או null>,
      "floors_planned": <קומות מתוכננות או null>,
      "building_type": "tower/midrise/lowrise",
      "notes": "הערות"
    }
  ],
  "total_existing_units": <סה"כ קיימות>,
  "total_planned_units": <סה"כ מתוכננות>,
  "plan_number": "${complex.plan_number || 'null'}",
  "source": "מקורות המידע",
  "data_quality": "high/medium/low",
  "notes": "הערות על שלמות הנתונים"
}`;

  const systemPrompt = `You are an Israeli real estate data specialist. Your job is to find SPECIFIC NUMBERS - how many apartments exist and are planned in each building. Search news articles, municipal websites, and planning documents. Be thorough. If you find "1,083 units in 16 buildings of 5-16 floors" you should break that down per building. Return ONLY valid JSON, no markdown backticks.`;

  try {
    const raw = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJson(raw);
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

  // Check if we already have per-building data
  const hasExisting = buildings.some(b => b.existing_units && b.existing_units > 0);
  const hasPlanned = buildings.some(b => b.planned_units && b.planned_units > 0);

  // Estimate EXISTING units if we have total but not per-building
  if (totalExisting && !hasExisting) {
    const numBuildings = buildings.length;
    const avgPerBuilding = Math.round(totalExisting / numBuildings);
    let distributed = 0;
    
    buildings.forEach((b, i) => {
      if (i < numBuildings - 1) {
        // Use floor count for proportional distribution if available
        if (b.floors_existing) {
          // Rough estimate: ~4 units per floor for old Israeli buildings (2 per stairwell)
          b.existing_units = b.floors_existing * 4;
        } else {
          b.existing_units = avgPerBuilding;
        }
        distributed += b.existing_units;
      } else {
        // Last building gets remainder to match total
        b.existing_units = totalExisting - distributed;
      }
      b.confidence = b.confidence || 'estimated';
    });

    // Validate and adjust if floor-based estimate overshoots
    const sum = buildings.reduce((s, b) => s + (b.existing_units || 0), 0);
    if (sum !== totalExisting && totalExisting > 0) {
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
  }

  // Estimate PLANNED units if we have total but not per-building
  if (totalPlanned && !hasPlanned) {
    // Use floors_planned for proportional distribution
    const hasFloorData = buildings.some(b => b.floors_planned && b.floors_planned > 0);
    
    if (hasFloorData) {
      // Weight by floors: more floors = more units
      // Typical: ~6-8 units per floor for new Israeli residential (3-4 per stairwell)
      const totalWeight = buildings.reduce((s, b) => {
        const floors = b.floors_planned || 8; // default 8 floors
        const unitsPerFloor = floors > 15 ? 8 : 6; // towers get more units/floor
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
        b.confidence = b.confidence || 'estimated';
      });
    } else {
      // Even distribution
      const avgPerBuilding = Math.round(totalPlanned / buildings.length);
      let distributed = 0;
      buildings.forEach((b, i) => {
        if (i < buildings.length - 1) {
          b.planned_units = avgPerBuilding;
          distributed += avgPerBuilding;
        } else {
          b.planned_units = totalPlanned - distributed;
        }
        b.confidence = b.confidence || 'estimated';
      });
    }
  }

  return buildings;
}

/**
 * Save building details to database
 */
async function saveBuildingDetails(complexId, buildings, source) {
  if (!buildings || buildings.length === 0) return 0;

  // Clear old data for this complex
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

  // Update complex timestamp
  await pool.query(
    'UPDATE complexes SET last_building_scan = NOW() WHERE id = $1',
    [complexId]
  );

  return saved;
}

/**
 * Full enrichment for a single complex
 * Phase A -> Phase B -> Phase C (estimation fallback)
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

  if (!buildingData || !buildingData.buildings || buildingData.buildings.length === 0) {
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
  const totalExisting = buildingData.total_existing_units || complex.existing_units;
  const totalPlanned = buildingData.total_planned_units || complex.planned_units;
  
  let buildings = buildingData.buildings;
  const hadUnitsBeforeEstimation = buildings.some(b => (b.existing_units && b.existing_units > 0) || (b.planned_units && b.planned_units > 0));
  
  if (!hadUnitsBeforeEstimation && (totalExisting || totalPlanned)) {
    logger.info(`[MavatBuilding] Phase C: Estimating units for ${buildings.length} buildings (total: ${totalExisting}->${totalPlanned})`);
    buildings = estimateBuildingUnits(buildings, totalExisting, totalPlanned);
  }

  // Determine data quality
  let dataQuality = buildingData.data_quality || 'medium';
  if (!hadUnitsBeforeEstimation && buildings.some(b => b.confidence === 'estimated')) {
    dataQuality = 'estimated';
  }

  // Save buildings
  const savedCount = await saveBuildingDetails(
    complexId, 
    buildings, 
    hadUnitsBeforeEstimation ? (buildingData.source || 'gemini_mavat') : 'gemini_mavat+estimation'
  );

  // Update complex totals if we got better data from Gemini
  if (buildingData.total_existing_units && !complex.existing_units) {
    await pool.query(
      'UPDATE complexes SET existing_units = $1 WHERE id = $2',
      [buildingData.total_existing_units, complexId]
    );
  }
  if (buildingData.total_planned_units && !complex.planned_units) {
    await pool.query(
      'UPDATE complexes SET planned_units = $1 WHERE id = $2',
      [buildingData.total_planned_units, complexId]
    );
  }
  if (buildingData.plan_number && buildingData.plan_number !== 'null' && !complex.plan_number) {
    await pool.query(
      'UPDATE complexes SET plan_number = $1 WHERE id = $2',
      [buildingData.plan_number, complexId]
    );
  }

  // Calculate summary stats
  const sumExisting = buildings.reduce((s, b) => s + (b.existing_units || 0), 0);
  const sumPlanned = buildings.reduce((s, b) => s + (b.planned_units || 0), 0);

  return {
    status: 'success',
    complexId,
    name: complex.name,
    city: complex.city,
    plan_number: complex.plan_number || buildingData.plan_number,
    plan_number_found: planUpdated,
    buildings_found: buildingData.buildings.length,
    buildings_saved: savedCount,
    total_existing: sumExisting || buildingData.total_existing_units,
    total_planned: sumPlanned || buildingData.total_planned_units,
    estimation_used: !hadUnitsBeforeEstimation,
    data_quality: dataQuality,
    source: buildingData.source
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

  // Calculate summary
  const summary = {
    total_existing: buildings.rows.reduce((s, b) => s + (b.existing_units || 0), 0),
    total_planned: buildings.rows.reduce((s, b) => s + (b.planned_units || 0), 0),
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
  getBuildingDetails
};
