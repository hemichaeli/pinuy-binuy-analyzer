/**
 * KonesIsrael Live Scraper
 * 
 * Scrapes receivership property listings from konesisrael.co.il
 * using SiteGround CAPTCHA bypass + WordPress login.
 * 
 * Flow:
 * 1. Bypass SG CAPTCHA (Proof-of-Work)
 * 2. Login with paid subscription credentials
 * 3. Scrape member-only real estate listings
 * 4. Parse into structured data
 * 5. Import into kones_listings database
 */

const sgCaptcha = require('./sgCaptchaSolver');
const pool = require('../db/pool');
const { logger } = require('./logger');

const BASE_URL = 'https://konesisrael.co.il';

const LISTING_PAGES = [
  '/%D7%A0%D7%93%D7%9C%D7%9F-%D7%9E%D7%9B%D7%95%D7%A0%D7%A1-%D7%A0%D7%9B%D7%A1%D7%99%D7%9D/',
  '/category/%D7%A0%D7%93%D7%9C%D7%9F/',
];

class KonesLiveScraper {
  constructor() {
    this.isLoggedIn = false;
    this.lastScrapeTime = null;
    this.scrapeInProgress = false;
  }

  async initialize() {
    const email = process.env.KONES_EMAIL;
    const password = process.env.KONES_PASSWORD;
    if (!email || !password) throw new Error('KONES_EMAIL and KONES_PASSWORD must be set');

    logger.info('KonesLiveScraper: Initializing...');
    const captchaBypassed = await sgCaptcha.bypassCaptcha(BASE_URL);
    if (!captchaBypassed) throw new Error('Failed to bypass SiteGround CAPTCHA');
    
    const loggedIn = await sgCaptcha.wpLogin(email, password, BASE_URL);
    if (!loggedIn) {
      logger.warn('KonesLiveScraper: WP login failed, trying with CAPTCHA cookie only');
    } else {
      this.isLoggedIn = true;
    }
    return true;
  }

  async scrapePage(pageUrl) {
    const fullUrl = pageUrl.startsWith('http') ? pageUrl : BASE_URL + pageUrl;
    const res = await sgCaptcha.fetchPage(fullUrl);
    if (!res || !res.body) return [];
    if (res.body.includes('התוכן למנויים בלבד')) {
      logger.warn(`KonesLiveScraper: Members-only at ${pageUrl}`);
      return [];
    }
    return this.parseListings(res.body, fullUrl);
  }

