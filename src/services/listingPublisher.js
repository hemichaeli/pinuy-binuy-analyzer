/**
 * Listing Publisher Service
 * Publishes outgoing listings to multiple real-estate platforms.
 *
 * Supported platforms:
 *   - yad2       (Puppeteer + 2captcha Residential Proxy + Cloudflare Turnstile)
 *   - homeless   (Puppeteer + 2captcha Residential Proxy + reCAPTCHA)
 *   - madlan     (Puppeteer + 2captcha Residential Proxy)
 *   - winwin     (Puppeteer + 2captcha Residential Proxy)
 *   - facebook   (Apify actor — scraping only, manual publish fallback)
 *
 * Env vars required:
 *   TWOCAPTCHA_API_KEY          — 2captcha API key (captcha solving + residential proxy)
 *   TWOCAPTCHA_PROXY_USER       — 2captcha proxy username (u1d381207513d0589-zone-custom)
 *   TWOCAPTCHA_PROXY_PASS       — 2captcha proxy password (2ddaa2a486fc4e3296acd639aa486614)
 *   TWOCAPTCHA_PROXY_HOST       — ap.proxy.2captcha.com
 *   TWOCAPTCHA_PROXY_PORT       — 2334
 *   YAD2_EMAIL, YAD2_PASSWORD
 *   HOMELESS_EMAIL, HOMELESS_PASSWORD
 *   MADLAN_EMAIL, MADLAN_PASSWORD
 *   WINWIN_EMAIL, WINWIN_PASSWORD
 *   APIFY_API_TOKEN (for Facebook)
 */

const { logger } = require('./logger');
const pool = require('../db/pool');
const axios = require('axios');

// ─────────────────────────────────────────────
// PROXY HELPERS
// ─────────────────────────────────────────────

/**
 * Returns 2captcha residential proxy args for Puppeteer launch.
 * Falls back to no proxy if env vars not set.
 */
function getProxyArgs() {
  const host = process.env.TWOCAPTCHA_PROXY_HOST || 'ap.proxy.2captcha.com';
  const port = process.env.TWOCAPTCHA_PROXY_PORT || '2334';
  return [`--proxy-server=http://${host}:${port}`];
}

/**
 * Authenticate proxy in the browser page (basic auth popup).
 */
async function authenticateProxy(page) {
  const user = process.env.TWOCAPTCHA_PROXY_USER || 'u1d381207513d0589-zone-custom';
  const pass = process.env.TWOCAPTCHA_PROXY_PASS || '2ddaa2a486fc4e3296acd639aa486614';
  await page.authenticate({ username: user, password: pass });
}

// ─────────────────────────────────────────────
// BROWSER FACTORY (puppeteer-extra + stealth + residential proxy)
// ─────────────────────────────────────────────
async function launchStealthBrowser({ useProxy = true } = {}) {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,800',
    '--lang=he-IL,he',
    '--disable-web-security',
    '--allow-running-insecure-content'
  ];

  if (useProxy) {
    args.push(...getProxyArgs());
  }

  return puppeteer.launch({
    headless: 'new',
    args
  });
}

// ─────────────────────────────────────────────
// CAPTCHA SOLVERS
// ─────────────────────────────────────────────

/** Solve image/text captcha */
async function solveCaptchaImage(base64Image) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) return null;
  try {
    const { Solver } = require('2captcha-ts');
    const solver = new Solver(apiKey);
    const result = await solver.imageCaptcha({ body: base64Image });
    return result.data;
  } catch (err) {
    logger.warn('[2captcha] Failed to solve image captcha:', err.message);
    return null;
  }
}

/** Solve reCAPTCHA v2 */
async function solveRecaptchaV2(siteKey, pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) return null;
  try {
    const { Solver } = require('2captcha-ts');
    const solver = new Solver(apiKey);
    const result = await solver.recaptcha({ googlekey: siteKey, pageurl: pageUrl });
    return result.data;
  } catch (err) {
    logger.warn('[2captcha] Failed to solve reCAPTCHA:', err.message);
    return null;
  }
}

