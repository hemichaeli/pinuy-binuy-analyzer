/**
 * Urban Renewal Authority Service (הרשות הממשלתית להתחדשות עירונית)
 * 
 * Fetches official data about declared Pinuy-Binuy complexes from:
 * - gov.il urban renewal authority
 * - govmap.gov.il official maps
 * - Official gazettes (רשומות)
 * 
 * This is the authoritative source for:
 * - Official complex declarations
 * - Tax track vs Local Authority track
 * - Official status updates
 * - Legal boundaries (גבולות מתחם)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryPerplexity, parseJsonResponse } = require('./perplexityService');

// URLs for official data
const GOVMAP_URBAN_RENEWAL_LAYER = 'https://www.govmap.gov.il/?lay=200720';
const URBAN_RENEWAL_AUTHORITY = 'https://www.gov.il/he/departments/government_authority_for_urban_renewal';
const ARCGIS_MAP = 'https://www.arcgis.com/apps/webappviewer/index.html?id=d6191754d18a4fd29ee2e2ca1d040759';

/**
 * Build query for official urban renewal data
 */
function buildOfficialDataQuery(city) {
  return `חפש באתר הרשות הממשלתית להתחדשות עירונית (gov.il) את כל מתחמי הפינוי-בינוי המוכרזים ב${city}.

חפש ב:
1. אתר הרשות הממשלתית להתחדשות עירונית
2. מתחמים במסלול רשויות מקומיות
3. מתחמים במסלול מיסוי
4. govmap.gov.il שכבת התחדשות עירונית (200720)

החזר JSON בפורמט הבא:
{
  "city": "${city}",
  "declared_complexes": [
    {
      "name": "שם המתחם",
      "track": "רשויות מקומיות/מיסוי",
      "declaration_date": "YYYY-MM-DD או null",
      "declaration_number": "מספר הכרזה אם יש",
      "existing_units": 0,
      "planned_units": 0,
      "status": "מוכרז/בתכנון/מופקד/מאושר/בביצוע",
      "developer": "שם היזם אם ידוע",
      "boundaries": "תיאור גבולות המתחם",
      "gazette_reference": "הפניה לרשומות אם יש",
      "expiry_date": "תאריך פקיעת הכרזה אם ידוע"
    }
  ],
  "pending_declarations": [
    {
      "name": "שם המתחם הממתין להכרזה",
      "status": "בבדיקה/להחלטה",
      "expected_date": "YYYY-MM או null"
    }
  ],
  "total_existing_units": 0,
  "total_planned_units": 0,
  "last_gazette_update": "YYYY-MM-DD",
  "data_source": "רשות התחדשות עירונית/govmap"
}`;
}

const OFFICIAL_SYSTEM_PROMPT = `You are a government data extraction assistant focused on Israeli urban renewal (התחדשות עירונית).
Extract ONLY official data from gov.il and govmap.gov.il sources.
Return ONLY valid JSON.
Focus on officially declared complexes (מתחמים מוכרזים).
Include gazette references when available.
Distinguish between tax track (מסלול מיסוי) and local authority track (מסלול רשויות מקומיות).`;

/**
 * Fetch official data for a specific city
 */
async function fetchOfficialComplexes(city) {
  logger.info(`Fetching official complexes for: ${city}`);

  const prompt = buildOfficialDataQuery(city);

  try {
    const rawResponse = await queryPerplexity(prompt, OFFICIAL_SYSTEM_PROMPT);
    const data = parseJsonResponse(rawResponse);

    if (!data || !data.declared_complexes) {
      logger.warn(`No official data found for ${city}`);
      return { city, complexes: [], status: 'no_data' };
    }

    logger.info(`Found ${data.declared_complexes.length} official complexes in ${city}`);
    return {
      city,
      complexes: data.declared_complexes,
      pendingDeclarations: data.pending_declarations || [],
      totalExisting: data.total_existing_units,
      totalPlanned: data.total_planned_units,
      status: 'success'
    };

  } catch (err) {
    logger.error(`Error fetching official data for ${city}: ${err.message}`);
    return { city, complexes: [], status: 'error', error: err.message };
  }
}

