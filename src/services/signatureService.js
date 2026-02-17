const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Signature Percent Enrichment Service
 * 
 * Two-tier source system:
 *   Tier 1 (HIGH confidence): Committee protocols (פרוטוקולים של ועדות מקומיות/מחוזיות)
 *   Tier 2 (LOW confidence):  Press/social media (עיתונות, רשתות חברתיות, פורומים)
 * 
 * Colors in dashboard:
 *   Green = protocol source (reliable)
 *   Yellow = press/social source (treat with caution)
 *   Gray = no data
 */

async function queryPerplexity(prompt) {
  const response = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: 'You are a data extraction assistant. Return ONLY valid JSON, no markdown, no explanation.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    throw new Error(`Perplexity API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Enrich signature_percent for a single complex
 * Queries two Perplexity searches:
 *   1. Committee protocols (high confidence)
 *   2. Press/social media (low confidence)
 */
async function enrichSignature(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, developer, address FROM complexes WHERE id = $1',
    [complexId]
  );

  if (complexResult.rows.length === 0) {
    return { complexId, status: 'not_found' };
  }

  const complex = complexResult.rows[0];
  const searchName = `${complex.name} ${complex.city}`;
  let bestResult = null;

  // === TIER 1: Committee Protocols ===
  try {
    const protocolData = await queryPerplexity(`
חפש בפרוטוקולים של ועדות תכנון (ועדה מקומית, ועדה מחוזית, ועדת משנה) מידע על אחוז החתימות בפרויקט פינוי-בינוי "${complex.name}" ב${complex.city}.

חפש ב:
- פרוטוקולים של ועדות מקומיות לתכנון ובנייה
- פרוטוקולים של ועדות מחוזיות
- החלטות רשות מקרקעי ישראל
- פרוטוקולים של ועדות ערר
- מסמכי תכנית (תב"ע) שמציינים אחוז חתימות

החזר JSON בפורמט:
{
  "signature_percent": <מספר 0-100 או null אם לא נמצא>,
  "source_type": "protocol",
  "source_detail": "<שם הוועדה + תאריך הפרוטוקול>",
  "committee_type": "<מקומית/מחוזית/משנה/ערר>",
  "date_mentioned": "<תאריך אם נמצא>",
  "context": "<משפט קצר מהפרוטוקול שמציין את האחוז>",
  "confidence": <1-100>
}

אם לא נמצא מידע בפרוטוקולים, החזר {"signature_percent": null, "source_type": "protocol", "confidence": 0}
`);

    if (protocolData.signature_percent !== null && protocolData.signature_percent > 0) {
      bestResult = {
        signature_percent: parseFloat(protocolData.signature_percent),
        signature_source: 'protocol',
        signature_source_detail: protocolData.source_detail || protocolData.committee_type || 'ועדה',
        signature_confidence: Math.min(protocolData.confidence || 85, 95),
        signature_date: protocolData.date_mentioned || null,
        signature_context: protocolData.context || null
      };
      logger.info(`Signature from PROTOCOL for ${searchName}: ${bestResult.signature_percent}% (confidence: ${bestResult.signature_confidence})`);
    }
  } catch (err) {
    logger.warn(`Protocol search failed for ${searchName}: ${err.message}`);
  }

  // Wait between API calls
  await new Promise(r => setTimeout(r, 3000));

  // === TIER 2: Press / Social Media (only if no protocol found) ===
  if (!bestResult) {
    try {
      const pressData = await queryPerplexity(`
חפש בחדשות, עיתונות, אתרי נדל"ן, פורומים ורשתות חברתיות מידע על אחוז החתימות בפרויקט פינוי-בינוי "${complex.name}" ב${complex.city}.

חפש ב:
- כתבות בעיתונות (גלובס, כלכליסט, דה מרקר, ynet נדל"ן)
- אתרי נדל"ן (מדלן, יד2, הומלס)
- פורומים (תפוז נדל"ן, פייסבוק קבוצות פינוי בינוי)
- אתרי היזמים עצמם
- דיווחים של חברות הייעוץ

החזר JSON בפורמט:
{
  "signature_percent": <מספר 0-100 או null אם לא נמצא>,
  "source_type": "press",
  "source_name": "<שם המקור - עיתון/אתר/פורום>",
  "source_url": "<URL אם זמין>",
  "date_published": "<תאריך הפרסום>",
  "context": "<ציטוט קצר שמציין את האחוז>",
  "confidence": <1-100>
}

אם לא נמצא מידע, החזר {"signature_percent": null, "source_type": "press", "confidence": 0}
`);

      if (pressData.signature_percent !== null && pressData.signature_percent > 0) {
        bestResult = {
          signature_percent: parseFloat(pressData.signature_percent),
          signature_source: 'press',
          signature_source_detail: pressData.source_name || 'עיתונות',
          signature_confidence: Math.min(pressData.confidence || 50, 70), // Cap press at 70
          signature_date: pressData.date_published || null,
          signature_context: pressData.context || null
        };
        logger.info(`Signature from PRESS for ${searchName}: ${bestResult.signature_percent}% (confidence: ${bestResult.signature_confidence})`);
      }
    } catch (err) {
      logger.warn(`Press search failed for ${searchName}: ${err.message}`);
    }
  }

  // === UPDATE DB ===
  if (bestResult) {
    await pool.query(`
      UPDATE complexes SET
        signature_percent = $1,
        signature_source = $2,
        signature_source_detail = $3,
        signature_confidence = $4,
        signature_date = $5,
        signature_context = $6,
        updated_at = NOW()
      WHERE id = $7
    `, [
      bestResult.signature_percent,
      bestResult.signature_source,
      bestResult.signature_source_detail,
      bestResult.signature_confidence,
      bestResult.signature_date,
      bestResult.signature_context,
      complexId
    ]);

    return {
      complexId,
      name: complex.name,
      city: complex.city,
      status: 'enriched',
      ...bestResult
    };
  }

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    status: 'no_data',
    signature_percent: null,
    signature_source: null
  };
}