/** Solve Cloudflare Turnstile */
async function solveTurnstile(siteKey, pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) return null;
  try {
    const { Solver } = require('2captcha-ts');
    const solver = new Solver(apiKey);
    const result = await solver.cloudflareTurnstile({ sitekey: siteKey, pageurl: pageUrl });
    return result.data;
  } catch (err) {
    logger.warn('[2captcha] Failed to solve Turnstile:', err.message);
    return null;
  }
}

/** Detect and solve any captcha on the current page */
async function detectAndSolveCaptcha(page) {
  const url = page.url();

  // Cloudflare Turnstile
  const turnstileKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el && el.closest('[class*="turnstile"], [id*="turnstile"], [class*="cf-"]')) {
      return el.getAttribute('data-sitekey');
    }
    // Also check for cf-turnstile class
    const cfEl = document.querySelector('.cf-turnstile, [data-cf-turnstile]');
    if (cfEl) return cfEl.getAttribute('data-sitekey');
    return null;
  }).catch(() => null);

  if (turnstileKey) {
    logger.info('[2captcha] Turnstile detected, solving...');
    const token = await solveTurnstile(turnstileKey, url);
    if (token) {
      await page.evaluate((t) => {
        // Inject token into Turnstile response field
        const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="turnstile-response"]');
        inputs.forEach(el => { el.value = t; });
        // Try callback
        if (window.turnstile && window.turnstile.reset) {
          // some sites use callback
        }
      }, token);
      logger.info('[2captcha] Turnstile token injected');
      return true;
    }
  }

  // reCAPTCHA v2
  const recaptchaKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    return null;
  }).catch(() => null);

  if (recaptchaKey) {
    logger.info('[2captcha] reCAPTCHA detected, solving...');
    const token = await solveRecaptchaV2(recaptchaKey, url);
    if (token) {
      await page.evaluate((t) => {
        const el = document.querySelector('[name="g-recaptcha-response"]');
        if (el) el.value = t;
        // Try to trigger callback
        if (window.grecaptcha) {
          try {
            const widgetId = window.___grecaptcha_cfg?.clients?.[0];
            if (widgetId !== undefined) window.grecaptcha.reset(widgetId);
          } catch (e) {}
        }
      }, token);
      logger.info('[2captcha] reCAPTCHA token injected');
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────
async function publishListing(listingId, platforms) {
  const listing = await getListing(listingId);
  if (!listing) throw new Error(`Listing ${listingId} not found`);

  logger.info(`[Publisher] Publishing listing ${listingId} to: ${platforms.join(', ')}`);

  const results = {};

  for (const platform of platforms) {
    try {
      let result;
      switch (platform) {
        case 'yad2':     result = await publishToYad2(listing); break;
        case 'homeless': result = await publishToHomeless(listing); break;
        case 'madlan':   result = await publishToMadlan(listing); break;
        case 'winwin':   result = await publishToWinwin(listing); break;
        case 'facebook': result = await publishToFacebook(listing); break;
        default:
          results[platform] = { success: false, error: 'Unknown platform' };
          continue;
      }
      results[platform] = result;

      if (result.success) {
        await pool.query(
          `UPDATE outgoing_listings 
           SET published_platforms = array_append(
             COALESCE(published_platforms, '{}'), $1::text
           ),
           status = 'active',
           updated_at = NOW()
           WHERE id = $2 AND NOT ($1 = ANY(COALESCE(published_platforms, '{}')))`,
          [platform, listingId]
        );
        logger.info(`[Publisher] ✅ ${platform} published (id: ${result.external_id || 'N/A'})`);
      } else {
        logger.warn(`[Publisher] ❌ ${platform} failed: ${result.error}`);
      }
    } catch (err) {
      results[platform] = { success: false, error: err.message };
      logger.error(`[Publisher] ${platform} error:`, err.message);
    }
  }

  const anySuccess = Object.values(results).some(r => r.success);
  if (!anySuccess) {
    await pool.query(
      `UPDATE outgoing_listings SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [listingId]
    );
  }

  return results;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function getListing(id) {
  const r = await pool.query(`SELECT * FROM outgoing_listings WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

function formatPrice(price) {
  if (!price) return '';
  return price.toLocaleString('he-IL');
}

function buildTitle(listing) {
  const city = listing.city || listing.address || '';
  const rooms = listing.rooms ? `${listing.rooms} חדרים` : 'דירה';
  return `${rooms} ב${city} - פינוי בינוי`;
}

function buildDescription(listing) {
  const parts = [];
  if (listing.description) {
    parts.push(listing.description);
  } else {
    parts.push('נכס בפרויקט פינוי בינוי מתקדם');
    if (listing.rooms) parts.push(`${listing.rooms} חדרים`);
    if (listing.floor) parts.push(`קומה ${listing.floor}`);
    if (listing.area_sqm) parts.push(`${listing.area_sqm} מ"ר`);
    if (listing.asking_price) parts.push(`מחיר: ₪${formatPrice(listing.asking_price)}`);
    parts.push('השקעה מצוינת למשקיעים');
  }
  return parts.join('\n');
}

// ─────────────────────────────────────────────
// FACEBOOK MARKETPLACE (via Apify — scraping only)
// ─────────────────────────────────────────────
async function publishToFacebook(listing) {
  // Facebook Marketplace does not allow automated publishing via API.
  // The Apify actor curious_coder~facebook-marketplace is for scraping only.
  // Return a structured response indicating manual action is required.
  logger.warn('[Publisher] Facebook Marketplace: automated publishing not supported. Manual action required.');
  return {
    success: false,
    error: 'Facebook Marketplace אינו מאפשר פרסום אוטומטי. יש לפרסם ידנית.',
    platform: 'facebook',
    manual_required: true,
    listing_title: buildTitle(listing),
    listing_description: buildDescription(listing),
    listing_price: listing.asking_price
  };
}

// ─────────────────────────────────────────────
// YAD2 (Puppeteer + Residential Proxy + Cloudflare Turnstile)
// ─────────────────────────────────────────────
async function publishToYad2(listing) {
  const email = process.env.YAD2_EMAIL;
  const password = process.env.YAD2_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      error: 'YAD2_EMAIL / YAD2_PASSWORD not set in Railway env vars',
      platform: 'yad2',
      setup_required: true
    };
  }

  let browser;
  try {
    browser = await launchStealthBrowser({ useProxy: true });
    const page = await browser.newPage();
    await authenticateProxy(page);
    await page.setViewport({ width: 1280, height: 800 });

    // Set realistic Hebrew browser headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    });

    // Step 1: Login
    logger.info('[Publisher] yad2: navigating to login...');
    await page.goto('https://www.yad2.co.il/account/login', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Check for Cloudflare challenge
    const cfChallenge = await page.evaluate(() => {
      return document.title.includes('Just a moment') ||
             document.querySelector('#challenge-form') !== null ||
             document.querySelector('.cf-browser-verification') !== null;
    });

    if (cfChallenge) {
      logger.info('[Publisher] yad2: Cloudflare challenge detected, waiting...');
      // Wait for Cloudflare to pass (it usually does with residential proxy)
      await page.waitForTimeout(5000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    // Solve any captcha on login page
    await detectAndSolveCaptcha(page);

    // Fill login form
    try {
      await page.waitForSelector('input[name="email"], input[type="email"], #email', { timeout: 15000 });
    } catch (e) {
      // Try to get current page status
      const title = await page.title();
      const content = await page.evaluate(() => document.body?.innerText?.substring(0, 200));
      logger.warn(`[Publisher] yad2: login page not loaded. Title: ${title}. Content: ${content}`);
      throw new Error(`yad2 login page not accessible: ${title}`);
    }

    await page.evaluate(() => {
      const emailEl = document.querySelector('input[name="email"], input[type="email"], #email');
      if (emailEl) emailEl.value = '';
    });
    await page.type('input[name="email"], input[type="email"], #email', email, { delay: 80 });
    await page.waitForTimeout(500);
    await page.type('input[name="password"], input[type="password"], #password', password, { delay: 80 });
    await page.waitForTimeout(500);

    // Solve captcha before submit if present
    await detectAndSolveCaptcha(page);

    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

    // Step 2: Navigate to new listing form
    logger.info('[Publisher] yad2: navigating to new listing form...');
    await page.goto('https://www.yad2.co.il/realestate/forsale/new', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Check for Cloudflare again
    const cfChallenge2 = await page.evaluate(() => {
      return document.title.includes('Just a moment') ||
             document.querySelector('#challenge-form') !== null;
    });
    if (cfChallenge2) {
      logger.info('[Publisher] yad2: Cloudflare on listing page, waiting...');
      await page.waitForTimeout(6000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    await detectAndSolveCaptcha(page);

    // Step 3: Fill listing form
    // Address
    if (listing.address) {
      const addrSel = 'input[placeholder*="כתובת"], input[name*="address"], input[id*="address"]';
      const addrInput = await page.$(addrSel);
      if (addrInput) {
        await addrInput.click({ clickCount: 3 });
        await addrInput.type(listing.address, { delay: 60 });
        await page.waitForTimeout(1500);
        // Click first autocomplete suggestion
        const suggestion = await page.$('.autocomplete-suggestion, [class*="suggestion"], [class*="Suggestion"]');
        if (suggestion) await suggestion.click();
        await page.waitForTimeout(500);
      }
    }

    // Rooms
    if (listing.rooms) {
      const roomsSel = 'input[name="rooms"], select[name="rooms"], [data-field="rooms"] input';
      const roomsEl = await page.$(roomsSel);
      if (roomsEl) {
        const tag = await roomsEl.evaluate(el => el.tagName.toLowerCase());
        if (tag === 'select') {
          await page.select(roomsSel, String(listing.rooms));
        } else {
          await roomsEl.click({ clickCount: 3 });
          await roomsEl.type(String(listing.rooms), { delay: 60 });
        }
      }
    }

    // Floor
    if (listing.floor) {
      const floorEl = await page.$('input[name="floor"], [data-field="floor"] input');
      if (floorEl) {
        await floorEl.click({ clickCount: 3 });
        await floorEl.type(String(listing.floor), { delay: 60 });
      }
    }

    // Area
    if (listing.area_sqm) {
      const areaEl = await page.$('input[name="squareMeter"], input[name="area"], [data-field="squareMeter"] input');
      if (areaEl) {
        await areaEl.click({ clickCount: 3 });
        await areaEl.type(String(listing.area_sqm), { delay: 60 });
      }
    }

    // Price
    if (listing.asking_price) {
      const priceEl = await page.$('input[name="price"], [data-field="price"] input');
      if (priceEl) {
        await priceEl.click({ clickCount: 3 });
        await priceEl.type(String(listing.asking_price), { delay: 60 });
      }
    }

    // Description
    const desc = buildDescription(listing);
    const descEl = await page.$('textarea[name="description"], textarea[id*="description"], textarea');
    if (descEl) {
      await descEl.click({ clickCount: 3 });
      await descEl.type(desc, { delay: 30 });
    }

    // Phone (Quantum's number)
    const phone = process.env.QUANTUM_PHONE || listing.contact_phone;
    if (phone) {
      const phoneEl = await page.$('input[name="phone"], input[type="tel"], [data-field="phone"] input');
      if (phoneEl) {
        await phoneEl.click({ clickCount: 3 });
        await phoneEl.type(phone, { delay: 60 });
      }
    }

    // Solve captcha before submit
    await detectAndSolveCaptcha(page);

    // Submit
    const submitBtn = await page.$('button[type="submit"]:not([disabled])');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    }

    const url = page.url();
    const match = url.match(/\/(\d+)(?:\?|$)/);
    const externalId = match ? match[1] : null;

    await browser.close();
    logger.info(`[Publisher] yad2: published successfully. URL: ${url}`);
    return { success: true, external_id: externalId, url, platform: 'yad2' };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    logger.error('[Publisher] yad2 error:', err.message);
    return { success: false, error: err.message, platform: 'yad2' };
  }
}

// ─────────────────────────────────────────────
// HOMELESS (Puppeteer + Residential Proxy + reCAPTCHA)
// ─────────────────────────────────────────────
async function publishToHomeless(listing) {
  const email = process.env.HOMELESS_EMAIL;
  const password = process.env.HOMELESS_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      error: 'HOMELESS_EMAIL / HOMELESS_PASSWORD not set in Railway env vars',
      platform: 'homeless',
      setup_required: true
    };
  }

  let browser;
  try {
    browser = await launchStealthBrowser({ useProxy: true });
    const page = await browser.newPage();
    await authenticateProxy(page);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });

    // Login
    logger.info('[Publisher] homeless: navigating to login...');
    await page.goto('https://www.homeless.co.il/privatezone/', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    await detectAndSolveCaptcha(page);

    const emailInput = await page.$('input[type="email"], input[name="email"], #email');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 80 });
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click({ clickCount: 3 });
        await passInput.type(password, { delay: 80 });
      }
      await detectAndSolveCaptcha(page);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    // Navigate to post ad
    await page.goto('https://www.homeless.co.il/postad/', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Select real estate / for sale category
    const catLink = await page.$('a[href*="sale"], a[href*="forsale"], a[href*="realestate"]');
    if (catLink) {
      await catLink.click();
      await page.waitForTimeout(1500);
    }

    // Fill title
    const title = buildTitle(listing);
    const titleInput = await page.$('input[name="title"], input[id*="title"], input[placeholder*="כותרת"]');
    if (titleInput) {
      await titleInput.click({ clickCount: 3 });
      await titleInput.type(title, { delay: 60 });
    }

    // Fill price
    if (listing.asking_price) {
      const priceInput = await page.$('input[name="price"], input[id*="price"]');
      if (priceInput) {
        await priceInput.click({ clickCount: 3 });
        await priceInput.type(String(listing.asking_price), { delay: 60 });
      }
    }

    // Fill description
    const descInput = await page.$('textarea');
    if (descInput) {
      await descInput.click({ clickCount: 3 });
      await descInput.type(buildDescription(listing), { delay: 30 });
    }

    // Phone
    const phone = process.env.QUANTUM_PHONE || listing.contact_phone;
    if (phone) {
      const phoneInput = await page.$('input[name="phone"], input[type="tel"]');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phone, { delay: 60 });
      }
    }

    // Solve captcha before submit
    await detectAndSolveCaptcha(page);

    const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    }

    const url = page.url();
    await browser.close();
    logger.info(`[Publisher] homeless: published. URL: ${url}`);
    return { success: true, url, platform: 'homeless' };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    logger.error('[Publisher] homeless error:', err.message);
    return { success: false, error: err.message, platform: 'homeless' };
  }
}

