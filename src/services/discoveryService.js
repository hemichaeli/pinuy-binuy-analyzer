/**
 * Discovery Service - Find NEW Pinuy-Binuy complexes
 * 
 * Searches for urban renewal projects that match our criteria:
 * - Minimum 12 housing units (updated per 2024 law - was 24)
 * - Specific regions (Gush Dan, Sharon, Center, Jerusalem, Haifa)
 * - Any planning status
 * 
 * Version: 1.1.0 (2026-02-11) - Added slug generation fix
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Target cities by region
const TARGET_REGIONS = {
  'גוש דן': ['תל אביב', 'רמת גן', 'גבעתיים', 'בני ברק', 'חולון', 'בת ים', 'אור יהודה', 'קריית אונו', 'יהוד'],
  'שרון': ['רעננה', 'כפר סבא', 'הוד השרון', 'הרצליה', 'נתניה', 'רמת השרון', 'כוכב יאיר'],
  'מרכז': ['פתח תקווה', 'ראשון לציון', 'ראשלצ', 'רחובות', 'נס ציונה', 'לוד', 'רמלה', 'מודיעין'],
  'ירושלים': ['ירושלים', 'בית שמש', 'מבשרת ציון', 'מעלה אדומים'],
  'חיפה והקריות': ['חיפה', 'קריית ביאליק', 'קריית מוצקין', 'קריית ים', 'קריית אתא', 'נשר', 'טירת כרמל']
};

// All target cities flat list
const ALL_TARGET_CITIES = Object.values(TARGET_REGIONS).flat();

// Minimum housing units per 2024 law amendment (reduced from 24 to 12)
const MIN_HOUSING_UNITS = 12;

/**
 * Generate a URL-friendly slug from Hebrew name and city
 * IMPORTANT: This must generate a valid slug for database insertion
 */
function generateSlug(name, city) {
  // Transliteration map for Hebrew characters
  const hebrewMap = {
    'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
    'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm',
    'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'p',
    'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't'
  };

  const transliterate = (text) => {
    if (!text) return '';
    return text.split('').map(char => hebrewMap[char] || char).join('');
  };

  const cleanName = transliterate(name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);

  const cleanCity = transliterate(city || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20);

  // Add timestamp for uniqueness
  const timestamp = Date.now().toString(36);

  const slug = `${cleanCity}-${cleanName}-${timestamp}`.replace(/-+/g, '-');
  logger.debug(`Generated slug: ${slug} for ${name} in ${city}`);
  return slug;
}

/**
 * Build Perplexity prompt for discovering new complexes in a city
 */
function buildDiscoveryPrompt(city) {
  return `חפש מתחמי פינוי בינוי והתחדשות עירונית ב${city}.

אני מחפש מתחמים שעונים לקריטריונים:
- מינימום ${MIN_HOUSING_UNITS} יחידות דיור קיימות (לפי תיקון חוק 2024)
- בכל שלב תכנוני (הוכרז, בתכנון, הופקד, אושר, בביצוע)
- פרויקטים שהוכרזו או קודמו ב-2023-2026
- עדיפות למתחמים שהוכרזו רשמית ע"י הרשות להתחדשות עירונית

החזר JSON בלבד (ללא טקסט נוסף) בפורמט:

{
  "city": "${city}",
  "discovered_complexes": [
    {
      "name": "שם המתחם/שכונה",
      "addresses": "כתובות או גבולות המתחם",
      "existing_units": 0,
      "planned_units": 0,
      "developer": "שם היזם או null",
      "status": "הוכרז/בתכנון/הופקד/אושר/בביצוע",
      "plan_number": "מספר תוכנית אם ידוע",
      "declaration_date": "YYYY-MM-DD או null",
      "source": "מקור המידע",
      "notes": "הערות נוספות"
    }
  ],
  "search_date": "${new Date().toISOString().split('T')[0]}",
  "confidence": "high/medium/low"
}

חפש במקורות:
- mavat.iplan.gov.il (מנהל התכנון)
- הרשות הממשלתית להתחדשות עירונית
- אתר העירייה/רשות מקומית
- אתרי חדשות נדל"ן (גלובס, כלכליסט, דה-מרקר, ynet נדל"ן)

החזר JSON בלבד.`;
}

const DISCOVERY_SYSTEM_PROMPT = `You are an Israeli real estate research assistant specializing in finding Pinuy-Binuy (urban renewal) projects.
Return ONLY valid JSON. No explanations, no markdown, no text before or after.
Search for projects that are publicly announced or in planning stages.
Focus on official sources: the Urban Renewal Authority, mavat.iplan.gov.il, and municipal websites.
All text should be in Hebrew.
If you can't find any new complexes, return an empty array for discovered_complexes.`;

/**
 * Query Perplexity for new complexes in a city
 */
async function discoverInCity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not set');
  }

  const axios = require('axios');
  const prompt = buildDiscoveryPrompt(city);

  try {
    logger.info(`Discovering complexes in ${city}...`);
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: DISCOVERY_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    const content = response.data.choices[0].message.content;
    const parsed = parseDiscoveryResponse(content);
    logger.info(`Discovery for ${city}: found ${parsed?.discovered_complexes?.length || 0} complexes`);
    return parsed;
  } catch (err) {
    logger.error(`Discovery failed for ${city}`, { error: err.message });
    return null;
  }
}

/**
 * Parse JSON from discovery response
 */
function parseDiscoveryResponse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (e2) {}
    }
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (e3) {}
    }
    logger.warn('Could not parse discovery response');
    return null;
  }
}

/**
 * Check if a complex already exists in our database
 */