/**
 * Batch enrich signatures for multiple complexes
 */
async function enrichSignaturesBatch({ limit = 20, minIai = 0, staleOnly = true } = {}) {
  let query = `
    SELECT id, name, city FROM complexes 
    WHERE 1=1
  `;
  const params = [];

  if (staleOnly) {
    query += ` AND (signature_percent IS NULL OR signature_source IS NULL)`;
  }
  if (minIai > 0) {
    params.push(minIai);
    query += ` AND iai_score >= $${params.length}`;
  }

  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${params.length + 1}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  
  const results = {
    total: complexes.rows.length,
    enriched: 0,
    noData: 0,
    errors: 0,
    details: []
  };

  for (const c of complexes.rows) {
    try {
      const result = await enrichSignature(c.id);
      results.details.push(result);
      if (result.status === 'enriched') results.enriched++;
      else results.noData++;
      
      // Rate limiting between complexes
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      results.errors++;
      results.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
      logger.error(`Signature enrichment failed for ${c.name}: ${err.message}`);
    }
  }

  // After batch, calculate premium for any newly priced items
  return results;
}

/**
 * Get signature coverage stats
 */
async function getSignatureStats() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(signature_percent) as has_signature,
      COUNT(CASE WHEN signature_source = 'protocol' THEN 1 END) as from_protocol,
      COUNT(CASE WHEN signature_source = 'press' THEN 1 END) as from_press,
      AVG(CASE WHEN signature_percent IS NOT NULL THEN signature_percent END) as avg_signature,
      AVG(CASE WHEN signature_confidence IS NOT NULL THEN signature_confidence END) as avg_confidence,
      COUNT(CASE WHEN signature_percent >= 80 THEN 1 END) as above_80,
      COUNT(CASE WHEN signature_percent >= 60 AND signature_percent < 80 THEN 1 END) as between_60_80,
      COUNT(CASE WHEN signature_percent < 60 AND signature_percent IS NOT NULL THEN 1 END) as below_60
    FROM complexes
  `);
  return result.rows[0];
}

module.exports = {
  enrichSignature,
  enrichSignaturesBatch,
  getSignatureStats
};
