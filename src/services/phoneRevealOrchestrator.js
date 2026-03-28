/**
 * phoneRevealOrchestrator.js
 *
 * Unified phone enrichment for ALL platforms — targeting 100% coverage.
 *
 * Strategy per platform (ordered by reliability):
 *
 * ┌─────────────┬────────────────────────────────────────────────────────────┐
 * │ Platform    │ Method                                                    │
 * ├─────────────┼────────────────────────────────────────────────────────────┤
 * │ komo        │ Open phone API (POST showPhoneDetails) — FREE, no auth   │
 * │ yad2        │ Apify Actor with residential proxy + click-to-reveal     │
 * │ yad1        │ Apify Actor with residential proxy + page scraping       │
 * │ dira        │ Apify Actor with residential proxy + page scraping       │
 * │ homeless    │ Apify Actor with residential proxy + page scraping       │
 * │ banknadlan  │ Apify Actor with residential proxy + attorney contact    │
 * │ ALL         │ Regex extraction from description/title (pre-pass)       │
 * └─────────────┴────────────────────────────────────────────────────────────┘
 *
 * Replaces: phoneEnrichmentService.js (Perplexity — 1/795 success)
 *           yad2PhoneReveal.js (Puppeteer — blocked by Cloudflare on Railway)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// ── Phone cleaning (shared) ─────────────────────────────────────────────────

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  if (digits.startsWith('0')) return digits;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Method 1: Regex extraction from existing data (FREE, instant) ────────────

function extractPhoneFromText(text) {
  if (!text) return null;
  const phoneRegex = /(?:0[2-9]\d{7,8}|05\d{8}|\+972[2-9]\d{7,8})/g;
  const matches = text.match(phoneRegex);
  if (matches) {
    for (const m of matches) {
      const phone = cleanPhone(m);
      if (phone) return phone;
    }
  }
  return null;
}

// ── Method 2: Komo open phone API (FREE, no auth required) ──────────────────

const KOMO_BASE = 'https://www.komo.co.il';
const KOMO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.komo.co.il'
};

async function fetchKomoPhone(modaaNum) {
  try {
    const r = await axios.post(
      `${KOMO_BASE}/api/modaotService/showPhoneDetails/post/`,
      `luachNum=2&modaaNum=${modaaNum}&source=1`,
      { headers: KOMO_HEADERS, timeout: 10000 }
    );
    if (r.data?.status === 'OK' && r.data?.list) {
      const { name, phone1_pre, phone1, phone2_pre, phone2 } = r.data.list;
      const ph1 = cleanPhone(`${phone1_pre || ''}${phone1 || ''}`);
      const ph2 = cleanPhone(`${phone2_pre || ''}${phone2 || ''}`);
      return { phone: ph1 || ph2 || null, contact_name: name || null };
    }
  } catch (err) {
    logger.debug(`[PhoneOrch] Komo API failed for ${modaaNum}: ${err.message}`);
  }
  return { phone: null, contact_name: null };
}

async function enrichKomoListings(listings) {
  let enriched = 0;
  for (const listing of listings) {
    let modaaNum = null;
    // Extract modaaNum from source_listing_id or URL
    if (listing.source_listing_id && /^\d+$/.test(listing.source_listing_id)) {
      modaaNum = listing.source_listing_id;
    } else if (listing.url) {
      const match = listing.url.match(/modaaNum=(\d+)/i);
      if (match) modaaNum = match[1];
    }
    if (!modaaNum) continue;

    const result = await fetchKomoPhone(modaaNum);
    if (result.phone) {
      await pool.query(
        `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
        [result.phone, result.contact_name, listing.id]
      );
      enriched++;
      logger.debug(`[PhoneOrch] Komo: ${listing.address} → ${result.phone}`);
    }
    await sleep(800);
  }
  return enriched;
}

// ── Method 3: Apify Actor — multi-platform browser automation ───────────────

/**
 * Run the universal Israeli real-estate phone reveal Apify Actor.
 * One actor handles ALL platforms — dispatches by source internally.
 *
 * Input: { listings: [{id, url, source, source_listing_id, address, city}] }
 * Output: [{id, phone, contact_name}]
 */
