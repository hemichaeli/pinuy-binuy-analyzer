const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Deep Enrichment Service v3.0 - TRUE DUAL ENGINE
 * 
 * Architecture:
 *   ENGINE A - Perplexity sonar-pro (Phases 1-4): Focused web research queries
 *   ENGINE B - Claude Sonnet 4.5 + web_search (Phases 5-6): Independent deep research
 *   SYNTHESIS - Claude Opus 4.6 (Phase 7): Cross-validates & synthesizes BOTH engines
 *   DATA      - nadlan.gov.il (Phase 8): Actual transaction prices (overrides estimates)
 *   CALC      - City average (Phase 9): From DB transactions
 * 
 * Both research engines work INDEPENDENTLY on the same complex.
 * Opus 4.6 receives ALL outputs and produces a unified, cross-validated result.
 * 
 * v3.0: Both engines research independently, Opus 4.6 synthesizes
 * v2.0: Perplexity researched, Sonnet synthesized
 * v1.x: Perplexity-only with basic sonar
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_RESEARCH_MODEL = 'claude-sonnet-4-5-20250929';
const CLAUDE_SYNTHESIS_MODEL = 'claude-opus-4-6';
const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const DELAY_MS = 8000;
const CLAUDE_DELAY_MS = 65000;  // 65s between Claude phases - respects 30K tokens/min limit
const BETWEEN_COMPLEX_MS = 45000;  // 45s between complexes for rate limit breathing room
const MAX_RETRIES = 4;  // Extra retry for rate limits
const BASE_BACKOFF_MS = 60000;  // 60s base backoff for rate limits (doubles each retry)