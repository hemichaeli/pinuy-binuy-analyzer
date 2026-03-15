/**
 * fullScanOrchestrator.js
 * 
 * Runs a comprehensive scan across all platforms:
 * 1. yad2 - direct API + Perplexity fallback
 * 2. yad1 - direct API + Perplexity fallback  
 * 3. dira - direct API + Perplexity fallback
 * 4. winwin - direct API + Perplexity fallback
 * 5. homeless - direct API + Perplexity fallback
 * 6. komo - new projects
 * 7. banknadlan - bank foreclosures
 * 8. bidspirit - auctions
 * 9. madlan - market data
 * 
 * After scraping: enriches all new/existing listings with phone numbers
 * Uses Gemini Flash to extract phones from descriptions
 * Uses yad2 phone API for yad2 listings
 */
const pool = require('../db/pool');
const { logger } = require('./logger');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SCRAPER RUNNERS
// ============================================================
async function runYad2Scan() {
  try {
    const yad2 = require('./yad2Scraper');
    logger.info('[FullScan] Starting yad2 scan...');
    const result = await yad2.scanAll({ staleOnly: false });
    logger.info(`[FullScan] yad2: ${result.totalNew} new, ${result.totalUpdated} updated`);
    return { source: 'yad2', success: true, new: result.totalNew || 0, updated: result.totalUpdated || 0 };
  } catch (err) {
    logger.error(`[FullScan] yad2 failed: ${err.message}`);
    return { source: 'yad2', success: false, error: err.message };
  }
}

