/**
 * adEnrichmentService.js
 * Enriches individual listings (ads) with:
 *   1. Gemini Flash — urgency flags, hidden info, exact address (ALL listings, ~$0.0001 each)
 *   2. Perplexity Sonar — building age, nearby plans, recent transactions (IAI > 55 only, ~$0.005 each)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';

const DELAY_MS = 500; // 500ms between calls to avoid rate limits

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// GEMINI FLASH — Enrich listing text
// ============================================================
async function enrichWithGemini(listing) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('[AdEnrich] GEMINI_API_KEY not set, skipping Gemini enrichment');
    return null;
  }

  const prompt = `אתה מנתח מודעות נדל"ן ישראליות. נתח את המודעה הבאה והחזר JSON בלבד.

כותרת: ${listing.title || ''}
כתובת: ${listing.address || ''}
עיר: ${listing.city || ''}
תיאור: ${listing.description_snippet || ''}
מחיר: ${listing.asking_price || 0} ₪
חדרים: ${listing.rooms || ''}, שטח: ${listing.area_sqm || ''} מ"ר, קומה: ${listing.floor || ''}

החזר JSON בלבד (ללא טקסט נוסף):
{
  "urgency_flag": "דחוף|ירושה|כינוס|גירושין|עוזב_ארץ|null",
  "urgency_reason": "הסבר קצר מדוע או null",
  "hidden_info": "מידע חשוב שלא בשדות הרשמיים (קרוב לתחנה, נוף פתוח, שיפוץ חדש וכו') או null",
  "exact_address": "כתובת מדויקת אם ניתן לחלץ מהתיאור, אחרת null",
  "gemini_score_boost": -10 עד 10 (כמה להוסיף/להוריד מה-SSI score),
  "gemini_score_reason": "הסבר קצר"
}`;

  try {
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
      },
      { timeout: 15000 }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Parse JSON from response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn(`[AdEnrich] Gemini error for listing ${listing.id}: ${err.message}`);
    return null;
  }
}

// ============================================================
// PERPLEXITY SONAR — Enrich with external data (high-IAI only)
// ============================================================
async function enrichWithPerplexity(listing) {
  const apiKey = process.env.PERPLEXITY_API_KEY || process.env.SONAR_API_KEY;
  if (!apiKey) {
    logger.warn('[AdEnrich] PERPLEXITY_API_KEY not set, skipping Perplexity enrichment');
    return null;
  }

  const address = listing.exact_address_enriched || listing.address || '';
  const city = listing.city || '';

  const prompt = `חפש מידע על הנכס בכתובת: ${address}, ${city}, ישראל.

אני צריך:
1. גיל הבניין (שנת בנייה)
2. תוכניות בינוי/פינוי-בינוי/תמ"א בסביבה (500 מטר)
3. עסקאות נדל"ן אחרונות בבניין או ברחוב (12 חודשים אחרונים)
4. מידע ציבורי נוסף על הנכס

החזר JSON בלבד:
{
  "building_year": שנת בנייה כמספר או null,
  "building_age": גיל בשנים או null,
  "nearby_plans": ["תיאור תוכנית 1", "תיאור תוכנית 2"] או [],
  "has_renewal_plan": true/false,
  "recent_transactions": [{"date": "YYYY-MM", "price": מחיר, "sqm": שטח}] או [],
  "avg_price_sqm_area": מחיר ממוצע למ"ר באזור או null,
  "public_notes": "מידע נוסף רלוונטי או null",
  "data_quality": "high/medium/low"
}`;

  try {
    const response = await axios.post(
      PERPLEXITY_API_URL,
      {
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'אתה מומחה נדל"ן ישראלי. חפש מידע ציבורי על נכסים. החזר JSON בלבד.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1000
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const rawText = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn(`[AdEnrich] Perplexity error for listing ${listing.id}: ${err.message}`);
    return null;
  }
}

// ============================================================
// SAVE ENRICHMENT TO DB
// ============================================================
async function saveEnrichment(listingId, geminiData, perplexityData) {
  const updates = {};
  const params = [];
  let paramIdx = 1;

  if (geminiData) {
    if (geminiData.urgency_flag && geminiData.urgency_flag !== 'null') {
      updates.gemini_urgency_flag = geminiData.urgency_flag;
    }
    if (geminiData.urgency_reason) updates.gemini_urgency_reason = geminiData.urgency_reason;
    if (geminiData.hidden_info) updates.gemini_hidden_info = geminiData.hidden_info;
    if (geminiData.exact_address) updates.exact_address_enriched = geminiData.exact_address;
    if (geminiData.gemini_score_boost) updates.gemini_score_boost = geminiData.gemini_score_boost;
    if (geminiData.gemini_score_reason) updates.gemini_score_reason = geminiData.gemini_score_reason;
    updates.gemini_enriched_at = new Date();
  }

  if (perplexityData) {
    if (perplexityData.building_year) updates.building_year = perplexityData.building_year;
    if (perplexityData.building_age) updates.building_age = perplexityData.building_age;
    if (perplexityData.nearby_plans?.length > 0) updates.nearby_plans = JSON.stringify(perplexityData.nearby_plans);
    if (perplexityData.has_renewal_plan !== undefined) updates.has_renewal_plan = perplexityData.has_renewal_plan;
    if (perplexityData.recent_transactions?.length > 0) updates.recent_transactions = JSON.stringify(perplexityData.recent_transactions);
    if (perplexityData.avg_price_sqm_area) updates.avg_price_sqm_area = perplexityData.avg_price_sqm_area;
    if (perplexityData.public_notes) updates.perplexity_public_notes = perplexityData.public_notes;
    updates.perplexity_enriched_at = new Date();
  }

  if (Object.keys(updates).length === 0) return;

  const setClauses = Object.keys(updates).map(key => {
    params.push(updates[key]);
    return `${key} = $${paramIdx++}`;
  });
  params.push(listingId);

  await pool.query(
    `UPDATE listings SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
    params
  );
}

// ============================================================
// MAIN: Enrich a single listing
// ============================================================
async function enrichListing(listing) {
  logger.info(`[AdEnrich] Enriching listing ${listing.id} (${listing.address}, ${listing.city})`);

  // Step 1: Gemini Flash (always)
  const geminiData = await enrichWithGemini(listing);
  await sleep(DELAY_MS);

  // Step 2: Perplexity (only if IAI > 55)
  let perplexityData = null;
  if (listing.iai_score > 55) {
    // Use enriched address if Gemini found a better one
    const enrichedListing = { ...listing };
    if (geminiData?.exact_address) {
      enrichedListing.exact_address_enriched = geminiData.exact_address;
    }
    perplexityData = await enrichWithPerplexity(enrichedListing);
    await sleep(DELAY_MS);
  }

  // Save to DB
  await saveEnrichment(listing.id, geminiData, perplexityData);

  return { gemini: !!geminiData, perplexity: !!perplexityData };
}

// ============================================================
// BATCH: Enrich all unenriched listings
// ============================================================
async function enrichNewListings(limit = 50) {
  const { rows: listings } = await pool.query(`
    SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor,
           l.description_snippet, l.title, l.source,
           c.iai_score
    FROM listings l
    LEFT JOIN complexes c ON l.complex_id = c.id
    WHERE l.is_active = true
      AND l.gemini_enriched_at IS NULL
    ORDER BY l.created_at DESC
    LIMIT $1
  `, [limit]);

  if (listings.length === 0) {
    logger.info('[AdEnrich] No new listings to enrich');
    return { enriched: 0 };
  }

  logger.info(`[AdEnrich] Enriching ${listings.length} listings...`);
  let enriched = 0;

  for (const listing of listings) {
    try {
      await enrichListing(listing);
      enriched++;
    } catch (err) {
      logger.warn(`[AdEnrich] Failed to enrich listing ${listing.id}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  logger.info(`[AdEnrich] Enriched ${enriched}/${listings.length} listings`);
  return { enriched, total: listings.length };
}

module.exports = {
  enrichListing,
  enrichNewListings,
  enrichWithGemini,
  enrichWithPerplexity
};
