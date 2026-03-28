/**
 * QUANTUM Phone Reveal — Apify Actor
 *
 * Multi-platform browser automation for revealing phone numbers on
 * Israeli real estate websites. Uses Apify residential proxies to
 * bypass Cloudflare and bot protection.
 *
 * Deploy: apify push quantum-phone-reveal
 *
 * Supported platforms:
 *   - yad2.co.il     (click-to-reveal + API intercept)
 *   - yad1.co.il     (page scraping + tel: links)
 *   - dira.co.il     (page scraping)
 *   - homeless.co.il  (page scraping + API intercept)
 *   - banknadlan.co.il (attorney contact info)
 *   - komo.co.il      (fallback — open API preferred via orchestrator)
 *   - madlan.co.il    (page scraping)
 *
 * Input:
 *   listings: [{id, url, source, sourceListingId, address, city}]
 *   maxConcurrency: number (default 5)
 *   proxyConfig: { useApifyProxy, apifyProxyGroups, countryCode }
 *
 * Output:
 *   [{id, phone, contact_name, source, method}]
 */

const { Actor } = require('apify');
const { PuppeteerCrawler, log } = require('crawlee');

// ── Phone utils ──────────────────────────────────────────────────────────────

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  if (digits.startsWith('0')) return digits;
  return null;
}

function extractPhonesFromText(text) {
  if (!text) return [];
  const regex = /(?:0[2-9][\s-]?\d{3}[\s-]?\d{4}|05\d[\s-]?\d{3}[\s-]?\d{4}|\+972[\s-]?[2-9][\s-]?\d{3}[\s-]?\d{4})/g;
  const matches = text.match(regex) || [];
  return matches.map(cleanPhone).filter(Boolean);
}

// ── Platform-specific handlers ───────────────────────────────────────────────

/**
 * yad2.co.il — Click "הצג טלפון" button, intercept phone API response
 */
async function handleYad2(page, listing) {
  let capturedPhone = null;

  // Intercept phone API responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/phone') || url.includes('phone_number')) {
      try {
        const data = await response.json();
        const d = data?.data || data;
        const phone = cleanPhone(d?.phone || d?.phone_number || d?.contactPhone || d?.phones?.[0]);
        if (phone) capturedPhone = phone;
      } catch (e) { /* not json */ }
    }
  });

  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Click reveal button
  const revealSelectors = [
    '[data-testid="phone-button"]',
    '[data-test="phone-reveal"]',
    '[data-test="reveal-phone"]',
    'button[class*="phone-reveal"]',
    'button[class*="phone"]',
    '[class*="reveal-phone"]',
    'button[aria-label*="טלפון"]',
    '[data-test="contact-phone"]',
    '[class*="phoneReveal"]',
    '[class*="PhoneButton"]',
  ];

  for (const sel of revealSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(3000);
        break;
      }
    } catch (e) { /* try next */ }
  }

  if (capturedPhone) return { phone: capturedPhone, method: 'api_intercept' };

  // Fallback: tel: links
  const telPhone = await page.evaluate(() => {
    const tel = document.querySelector('a[href^="tel:"]');
    return tel ? tel.href.replace('tel:', '').replace(/\s/g, '') : null;
  });
  if (cleanPhone(telPhone)) return { phone: cleanPhone(telPhone), method: 'tel_link' };

  // Fallback: regex on page text
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const phones = extractPhonesFromText(pageText);
  if (phones.length) return { phone: phones[0], method: 'page_regex' };

  return { phone: null, method: null };
}

/**
 * yad1.co.il — Simpler site, phone often in page content
 */
async function handleYad1(page, listing) {
  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  // Try clicking phone reveal button
  try {
    const btn = await page.$('button[class*="phone"], [class*="show-phone"], [data-action="reveal-phone"]');
    if (btn) { await btn.click(); await page.waitForTimeout(2000); }
  } catch (e) { /* no button */ }

  // Extract from tel: links
  const telPhone = await page.evaluate(() => {
    const tel = document.querySelector('a[href^="tel:"]');
    return tel ? tel.href.replace('tel:', '').replace(/\s/g, '') : null;
  });
  if (cleanPhone(telPhone)) return { phone: cleanPhone(telPhone), method: 'tel_link' };

  // Regex on page text
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const phones = extractPhonesFromText(pageText);
  if (phones.length) return { phone: phones[0], method: 'page_regex' };

  return { phone: null, method: null };
}

/**
 * dira.co.il — Government housing portal
 */
