/**
 * Claude Enrichment Service
 * 
 * Uses Claude API with web_search tool to enrich complex data.
 * Alternative/complement to Perplexity for Hebrew real estate data.
 * Particularly effective for nadlan.gov.il transaction data.
 */

const axios = require('axios');
const { logger } = require('./logger');

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query Claude API with optional web search
 */
async function queryClaude(prompt, systemPrompt, useWebSearch = true) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: prompt }
    ]
  };

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };

  if (useWebSearch) {
    body.tools = [
      {
        type: 'web_search_20250305',
        name: 'web_search'
      }
    ];
    // Web search requires the beta header
    headers['anthropic-beta'] = 'web-search-2025-03-05';
  }

  logger.info(`[Claude] Calling API (web_search=${useWebSearch})`);

  const response = await axios.post(CLAUDE_API_URL, body, {
    headers,
    timeout: 120000
  });

  // Extract text from response content blocks
  const content = response.data.content || [];
  const textBlocks = content
    .filter(b => b.type === 'text')
    .map(b => b.text);
  
  return textBlocks.join('\n');
}

/**
 * Parse JSON from Claude response
 */
function parseClaudeJson(text) {
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

  logger.warn('[Claude] Could not parse JSON from response', { preview: text.substring(0, 300) });
  return null;
}

/**
 * Fetch nadlan closed transaction data via Claude web search
 */
async function fetchNadlanViaClaude(complex, streets) {
  try {
    const streetList = streets.join(', ');
    
    const prompt = `Search for closed real estate transactions (עסקאות סגורות) near these streets: ${streetList} in ${complex.city}, Israel.

Search nadlan.gov.il and other Israeli real estate sources for ACTUAL CLOSED DEALS in the last 24 months.
I need ONLY apartments (דירות מגורים), not commercial.

Return ONLY this JSON:
{
  "nadlan_avg_price_sqm": <average price per sqm in ILS>,
  "nadlan_transactions_count": <number of transactions found>,
  "nadlan_price_range": {"min": <min price/sqm>, "max": <max price/sqm>},
  "streets_found": ["list of streets with data"],
  "data_quality": "high/medium/low",
  "sample_transactions": [{"address": "", "price": 0, "area_sqm": 0, "date": "", "price_per_sqm": 0}],
  "notes": ""
}

IMPORTANT: I need the actual average price per square meter from CLOSED deals, not asking prices. Search nadlan.gov.il specifically.
Return ONLY valid JSON, no other text.`;

    const systemPrompt = `You are a real estate data analyst for Israel. Your job is to find CLOSED transaction data from nadlan.gov.il and other official sources. Always search the web for the most current data. Return ONLY valid JSON. All prices in Israeli Shekels (ILS). Focus on residential apartments only.`;

    const rawResponse = await queryClaude(prompt, systemPrompt, true);
    const data = parseClaudeJson(rawResponse);

    if (!data || !data.nadlan_avg_price_sqm || data.nadlan_avg_price_sqm <= 0) {
      logger.warn(`[Claude] No nadlan data for ${complex.name} (${complex.city})`);
      return null;
    }

    logger.info(`[Claude] nadlan data for ${complex.name}: ${data.nadlan_avg_price_sqm} ILS/sqm (${data.data_quality}, ${data.nadlan_transactions_count} txs)`);

    return {
      avg_price_sqm: Math.round(data.nadlan_avg_price_sqm),
      transactions_count: data.nadlan_transactions_count || 0,
      price_range: data.nadlan_price_range || null,
      data_quality: data.data_quality || 'medium',
      streets_found: data.streets_found || streets,
      sample_transactions: data.sample_transactions || [],
      source: 'nadlan_via_claude'
    };

  } catch (err) {
    logger.warn(`[Claude] nadlan error for ${complex.name}: ${err.message}`);
    // Log full error for debugging
    if (err.response) {
      logger.warn(`[Claude] API response: ${JSON.stringify(err.response.data || {}).substring(0, 500)}`);
    }
    return null;
  }
}

/**
 * Fetch comprehensive market data for a complex via Claude
 */
async function fetchMarketData(complex, streets) {
  try {
    const streetList = streets.join(', ');
    
    const prompt = `Search for current real estate market data for the area around: ${streetList} in ${complex.city}, Israel.

This is a Pinuy Binuy (urban renewal) complex called "${complex.name}".

I need:
1. Average closed transaction price per sqm (from nadlan.gov.il) - last 24 months
2. Current asking prices per sqm (from yad2.co.il, madlan.co.il)
3. Number of active listings nearby
4. Price trend (rising/stable/declining)

Return ONLY this JSON:
{
  "closed_avg_price_sqm": <from nadlan.gov.il closed deals>,
  "asking_avg_price_sqm": <from current listings>,
  "active_listings_count": <number>,
  "price_trend": "rising/stable/declining",
  "price_trend_percent": <annual % change>,
  "neighborhood": "<neighborhood name>",
  "data_sources": ["list of sources used"],
  "confidence": "high/medium/low"
}

Search the web for real data. Return ONLY valid JSON.`;

    const systemPrompt = `You are an Israeli real estate market analyst. Search the web for the most current data from nadlan.gov.il, madlan.co.il, and yad2.co.il. Return ONLY valid JSON with actual market data. All prices in ILS.`;

    const rawResponse = await queryClaude(prompt, systemPrompt, true);
    return parseClaudeJson(rawResponse);

  } catch (err) {
    logger.warn(`[Claude] market data error for ${complex.name}: ${err.message}`);
    return null;
  }
}

module.exports = {
  queryClaude,
  parseClaudeJson,
  fetchNadlanViaClaude,
  fetchMarketData,
  sleep
};