async function runApifyPhoneReveal(listings) {
  if (!APIFY_TOKEN) {
    logger.warn('[PhoneOrch] APIFY_API_TOKEN not configured — skipping Apify enrichment');
    return [];
  }

  const actorId = process.env.APIFY_PHONE_REVEAL_ACTOR || 'quantum-phone-reveal';

  const input = {
    listings: listings.map(l => ({
      id: l.id,
      url: l.url,
      source: l.source,
      sourceListingId: l.source_listing_id,
      address: l.address,
      city: l.city,
    })),
    maxConcurrency: 5,
    proxyConfig: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      countryCode: 'IL',
    },
  };

  try {
    logger.info(`[PhoneOrch] Apify: sending ${listings.length} listings to actor ${actorId}`);

    const resp = await axios.post(
      `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`,
      input,
      {
        headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
        timeout: 600000, // 10 min for large batches
        params: { timeout: 600 },
      }
    );

    const results = resp.data || [];
    logger.info(`[PhoneOrch] Apify returned ${results.length} results`);
    return results;
  } catch (err) {
    // If sync call times out, try async
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return await runApifyAsync(actorId, input);
    }
    logger.error(`[PhoneOrch] Apify actor failed: ${err.message}`);
    return [];
  }
}

/**
 * Async fallback — start actor run, poll for completion.
 */
async function runApifyAsync(actorId, input) {
  try {
    // Start the run
    const startResp = await axios.post(
      `${APIFY_BASE}/acts/${actorId}/runs`,
      input,
      {
        headers: { Authorization: `Bearer ${APIFY_TOKEN}` },
        timeout: 30000,
      }
    );

    const runId = startResp.data?.data?.id;
    if (!runId) return [];

    logger.info(`[PhoneOrch] Apify async run started: ${runId}`);

    // Poll for completion (max 15 min)
    const maxWait = 15 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await sleep(15000); // Check every 15s

      const statusResp = await axios.get(
        `${APIFY_BASE}/actor-runs/${runId}`,
        { headers: { Authorization: `Bearer ${APIFY_TOKEN}` }, timeout: 10000 }
      );

      const status = statusResp.data?.data?.status;
      if (status === 'SUCCEEDED') {
        // Fetch dataset items
        const datasetId = statusResp.data?.data?.defaultDatasetId;
        const dataResp = await axios.get(
          `${APIFY_BASE}/datasets/${datasetId}/items`,
          { headers: { Authorization: `Bearer ${APIFY_TOKEN}` }, timeout: 30000 }
        );
        return dataResp.data || [];
      }
      if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        logger.error(`[PhoneOrch] Apify run ${runId} ended with status: ${status}`);
        return [];
      }
    }
    logger.warn(`[PhoneOrch] Apify run ${runId} timed out after 15 min`);
    return [];
  } catch (err) {
    logger.error(`[PhoneOrch] Apify async failed: ${err.message}`);
    return [];
  }
}

// ── Method 4: yad2 direct API phone endpoint (opportunistic, often 403) ─────