async function handleDira(page, listing) {
  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  // Try phone reveal button
  try {
    const btn = await page.$('[class*="phone"], [class*="contact-btn"], button[class*="reveal"]');
    if (btn) { await btn.click(); await page.waitForTimeout(2000); }
  } catch (e) { /* skip */ }

  // tel: link
  const telPhone = await page.evaluate(() => {
    const tel = document.querySelector('a[href^="tel:"]');
    return tel ? tel.href.replace('tel:', '').replace(/\s/g, '') : null;
  });
  if (cleanPhone(telPhone)) return { phone: cleanPhone(telPhone), method: 'tel_link' };

  // Contact section
  const contactPhone = await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="contact"], [class*="phone"], [class*="seller"]');
    for (const el of els) {
      const text = el.textContent || '';
      const m = text.match(/0[2-9]\d[\s-]?\d{3}[\s-]?\d{4}|05\d[\s-]?\d{3}[\s-]?\d{4}/);
      if (m) return m[0];
    }
    return null;
  });
  if (cleanPhone(contactPhone)) return { phone: cleanPhone(contactPhone), method: 'contact_section' };

  // Full page regex
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const phones = extractPhonesFromText(pageText);
  if (phones.length) return { phone: phones[0], method: 'page_regex' };

  return { phone: null, method: null };
}

/**
 * homeless.co.il — Similar to yad1
 */
async function handleHomeless(page, listing) {
  let capturedPhone = null;

  // Intercept API responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('phone') || url.includes('contact')) {
      try {
        const data = await response.json();
        const phone = cleanPhone(data?.phone || data?.data?.phone || data?.seller_phone);
        if (phone) capturedPhone = phone;
      } catch (e) { /* skip */ }
    }
  });

  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  // Click reveal
  try {
    const btn = await page.$('[class*="phone"], [class*="show-phone"], [class*="reveal"]');
    if (btn) { await btn.click(); await page.waitForTimeout(2500); }
  } catch (e) { /* skip */ }

  if (capturedPhone) return { phone: capturedPhone, method: 'api_intercept' };

  const telPhone = await page.evaluate(() => {
    const tel = document.querySelector('a[href^="tel:"]');
    return tel ? tel.href.replace('tel:', '').replace(/\s/g, '') : null;
  });
  if (cleanPhone(telPhone)) return { phone: cleanPhone(telPhone), method: 'tel_link' };

  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const phones = extractPhonesFromText(pageText);
  if (phones.length) return { phone: phones[0], method: 'page_regex' };

  return { phone: null, method: null };
}

/**
 * banknadlan.co.il — Foreclosure listings, attorney contact
 */
async function handleBankNadlan(page, listing) {
  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  // BankNadlan usually shows attorney/agent info directly
  const contactInfo = await page.evaluate(() => {
    let phone = null;
    let name = null;

    // Look for attorney/agent section
    const sections = document.querySelectorAll('[class*="contact"], [class*="attorney"], [class*="agent"], [class*="lawyer"], [class*="details"]');
    for (const section of sections) {
      const text = section.textContent || '';
      const phoneMatch = text.match(/0[2-9]\d[\s-]?\d{3}[\s-]?\d{4}|05\d[\s-]?\d{3}[\s-]?\d{4}/);
      if (phoneMatch) {
        phone = phoneMatch[0];
        // Try to find name nearby
        const nameMatch = text.match(/עו"ד\s+([^\n,]+)|כונס[:\s]+([^\n,]+)|נציג[:\s]+([^\n,]+)/);
        if (nameMatch) name = (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
        break;
      }
    }

    // Fallback: tel: links
    if (!phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) phone = tel.href.replace('tel:', '').replace(/\s/g, '');
    }

    // Fallback: full page
    if (!phone) {
      const text = document.body?.innerText || '';
      const m = text.match(/0[2-9]\d[\s-]?\d{3}[\s-]?\d{4}|05\d[\s-]?\d{3}[\s-]?\d{4}/);
      if (m) phone = m[0];
    }

    return { phone, name };
  });

  if (cleanPhone(contactInfo.phone)) {
    return { phone: cleanPhone(contactInfo.phone), contact_name: contactInfo.name, method: 'page_scrape' };
  }

  return { phone: null, method: null };
}

/**
 * komo.co.il — Fallback (orchestrator usually handles via open API)
 */
async function handleKomo(page, listing) {
  // Extract modaaNum
  const modaaMatch = listing.url?.match(/modaaNum=(\d+)/);
  if (!modaaMatch) {
    // Try page scraping
    await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const pageText = await page.evaluate(() => document.body?.innerText || '');
    const phones = extractPhonesFromText(pageText);
    if (phones.length) return { phone: phones[0], method: 'page_regex' };
    return { phone: null, method: null };
  }

  // Use the open API directly (more reliable than browser)
  try {
    const resp = await page.evaluate(async (modaaNum) => {
      const r = await fetch('https://www.komo.co.il/api/modaotService/showPhoneDetails/post/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `luachNum=2&modaaNum=${modaaNum}&source=1`,
      });
      return r.json();
    }, modaaMatch[1]);

    if (resp?.status === 'OK' && resp?.list) {
      const { name, phone1_pre, phone1, phone2_pre, phone2 } = resp.list;
      const ph = cleanPhone(`${phone1_pre || ''}${phone1 || ''}`) ||
                 cleanPhone(`${phone2_pre || ''}${phone2 || ''}`);
      if (ph) return { phone: ph, contact_name: name, method: 'komo_api' };
    }
  } catch (e) { /* fallback to page scrape */ }

  return { phone: null, method: null };
}

