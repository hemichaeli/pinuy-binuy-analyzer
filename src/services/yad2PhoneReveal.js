/**
 * yad2PhoneReveal.js
 * 
 * Reveals phone numbers for yad2 listings by:
 * 1. Using the yad2Messenger's existing login session
 * 2. Calling the yad2 phone reveal API with session cookies
 * 3. Visiting listing pages and extracting phone numbers
 * 
 * Also enriches phones for other sources (yad1, dira, komo) 
 * by visiting their listing pages.
 */
const pool = require('../db/pool');
const { logger } = require('./logger');
const axios = require('axios');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  if (digits.startsWith('0')) return digits;
  return null;
}

/**
 * Try to get phone via yad2 API using session cookies from yad2Messenger
 */
async function tryYad2ApiPhone(itemId, cookies) {
  if (!itemId || itemId === 'NULL' || itemId.startsWith('yad2-')) return null;
  
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  const endpoints = [
    `https://gw.yad2.co.il/feed-search/item/${itemId}/phone`,
    `https://gw.yad2.co.il/feed-search-legacy/item/${itemId}/phone`,
    `https://gw.yad2.co.il/realestate/item/${itemId}/phone`,
    `https://gw.yad2.co.il/item/${itemId}/phone`
  ];
  
  for (const endpoint of endpoints) {
    try {
      const r = await axios.get(endpoint, {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.yad2.co.il/',
          'Origin': 'https://www.yad2.co.il',
          'Accept': 'application/json',
          'mobile_app': 'false',
          'mainsite': 'true'
        },
        timeout: 8000
      });
      
      if (r.data) {
        const d = r.data.data || r.data;
        const phone = cleanPhone(
          d.phone || d.phone_number || d.contactPhone || 
          d.contact_phone || d.phones?.[0] || d.phoneNumber
        );
        if (phone) {
          logger.info(`[yad2PhoneReveal] API phone found for ${itemId}: ${phone}`);
          return phone;
        }
      }
    } catch (e) {
      // Try next endpoint
    }
  }
  return null;
}

/**
 * Visit a listing URL using Puppeteer page and extract phone
 */
