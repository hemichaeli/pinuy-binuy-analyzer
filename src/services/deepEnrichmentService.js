const axios = require('axios');
const { logger } = require('./logger');
const pool = require('../db/pool');

/**
 * QUANTUM v3.0 TRUE DUAL ENGINE Enrichment Service
 * 
 * Architecture:
 *   ENGINE A - Perplexity sonar-pro (Phases 1-4): Fast factual data collection
 *   ENGINE B - Claude Sonnet 4.5 + web_search (Phases 5-6): Independent deep research
 *   SYNTHESIS - Claude Opus 4.6 (Phase 7): Cross-validates, resolves conflicts, produces final output
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
