/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * Uses Puppeteer headless browser to bypass bot protection
 * Provides access to properties being sold by receivers (כונס נכסים)
 * Key SSI indicator: Properties in receivership are distressed sales by definition
 */

const { logger } = require('./logger');
const { execSync } = require('child_process');
const fs = require('fs');

// Lazy-load browser dependencies
let puppeteer = null;

// Cache discovered chromium path
let cachedChromiumPath = null;

// Find Chromium executable path - Nix-aware for Railway
function findChromiumPath() {
  // Return cached path if already discovered
  if (cachedChromiumPath && fs.existsSync(cachedChromiumPath)) {
    return cachedChromiumPath;
  }
  
  // Check environment variables first
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    cachedChromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    logger.info(`KonesIsrael: Found Chromium via PUPPETEER_EXECUTABLE_PATH: ${cachedChromiumPath}`);
    return cachedChromiumPath;
  }
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    cachedChromiumPath = process.env.CHROMIUM_PATH;
    logger.info(`KonesIsrael: Found Chromium via CHROMIUM_PATH: ${cachedChromiumPath}`);
    return cachedChromiumPath;
  }
  
  // Priority 1: Use 'which' command - works on Nix (Railway) where binaries are on PATH
  try {
    const whichResult = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || which google-chrome-stable 2>/dev/null || true', { encoding: 'utf8' });
    const foundPath = whichResult.trim().split('\n')[0];
    if (foundPath && fs.existsSync(foundPath)) {
      cachedChromiumPath = foundPath;
      logger.info(`KonesIsrael: Found Chromium via which: ${cachedChromiumPath}`);
      return cachedChromiumPath;
    }
  } catch (e) {
    logger.debug('KonesIsrael: which command failed');
  }
  
  // Priority 2: Search Nix store (Railway uses Nix, paths include hashes)
  try {
    const nixResult = execSync('find /nix/store -maxdepth 3 -name "chromium" -type f -executable 2>/dev/null | head -1', { encoding: 'utf8', timeout: 5000 });
    const nixPath = nixResult.trim();
    if (nixPath && fs.existsSync(nixPath)) {
      cachedChromiumPath = nixPath;
      logger.info(`KonesIsrael: Found Chromium in Nix store: ${cachedChromiumPath}`);
      return cachedChromiumPath;
    }
  } catch (e) {
    logger.debug('KonesIsrael: Nix store search failed or timed out');
  }
  
  // Priority 3: Try Nix store bin wrapper paths
  try {
    const nixBinResult = execSync('find /nix/store -maxdepth 4 -path "*/bin/chromium" -type f 2>/dev/null | head -1', { encoding: 'utf8', timeout: 5000 });
    const nixBinPath = nixBinResult.trim();
    if (nixBinPath && fs.existsSync(nixBinPath)) {
      cachedChromiumPath = nixBinPath;
      logger.info(`KonesIsrael: Found Chromium in Nix bin: ${cachedChromiumPath}`);
      return cachedChromiumPath;
    }
  } catch (e) {
    logger.debug('KonesIsrael: Nix bin search failed');
  }
  
  // Priority 4: Standard Linux paths (non-Nix environments)
  const possiblePaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium',
    '/snap/bin/chromium'
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cachedChromiumPath = p;
      logger.info(`KonesIsrael: Found Chromium at standard path: ${cachedChromiumPath}`);
      return cachedChromiumPath;
    }
  }
  
  logger.error('KonesIsrael: Chromium not found on system. Searched: env vars, which, nix store, standard paths');
  return null;
}