async function complexExists(name, city) {
  const result = await pool.query(
    `SELECT id FROM complexes 
     WHERE (LOWER(name) = LOWER($1) OR name ILIKE $2) 
     AND city = $3`,
    [name, `%${name}%`, city]
  );
  return result.rows.length > 0;
}

/**
 * Add a newly discovered complex to the database
 */
async function addNewComplex(complex, city, source = 'discovery') {
  const statusMap = {
    'הוכרז': 'declared',
    'בתכנון': 'planning',
    'להפקדה': 'pre_deposit',
    'הופקד': 'deposited',
    'הופקדה': 'deposited',
    'אושר': 'approved',
    'אושרה': 'approved',
    'בביצוע': 'construction',
    'היתר': 'permit'
  };

  const status = statusMap[complex.status] || 'declared';
  const slug = generateSlug(complex.name, city);

  logger.info(`Adding new complex: ${complex.name} (${city}) with slug: ${slug}`);

  try {
    const result = await pool.query(
      `INSERT INTO complexes 
       (name, slug, city, addresses, existing_units, planned_units, developer, 
        status, plan_number, discovery_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING id`,
      [
        complex.name,
        slug,
        city,
        complex.addresses || null,
        complex.existing_units || null,
        complex.planned_units || null,
        complex.developer || null,
        status,
        complex.plan_number || null,
        source
      ]
    );

    logger.info(`Successfully added complex ID: ${result.rows[0].id}`);
    return result.rows[0].id;
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      logger.debug(`Complex already exists: ${complex.name} in ${city}`);
      return null;
    }
    logger.error(`Failed to add complex: ${complex.name}`, { error: err.message, code: err.code });
    throw err;
  }
}

/**
 * Create alert for newly discovered complex
 */
async function createDiscoveryAlert(complexId, complex, city) {
  try {
    await pool.query(
      `INSERT INTO alerts 
       (complex_id, alert_type, severity, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        complexId,
        'new_complex',
        'high',
        `🆕 מתחם חדש התגלה: ${complex.name} (${city})`,
        `נמצא מתחם חדש: ${complex.existing_units || '?'} יח"ד קיימות, ` +
        `${complex.planned_units || '?'} יח"ד מתוכננות. ` +
        `סטטוס: ${complex.status}. יזם: ${complex.developer || 'לא ידוע'}.`,
        JSON.stringify({
          addresses: complex.addresses,
          source: complex.source,
          plan_number: complex.plan_number,
          declaration_date: complex.declaration_date
        })
      ]
    );
    logger.info(`Created discovery alert for complex ${complexId}`);
  } catch (err) {
    logger.warn('Failed to create discovery alert', { error: err.message });
  }
}

/**
 * Run discovery scan for all target cities
 */
async function discoverAll(options = {}) {
  const { region = null, limit = null } = options;
  
  let cities = ALL_TARGET_CITIES;
  
  if (region && TARGET_REGIONS[region]) {
    cities = TARGET_REGIONS[region];
  }
  
  if (limit) {
    cities = cities.slice(0, limit);
  }

  logger.info(`Starting discovery scan for ${cities.length} cities (min ${MIN_HOUSING_UNITS} units)`);

  const results = {
    cities_scanned: 0,
    total_discovered: 0,
    new_added: 0,
    already_existed: 0,
    details: []
  };

  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    logger.info(`[${i + 1}/${cities.length}] Discovering in ${city}...`);

    try {
      const discovered = await discoverInCity(city);
      results.cities_scanned++;

      if (!discovered || !discovered.discovered_complexes) {
        results.details.push({ city, found: 0, added: 0, error: null });
        continue;
      }

      const complexes = discovered.discovered_complexes;
      let added = 0;
      let existed = 0;

      for (const complex of complexes) {
        // Skip if below minimum units
        if (complex.existing_units && complex.existing_units < MIN_HOUSING_UNITS) {
          logger.debug(`Skipping ${complex.name}: only ${complex.existing_units} units`);
          continue;
        }

        // Check if already exists
        const exists = await complexExists(complex.name, city);
        if (exists) {
          existed++;
          continue;
        }

        // Add new complex
        try {
          const newId = await addNewComplex(complex, city, 'discovery-perplexity');
          if (newId) {
            added++;
            results.total_discovered++;
            results.new_added++;

            // Create alert for new discovery
            await createDiscoveryAlert(newId, complex, city);
            
            logger.info(`✨ NEW: ${complex.name} (${city}) - ${complex.existing_units || '?'} units`);
          }
        } catch (addErr) {
          logger.error(`Failed to add ${complex.name}`, { error: addErr.message });
        }
      }

      results.already_existed += existed;
      results.details.push({
        city,
        found: complexes.length,
        added,
        existed,
        error: null
      });

    } catch (err) {
      logger.error(`Discovery error for ${city}`, { error: err.message });
      results.details.push({ city, found: 0, added: 0, error: err.message });
    }

    // Rate limiting
    if (i < cities.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  logger.info('Discovery scan completed', {
    cities: results.cities_scanned,
    discovered: results.total_discovered,
    new: results.new_added
  });

  return results;
}

/**
 * Quick discovery for a single region
 */
async function discoverRegion(regionName) {
  if (!TARGET_REGIONS[regionName]) {
    throw new Error(`Unknown region: ${regionName}. Available: ${Object.keys(TARGET_REGIONS).join(', ')}`);
  }
  return discoverAll({ region: regionName });
}

module.exports = {
  discoverAll,
  discoverInCity,
  discoverRegion,
  addNewComplex,
  generateSlug,
  TARGET_REGIONS,
  ALL_TARGET_CITIES,
  MIN_HOUSING_UNITS
};
