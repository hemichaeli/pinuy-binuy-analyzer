/**
 * Mavat Building Details Service
 * 
 * Uses Gemini + Google Search Grounding to extract per-building
 * unit counts from mavat.iplan.gov.il planning documents.
 * 
 * Two-phase approach:
 * Phase 1: Find missing plan_numbers via Gemini search
 * Phase 2: Extract building-level details (units per building, floors, addresses)
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
  
  // Add last_building_scan to complexes
  try {
    await pool.query(`ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_building_scan TIMESTAMP`);
  } catch (e) { /* exists */ }
}

/**
 * Phase 1: Find plan_number for a complex using Gemini Google Search
 */
async function findPlanNumber(complex) {
  const prompt = `Search mavat.iplan.gov.il and Israeli planning databases for the Pinuy-Binuy (urban renewal) plan number for:

Complex: "${complex.name}"
City: ${complex.city}
${complex.address ? `Address: ${complex.address}` : ''}
${complex.developer ? `Developer: ${complex.developer}` : ''}
${complex.neighborhood ? `Neighborhood: ${complex.neighborhood}` : ''}

I need the official Israeli planning system plan number (מספר תכנית).
Plan numbers typically look like: XXX-XXXXXXX or city-code/plan-number (e.g., 504-0351403, הר/מק/2214/א)

Search specifically on:
- mavat.iplan.gov.il 
- iplan.gov.il
- City planning committee websites
- רשות להתחדשות עירונית

Return ONLY this JSON:
{
  "plan_number": "the plan number or null",
  "plan_name": "official plan name in Hebrew",
  "plan_url": "URL on mavat/iplan if found",
  "source": "where you found it",
  "confidence": "high/medium/low"
}

Return ONLY valid JSON.`;

  const systemPrompt = 'You are an Israeli urban planning data specialist. Find official plan numbers from mavat.iplan.gov.il. Return ONLY valid JSON.';

  try {
    const raw = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJson(raw);
  } catch (err) {
    logger.warn(`[MavatBuilding] findPlanNumber failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Phase 2: Extract per-building details from mavat planning documents
 */
async function fetchBuildingDetails(complex) {
  const planRef = complex.plan_number ? `Plan number: ${complex.plan_number}` : '';
  
  const prompt = `Search mavat.iplan.gov.il and Israeli planning databases for DETAILED BUILDING INFORMATION in this Pinuy-Binuy (urban renewal) project:

Complex: "${complex.name}"
City: ${complex.city}
${planRef}
${complex.address ? `Address area: ${complex.address}` : ''}
${complex.developer ? `Developer: ${complex.developer}` : ''}
Known info: ${complex.num_buildings || '?'} buildings, ${complex.existing_units || '?'} existing units, ${complex.planned_units || '?'} planned units

I need PER-BUILDING breakdown:
- Street address with building number for each building
- Number of EXISTING apartments in each building (before demolition)
- Number of PLANNED apartments in each building (after construction)  
- Number of floors planned for each new building

Search specifically:
- mavat.iplan.gov.il plan documents and tables (טבלאות שטחים)
- iplan.gov.il plan details
- תשריט and נספח בינוי documents
- Municipal planning websites

Return ONLY this JSON:
{
  "complex_name": "${complex.name}",
  "plan_number": "plan number found or confirmed",
  "total_existing_units": <number>,
  "total_planned_units": <number>,
  "buildings": [
    {
      "address": "street name and building number",
      "building_id": "building identifier if available",
      "existing_units": <number of current apartments>,
      "planned_units": <number of planned apartments>,
      "floors_existing": <current floors>,
      "floors_planned": <planned floors>,
      "notes": "any relevant notes"
    }
  ],
  "source": "where the data was found",
  "data_quality": "high/medium/low",
  "notes": "general notes about data completeness"
}

If you cannot find per-building breakdown, return what you can find with data_quality: "low".
Return ONLY valid JSON.`;

  const systemPrompt = `You are an Israeli urban planning data specialist extracting building-level details from mavat.iplan.gov.il planning documents. You understand Hebrew planning terminology: תב"ע, תשריט, נספח בינוי, טבלאות שטחים, יחידות דיור. Return ONLY valid JSON with accurate data.`;

  try {
    const raw = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJson(raw);
  } catch (err) {
    logger.warn(`[MavatBuilding] fetchBuildingDetails failed for ${complex.name}: ${err.message}`);
    return null;
  }
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
          b.building_id || null,
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
 * Full enrichment for a single complex: find plan + get buildings
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

  // Phase 1: Find plan_number if missing
  let planUpdated = false;
  if (!complex.plan_number) {
    logger.info(`[MavatBuilding] Phase 1: Finding plan_number for ${complex.name}`);
    const planData = await findPlanNumber(complex);
    
    if (planData && planData.plan_number && planData.plan_number !== 'null') {
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

  // Phase 2: Get building details
  logger.info(`[MavatBuilding] Phase 2: Fetching building details for ${complex.name}`);
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

  // Save buildings
  const savedCount = await saveBuildingDetails(
    complexId, 
    buildingData.buildings, 
    buildingData.source || 'gemini_mavat'
  );

  // Update complex totals if we got better data
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
  if (buildingData.plan_number && !complex.plan_number) {
    await pool.query(
      'UPDATE complexes SET plan_number = $1 WHERE id = $2',
      [buildingData.plan_number, complexId]
    );
  }

  return {
    status: 'success',
    complexId,
    name: complex.name,
    city: complex.city,
    plan_number: complex.plan_number || buildingData.plan_number,
    plan_number_found: planUpdated,
    buildings_found: buildingData.buildings.length,
    buildings_saved: savedCount,
    total_existing: buildingData.total_existing_units,
    total_planned: buildingData.total_planned_units,
    data_quality: buildingData.data_quality,
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

  // Prioritize deposited/approved plans (most useful for investors)
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

  logger.info(`[MavatBuilding] Batch complete: ${results.succeeded}/${results.total} succeeded, ${results.buildings_found} buildings found`);
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

  return {
    complex: complex.rows[0],
    buildings: buildings.rows,
    total_buildings: buildings.rows.length,
    last_scan: complex.rows[0].last_building_scan
  };
}

module.exports = {
  ensureTable,
  findPlanNumber,
  fetchBuildingDetails,
  saveBuildingDetails,
  enrichComplex,
  batchEnrich,
  getBuildingDetails
};