async function extractPhoneFromPage(page, url) {
  try {
    let capturedPhone = null;
    
    // Intercept API responses for phone data
    const responseHandler = async (response) => {
      const rUrl = response.url();
      if (rUrl.includes('/phone') || rUrl.includes('phone_number') || rUrl.includes('contact')) {
        try {
          const data = await response.json();
          const phone = cleanPhone(
            data?.data?.phone || data?.phone || 
            data?.data?.phone_number || data?.phone_number ||
            data?.data?.phones?.[0]
          );
          if (phone) capturedPhone = phone;
        } catch (e) {}
      }
    };
    
    page.on('response', responseHandler);
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);
    
    // Click reveal phone button
    const revealSelectors = [
      '[data-test="phone-reveal"]',
      '[data-test="reveal-phone"]',
      'button[class*="phone-reveal"]',
      '[class*="reveal-phone"]',
      'button[aria-label*="טלפון"]',
      '[data-test="contact-phone"]',
      'button[class*="phone"]',
      '[class*="phoneReveal"]'
    ];
    
    for (const sel of revealSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await sleep(2500);
          break;
        }
      } catch (e) {}
    }
    
    // Check captured phone from API
    if (capturedPhone) {
      page.off('response', responseHandler);
      return capturedPhone;
    }
    
    // Extract from tel: links
    const telLinks = await page.$$('a[href^="tel:"]');
    for (const link of telLinks) {
      try {
        const href = await link.evaluate(el => el.href);
        const phone = cleanPhone(href.replace('tel:', ''));
        if (phone) {
          page.off('response', responseHandler);
          return phone;
        }
      } catch (e) {}
    }
    
    // Extract from data attributes
    const phoneEls = await page.$$('[data-phone], [data-tel], [data-test="phone-number"]');
    for (const el of phoneEls) {
      try {
        const text = await el.evaluate(node => 
          node.dataset?.phone || node.dataset?.tel || node.textContent || ''
        );
        const phone = cleanPhone(text);
        if (phone) {
          page.off('response', responseHandler);
          return phone;
        }
      } catch (e) {}
    }
    
    // Regex search in page content
    const pageText = await page.evaluate(() => document.body.innerText || '');
    const phoneRegex = /(?:0[2-9]\d{7,8}|05\d{8}|\+972[2-9]\d{7,8})/g;
    const matches = pageText.match(phoneRegex);
    if (matches && matches.length > 0) {
      const phone = cleanPhone(matches[0]);
      if (phone) {
        page.off('response', responseHandler);
        return phone;
      }
    }
    
    page.off('response', responseHandler);
    return null;
    
  } catch (err) {
    logger.warn(`[yad2PhoneReveal] Page visit failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Search yad2 for a listing by address and reveal phone
 */
async function searchYad2ForPhone(page, listing) {
  try {
    const address = listing.address || '';
    const city = listing.city || '';
    const price = listing.asking_price;
    
    if (!address || !city) return null;
    
    // Build search URL
    const searchQuery = encodeURIComponent(`${address} ${city}`);
    const searchUrl = `https://www.yad2.co.il/realestate/forsale?text=${searchQuery}`;
    
    let capturedPhone = null;
    const responseHandler = async (response) => {
      const rUrl = response.url();
      if (rUrl.includes('/phone') || rUrl.includes('phone_number')) {
        try {
          const data = await response.json();
          const phone = cleanPhone(data?.data?.phone || data?.phone);
          if (phone) capturedPhone = phone;
        } catch (e) {}
      }
    };
    
    page.on('response', responseHandler);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);
    
    // Find matching listing card
    const cards = await page.$$('[data-test="feed-item"], .feed-item, [class*="feedItem"]');
    
    let targetCard = null;
    for (const card of cards) {
      try {
        const cardText = await card.evaluate(el => el.innerText || '');
        const addressWords = address.split(/[\s,]+/).filter(w => w.length > 2);
        const matches = addressWords.filter(w => cardText.includes(w)).length;
        
        if (matches >= Math.min(2, addressWords.length)) {
          if (price) {
            const priceInK = Math.round(price / 1000).toString();
            if (cardText.includes(priceInK)) {
              targetCard = card;
              break;
            }
          }
          if (!targetCard) targetCard = card;
        }
      } catch (e) {}
    }
    
    if (targetCard) {
      // Click reveal phone in this card
      const revealBtn = await targetCard.$('[data-test="phone-reveal"], button[class*="phone"]');
      if (revealBtn) {
        await revealBtn.click();
        await sleep(2500);
      }
    }
    
    if (capturedPhone) {
      page.off('response', responseHandler);
      return capturedPhone;
    }
    
    // Try tel links
    const telLinks = await page.$$('a[href^="tel:"]');
    for (const link of telLinks) {
      try {
        const href = await link.evaluate(el => el.href);
        const phone = cleanPhone(href.replace('tel:', ''));
        if (phone) {
          page.off('response', responseHandler);
          return phone;
        }
      } catch (e) {}
    }
    
    page.off('response', responseHandler);
    return null;
    
  } catch (err) {
    logger.warn(`[yad2PhoneReveal] Search failed for ${listing.address}: ${err.message}`);
    return null;
  }
}

/**
 * Main batch phone reveal function
 * Uses yad2Messenger's existing Puppeteer session
 */
