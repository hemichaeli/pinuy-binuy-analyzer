/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * Uses axios + cheerio for reliable HTTP scraping (no browser needed)
 * Provides access to properties being sold by receivers (כונס נכסים)
 * Key SSI indicator: Properties in receivership are distressed sales by definition
 */

const { logger } = require('./logger');
const axios = require('axios');
const cheerio = require('cheerio');

// HTTP client with browser-like headers
const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache'
  },
  maxRedirects: 5
});

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
    
    // Cookie jar for session persistence
    this.cookies = '';
    this.isLoggedIn = false;
  }

  /**
   * Check if credentials are configured
   */
  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  /**
   * Login to KonesIsrael via HTTP POST
   */
  async login() {
    if (!this.isConfigured()) {
      logger.info('KonesIsrael: No credentials configured');
      return false;
    }

    try {
      logger.info('KonesIsrael: Attempting HTTP login...');
      
      // First get the login page to capture any nonce/tokens
      const loginPage = await httpClient.get(this.loginUrl);
      const $ = cheerio.load(loginPage.data);
      
      // Extract any hidden form fields
      const formData = new URLSearchParams();
      formData.append('log', this.credentials.email);
      formData.append('pwd', this.credentials.password);
      formData.append('wp-submit', 'Log In');
      formData.append('redirect_to', this.baseUrl);
      formData.append('testcookie', '1');
      
      // Submit login
      const response = await httpClient.post(this.loginUrl, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.extractCookies(loginPage.headers)
        },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302
      });
      
      // Capture cookies from response
      this.cookies = this.extractCookies(response.headers);
      
      if (response.status === 302 || !response.data?.includes('שגיאה')) {
        this.isLoggedIn = true;
        logger.info('KonesIsrael: HTTP login successful');
        return true;
      }
      
      logger.warn('KonesIsrael: Login failed - invalid credentials');
      return false;
      
    } catch (error) {
      // 302 redirect on login is actually success
      if (error.response && error.response.status === 302) {
        this.cookies = this.extractCookies(error.response.headers);
        this.isLoggedIn = true;
        logger.info('KonesIsrael: HTTP login successful (redirect)');
        return true;
      }
      logger.error(`KonesIsrael: Login failed - ${error.message}`);
      return false;
    }
  }

  /**
   * Extract cookies from response headers
   */
  extractCookies(headers) {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return this.cookies || '';
    
    const cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie];
    const newCookies = cookieArr.map(c => c.split(';')[0]).join('; ');
    
    // Merge with existing cookies
    if (this.cookies) {
      return `${this.cookies}; ${newCookies}`;
    }
    return newCookies;
  }

  /**
   * Fetch listings via HTTP request
   */
  async fetchListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      logger.info(`KonesIsrael: Returning cached listings (${this.listingsCache.data.length} items)`);
      return this.listingsCache.data;
    }

    try {
      logger.info('KonesIsrael: Fetching listings via HTTP...');
      
      const requestConfig = {};
      if (this.cookies) {
        requestConfig.headers = { 'Cookie': this.cookies };
      }
      
      // Fetch main listings page
      const response = await httpClient.get(this.realEstateUrl, requestConfig);
      
      // Update cookies
      if (response.headers['set-cookie']) {
        this.cookies = this.extractCookies(response.headers);
      }
      
      // Parse the HTML
      const listings = this.parseListingsPage(response.data);
      
      // Try to fetch additional pages if pagination exists
      const $ = cheerio.load(response.data);
      const paginationLinks = [];
      $('a.page-numbers, .pagination a, .nav-links a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && !href.includes('#') && !paginationLinks.includes(href)) {
          paginationLinks.push(href);
        }
      });
      
      // Fetch up to 5 additional pages
      for (const pageUrl of paginationLinks.slice(0, 5)) {
        try {
          await new Promise(r => setTimeout(r, 2000)); // Rate limit
          const pageResponse = await httpClient.get(pageUrl, requestConfig);
          const pageListings = this.parseListingsPage(pageResponse.data);
          listings.push(...pageListings);
          logger.info(`KonesIsrael: Fetched ${pageListings.length} listings from ${pageUrl}`);
        } catch (err) {
          logger.warn(`KonesIsrael: Failed to fetch page ${pageUrl}: ${err.message}`);
        }
      }
      
      // Deduplicate by address+city
      const seen = new Set();
      const unique = listings.filter(l => {
        const key = `${l.city || ''}_${l.address || ''}_${l.propertyType || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      // Update cache
      this.listingsCache.data = unique;
      this.listingsCache.timestamp = Date.now();
      
      logger.info(`KonesIsrael: Fetched ${unique.length} unique receivership listings (${listings.length} total)`);
      return unique;
      
    } catch (error) {
      logger.error(`KonesIsrael: Fetch failed - ${error.message}`);
      
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
    const $ = cheerio.load(html);
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
    
    // If no table data found, try alternative card/article selectors
    if (listings.length === 0) {
      logger.info('KonesIsrael: No table data found, checking for alternative formats...');
      
      $('.property-item, .listing-item, article.property, .wp-block-table tr').each((index, item) => {
        try {
          const cells = $(item).find('td');
          if (cells.length >= 3) {
            const listing = {
              id: `kones_${Date.now()}_alt_${index}`,
              source: 'konesisrael',
              city: $(cells[0]).text().trim() || null,
              address: $(cells[1]).text().trim() || null,
              propertyType: $(cells[2]).text().trim() || null,
              url: $(item).find('a').first().attr('href') || null,
              isReceivership: true,
              ssiContribution: 30
            };
            
            if (listing.city || listing.address) {
              listings.push(listing);
            }
          }
        } catch (err) {
          logger.debug(`KonesIsrael: Error parsing alt item ${index}: ${err.message}`);
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
      const address = complex.addresses || complex.address || complex.street || '';
      
      const matchingListings = listings.filter(l => {
        if (!l.city || !city) return false;
        
        const cityMatch = l.city.includes(city) || city.includes(l.city);
        if (!cityMatch) return false;
        
        if (address && l.address) {
          return l.address.includes(address) || address.includes(l.address);
        }
        
        return cityMatch;
      });
      
      if (matchingListings.length > 0) {
        matches.push({
          complexId: complex.id,
          complexName: complex.name || `${city} - ${address}`,
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
    return {
      status: 'ready',
      method: 'http_scraper',
      configured: this.isConfigured(),
      authenticated: this.isLoggedIn,
      source: 'konesisrael.co.il',
      cached: !!(this.listingsCache.data),
      cachedListings: this.listingsCache.data ? this.listingsCache.data.length : 0,
      cacheAge: this.listingsCache.timestamp 
        ? Math.round((Date.now() - this.listingsCache.timestamp) / 60000) + ' minutes'
        : 'no cache'
    };
  }
}

const konesIsraelService = new KonesIsraelService();

module.exports = konesIsraelService;