// ─────────────────────────────────────────────
// MADLAN (Puppeteer + Residential Proxy)
// ─────────────────────────────────────────────
async function publishToMadlan(listing) {
  const email = process.env.MADLAN_EMAIL;
  const password = process.env.MADLAN_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      error: 'MADLAN_EMAIL / MADLAN_PASSWORD not set in Railway env vars',
      platform: 'madlan',
      setup_required: true
    };
  }

  let browser;
  try {
    browser = await launchStealthBrowser({ useProxy: true });
    const page = await browser.newPage();
    await authenticateProxy(page);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });

    logger.info('[Publisher] madlan: navigating to login...');
    await page.goto('https://www.madlan.co.il/user/login', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    await detectAndSolveCaptcha(page);

    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 80 });
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click({ clickCount: 3 });
        await passInput.type(password, { delay: 80 });
      }
      await detectAndSolveCaptcha(page);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    await page.goto('https://www.madlan.co.il/publish-listing', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Fill address
    if (listing.address) {
      const addrInput = await page.$('input[placeholder*="כתובת"], input[name*="address"]');
      if (addrInput) {
        await addrInput.click({ clickCount: 3 });
        await addrInput.type(listing.address, { delay: 60 });
        await page.waitForTimeout(1500);
        const suggestion = await page.$('[class*="suggestion"], [class*="Suggestion"]');
        if (suggestion) await suggestion.click();
      }
    }

    // Fill price
    if (listing.asking_price) {
      const priceInput = await page.$('input[name="price"]');
      if (priceInput) {
        await priceInput.click({ clickCount: 3 });
        await priceInput.type(String(listing.asking_price), { delay: 60 });
      }
    }

    // Fill description
    const descInput = await page.$('textarea');
    if (descInput) {
      await descInput.click({ clickCount: 3 });
      await descInput.type(buildDescription(listing), { delay: 30 });
    }

    // Phone
    const phone = process.env.QUANTUM_PHONE || listing.contact_phone;
    if (phone) {
      const phoneInput = await page.$('input[name="phone"], input[type="tel"]');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phone, { delay: 60 });
      }
    }

    await detectAndSolveCaptcha(page);

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    }

    const url = page.url();
    await browser.close();
    logger.info(`[Publisher] madlan: published. URL: ${url}`);
    return { success: true, url, platform: 'madlan' };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    logger.error('[Publisher] madlan error:', err.message);
    return { success: false, error: err.message, platform: 'madlan' };
  }
}