async function tryYad2ApiPhone(itemId) {
  if (!itemId || itemId === 'NULL' || itemId.startsWith('yad2-') || itemId.startsWith('ai-')) return null;

  const endpoints = [
    `https://gw.yad2.co.il/feed-search/item/${itemId}/phone`,
    `https://gw.yad2.co.il/feed-search-legacy/item/${itemId}/phone`,
  ];

  for (const endpoint of endpoints) {
    try {
      const r = await axios.get(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.yad2.co.il/',
          'Origin': 'https://www.yad2.co.il',
        },
        timeout: 8000,
      });
      if (r.data?.data) {
        const d = r.data.data;
        const phone = cleanPhone(d.phone || d.phone_number || d.contactPhone);
        if (phone) return phone;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ── Method 5: Platform-specific direct page scraping (no browser) ────────────

async function tryDirectPageScrape(listing) {
  if (!listing.url || listing.url === 'NULL') return null;

  try {
    const r = await axios.get(listing.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'he-IL,he;q=0.9',
      },
      timeout: 15000,
      maxRedirects: 3,
    });

    const html = r.data;
    if (typeof html !== 'string') return null;

    // Look for tel: links
    const telMatch = html.match(/href="tel:([^"]+)"/);
    if (telMatch) {
      const phone = cleanPhone(telMatch[1]);
      if (phone) return phone;
    }

    // Look for phone patterns in page content
    const phoneRegex = /(?:0[2-9]\d[\s-]?\d{3}[\s-]?\d{4}|05\d[\s-]?\d{3}[\s-]?\d{4})/g;
    const matches = html.match(phoneRegex);
    if (matches) {
      for (const m of matches) {
        const phone = cleanPhone(m);
        if (phone) return phone;
      }
    }
  } catch (err) {
    // 403/Cloudflare block = expected for yad2, skip silently
    if (err.response?.status !== 403) {
      logger.debug(`[PhoneOrch] Page scrape failed for ${listing.url}: ${err.message}`);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Enrich ALL listings without phone numbers.
 * Multi-pass strategy for maximum coverage:
 *
 * Pass 1: Regex extraction from description/title (instant, free)
 * Pass 2: Komo open phone API (free, reliable)
 * Pass 3: yad2 direct API (opportunistic, sometimes works)
 * Pass 4: Direct page scraping for non-cloudflare sites (free)
 * Pass 5: Apify browser automation for remaining (paid, reliable)
 *
 * @param {object} options
 * @param {number} options.limit - Max listings to process (default: all)
 * @param {string} options.source - Filter by platform (null = all)
 * @param {boolean} options.useApify - Whether to use Apify (default: true)
 * @param {boolean} options.dryRun - Log without updating DB
 * @returns {object} Results summary
 */
async function enrichAllPhones(options = {}) {
  const { limit = 2000, source = null, useApify = true, dryRun = false } = options;

  // Fetch ALL listings without phone
  let query = `
    SELECT id, address, city, asking_price, source, source_listing_id,
           description_snippet, title, phone, url, contact_name
    FROM listings
    WHERE is_active = TRUE
      AND (phone IS NULL OR phone = '' OR phone = 'NULL')
  `;
  const params = [];
  if (source) {
    params.push(source);
    query += ` AND source = $${params.length}`;
  }
  params.push(limit);
  query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const { rows: allListings } = await pool.query(query, params);

  if (!allListings.length) {
    logger.info('[PhoneOrch] No listings need phone enrichment');
    return { enriched: 0, total: 0, passes: {} };
  }

  logger.info(`[PhoneOrch] ═══ Starting enrichment for ${allListings.length} listings ═══`);

  const results = {
    total: allListings.length,
    enriched: 0,
    passes: {
      regex: { attempted: 0, enriched: 0 },
      komo_api: { attempted: 0, enriched: 0 },
      yad2_api: { attempted: 0, enriched: 0 },
      page_scrape: { attempted: 0, enriched: 0 },
      apify: { attempted: 0, enriched: 0 },
    },
    byPlatform: {},
  };

  // Track which listings still need phones
  const needsPhone = new Set(allListings.map(l => l.id));
  const listingMap = new Map(allListings.map(l => [l.id, l]));

  function markEnriched(id, phone, contactName, method) {
    needsPhone.delete(id);
    results.enriched++;
    results.passes[method].enriched++;
    const listing = listingMap.get(id);
    if (listing) {
      const src = listing.source || 'unknown';
      if (!results.byPlatform[src]) results.byPlatform[src] = { total: 0, enriched: 0 };
      results.byPlatform[src].enriched++;
    }
  }

  // Count totals by platform
  for (const l of allListings) {
    const src = l.source || 'unknown';
    if (!results.byPlatform[src]) results.byPlatform[src] = { total: 0, enriched: 0 };
    results.byPlatform[src].total++;
  }

  // ── PASS 1: Regex extraction ──────────────────────────────────────────────

  logger.info('[PhoneOrch] Pass 1: Regex extraction from description/title...');
  for (const listing of allListings) {
    const text = [listing.description_snippet, listing.title, listing.address].filter(Boolean).join(' ');
    const phone = extractPhoneFromText(text);
    if (phone) {
      results.passes.regex.attempted++;
      if (!dryRun) {
        await pool.query(
          `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
          [phone, listing.id]
        );
      }
      markEnriched(listing.id, phone, null, 'regex');
      logger.debug(`[PhoneOrch] Regex: ${listing.address} → ${phone}`);
    }
  }
  logger.info(`[PhoneOrch] Pass 1 complete: ${results.passes.regex.enriched} phones from regex`);

  // ── PASS 2: Komo open phone API ───────────────────────────────────────────

  const komoListings = allListings.filter(l => needsPhone.has(l.id) && l.source === 'komo');
  if (komoListings.length > 0) {
    logger.info(`[PhoneOrch] Pass 2: Komo open API for ${komoListings.length} listings...`);
    results.passes.komo_api.attempted = komoListings.length;
    const komoEnriched = dryRun ? 0 : await enrichKomoListings(komoListings);
    // Re-check which komo listings got enriched
    if (!dryRun) {
      const komoIds = komoListings.map(l => l.id);
      const { rows: updated } = await pool.query(
        `SELECT id FROM listings WHERE id = ANY($1) AND phone IS NOT NULL AND phone != '' AND phone != 'NULL'`,
        [komoIds]
      );
      for (const row of updated) {
        if (needsPhone.has(row.id)) markEnriched(row.id, null, null, 'komo_api');
      }
    }
    logger.info(`[PhoneOrch] Pass 2 complete: ${results.passes.komo_api.enriched} phones from Komo API`);
  }

  // ── PASS 3: yad2 direct API (phone endpoint, no browser) ─────────────────

  const yad2Listings = allListings.filter(
    l => needsPhone.has(l.id) && l.source === 'yad2' && l.source_listing_id &&
         !l.source_listing_id.startsWith('yad2-') && !l.source_listing_id.startsWith('ai-') &&
         /^[a-zA-Z0-9_-]+$/.test(l.source_listing_id)
  );
  if (yad2Listings.length > 0) {
    logger.info(`[PhoneOrch] Pass 3: yad2 direct API for ${yad2Listings.length} listings...`);
    results.passes.yad2_api.attempted = yad2Listings.length;
    for (const listing of yad2Listings) {
      const phone = await tryYad2ApiPhone(listing.source_listing_id);
      if (phone) {
        if (!dryRun) {
          await pool.query(
            `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
            [phone, listing.id]
          );
        }
        markEnriched(listing.id, phone, null, 'yad2_api');
        logger.debug(`[PhoneOrch] yad2 API: ${listing.address} → ${phone}`);
      }
      await sleep(1500);
    }
    logger.info(`[PhoneOrch] Pass 3 complete: ${results.passes.yad2_api.enriched} phones from yad2 API`);
  }

  // ── PASS 4: Direct page scraping (for non-Cloudflare sites) ───────────────

  const scrapableSources = ['dira', 'homeless', 'banknadlan', 'yad1'];
  const scrapableListings = allListings.filter(
    l => needsPhone.has(l.id) && scrapableSources.includes(l.source) && l.url && l.url !== 'NULL'
  );
  if (scrapableListings.length > 0) {
    logger.info(`[PhoneOrch] Pass 4: Direct page scraping for ${scrapableListings.length} listings...`);
    results.passes.page_scrape.attempted = scrapableListings.length;
    for (const listing of scrapableListings) {
      const phone = await tryDirectPageScrape(listing);
      if (phone) {
        if (!dryRun) {
          await pool.query(
            `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
            [phone, listing.id]
          );
        }
        markEnriched(listing.id, phone, null, 'page_scrape');
        logger.debug(`[PhoneOrch] Scrape: [${listing.source}] ${listing.address} → ${phone}`);
      }
      await sleep(2000);
    }
    logger.info(`[PhoneOrch] Pass 4 complete: ${results.passes.page_scrape.enriched} phones from page scraping`);
  }

  // ── PASS 5: Apify browser automation (for everything remaining) ───────────

  const remaining = allListings.filter(
    l => needsPhone.has(l.id) && l.url && l.url !== 'NULL' &&
         !l.url.includes('/forsale?') && !l.url.includes('/city/')
  );
  if (remaining.length > 0 && useApify) {
    logger.info(`[PhoneOrch] Pass 5: Apify browser automation for ${remaining.length} remaining listings...`);
    results.passes.apify.attempted = remaining.length;

    // Process in batches of 25
    for (let i = 0; i < remaining.length; i += 25) {
      const batch = remaining.slice(i, i + 25);
      const apifyResults = await runApifyPhoneReveal(batch);

      for (const result of apifyResults) {
        const phone = cleanPhone(result.phone);
        if (phone && result.id) {
          if (!dryRun) {
            await pool.query(
              `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
              [phone, result.contact_name || null, result.id]
            );
          }
          markEnriched(result.id, phone, result.contact_name, 'apify');
          logger.debug(`[PhoneOrch] Apify: [${listingMap.get(result.id)?.source}] ${listingMap.get(result.id)?.address} → ${phone}`);
        }
      }
    }
    logger.info(`[PhoneOrch] Pass 5 complete: ${results.passes.apify.enriched} phones from Apify`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const coverage = results.total > 0 ? ((results.enriched / results.total) * 100).toFixed(1) : '0';
  logger.info(`[PhoneOrch] ═══ COMPLETE: ${results.enriched}/${results.total} phones found (${coverage}% coverage) ═══`);
  logger.info(`[PhoneOrch] Breakdown: regex=${results.passes.regex.enriched} komo=${results.passes.komo_api.enriched} yad2api=${results.passes.yad2_api.enriched} scrape=${results.passes.page_scrape.enriched} apify=${results.passes.apify.enriched}`);

  for (const [platform, stats] of Object.entries(results.byPlatform)) {
    const pct = stats.total > 0 ? ((stats.enriched / stats.total) * 100).toFixed(1) : '0';
    logger.info(`[PhoneOrch]   ${platform}: ${stats.enriched}/${stats.total} (${pct}%)`);
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// SINGLE LISTING ENRICHMENT (for real-time use after scraping)
// ══════════════════════════════════════════════════════════════════════════════

async function enrichSingleListing(listing) {
  if (listing.phone && listing.phone.trim() && listing.phone !== 'NULL') {
    return { success: false, reason: 'already_has_phone' };
  }

  // Pass 1: Regex
  const text = [listing.description_snippet, listing.title, listing.address].filter(Boolean).join(' ');
  let phone = extractPhoneFromText(text);
  let method = phone ? 'regex' : null;

  // Pass 2: Komo API
  if (!phone && listing.source === 'komo') {
    let modaaNum = null;
    if (listing.source_listing_id && /^\d+$/.test(listing.source_listing_id)) {
      modaaNum = listing.source_listing_id;
    } else if (listing.url) {
      const match = listing.url.match(/modaaNum=(\d+)/i);
      if (match) modaaNum = match[1];
    }
    if (modaaNum) {
      const result = await fetchKomoPhone(modaaNum);
      if (result.phone) {
        phone = result.phone;
        method = 'komo_api';
        if (result.contact_name) listing.contact_name = result.contact_name;
      }
    }
  }

  // Pass 3: yad2 API
  if (!phone && listing.source === 'yad2' && listing.source_listing_id) {
    phone = await tryYad2ApiPhone(listing.source_listing_id);
    if (phone) method = 'yad2_api';
  }

  // Pass 4: Direct page scrape
  if (!phone && listing.url && listing.url !== 'NULL') {
    phone = await tryDirectPageScrape(listing);
    if (phone) method = 'page_scrape';
  }

  if (phone) {
    await pool.query(
      `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
      [phone, listing.contact_name || null, listing.id]
    );
    return { success: true, phone, method };
  }

  return { success: false, reason: 'no_phone_found' };
}

// ══════════════════════════════════════════════════════════════════════════════
// COVERAGE REPORT
// ══════════════════════════════════════════════════════════════════════════════

async function getCoverageReport() {
  const { rows } = await pool.query(`
    SELECT
      source,
      COUNT(*) as total,
      COUNT(CASE WHEN phone IS NOT NULL AND phone != '' AND phone != 'NULL' THEN 1 END) as with_phone,
      ROUND(100.0 * COUNT(CASE WHEN phone IS NOT NULL AND phone != '' AND phone != 'NULL' THEN 1 END) / NULLIF(COUNT(*), 0), 1) as coverage_pct
    FROM listings
    WHERE is_active = TRUE
    GROUP BY source
    ORDER BY total DESC
  `);

  const overall = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN phone IS NOT NULL AND phone != '' AND phone != 'NULL' THEN 1 END) as with_phone
    FROM listings WHERE is_active = TRUE
  `);

  const o = overall.rows[0];
  return {
    overall: {
      total: parseInt(o.total),
      with_phone: parseInt(o.with_phone),
      coverage_pct: o.total > 0 ? ((o.with_phone / o.total) * 100).toFixed(1) : '0',
    },
    byPlatform: rows.map(r => ({
      source: r.source,
      total: parseInt(r.total),
      with_phone: parseInt(r.with_phone),
      coverage_pct: parseFloat(r.coverage_pct) || 0,
    })),
  };
}

module.exports = {
  enrichAllPhones,
  enrichSingleListing,
  getCoverageReport,
  // Individual methods (for testing)
  extractPhoneFromText,
  fetchKomoPhone,
  tryYad2ApiPhone,
  tryDirectPageScrape,
  runApifyPhoneReveal,
  cleanPhone,
};