  parseListings(html, sourceUrl) {
    const listings = [];
    let match;
    
    const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    while ((match = articleRegex.exec(html)) !== null) {
      const listing = this.extractListingFromHtml(match[1], sourceUrl);
      if (listing) listings.push(listing);
    }
    
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((match = trRegex.exec(html)) !== null) {
      if (this.isPropertyRow(match[1])) {
        const listing = this.extractListingFromHtml(match[1], sourceUrl);
        if (listing) listings.push(listing);
      }
    }
    
    const divRegex = /<div[^>]*class="[^"]*(?:listing|property|nadlan|kones|item)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = divRegex.exec(html)) !== null) {
      const listing = this.extractListingFromHtml(match[1], sourceUrl);
      if (listing) listings.push(listing);
    }
    
    const seen = new Set();
    return listings.filter(l => {
      const key = `${l.city}|${l.address}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  isPropertyRow(rowHtml) {
    const text = rowHtml.replace(/<[^>]+>/g, '');
    return (text.includes('גוש') || text.includes('חלקה') || 
            text.includes('דירה') || text.includes('מגרש') ||
            text.includes('כתובת') || text.includes('כונס'));
  }

  extractListingFromHtml(html, sourceUrl) {
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (!text.includes('כונס') && !text.includes('מימוש') && 
        !text.includes('פירוק') && !text.includes('עיזבון') &&
        !text.includes('הוצאה לפועל') && !text.includes('משכנתא') &&
        !text.includes('גוש') && !text.includes('חלקה')) {
      return null;
    }
    
    const listing = { source: 'konesisrael_live', sourceUrl };
    
    const gushMatch = text.match(/גוש\s*:?\s*(\d+)/);
    const helkaMatch = text.match(/חלק[הה]\s*:?\s*(\d+)/);
    if (gushMatch) listing.gushHelka = `גוש ${gushMatch[1]}${helkaMatch ? ` חלקה ${helkaMatch[1]}` : ''}`;
    
    const cityPattern = /(?:ב|עיר|יישוב)\s*:?\s*(תל\s*אביב[\-\s]*יפו|חולון|בת\s*ים|רמת\s*גן|גבעתיים|פתח\s*תקו[וו]?ה|ראשון\s*לציון|חיפה|ירושלים|נתניה|הרצליה|כפר\s*סבא|רעננה|הוד\s*השרון|אשדוד|באר\s*שבע|רחובות|לוד|רמלה)/i;
    const cityMatch = text.match(cityPattern);
    if (cityMatch) listing.city = cityMatch[1].trim();
    
    const streetMatch = text.match(/(?:רחוב|כתובת|ברח'?)\s*:?\s*([^\d,]{3,40})/);
    if (streetMatch) listing.address = streetMatch[1].trim();
    
    if (text.includes('דירה')) listing.propertyType = 'דירה';
    else if (text.includes('מגרש')) listing.propertyType = 'מגרש';
    else if (text.includes('בית')) listing.propertyType = 'בית';
    else if (text.includes('קרקע')) listing.propertyType = 'קרקע';
    
    const lawyerMatch = text.match(/עו["״]?ד\s*:?\s*([^,\n]{3,30})/);
    if (lawyerMatch) listing.contactPerson = lawyerMatch[1].trim();
    
    const phoneMatch = text.match(/(?:טלפון|טל|נייד)\s*:?\s*([\d\-\s]{8,15})/);
    if (phoneMatch) listing.phone = phoneMatch[1].trim().replace(/\s/g, '');
    
    const dateMatch = text.match(/(?:עד|מועד|תאריך)\s*:?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/);
    if (dateMatch) listing.submissionDeadline = dateMatch[1];
    
    const priceMatch = text.match(/(?:מחיר|סכום|שווי)\s*:?\s*([\d,]+(?:\.\d+)?)\s*(?:₪|ש"ח|שח)/);
    if (priceMatch) listing.price = priceMatch[1].replace(/,/g, '');
    
    if (text.includes('כינוס נכסים')) listing.receivershipType = 'כינוס נכסים';
    else if (text.includes('פירוק שיתוף')) listing.receivershipType = 'פירוק שיתוף';
    else if (text.includes('מימוש משכנתא')) listing.receivershipType = 'מימוש משכנתא';
    else if (text.includes('הוצאה לפועל')) listing.receivershipType = 'הוצאה לפועל';
    else if (text.includes('עיזבון')) listing.receivershipType = 'עיזבון';
    
    const linkMatch = html.match(/href="([^"]*konesisrael[^"]*)"/);
    if (linkMatch) listing.sourceUrl = linkMatch[1];
    
    if (listing.city || listing.gushHelka || listing.address) return listing;
    return null;
  }

  async scrapeAll() {
    if (this.scrapeInProgress) return { error: 'Scrape already in progress' };
    this.scrapeInProgress = true;
    const startTime = Date.now();
    
    try {
      await this.initialize();
      let allListings = [];
      const pageResults = [];
      
      for (const page of LISTING_PAGES) {
        try {
          logger.info(`KonesLiveScraper: Scraping ${page}...`);
          const listings = await this.scrapePage(page);
          allListings = allListings.concat(listings);
          pageResults.push({ page, listings: listings.length, status: 'ok' });
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          pageResults.push({ page, status: 'error', error: err.message });
        }
      }
      
      for (const page of LISTING_PAGES.slice(0, 1)) {
        for (let pageNum = 2; pageNum <= 5; pageNum++) {
          try {
            const pagedUrl = `${page}page/${pageNum}/`;
            const listings = await this.scrapePage(pagedUrl);
            if (listings.length === 0) break;
            allListings = allListings.concat(listings);
            pageResults.push({ page: pagedUrl, listings: listings.length, status: 'ok' });
            await new Promise(r => setTimeout(r, 2000));
          } catch (err) { break; }
        }
      }
      
      const seen = new Set();
      allListings = allListings.filter(l => {
        const key = `${l.city || ''}|${l.address || ''}|${l.gushHelka || ''}`.toLowerCase();
        if (seen.has(key) || key === '||') return false;
        seen.add(key);
        return true;
      });
      
      let importResult = { imported: 0, skipped: 0 };
      if (allListings.length > 0) importResult = await this.importToDb(allListings);
      
      this.lastScrapeTime = Date.now();
      return {
        success: true,
        elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
        pagesScraped: pageResults.length,
        listingsFound: allListings.length,
        imported: importResult.imported,
        skipped: importResult.skipped,
        isLoggedIn: this.isLoggedIn,
        captchaStatus: sgCaptcha.getStatus(),
        pageResults,
        listings: allListings.slice(0, 20)
      };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      this.scrapeInProgress = false;
    }
  }

  async importToDb(listings) {
    let imported = 0, skipped = 0;
    for (const listing of listings) {
      try {
        const existing = await pool.query(
          `SELECT id FROM kones_listings WHERE 
           (address = $1 AND city = $2) OR 
           (gush_helka = $3 AND gush_helka IS NOT NULL AND gush_helka != '')
           LIMIT 1`,
          [listing.address || '', listing.city || '', listing.gushHelka || '']
        );
        if (existing.rows.length > 0) { skipped++; continue; }
        
        await pool.query(`
          INSERT INTO kones_listings 
            (property_type, city, address, region, gush_helka, 
             contact_person, email, phone, submission_deadline,
             source, source_url, is_active, price, receivership_type, scan_source,
             created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14,NOW(),NOW())
        `, [
          listing.propertyType || null, listing.city || null,
          listing.address || null, listing.region || null,
          listing.gushHelka || null, listing.contactPerson || null,
          listing.email || null, listing.phone || null,
          listing.submissionDeadline || null, 'konesisrael.co.il',
          listing.sourceUrl || null, listing.price || null,
          listing.receivershipType || null, 'konesisrael_live_scrape'
        ]);
        imported++;
      } catch (err) {
        logger.warn(`KonesLiveScraper: DB error: ${err.message}`);
        skipped++;
      }
    }
    return { imported, skipped };
  }

  getStatus() {
    return {
      isLoggedIn: this.isLoggedIn,
      scrapeInProgress: this.scrapeInProgress,
      lastScrapeTime: this.lastScrapeTime ? new Date(this.lastScrapeTime).toISOString() : null,
      captcha: sgCaptcha.getStatus(),
      credentials: {
        email: process.env.KONES_EMAIL ? 'set' : 'missing',
        password: process.env.KONES_PASSWORD ? 'set' : 'missing'
      }
    };
  }
}

module.exports = new KonesLiveScraper();
