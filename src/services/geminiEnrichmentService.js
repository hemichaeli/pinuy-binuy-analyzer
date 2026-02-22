/**
 * Gemini Enrichment Service
 * 
 * Uses Google Gemini Flash with Google Search grounding for fast, cheap enrichment.
 * Best for: pricing data, addresses, madlan/yad2 listings, location data.
 * Complements Claude (which handles complex Hebrew analysis).
 * 
 * Model fallback order (Feb 2026):
 * 1. gemini-2.5-flash (stable, current)
 * 2. gemini-3-flash-preview (newest preview)
 * 3. gemini-2.5-flash-lite (budget fallback)
 * Note: Gemini 1.5 retired, Gemini 2.0 retiring March 2026
 */

const axios = require('axios');
const { logger } = require('./logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Gemini API with Google Search grounding.
 * Includes automatic model fallback if primary model is unavailable.
 */
async function queryGemini(prompt, systemPrompt, useGrounding = true) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }

  // Current model hierarchy (Feb 2026): 2.5 stable > 3.0 preview > 2.5 lite
  const models = [GEMINI_MODEL, 'gemini-3-flash-preview', 'gemini-2.5-flash-lite'];

  for (const model of models) {
    try {
      const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096
        }
      };

      if (useGrounding) {
        body.tools = [
          {
            google_search: {}
          }
        ];
      }

      logger.info(`[Gemini] Calling ${model} (grounding=${useGrounding})`);

      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      });

      // Extract text from response
      const candidates = response.data.candidates || [];
      if (candidates.length === 0) {
        logger.warn(`[Gemini] ${model}: no candidates returned`);
        continue;
      }

      const parts = candidates[0].content?.parts || [];
      const textParts = parts
        .filter(p => p.text)
        .map(p => p.text);

      if (textParts.length > 0) {
        logger.info(`[Gemini] ${model}: success`);
        return textParts.join('\n');
      }

    } catch (err) {
      const status = err.response?.status;
      const errMsg = err.response?.data?.error?.message || err.message;
      
      // If model not found or deprecated, try next
      if (status === 404 || status === 400) {
        logger.warn(`[Gemini] ${model}: ${status} - ${errMsg.substring(0, 150)}. Trying next model...`);
        continue;
      }
      
      // For other errors (429 quota, 403 auth), throw immediately
      throw err;
    }
  }

  logger.warn('[Gemini] All models failed');
  return null;
}

/**
 * Parse JSON from Gemini response
 */
function parseGeminiJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (e) {
    // noop
  }

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // noop
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (e) {
      // noop
    }
  }

  logger.warn('[Gemini] Could not parse JSON from response', { preview: (text || '').substring(0, 300) });
  return null;
}

/**
 * Fetch madlan/yad2 pricing data via Gemini Google Search
 */
async function fetchMadlanViaGemini(complex, streets) {
  try {
    const streetList = streets.join(', ');

    const prompt = `Search for recent closed real estate transactions and current listing prices near these streets: ${streetList} in ${complex.city}, Israel.

Search madlan.co.il, yad2.co.il, and nadlan.gov.il for:
1. Average closed transaction price per sqm (last 24 months)
2. Current average asking price per sqm from active listings
3. Number of active listings in the area
4. Price trend direction

Return ONLY this JSON:
{
  "madlan_avg_price_sqm": <average closed deal price per sqm in ILS>,
  "madlan_transactions_count": <number of transactions found>,
  "madlan_price_range": {"min": <min>, "max": <max>},
  "asking_avg_price_sqm": <current listing average per sqm>,
  "active_listings": <number of active listings>,
  "madlan_data_freshness": "YYYY-MM",
  "streets_found": ["streets with data"],
  "data_quality": "high/medium/low",
  "notes": ""
}

Return ONLY valid JSON, no other text.`;

    const systemPrompt = `You are a real estate data analyst for Israel. Extract ONLY verified data from Israeli real estate sources. Return ONLY valid JSON. All prices in Israeli Shekels (ILS). Focus on residential apartments only.`;

    const rawResponse = await queryGemini(prompt, systemPrompt, true);
    const data = parseGeminiJson(rawResponse);

    if (!data || !data.madlan_avg_price_sqm || data.madlan_avg_price_sqm <= 0) {
      logger.warn(`[Gemini] No madlan data for ${complex.name} (${complex.city})`);
      return null;
    }

    logger.info(`[Gemini] madlan data for ${complex.name}: ${data.madlan_avg_price_sqm} ILS/sqm (${data.data_quality})`);

    return {
      avg_price_sqm: Math.round(data.madlan_avg_price_sqm),
      transactions_count: data.madlan_transactions_count || 0,
      data_quality: data.data_quality || 'medium',
      streets_found: data.streets_found || streets,
      freshness: data.madlan_data_freshness || null,
      asking_avg: data.asking_avg_price_sqm || null,
      active_listings: data.active_listings || 0,
      source: 'madlan_via_gemini'
    };

  } catch (err) {
    logger.warn(`[Gemini] madlan error for ${complex.name}: ${err.message}`);
    if (err.response) {
      logger.warn(`[Gemini] API response: ${JSON.stringify(err.response.data || {}).substring(0, 500)}`);
    }
    return null;
  }
}

