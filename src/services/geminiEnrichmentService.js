/**
 * Gemini Enrichment Service
 * 
 * Uses Google Gemini Flash with Google Search grounding for fast, cheap enrichment.
 * Best for: pricing data, addresses, madlan/yad2 listings, location data.
 * Complements Claude (which handles complex Hebrew analysis).
 */

const axios = require('axios');
const { logger } = require('./logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-2.0-flash';
const DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Gemini API with Google Search grounding
 */
async function queryGemini(prompt, systemPrompt, useGrounding = true) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }

  const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

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

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  });

  // Extract text from response
  const candidates = response.data.candidates || [];
  if (candidates.length === 0) return null;

  const parts = candidates[0].content?.parts || [];
  const textParts = parts
    .filter(p => p.text)
    .map(p => p.text);

  return textParts.join('\n');
}

/**
 * Parse JSON from Gemini response
 */
function parseGeminiJson(text) {
  if (!text) return null;

  // Try direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // noop
  }

  // Try extracting from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // noop
    }
  }

  // Try finding JSON object in text
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
 * Great for: current market prices, listing data, neighborhood comparisons
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
 * Leverages Google's superior address/maps data
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
 * Backup/complement to Claude for nadlan data
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