/**
 * Sync official data with database
 */
async function syncOfficialData(city) {
  const official = await fetchOfficialComplexes(city);
  
  if (official.status !== 'success' || official.complexes.length === 0) {
    return { city, synced: 0, new: 0, updated: 0 };
  }

  let synced = 0;
  let newComplexes = 0;
  let updated = 0;

  for (const complex of official.complexes) {
    try {
      // Check if complex exists
      const existing = await pool.query(
        `SELECT id, status, declaration_track FROM complexes 
         WHERE city = $1 AND (name ILIKE $2 OR name ILIKE $3)`,
        [city, `%${complex.name}%`, complex.name]
      );

      if (existing.rows.length > 0) {
        // Update existing complex with official data
        const existingComplex = existing.rows[0];
        
        const statusMap = {
          'מוכרז': 'declared',
          'בתכנון': 'planning',
          'מופקד': 'deposited',
          'מאושר': 'approved',
          'בביצוע': 'construction'
        };
        const newStatus = statusMap[complex.status] || existingComplex.status;

        await pool.query(
          `UPDATE complexes SET 
           declaration_track = $1,
           declaration_date = $2,
           declaration_number = $3,
           status = $4,
           official_existing_units = $5,
           official_planned_units = $6,
           official_boundaries = $7,
           gazette_reference = $8,
           declaration_expiry = $9,
           official_source = 'urban_renewal_authority',
           last_official_sync = NOW()
           WHERE id = $10`,
          [
            complex.track === 'מיסוי' ? 'tax' : 'local_authority',
            complex.declaration_date || null,
            complex.declaration_number || null,
            newStatus,
            complex.existing_units || null,
            complex.planned_units || null,
            complex.boundaries || null,
            complex.gazette_reference || null,
            complex.expiry_date || null,
            existingComplex.id
          ]
        );
        updated++;
      } else {
        // Create new complex from official data
        await pool.query(
          `INSERT INTO complexes (
            name, city, status, declaration_track, declaration_date,
            declaration_number, official_existing_units, official_planned_units,
            official_boundaries, gazette_reference, declaration_expiry,
            official_source, discovery_source, last_official_sync
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'urban_renewal_authority', 'official_authority', NOW())
          ON CONFLICT (name, city) DO UPDATE SET
            declaration_track = EXCLUDED.declaration_track,
            official_existing_units = EXCLUDED.official_existing_units,
            official_planned_units = EXCLUDED.official_planned_units,
            last_official_sync = NOW()`,
          [
            complex.name,
            city,
            complex.status === 'מוכרז' ? 'declared' : 'planning',
            complex.track === 'מיסוי' ? 'tax' : 'local_authority',
            complex.declaration_date || null,
            complex.declaration_number || null,
            complex.existing_units || null,
            complex.planned_units || null,
            complex.boundaries || null,
            complex.gazette_reference || null,
            complex.expiry_date || null
          ]
        );
        newComplexes++;
      }
      synced++;
    } catch (err) {
      logger.warn(`Error syncing complex ${complex.name}: ${err.message}`);
    }
  }

  // Create alerts for pending declarations
  for (const pending of official.pendingDeclarations || []) {
    try {
      await pool.query(
        `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
         SELECT c.id, 'pending_declaration', 
                $1,
                $2,
                'medium', NOW()
         FROM complexes c WHERE c.name ILIKE $3 AND c.city = $4
         AND NOT EXISTS (
           SELECT 1 FROM alerts a WHERE a.complex_id = c.id 
           AND a.alert_type = 'pending_declaration' 
           AND a.created_at > NOW() - INTERVAL '30 days'
         )`,
        [
          `📋 ${pending.name} ממתין להכרזה`,
          `סטטוס: ${pending.status}. צפי: ${pending.expected_date || 'לא ידוע'}`,
          `%${pending.name}%`,
          city
        ]
      );
    } catch (err) {
      // Ignore
    }
  }

  logger.info(`Synced ${synced} complexes for ${city}: ${newComplexes} new, ${updated} updated`);
  return { city, synced, new: newComplexes, updated };
}