async function getBrowser() {
  if (!puppeteer) {
    puppeteer = require('puppeteer-core');
  }
  
  const executablePath = findChromiumPath();
  
  if (!executablePath) {
    // Collect diagnostic info for troubleshooting
    let diagnostics = '';
    try {
      diagnostics = execSync('echo "PATH=$PATH" && ls /nix/store/ 2>/dev/null | head -20 || echo "no nix store"', { encoding: 'utf8' });
    } catch (e) { /* ignore */ }
    throw new Error(`Chromium not found. Diagnostics: ${diagnostics.substring(0, 500)}`);
  }
  
  logger.info(`KonesIsrael: Launching browser with executablePath: ${executablePath}`);
  
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ],
    defaultViewport: { width: 1280, height: 720 },
    executablePath,
    headless: 'new',
    ignoreHTTPSErrors: true
  });
  
  return browser;
}

// Lazy-load cheerio
let cheerio = null;
function getCheerio() {
  if (!cheerio) {
    cheerio = require('cheerio');
  }
  return cheerio;
}

class KonesIsraelService {
  constructor() {
    this.baseUrl = 'https://konesisrael.co.il';
    this.realEstateUrl = `${this.baseUrl}/%D7%A0%D7%93%D7%9C%D7%9F-%D7%9E%D7%9B%D7%95%D7%A0%D7%A1-%D7%A0%D7%9B%D7%A1%D7%99%D7%9D/`;
    this.loginUrl = `${this.baseUrl}/wp-login.php`;
    
    // Credentials from environment
    this.credentials = {
      email: process.env.KONES_EMAIL || '',
      password: process.env.KONES_PASSWORD || ''
    };
    
    // Property type mapping
    this.propertyTypes = {
      'דירה': 'apartment',
      'דירת גן': 'garden_apartment',
      'פנטהאוז': 'penthouse',
      'דופלקס': 'duplex',
      'בית פרטי': 'house',
      'חד משפחתי': 'single_family',
      'דו משפחתי': 'duplex_house',
      'מגרש': 'land',
      'חנות': 'store',
      'מבנה מסחרי': 'commercial',
      'יחידה': 'unit'
    };
    
    // Region mapping
    this.regions = {
      'מרכז': 'center',
      'דרום': 'south',
      'צפון': 'north',
      'ירושלים': 'jerusalem',
      'יהודה ושומרון': 'judea_samaria'
    };
    
    // Cache for listings
    this.listingsCache = {
      data: null,
      timestamp: null,
      ttl: 4 * 60 * 60 * 1000 // 4 hours cache
    };
    
    // Store cookies for session persistence
    this.cookies = null;
    this.isLoggedIn = false;
  }

  /**
   * Check if credentials are configured
   */
  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  /**
   * Login to KonesIsrael using headless browser
   */
  async login() {
    if (!this.isConfigured()) {
      logger.info('KonesIsrael: No credentials configured');
      return false;
    }

    let browser = null;
    try {
      logger.info('KonesIsrael: Starting headless browser for login...');
      browser = await getBrowser();
      const page = await browser.newPage();
      
      // Set user agent to look like a real browser
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
      
      // Set Hebrew language
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
      });
      