// ─────────────────────────────────────────────
// WINWIN (Puppeteer + Residential Proxy)
// ─────────────────────────────────────────────
async function publishToWinwin(listing) {
  const email = process.env.WINWIN_EMAIL;
  const password = process.env.WINWIN_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      error: 'WINWIN_EMAIL / WINWIN_PASSWORD not set in Railway env vars',
      platform: 'winwin',
      setup_required: true
    };
  }

  let browser;
  try {
    browser = await launchStealthBrowser({ useProxy: true });
    const page = await browser.newPage();
    await authenticateProxy(page);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });

    logger.info('[Publisher] winwin: navigating to login...');
    await page.goto('https://www.winwin.co.il/login', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    await detectAndSolveCaptcha(page);

    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 80 });
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click({ clickCount: 3 });
        await passInput.type(password, { delay: 80 });
      }
      await detectAndSolveCaptcha(page);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    await page.goto('https://www.winwin.co.il/publish', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Fill address
    if (listing.address) {
      const addrInput = await page.$('input[placeholder*="כתובת"], input[name*="address"]');
      if (addrInput) {
        await addrInput.click({ clickCount: 3 });
        await addrInput.type(listing.address, { delay: 60 });
        await page.waitForTimeout(1500);
        const suggestion = await page.$('[class*="suggestion"], [class*="Suggestion"]');
        if (suggestion) await suggestion.click();
      }
    }

    // Fill price
    if (listing.asking_price) {
      const priceInput = await page.$('input[name="price"]');
      if (priceInput) {
        await priceInput.click({ clickCount: 3 });
        await priceInput.type(String(listing.asking_price), { delay: 60 });
      }
    }

    // Fill description
    const descInput = await page.$('textarea');
    if (descInput) {
      await descInput.click({ clickCount: 3 });
      await descInput.type(buildDescription(listing), { delay: 30 });
    }

    // Phone
    const phone = process.env.QUANTUM_PHONE || listing.contact_phone;
    if (phone) {
      const phoneInput = await page.$('input[name="phone"], input[type="tel"]');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phone, { delay: 60 });
      }
    }

    await detectAndSolveCaptcha(page);

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    }

    const url = page.url();
    await browser.close();
    logger.info(`[Publisher] winwin: published. URL: ${url}`);
    return { success: true, url, platform: 'winwin' };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    logger.error('[Publisher] winwin error:', err.message);
    return { success: false, error: err.message, platform: 'winwin' };
  }
}