/**
 * Verify complex against official records
 */
async function verifyComplex(complexId) {
  const result = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (result.rows.length === 0) return null;

  const complex = result.rows[0];
  
  const prompt = `בדוק את הסטטוס הרשמי של מתחם "${complex.name}" ב${complex.city} מול הרשות להתחדשות עירונית.

החזר JSON:
{
  "is_officially_declared": true/false,
  "official_status": "סטטוס רשמי",
  "track": "מסלול מיסוי/רשויות מקומיות",
  "declaration_valid": true/false,
  "expiry_warning": "אזהרה אם ההכרזה עומדת לפוג",
  "discrepancies": ["רשימת אי-התאמות בין המידע שלנו למידע הרשמי"],
  "verification_date": "YYYY-MM-DD",
  "confidence": "high/medium/low"
}`;

  try {
    const rawResponse = await queryPerplexity(prompt, OFFICIAL_SYSTEM_PROMPT);
    const verification = parseJsonResponse(rawResponse);

    if (verification) {
      // Update verification status
      await pool.query(
        `UPDATE complexes SET 
         official_verified = $1,
         verification_date = NOW(),
         verification_notes = $2
         WHERE id = $3`,
        [
          verification.is_officially_declared,
          JSON.stringify(verification),
          complexId
        ]
      );

      // Create alert if discrepancies found
      if (verification.discrepancies && verification.discrepancies.length > 0) {
        await pool.query(
          `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
           VALUES ($1, 'verification_discrepancy', $2, $3, 'medium', NOW())`,
          [
            complexId,
            `⚠️ אי-התאמה במידע הרשמי: ${complex.name}`,
            verification.discrepancies.join('; ')
          ]
        );
      }

      // Create alert if expiry warning
      if (verification.expiry_warning) {
        await pool.query(
          `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
           VALUES ($1, 'declaration_expiry', $2, $3, 'high', NOW())`,
          [
            complexId,
            `⏰ הכרזה עומדת לפוג: ${complex.name}`,
            verification.expiry_warning
          ]
        );
      }
    }

    return verification;
  } catch (err) {
    logger.error(`Verification error for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Sync all cities with official data
 */
async function syncAllCities(cities = null) {
  const targetCities = cities || [
    'תל אביב', 'רמת גן', 'גבעתיים', 'בני ברק', 'חולון', 'בת ים',
    'רעננה', 'כפר סבא', 'הוד השרון', 'הרצליה', 'נתניה', 'רמת השרון',
    'פתח תקווה', 'ראשון לציון', 'רחובות', 'נס ציונה',
    'ירושלים', 'מודיעין', 'בית שמש',
    'חיפה', 'קריית אתא', 'קריית מוצקין', 'קריית ביאליק', 'קריית ים', 'נשר'
  ];

  const results = {
    cities: targetCities.length,
    synced: 0,
    totalNew: 0,
    totalUpdated: 0,
    errors: []
  };

  for (const city of targetCities) {
    try {
      const cityResult = await syncOfficialData(city);
      results.synced++;
      results.totalNew += cityResult.new;
      results.totalUpdated += cityResult.updated;
      logger.info(`[Official Sync] ${city}: ${cityResult.new} new, ${cityResult.updated} updated`);
    } catch (err) {
      results.errors.push({ city, error: err.message });
      logger.error(`[Official Sync] ${city}: ERROR - ${err.message}`);
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 3000));
  }

  logger.info('Official sync completed', results);
  return results;
}

module.exports = {
  fetchOfficialComplexes,
  syncOfficialData,
  syncAllCities,
  verifyComplex,
  GOVMAP_URBAN_RENEWAL_LAYER,
  URBAN_RENEWAL_AUTHORITY
};