/**
 * Fetch address/location data via Gemini Google Search
 */
async function fetchAddressData(complex) {
  try {
    const prompt = `Find the exact street addresses with building numbers for the Pinuy Binuy (urban renewal) complex "${complex.name}" in ${complex.city}, Israel.

Search for:
1. Exact street addresses with building numbers included in this complex
2. The neighborhood name
3. GPS coordinates (latitude, longitude)

Return ONLY this JSON:
{
  "addresses": ["full address with building number"],
  "neighborhood": "neighborhood name",
  "latitude": 0.0,
  "longitude": 0.0,
  "address_source": "source of info",
  "confidence": "high/medium/low"
}

Return ONLY valid JSON.`;

    const systemPrompt = `You are a geographic data specialist for Israel. Find exact addresses for urban renewal projects. Return ONLY valid JSON.`;

    const rawResponse = await queryGemini(prompt, systemPrompt, true);
    return parseGeminiJson(rawResponse);

  } catch (err) {
    logger.warn(`[Gemini] address error for ${complex.name}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch nadlan transaction data via Gemini Google Search
 */
async function fetchNadlanViaGemini(complex, streets) {
  try {
    const streetList = streets.join(', ');

    const prompt = `Search nadlan.gov.il for closed apartment transactions near: ${streetList} in ${complex.city}, Israel.

I need ONLY closed deals (not asking prices) from the last 24 months for residential apartments.

Return ONLY this JSON:
{
  "nadlan_avg_price_sqm": <average price per sqm in ILS>,
  "nadlan_transactions_count": <number found>,
  "nadlan_price_range": {"min": 0, "max": 0},
  "streets_found": ["streets"],
  "data_quality": "high/medium/low",
  "notes": ""
}

Return ONLY valid JSON.`;

    const systemPrompt = `You are a real estate data analyst for Israel. Extract closed transaction data from nadlan.gov.il. Return ONLY valid JSON. All prices in ILS.`;

    const rawResponse = await queryGemini(prompt, systemPrompt, true);
    const data = parseGeminiJson(rawResponse);

    if (!data || !data.nadlan_avg_price_sqm || data.nadlan_avg_price_sqm <= 0) {
      return null;
    }

    return {
      avg_price_sqm: Math.round(data.nadlan_avg_price_sqm),
      transactions_count: data.nadlan_transactions_count || 0,
      data_quality: data.data_quality || 'medium',
      streets_found: data.streets_found || streets,
      source: 'nadlan_via_gemini'
    };

  } catch (err) {
    logger.warn(`[Gemini] nadlan error for ${complex.name}: ${err.message}`);
    return null;
  }
}

module.exports = {
  queryGemini,
  parseGeminiJson,
  fetchMadlanViaGemini,
  fetchNadlanViaGemini,
  fetchAddressData,
  sleep
};