// ─────────────────────────────────────────────
// PLATFORM STATUS
// ─────────────────────────────────────────────
function getPlatformStatus() {
  const hasProxy = !!(process.env.TWOCAPTCHA_PROXY_USER || process.env.TWOCAPTCHA_API_KEY);
  return {
    yad2:     { configured: !!(process.env.YAD2_EMAIL && process.env.YAD2_PASSWORD),         method: 'puppeteer+proxy', captcha: !!process.env.TWOCAPTCHA_API_KEY, proxy: hasProxy },
    homeless: { configured: !!(process.env.HOMELESS_EMAIL && process.env.HOMELESS_PASSWORD), method: 'puppeteer+proxy', captcha: !!process.env.TWOCAPTCHA_API_KEY, proxy: hasProxy },
    madlan:   { configured: !!(process.env.MADLAN_EMAIL && process.env.MADLAN_PASSWORD),     method: 'puppeteer+proxy', captcha: !!process.env.TWOCAPTCHA_API_KEY, proxy: hasProxy },
    winwin:   { configured: !!(process.env.WINWIN_EMAIL && process.env.WINWIN_PASSWORD),     method: 'puppeteer+proxy', captcha: !!process.env.TWOCAPTCHA_API_KEY, proxy: hasProxy },
    facebook: { configured: !!process.env.APIFY_API_TOKEN,                                   method: 'manual',          captcha: false,                             proxy: false }
  };
}

module.exports = { publishListing, getPlatformStatus };