/**
 * madlan.co.il — Page scraping
 */
async function handleMadlan(page, listing) {
  await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  const telPhone = await page.evaluate(() => {
    const tel = document.querySelector('a[href^="tel:"]');
    return tel ? tel.href.replace('tel:', '').replace(/\s/g, '') : null;
  });
  if (cleanPhone(telPhone)) return { phone: cleanPhone(telPhone), method: 'tel_link' };

  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const phones = extractPhonesFromText(pageText);
  if (phones.length) return { phone: phones[0], method: 'page_regex' };

  return { phone: null, method: null };
}

// ── Router ───────────────────────────────────────────────────────────────────

function getHandler(source, url) {
  if (url?.includes('yad2.co.il')) return handleYad2;
  if (url?.includes('yad1.co.il')) return handleYad1;
  if (url?.includes('dira.co.il')) return handleDira;
  if (url?.includes('homeless.co.il')) return handleHomeless;
  if (url?.includes('banknadlan.co.il')) return handleBankNadlan;
  if (url?.includes('komo.co.il')) return handleKomo;
  if (url?.includes('madlan.co.il')) return handleMadlan;

  // Source-based fallback
  switch (source) {
    case 'yad2': return handleYad2;
    case 'yad1': return handleYad1;
    case 'dira': return handleDira;
    case 'homeless': return handleHomeless;
    case 'banknadlan': return handleBankNadlan;
    case 'komo': return handleKomo;
    default: return handleYad2; // Generic handler
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

Actor.main(async () => {
  const input = await Actor.getInput();
  const { listings = [], maxConcurrency = 5, proxyConfig = {} } = input;

  log.info(`Processing ${listings.length} listings across multiple platforms`);

  const results = [];
  const failed = [];

  // Filter out listings without usable URLs
  const validListings = listings.filter(l => {
    if (!l.url || l.url === 'NULL') return false;
    // Skip search result pages — these don't have individual listing phones
    if (l.url.includes('/forsale?') || l.url.includes('/city/') ||
        l.url.includes('apartments-for-sale.asp?n')) return false;
    return true;
  });

  log.info(`${validListings.length} listings have valid URLs (filtered from ${listings.length})`);

  const crawler = new PuppeteerCrawler({
    maxConcurrency,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: maxConcurrency * 2 },
    proxyConfiguration: proxyConfig.useApifyProxy
      ? await Actor.createProxyConfiguration({
          groups: proxyConfig.apifyProxyGroups || ['RESIDENTIAL'],
          countryCode: proxyConfig.countryCode || 'IL',
        })
      : undefined,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 45,
    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--lang=he-IL',
        ],
      },
    },

    async requestHandler({ page, request }) {
      const listing = request.userData;
      const handler = getHandler(listing.source, listing.url);

      try {
        const result = await handler(page, listing);
        if (result?.phone) {
          log.info(`✅ [${listing.source}] ${listing.address || listing.url} → ${result.phone} (${result.method})`);
          results.push({
            id: listing.id,
            phone: result.phone,
            contact_name: result.contact_name || null,
            source: listing.source,
            method: result.method,
          });
        } else {
          log.debug(`❌ [${listing.source}] ${listing.address || listing.url} — no phone found`);
        }
      } catch (err) {
        log.warning(`Error [${listing.source}] ${listing.url}: ${err.message}`);
        failed.push({ id: listing.id, error: err.message });
      }
    },

    async failedRequestHandler({ request, error }) {
      const listing = request.userData;
      log.warning(`Failed [${listing.source}] ${listing.url}: ${error.message}`);
      failed.push({ id: listing.id, error: error.message });
    },
  });

  const requests = validListings.map(l => ({
    url: l.url,
    userData: l,
    uniqueKey: `${l.id}-${l.url}`,
  }));

  await crawler.run(requests);

  log.info(`Complete: ${results.length} phones found, ${failed.length} failed, ${validListings.length - results.length - failed.length} no phone`);

  await Actor.pushData(results);
});