      // Navigate to login page
      await page.goto(this.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Fill login form
      await page.type('#user_login', this.credentials.email, { delay: 50 });
      await page.type('#user_pass', this.credentials.password, { delay: 50 });
      
      // Click login button
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.click('#wp-submit')
      ]);
      
      // Check if login was successful
      const currentUrl = page.url();
      const pageContent = await page.content();
      
      if (currentUrl.includes('wp-login.php') && pageContent.includes('שגיאה')) {
        logger.warn('KonesIsrael: Login failed - invalid credentials');
        await browser.close();
        return false;
      }
      
      // Save cookies for future requests
      this.cookies = await page.cookies();
      this.isLoggedIn = true;
      
      logger.info('KonesIsrael: Login successful via headless browser');
      await browser.close();
      return true;
      
    } catch (error) {
      logger.error(`KonesIsrael: Login failed - ${error.message}`);
      if (browser) await browser.close();
      return false;
    }
  }

  /**
   * Fetch listings using headless browser
   */
  async fetchListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      logger.info('KonesIsrael: Returning cached listings');
      return this.listingsCache.data;
    }

    let browser = null;
    try {
      logger.info('KonesIsrael: Fetching listings via headless browser...');
      browser = await getBrowser();
      const page = await browser.newPage();
      
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
      
      // Set Hebrew language
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
      });
      
      // Restore cookies if we have them
      if (this.cookies && this.cookies.length > 0) {
        await page.setCookie(...this.cookies);
      }
      
      // Navigate to real estate listings page
      await page.goto(this.realEstateUrl, { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
      });
      
      // Wait for content to load
      await page.waitForSelector('body', { timeout: 10000 });
      
      // Try to wait for table
      try {
        await page.waitForSelector('table', { timeout: 10000 });
      } catch (e) {
        logger.warn('KonesIsrael: Table not found immediately, checking page content...');
      }
      
      // Get page HTML
      const html = await page.content();
      
      // Update cookies
      this.cookies = await page.cookies();
      
      await browser.close();
      
      // Parse the HTML
      const listings = this.parseListingsPage(html);
      
      // Update cache
      this.listingsCache.data = listings;
      this.listingsCache.timestamp = Date.now();
      
      logger.info(`KonesIsrael: Fetched ${listings.length} receivership listings`);
      return listings;
      
    } catch (error) {
      logger.error(`KonesIsrael: Fetch failed - ${error.message}`);
      if (browser) await browser.close();
      
      // Return cached data if available
      if (this.listingsCache.data) {
        logger.info('KonesIsrael: Returning stale cache due to fetch error');
        return this.listingsCache.data;
      }
      
      throw error;
    }
  }

  /**
   * Fetch with login if needed
   */
  async fetchWithLogin(forceRefresh = false) {
    // First try without login
    try {
      const listings = await this.fetchListings(forceRefresh);
      if (listings && listings.length > 0) {
        return listings;
      }
    } catch (e) {
      logger.info('KonesIsrael: Initial fetch failed, attempting login...');
    }
    
    // Try logging in first
    if (this.isConfigured() && !this.isLoggedIn) {
      await this.login();
    }
    
    // Try fetching again
    return await this.fetchListings(true);
  }

  /**
   * Parse the HTML page and extract listing data
   */
  parseListingsPage(html) {
    const $ = getCheerio().load(html);
    const listings = [];
    
    // Try multiple table selectors
    const tableSelectors = [
      'table.tablepress tbody tr',
      'table tbody tr',
      '.entry-content table tr',
      '#tablepress-1 tbody tr'
    ];
    
    let rows = $();
    for (const selector of tableSelectors) {
      rows = $(selector);
      if (rows.length > 0) {
        logger.info(`KonesIsrael: Found ${rows.length} rows with selector: ${selector}`);
        break;
      }
    }
    
    rows.each((index, row) => {
      try {
        const cells = $(row).find('td');
        if (cells.length < 5) return;
        
        const listing = {
          id: `kones_${Date.now()}_${index}`,
          source: 'konesisrael',
          propertyType: $(cells[0]).text().trim() || null,
          propertyTypeEn: this.propertyTypes[$(cells[0]).text().trim()] || 'other',
          region: $(cells[1]).text().trim() || null,
          regionEn: this.regions[$(cells[1]).text().trim()] || 'unknown',
          city: $(cells[2]).text().trim() || null,
          address: $(cells[3]).text().trim() || null,
          submissionDeadline: this.parseDate($(cells[4]).text().trim()),
          gushHelka: cells.length > 5 ? $(cells[5]).text().trim() : null,
          contactPerson: cells.length > 6 ? $(cells[6]).text().trim() : null,
          email: this.extractEmail($(row).html() || ''),
          phone: this.extractPhone($(row).html() || ''),
          url: this.extractUrl($(row)),
          isReceivership: true,
          ssiContribution: 30
        };
        
        if (listing.gushHelka) {
          const parsed = this.parseGushHelka(listing.gushHelka);
          listing.gush = parsed.gush;
          listing.helka = parsed.helka;
          listing.tatHelka = parsed.tatHelka;
        }
        
        if (listing.city || listing.address || listing.propertyType) {
          listings.push(listing);
        }
      } catch (err) {
        logger.debug(`KonesIsrael: Error parsing row ${index}: ${err.message}`);
      }
    });
    
    if (listings.length === 0) {
      logger.info('KonesIsrael: No table data found, checking for alternative formats...');
      
      $('.property-item, .listing-item, article.property').each((index, item) => {
        try {
          const listing = {
            id: `kones_${Date.now()}_${index}`,
            source: 'konesisrael',
            propertyType: $(item).find('.property-type, .type').text().trim() || null,
            city: $(item).find('.city, .location').text().trim() || null,
            address: $(item).find('.address, .street').text().trim() || null,
            url: $(item).find('a').first().attr('href') || null,
            isReceivership: true,
            ssiContribution: 30
          };
          
          if (listing.city || listing.address) {
            listings.push(listing);
          }
        } catch (err) {
          logger.debug(`KonesIsrael: Error parsing item ${index}: ${err.message}`);
        }
      });
    }
    
    return listings;
  }

  parseDate(dateStr) {
    if (!dateStr) return null;
    
    const match = dateStr.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (match) {
      const day = match[1].padStart(2, '0');
      const month = match[2].padStart(2, '0');
      const year = match[3].length === 2 ? `20${match[3]}` : match[3];
      return `${year}-${month}-${day}`;
    }
    
    return null;
  }

  extractEmail(html) {
    if (!html) return null;
    const match = html.match(/mailto:([^\s"'>]+)/);
    if (match) return match[1];
    
    const emailMatch = html.match(/[\w.-]+@[\w.-]+\.\w+/);
    return emailMatch ? emailMatch[0] : null;
  }

  extractPhone(html) {
    if (!html) return null;
    const match = html.match(/(?:tel:|href="tel:)?(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4})/);
    return match ? match[1].replace(/[\s-]/g, '') : null;
  }

  extractUrl($row) {
    const link = $row.find('a[href]').first();
    const href = link.attr('href');
    if (href && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
      return href.startsWith('http') ? href : `${this.baseUrl}${href}`;
    }
    return null;
  }

  parseGushHelka(str) {
    const result = { gush: null, helka: null, tatHelka: null };
    if (!str) return result;
    
    const gushMatch = str.match(/גוש\s*(\d+)/);
    const helkaMatch = str.match(/חלקה\s*(\d+)/);
    const tatMatch = str.match(/תת\s*חלקה?\s*(\d+)/);
    
    if (gushMatch) result.gush = parseInt(gushMatch[1]);
    if (helkaMatch) result.helka = parseInt(helkaMatch[1]);
    if (tatMatch) result.tatHelka = parseInt(tatMatch[1]);
    
    return result;
  }

  async searchByCity(city) {
    const listings = await this.fetchWithLogin();
    return listings.filter(l => l.city && l.city.includes(city));
  }

  async searchByRegion(region) {
    const listings = await this.fetchWithLogin();
    return listings.filter(l => l.region === region || l.regionEn === region);
  }

  async searchByGushHelka(gush, helka = null) {
    const listings = await this.fetchWithLogin();
    return listings.filter(l => {
      if (l.gush !== gush) return false;
      if (helka && l.helka !== helka) return false;
      return true;
    });
  }

  async checkAddress(city, street) {
    const listings = await this.fetchWithLogin();
    
    const normalizedStreet = street.toLowerCase().replace(/\s+/g, ' ');
    const normalizedCity = city.toLowerCase();
    
    return listings.filter(l => {
      const listingCity = (l.city || '').toLowerCase();
      const listingAddress = (l.address || '').toLowerCase().replace(/\s+/g, ' ');
      
      return listingCity.includes(normalizedCity) && 
             listingAddress.includes(normalizedStreet);
    });
  }

  async matchWithComplexes(complexes) {
    const listings = await this.fetchWithLogin();
    const matches = [];
    
    for (const complex of complexes) {
      const city = complex.city;
      const street = complex.street || complex.address || '';
      
      const matchingListings = listings.filter(l => {
        if (!l.city || !city) return false;
        
        const cityMatch = l.city.includes(city) || city.includes(l.city);
        if (!cityMatch) return false;
        
        if (street && l.address) {
          return l.address.includes(street) || street.includes(l.address);
        }
        
        return cityMatch;
      });
      
      if (matchingListings.length > 0) {
        matches.push({
          complexId: complex.id,
          complexName: complex.name || `${city} - ${street}`,
          matchedListings: matchingListings.length,
          listings: matchingListings,
          ssiBoost: 30
        });
      }
    }
    
    return matches;
  }

  async getStatistics() {
    const listings = await this.fetchWithLogin();
    
    const stats = {
      total: listings.length,
      byPropertyType: {},
      byRegion: {},
      byCity: {},
      upcomingDeadlines: [],
      urgentDeadlines: []
    };
    
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (const listing of listings) {
      const type = listing.propertyType || 'אחר';
      stats.byPropertyType[type] = (stats.byPropertyType[type] || 0) + 1;
      
      const region = listing.region || 'לא ידוע';
      stats.byRegion[region] = (stats.byRegion[region] || 0) + 1;
      
      const city = listing.city || 'לא ידוע';
      stats.byCity[city] = (stats.byCity[city] || 0) + 1;
      
      if (listing.submissionDeadline) {
        const deadline = new Date(listing.submissionDeadline);
        if (deadline > now) {
          stats.upcomingDeadlines.push({
            ...listing,
            deadline: listing.submissionDeadline,
            daysLeft: Math.ceil((deadline - now) / (24 * 60 * 60 * 1000))
          });
          
          if (deadline <= sevenDaysFromNow) {
            stats.urgentDeadlines.push(listing);
          }
        }
      }
    }
    
    stats.upcomingDeadlines.sort((a, b) => 
      new Date(a.deadline) - new Date(b.deadline)
    );
    stats.upcomingDeadlines = stats.upcomingDeadlines.slice(0, 20);
    
    return stats;
  }

  async getStatus() {
    try {
      const chromiumPath = findChromiumPath();
      
      // Collect diagnostic info regardless
      let diagnosticInfo = {};
      try {
        const whichOutput = execSync('which chromium 2>&1 || echo "not found"', { encoding: 'utf8' }).trim();
        const nixCheck = execSync('ls /nix/store/ 2>/dev/null | grep -i chrom | head -5 || echo "no nix store"', { encoding: 'utf8' }).trim();
        diagnosticInfo = {
          whichChromium: whichOutput,
          nixStoreChromium: nixCheck,
          PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)',
          CHROMIUM_PATH: process.env.CHROMIUM_PATH || '(not set)',
          PATH: (process.env.PATH || '').substring(0, 200) + '...'
        };
      } catch (e) {
        diagnosticInfo = { error: e.message };
      }
      
      if (!chromiumPath) {
        return {
          status: 'error',
          method: 'headless_browser',
          error: 'Chromium not found after searching: env vars, which, nix store, standard paths',
          configured: this.isConfigured(),
          authenticated: this.isLoggedIn,
          diagnostics: diagnosticInfo
        };
      }
      
      // Chromium found - try a quick launch test before full scrape
      return {
        status: 'ready',
        method: 'headless_browser',
        chromiumPath,
        configured: this.isConfigured(),
        authenticated: this.isLoggedIn,
        source: 'konesisrael.co.il',
        cached: !!(this.listingsCache.data),
        cacheAge: this.listingsCache.timestamp 
          ? Math.round((Date.now() - this.listingsCache.timestamp) / 60000) + ' minutes'
          : 'no cache',
        diagnostics: diagnosticInfo
      };
    } catch (error) {
      return {
        status: 'error',
        method: 'headless_browser',
        error: error.message,
        configured: this.isConfigured(),
        authenticated: this.isLoggedIn
      };
    }
  }
}

const konesIsraelService = new KonesIsraelService();

module.exports = konesIsraelService;