async function runYad1Scan() {
  try {
    const { scanAll } = require('./yad1Scraper');
    logger.info('[FullScan] Starting yad1 scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    const updatedCount = result?.total_updated || 0;
    logger.info(`[FullScan] yad1: ${newCount} new, ${updatedCount} updated`);
    return { source: 'yad1', success: true, new: newCount, updated: updatedCount };
  } catch (err) {
    logger.error(`[FullScan] yad1 failed: ${err.message}`);
    return { source: 'yad1', success: false, error: err.message };
  }
}

async function runDiraScan() {
  try {
    const { scanAll } = require('./diraScraper');
    logger.info('[FullScan] Starting dira scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    const updatedCount = result?.total_updated || 0;
    logger.info(`[FullScan] dira: ${newCount} new, ${updatedCount} updated`);
    return { source: 'dira', success: true, new: newCount, updated: updatedCount };
  } catch (err) {
    logger.error(`[FullScan] dira failed: ${err.message}`);
    return { source: 'dira', success: false, error: err.message };
  }
}

async function runWinwinScan() {
  try {
    const { scanAll } = require('./winwinScraper');
    logger.info('[FullScan] Starting winwin scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    const updatedCount = result?.total_updated || 0;
    logger.info(`[FullScan] winwin: ${newCount} new, ${updatedCount} updated`);
    return { source: 'winwin', success: true, new: newCount, updated: updatedCount };
  } catch (err) {
    logger.error(`[FullScan] winwin failed: ${err.message}`);
    return { source: 'winwin', success: false, error: err.message };
  }
}

async function runHomelessScan() {
  try {
    const { scanAll } = require('./homelessScraper');
    logger.info('[FullScan] Starting homeless scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    const updatedCount = result?.total_updated || 0;
    logger.info(`[FullScan] homeless: ${newCount} new, ${updatedCount} updated`);
    return { source: 'homeless', success: true, new: newCount, updated: updatedCount };
  } catch (err) {
    logger.error(`[FullScan] homeless failed: ${err.message}`);
    return { source: 'homeless', success: false, error: err.message };
  }
}

async function runKomoScan() {
  try {
    const { scanAll } = require('./komoScraper');
    logger.info('[FullScan] Starting komo scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    logger.info(`[FullScan] komo: ${newCount} new`);
    return { source: 'komo', success: true, new: newCount, updated: 0 };
  } catch (err) {
    logger.error(`[FullScan] komo failed: ${err.message}`);
    return { source: 'komo', success: false, error: err.message };
  }
}

async function runBankNadlanScan() {
  try {
    const { scanAll } = require('./bankNadlanScraper');
    logger.info('[FullScan] Starting banknadlan scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    logger.info(`[FullScan] banknadlan: ${newCount} new`);
    return { source: 'banknadlan', success: true, new: newCount, updated: 0 };
  } catch (err) {
    logger.error(`[FullScan] banknadlan failed: ${err.message}`);
    return { source: 'banknadlan', success: false, error: err.message };
  }
}

async function runBidspiritScan() {
  try {
    const { scanAll } = require('./bidspiritScraper');
    logger.info('[FullScan] Starting bidspirit scan...');
    const result = await scanAll();
    const newCount = result?.total_inserted || result?.saved || 0;
    logger.info(`[FullScan] bidspirit: ${newCount} new`);
    return { source: 'bidspirit', success: true, new: newCount, updated: 0 };
  } catch (err) {
    logger.error(`[FullScan] bidspirit failed: ${err.message}`);
    return { source: 'bidspirit', success: false, error: err.message };
  }
}

async function runMadlanScan() {
  try {
    const { scanAllMadlan } = require('./madlanService');
    logger.info('[FullScan] Starting madlan scan...');
    const result = await scanAllMadlan();
    const newCount = result?.saved || result?.count || 0;
    logger.info(`[FullScan] madlan: ${newCount} new`);
    return { source: 'madlan', success: true, new: newCount, updated: 0 };
  } catch (err) {
    logger.error(`[FullScan] madlan failed: ${err.message}`);
    return { source: 'madlan', success: false, error: err.message };
  }
}

// ============================================================
// PHONE ENRICHMENT RUNNER
// ============================================================
async function runPhoneEnrichment(limit = 200) {
  try {
    const { enrichAllPhones } = require('./phoneEnrichmentService');
    logger.info('[FullScan] Starting phone enrichment...');
    const result = await enrichAllPhones({ limit });
    logger.info(`[FullScan] Phone enrichment: ${result.enriched}/${result.total} phones found`);
    return result;
  } catch (err) {
    logger.error(`[FullScan] Phone enrichment failed: ${err.message}`);
    return { enriched: 0, total: 0, error: err.message };
  }
}

// ============================================================
// AI ENRICHMENT RUNNER
// ============================================================
async function runAiEnrichment(limit = 50) {
  try {
    const { enrichNewListings } = require('./adEnrichmentService');
    logger.info('[FullScan] Starting AI enrichment...');
    const result = await enrichNewListings(limit);
    logger.info(`[FullScan] AI enrichment: ${result.enriched} listings enriched`);
    return result;
  } catch (err) {
    logger.error(`[FullScan] AI enrichment failed: ${err.message}`);
    return { enriched: 0, error: err.message };
  }
}

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================
async function runFullScan(options = {}) {
  const ALL_SOURCES = ['yad2', 'yad1', 'dira', 'winwin', 'homeless', 'komo', 'banknadlan', 'bidspirit', 'madlan'];
  const {
    sources: sourcesRaw = ALL_SOURCES,
    enrichPhones = true,
    enrichAi = true,
    phoneLimit = 200,
    aiLimit = 50
  } = options;

  // Accept 'all' string, null, undefined, or array
  const sources = (!sourcesRaw || sourcesRaw === 'all')
    ? ALL_SOURCES
    : Array.isArray(sourcesRaw) ? sourcesRaw : [sourcesRaw];

  const startTime = Date.now();
  logger.info(`[FullScan] Starting full scan: ${sources.join(', ')}`);
  
  const results = {
    started_at: new Date().toISOString(),
    sources: {},
    phone_enrichment: null,
    ai_enrichment: null,
    total_new: 0,
    total_updated: 0,
    duration_ms: 0
  };
  
  // Run scrapers sequentially to avoid rate limits
  const scraperMap = {
    yad2: runYad2Scan,
    yad1: runYad1Scan,
    dira: runDiraScan,
    winwin: runWinwinScan,
    homeless: runHomelessScan,
    komo: runKomoScan,
    banknadlan: runBankNadlanScan,
    bidspirit: runBidspiritScan,
    madlan: runMadlanScan
  };
  
  for (const source of sources) {
    if (scraperMap[source]) {
      const result = await scraperMap[source]();
      results.sources[source] = result;
      results.total_new += result.new || 0;
      results.total_updated += result.updated || 0;
      await sleep(2000); // 2s between scrapers
    }
  }
  
  // Phone enrichment
  if (enrichPhones) {
    await sleep(3000);
    results.phone_enrichment = await runPhoneEnrichment(phoneLimit);
  }
  
  // AI enrichment
  if (enrichAi) {
    await sleep(3000);
    results.ai_enrichment = await runAiEnrichment(aiLimit);
  }
  
  results.duration_ms = Date.now() - startTime;
  results.completed_at = new Date().toISOString();
  
  logger.info(`[FullScan] Complete in ${Math.round(results.duration_ms/1000)}s: ${results.total_new} new, ${results.total_updated} updated`);
  
  return results;
}

module.exports = {
  runFullScan,
  runYad2Scan,
  runYad1Scan,
  runDiraScan,
  runWinwinScan,
  runHomelessScan,
  runKomoScan,
  runBankNadlanScan,
  runBidspiritScan,
  runMadlanScan,
  runPhoneEnrichment,
  runAiEnrichment
};