async function revealPhonesForAllYad2(options = {}) {
  const { limit = 200, scanId = null } = options;
  
  logger.info(`[yad2PhoneReveal] Starting batch phone reveal for up to ${limit} listings`);
  
  // Get listings without phones
  const { rows: listings } = await pool.query(`
    SELECT id, source, source_listing_id, url, address, city, asking_price
    FROM listings
    WHERE (phone IS NULL OR phone = '' OR phone = 'NULL')
      AND is_active = TRUE
      AND address IS NOT NULL
      AND address != ''
      AND city IS NOT NULL
      AND city != ''
    ORDER BY 
      CASE WHEN source = 'yad2' THEN 0
           WHEN source = 'yad1' THEN 1
           WHEN source = 'dira' THEN 2
           WHEN source = 'komo' THEN 3
           ELSE 4 END,
      created_at DESC
    LIMIT $1
  `, [limit]);
  
  logger.info(`[yad2PhoneReveal] Found ${listings.length} listings to process`);
  
  if (listings.length === 0) {
    return { enriched: 0, total: 0 };
  }
  
  let enriched = 0;
  let failed = 0;
  let page = null;
  let cookies = [];
  
  // Try to get the yad2Messenger's browser session
  try {
    const yad2Messenger = require('./yad2Messenger');
    const loginResult = await yad2Messenger.login();
    logger.info(`[yad2PhoneReveal] yad2Messenger login: ${JSON.stringify(loginResult)}`);
    
    // Get the page from yad2Messenger
    page = yad2Messenger._getPage ? yad2Messenger._getPage() : null;
    
    // Get cookies via the messenger's getStatus
    const status = await yad2Messenger.getStatus();
    logger.info(`[yad2PhoneReveal] Messenger status: ${JSON.stringify(status)}`);
    
  } catch (loginErr) {
    logger.warn(`[yad2PhoneReveal] yad2Messenger login failed: ${loginErr.message}`);
    // Continue without Puppeteer - will use API only
  }
  
  // If we have a page, get cookies for API calls
  if (page) {
    try {
      cookies = await page.cookies('https://www.yad2.co.il');
      logger.info(`[yad2PhoneReveal] Got ${cookies.length} cookies from session`);
    } catch (e) {
      logger.warn(`[yad2PhoneReveal] Could not get cookies: ${e.message}`);
    }
  }
  
  for (const listing of listings) {
    try {
      let phone = null;
      
      // Method 1: yad2 API with session cookies (for proper item IDs)
      if (!phone && cookies.length > 0 && listing.source_listing_id && 
          listing.source_listing_id !== 'NULL' && 
          !listing.source_listing_id.startsWith('yad2-') &&
          /^[a-zA-Z0-9_-]+$/.test(listing.source_listing_id)) {
        phone = await tryYad2ApiPhone(listing.source_listing_id, cookies);
      }
      
      // Method 2: Visit item URL directly (for yad2 item URLs)
      if (!phone && page && listing.url && 
          listing.url.includes('yad2.co.il/item/')) {
        phone = await extractPhoneFromPage(page, listing.url);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ URL: ${listing.address} → ${phone}`);
      }
      
      // Method 3: Visit yad1/dira/komo listing URLs
      if (!phone && page && listing.url && 
          listing.url !== 'NULL' && 
          !listing.url.includes('yad2.co.il/realestate/forsale') &&
          !listing.url.includes('banknadlan.co.il/city/') &&
          !listing.url.includes('komo.co.il/code/nadlan/apartments-for-sale.asp?n') &&
          (listing.url.includes('yad1.co.il') || listing.url.includes('dira.co.il') || 
           listing.url.includes('komo.co.il') || listing.url.includes('madlan.co.il'))) {
        phone = await extractPhoneFromPage(page, listing.url);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ External URL [${listing.source}]: ${listing.address} → ${phone}`);
      }
      
      // Method 4: Search yad2 by address (for yad2 listings with search page URLs)
      if (!phone && page && listing.source === 'yad2') {
        phone = await searchYad2ForPhone(page, listing);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ Search: ${listing.address} → ${phone}`);
      }
      
      if (phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
          [phone, listing.id]
        );
        enriched++;
        logger.info(`[yad2PhoneReveal] Saved phone for listing ${listing.id}: ${phone}`);
      }
      
      // Rate limiting
      await sleep(2000 + Math.random() * 1500);
      
    } catch (err) {
      failed++;
      logger.warn(`[yad2PhoneReveal] Failed for listing ${listing.id}: ${err.message}`);
      await sleep(1000);
    }
  }
  
  logger.info(`[yad2PhoneReveal] Complete: ${enriched}/${listings.length} phones revealed`);
  return { enriched, failed, total: listings.length };
}

module.exports = {
  revealPhonesForAllYad2,
  extractPhoneFromPage,
  searchYad2ForPhone,
  tryYad2ApiPhone
};
