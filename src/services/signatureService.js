const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Signature Percent Enrichment Service v2
 * 
 * Two-tier source system:
 *   Tier 1 (HIGH confidence): Committee protocols (green in dashboard)
 *   Tier 2 (LOW confidence):  Press/social media (yellow in dashboard)
 * 
 * Improved: Single combined query with broader search terms
 */

async function queryPerplexity(prompt, model = 'sonar') {
  const response = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a data extraction assistant for Israeli real estate. Return ONLY valid JSON, no markdown, no explanation. If you cannot find the specific data, return null values.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 1500
    })
  });

  if (!response.ok) throw new Error(`Perplexity API error: ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Enrich signature_percent for a single complex
 * Uses a single comprehensive search with broader terms
 */
async function enrichSignature(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, developer, address, plan_number FROM complexes WHERE id = $1',
    [complexId]
  );

  if (complexResult.rows.length === 0) {
    return { complexId, status: 'not_found' };
  }

  const complex = complexResult.rows[0];
  const searchTerms = [complex.name, complex.city];
  if (complex.developer) searchTerms.push(complex.developer);
  if (complex.plan_number) searchTerms.push(complex.plan_number);
  const searchStr = searchTerms.filter(Boolean).join(' ');

  let bestResult = null;

  try {
    const data = await queryPerplexity(`
Search for the tenant signature percentage (אחוז חתימות דיירים / אחוז הסכמה) in the Israeli Pinuy-Binuy (urban renewal) project: "${complex.name}" in ${complex.city}.
${complex.developer ? `Developer: ${complex.developer}` : ''}
${complex.plan_number ? `Plan number: ${complex.plan_number}` : ''}

Search across ALL these source types:
1. Committee protocols (פרוטוקולי ועדות תכנון - מקומית, מחוזית, ערר)
2. Government planning documents (mavat.iplan.gov.il, תב"ע)
3. News articles (גלובס, כלכליסט, דה מרקר, ynet נדל"ן, וואלה נדל"ן)
4. Real estate sites (מדלן, הומלס, יד2 מגזין)
5. Social media / forums (פייסבוק קבוצות פינוי בינוי, תפוז נדל"ן)
6. Developer websites and reports
7. Municipal council meeting minutes (ישיבות מועצה)

Look for phrases like:
- "XX% מהדיירים חתמו" / "הושגו XX% חתימות"  
- "הושגה הסכמה של XX%"
- "XX% בעלי דירות הסכימו"
- "נותרו XX% דיירים סרבנים" (then calculate: 100 - XX = signature%)
- "עסקת הפינוי בינוי הגיעה ל-XX% חתימות"
- Any mention of "רוב מיוחס" (typically 80%+) or "רוב רגיל" (typically 66%+)

Return JSON:
{
  "signature_percent": <number 0-100, or null if truly not found>,
  "source_type": "<protocol|government|news|forum|developer|municipal>",
  "source_name": "<specific source name>",
  "source_url": "<URL if available, or null>",
  "date_found": "<date of the source if available>",
  "context": "<exact Hebrew quote mentioning the percentage, max 200 chars>",
  "confidence_note": "<why you believe this data, or why uncertain>"
}

IMPORTANT: If you find any mention at all of signatures or agreement percentages for this project, report it even if not 100% certain. We prefer approximate data over no data.
If "רוב מיוחס" is mentioned without a specific number, use 80 as estimate.
If "רוב רגיל" mentioned without number, use 67 as estimate.
If "almost all signed" / "כמעט כולם חתמו", use 90 as estimate.
If truly nothing found, return {"signature_percent": null, "source_type": null, "confidence_note": "No data found"}
`);

    if (data.signature_percent !== null && data.signature_percent > 0) {
      // Determine tier based on source type
      const protocolSources = ['protocol', 'government', 'municipal'];
      const isProtocol = protocolSources.includes(data.source_type);
      
      // Confidence scoring
      let confidence = 50;
      if (isProtocol) confidence = 85;
      else if (data.source_type === 'news') confidence = 60;
      else if (data.source_type === 'developer') confidence = 55;
      else if (data.source_type === 'forum') confidence = 40;

      // If it's an estimate (רוב מיוחס etc), lower confidence
      if (data.confidence_note?.includes('estimate') || data.confidence_note?.includes('הערכה')) {
        confidence = Math.max(confidence - 20, 25);
      }

      bestResult = {
        signature_percent: parseFloat(data.signature_percent),
        signature_source: isProtocol ? 'protocol' : 'press',
        signature_source_detail: data.source_name || data.source_type || 'unknown',
        signature_confidence: confidence,
        signature_date: data.date_found || null,
        signature_context: data.context || null
      };

      logger.info(`Signature found for ${searchStr}: ${bestResult.signature_percent}% from ${bestResult.signature_source} (confidence: ${bestResult.signature_confidence})`);
    }
  } catch (err) {
    logger.warn(`Signature search failed for ${searchStr}: ${err.message}`);
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

    return { complexId, name: complex.name, city: complex.city, status: 'enriched', ...bestResult };
  }

  return { complexId, name: complex.name, city: complex.city, status: 'no_data', signature_percent: null, signature_source: null };
}

/**
 * Batch enrich signatures
 */
async function enrichSignaturesBatch({ limit = 20, minIai = 0, staleOnly = true } = {}) {
  let query = `SELECT id, name, city FROM complexes WHERE 1=1`;
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
  
  const results = { total: complexes.rows.length, enriched: 0, noData: 0, errors: 0, details: [] };

  for (const c of complexes.rows) {
    try {
      const result = await enrichSignature(c.id);
      results.details.push(result);
      if (result.status === 'enriched') results.enriched++;
      else results.noData++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      results.errors++;
      results.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
    }
  }
  return results;
}

/**
 * Safe numeric casting helper
 * Wraps column in CASE to only CAST when value is actually numeric
 * Prevents "invalid input syntax for type numeric" errors
 */
const SAFE_NUMERIC = (col) => `CAST(CASE WHEN ${col} ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${col} ELSE NULL END AS NUMERIC)`;

/**
 * Get signature coverage stats
 * Uses safe numeric casting to handle columns that may contain
 * non-numeric TEXT values like 'low', 'high', 'medium'
 */
async function getSignatureStats() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(CASE WHEN signature_percent IS NOT NULL AND signature_source IS NOT NULL THEN 1 END) as has_signature,
      COUNT(CASE WHEN signature_source = 'protocol' THEN 1 END) as from_protocol,
      COUNT(CASE WHEN signature_source = 'press' THEN 1 END) as from_press,
      AVG(${SAFE_NUMERIC('signature_percent')}) as avg_signature,
      AVG(${SAFE_NUMERIC('signature_confidence')}) as avg_confidence,
      COUNT(CASE WHEN ${SAFE_NUMERIC('signature_percent')} >= 80 THEN 1 END) as above_80,
      COUNT(CASE WHEN ${SAFE_NUMERIC('signature_percent')} >= 60 AND ${SAFE_NUMERIC('signature_percent')} < 80 THEN 1 END) as between_60_80,
      COUNT(CASE WHEN ${SAFE_NUMERIC('signature_percent')} < 60 THEN 1 END) as below_60
    FROM complexes
  `);
  return result.rows[0];
}

module.exports = { enrichSignature, enrichSignaturesBatch, getSignatureStats };
