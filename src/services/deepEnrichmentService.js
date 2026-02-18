const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * QUANTUM v3.0 - TRUE DUAL ENGINE Deep Enrichment Service
 * 
 * Architecture:
 *   ENGINE A - Perplexity sonar-pro (Phases 1-4): Fast web research
 *   ENGINE B - Claude Sonnet 4.5 + web_search (Phases 5-6): Independent deep research
 *   SYNTHESIS - Claude Opus 4.6 (Phase 7): Cross-validates, resolves conflicts, scores quality
 * 
 * Both engines research independently, then Opus synthesizes the best data.
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_RESEARCH_MODEL = 'claude-sonnet-4-5-20250929';
const CLAUDE_SYNTHESIS_MODEL = 'claude-opus-4-6';

const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const DELAY_MS = 8000;
const CLAUDE_DELAY_MS = 30000;  // 30s between Claude phases to avoid rate limits
const BETWEEN_COMPLEX_MS = 15000;  // 15s between complexes
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 30000;  // 30s base backoff for rate limits

const batchJobs = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getBatchStatus(jobId) {
  return batchJobs[jobId] || null;
}

// ============================================================
// ENGINE A: Perplexity sonar-pro (Fast web research)
// ============================================================
async function queryPerplexity(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  try {
    const response = await axios.post(PERPLEXITY_API_URL, {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.1,
      return_citations: true,
      search_recency_filter: 'month'
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return response.data.choices[0].message.content;
  } catch (err) {
    if (err.response && err.response.status === 429 && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Perplexity rate limited, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryPerplexity(prompt, systemPrompt, retryCount + 1);
    }
    throw err;
  }
}

// ============================================================
// ENGINE B: Claude Sonnet 4.5 + web_search (Deep research)
// ============================================================
async function queryClaudeResearch(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  try {
    const response = await axios.post(ANTHROPIC_API_URL, {
      model: CLAUDE_RESEARCH_MODEL,
      max_tokens: 16000,
      system: systemPrompt,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ],
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 180000
    });

    const content = response.data.content;
    if (Array.isArray(content)) {
      return content.map(block => block.text || '').filter(Boolean).join('\n');
    }
    return content;
  } catch (err) {
    if (err.response && (err.response.status === 429 || err.response.status === 529) && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Claude Research rate limited, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryClaudeResearch(prompt, systemPrompt, retryCount + 1);
    }
    // Log detailed error for debugging
    if (err.response) {
      logger.error(`Claude Research API error ${err.response.status}`, { 
        status: err.response.status, 
        data: JSON.stringify(err.response.data).substring(0, 500) 
      });
    }
    throw err;
  }
}

// ============================================================
// SYNTHESIS: Claude Opus 4.6 (No web search, pure reasoning)
// ============================================================
async function queryClaudeSynthesis(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  try {
    const response = await axios.post(ANTHROPIC_API_URL, {
      model: CLAUDE_SYNTHESIS_MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 180000
    });

    const content = response.data.content;
    if (Array.isArray(content)) {
      return content.map(block => block.text || '').filter(Boolean).join('\n');
    }
    return content;
  } catch (err) {
    if (err.response && (err.response.status === 429 || err.response.status === 529) && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Opus Synthesis rate limited, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryClaudeSynthesis(prompt, systemPrompt, retryCount + 1);
    }
    // Log detailed error for debugging
    if (err.response) {
      logger.error(`Opus Synthesis API error ${err.response.status}`, { 
        status: err.response.status, 
        data: JSON.stringify(err.response.data).substring(0, 500) 
      });
    }
    throw err;
  }
}