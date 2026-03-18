/**
 * Listing Publisher Service
 * Publishes outgoing listings to multiple real-estate platforms.
 * 
 * Supported platforms:
 *   - yad2       (Puppeteer browser automation)
 *   - homeless   (Puppeteer browser automation)
 *   - madlan     (Puppeteer browser automation)
 *   - winwin     (Puppeteer browser automation)
 *   - facebook   (Apify actor: curious_coder~facebook-marketplace)
 * 
 * Credentials are read from env vars:
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
        // Mark as published in DB
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

  // Update status
  const anySuccess = Object.values(results).some(r => r.success);
  if (!anySuccess) {
    await pool.query(`UPDATE outgoing_listings SET status = 'failed', updated_at = NOW() WHERE id = $1`, [listingId]);
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

function buildDescription(listing) {
  const parts = [];
  if (listing.rooms) parts.push(`${listing.rooms} חדרים`);
  if (listing.floor) parts.push(`קומה ${listing.floor}`);
  if (listing.area_sqm) parts.push(`${listing.area_sqm} מ"ר`);
  if (listing.asking_price) parts.push(`מחיר: ₪${formatPrice(listing.asking_price)}`);
  if (listing.description) parts.push(listing.description);
  return parts.join(' | ');
}

// ─────────────────────────────────────────────
// FACEBOOK MARKETPLACE (via Apify)
// ─────────────────────────────────────────────
async function publishToFacebook(listing) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) {
    return { success: false, error: 'APIFY_API_TOKEN not set' };
  }

  // Note: Facebook Marketplace publishing via Apify requires a logged-in Facebook session
  // The actor `curious_coder~facebook-marketplace` is primarily for scraping.
  // For publishing, we use the `apify~facebook-post-creator` actor or similar.
  // Until a publishing actor is confirmed, we return a structured placeholder.
  
  try {
    // Check if there's a publishing actor available
    const actorId = process.env.APIFY_FB_PUBLISH_ACTOR || 'apify~facebook-marketplace-poster';
    const title = `${listing.rooms ? listing.rooms + ' חדרים' : 'דירה'} ב${listing.city || listing.address}`;
    const description = buildDescription(listing);
    const price = listing.asking_price || 0;

    const runResp = await axios.post(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      {
        title,
        description,
        price,
        location: listing.city || listing.address,
        category: 'real_estate',
        images: listing.images || []
      },
      { timeout: 30000 }
    );

    if (runResp.data?.data?.id) {
      return { success: true, external_id: runResp.data.data.id, platform: 'facebook' };
    }
    return { success: false, error: 'Actor run failed', platform: 'facebook' };
  } catch (err) {
    // Actor not found or not available — log and return structured response
    logger.warn(`[Publisher] Facebook Marketplace publishing actor not available: ${err.message}`);
    return { 
      success: false, 
      error: 'Facebook publishing requires manual setup. Please publish manually and mark as published.',
      platform: 'facebook',
      manual_required: true
    };
  }
}

// ─────────────────────────────────────────────
// YAD2 (Puppeteer)
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

  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
      // Login
      await page.goto('https://www.yad2.co.il/account/login', { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('input[name="email"]', { timeout: 10000 });
      await page.type('input[name="email"]', email);
      await page.type('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

      // Navigate to new listing
      await page.goto('https://www.yad2.co.il/realestate/forsale/new', { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Fill in listing details
      // Address
      if (listing.address) {
        await page.waitForSelector('input[placeholder*="כתובת"]', { timeout: 10000 });
        await page.type('input[placeholder*="כתובת"]', listing.address);
        await page.waitForTimeout(1500);
        // Select first autocomplete suggestion
        const suggestion = await page.$('.autocomplete-suggestion, [class*="suggestion"]');
        if (suggestion) await suggestion.click();
      }

      // Rooms
      if (listing.rooms) {
        const roomsInput = await page.$('input[name="rooms"], select[name="rooms"]');
        if (roomsInput) {
          const tag = await roomsInput.evaluate(el => el.tagName.toLowerCase());
          if (tag === 'select') {
            await page.select('select[name="rooms"]', String(listing.rooms));
          } else {
            await roomsInput.click({ clickCount: 3 });
            await roomsInput.type(String(listing.rooms));
          }
        }
      }

      // Floor
      if (listing.floor) {
        const floorInput = await page.$('input[name="floor"]');
        if (floorInput) {
          await floorInput.click({ clickCount: 3 });
          await floorInput.type(String(listing.floor));
        }
      }

      // Area
      if (listing.area_sqm) {
        const areaInput = await page.$('input[name="squareMeter"], input[name="area"]');
        if (areaInput) {
          await areaInput.click({ clickCount: 3 });
          await areaInput.type(String(listing.area_sqm));
        }
      }

      // Price
      if (listing.asking_price) {
        const priceInput = await page.$('input[name="price"]');
        if (priceInput) {
          await priceInput.click({ clickCount: 3 });
          await priceInput.type(String(listing.asking_price));
        }
      }

      // Description
      if (listing.description) {
        const descInput = await page.$('textarea[name="description"], textarea[placeholder*="תיאור"]');
        if (descInput) {
          await descInput.type(listing.description);
        }
      }

      // Submit
      const submitBtn = await page.$('button[type="submit"]:not([disabled])');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      }

      // Try to get listing ID from URL
      const url = page.url();
      const match = url.match(/\/(\d+)(?:\?|$)/);
      const externalId = match ? match[1] : null;

      await browser.close();
      return { success: true, external_id: externalId, url, platform: 'yad2' };

    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return { 
        success: false, 
        error: 'puppeteer not installed. Run: npm install puppeteer',
        platform: 'yad2',
        setup_required: true
      };
    }
    return { success: false, error: err.message, platform: 'yad2' };
  }
}

// ─────────────────────────────────────────────
// HOMELESS (Puppeteer)
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

  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    try {
      await page.goto('https://www.homeless.co.il/login', { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Login
      const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="מייל"]');
      if (emailInput) {
        await emailInput.type(email);
        const passInput = await page.$('input[type="password"]');
        if (passInput) await passInput.type(password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      }

      // Navigate to new listing
      await page.goto('https://www.homeless.co.il/publish', { waitUntil: 'networkidle2', timeout: 30000 });

      // Fill basic fields
      const title = `${listing.rooms ? listing.rooms + ' חדרים' : 'דירה'} ב${listing.address || listing.city}`;
      const titleInput = await page.$('input[name="title"], input[placeholder*="כותרת"]');
      if (titleInput) await titleInput.type(title);

      if (listing.asking_price) {
        const priceInput = await page.$('input[name="price"]');
        if (priceInput) {
          await priceInput.click({ clickCount: 3 });
          await priceInput.type(String(listing.asking_price));
        }
      }

      if (listing.description) {
        const descInput = await page.$('textarea');
        if (descInput) await descInput.type(listing.description);
      }

      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      }

      const url = page.url();
      await browser.close();
      return { success: true, url, platform: 'homeless' };

    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return { success: false, error: 'puppeteer not installed', platform: 'homeless', setup_required: true };
    }
    return { success: false, error: err.message, platform: 'homeless' };
  }
}

// ─────────────────────────────────────────────
// MADLAN (Puppeteer)
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

  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    try {
      await page.goto('https://www.madlan.co.il/user/login', { waitUntil: 'networkidle2', timeout: 30000 });
      
      const emailInput = await page.$('input[type="email"], input[name="email"]');
      if (emailInput) {
        await emailInput.type(email);
        const passInput = await page.$('input[type="password"]');
        if (passInput) await passInput.type(password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      }

      await page.goto('https://www.madlan.co.il/publish-listing', { waitUntil: 'networkidle2', timeout: 30000 });

      if (listing.asking_price) {
        const priceInput = await page.$('input[name="price"]');
        if (priceInput) {
          await priceInput.click({ clickCount: 3 });
          await priceInput.type(String(listing.asking_price));
        }
      }

      if (listing.description) {
        const descInput = await page.$('textarea');
        if (descInput) await descInput.type(listing.description);
      }

      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      }

      const url = page.url();
      await browser.close();
      return { success: true, url, platform: 'madlan' };

    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return { success: false, error: 'puppeteer not installed', platform: 'madlan', setup_required: true };
    }
    return { success: false, error: err.message, platform: 'madlan' };
  }
}

// ─────────────────────────────────────────────
// WINWIN (Puppeteer)
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

  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    try {
      await page.goto('https://www.winwin.co.il/login', { waitUntil: 'networkidle2', timeout: 30000 });
      
      const emailInput = await page.$('input[type="email"], input[name="email"]');
      if (emailInput) {
        await emailInput.type(email);
        const passInput = await page.$('input[type="password"]');
        if (passInput) await passInput.type(password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      }

      await page.goto('https://www.winwin.co.il/publish', { waitUntil: 'networkidle2', timeout: 30000 });

      if (listing.asking_price) {
        const priceInput = await page.$('input[name="price"]');
        if (priceInput) {
          await priceInput.click({ clickCount: 3 });
          await priceInput.type(String(listing.asking_price));
        }
      }

      if (listing.description) {
        const descInput = await page.$('textarea');
        if (descInput) await descInput.type(listing.description);
      }

      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      }

      const url = page.url();
      await browser.close();
      return { success: true, url, platform: 'winwin' };

    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return { success: false, error: 'puppeteer not installed', platform: 'winwin', setup_required: true };
    }
    return { success: false, error: err.message, platform: 'winwin' };
  }
}

// ─────────────────────────────────────────────
// CHECK PLATFORM STATUS (which platforms are configured)
// ─────────────────────────────────────────────
function getPlatformStatus() {
  return {
    yad2:     { configured: !!(process.env.YAD2_EMAIL && process.env.YAD2_PASSWORD),     method: 'puppeteer' },
    homeless: { configured: !!(process.env.HOMELESS_EMAIL && process.env.HOMELESS_PASSWORD), method: 'puppeteer' },
    madlan:   { configured: !!(process.env.MADLAN_EMAIL && process.env.MADLAN_PASSWORD),   method: 'puppeteer' },
    winwin:   { configured: !!(process.env.WINWIN_EMAIL && process.env.WINWIN_PASSWORD),   method: 'puppeteer' },
    facebook: { configured: !!process.env.APIFY_API_TOKEN,                                 method: 'apify' }
  };
}

module.exports = { publishListing, getPlatformStatus };
