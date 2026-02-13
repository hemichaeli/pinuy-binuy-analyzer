/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * Uses axios + cheerio for reliable HTML scraping (no Puppeteer/Chromium dependency)
 * Provides access to properties being sold by receivers (כונס נכסים)
 * Key SSI indicator: Properties in receivership are distressed sales by definition
 */

const axios = require('axios');
const { logger } = require('./logger');

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
    
    // Session cookies from login
    this.sessionCookies = '';
    this.isLoggedIn = false;
    
    // HTTP client with browser-like headers
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
      },
      maxRedirects: 5
    });
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
      logger.info('KonesIsrael: No credentials configured, using public access');
      return false;
    }

    try {
      logger.info('KonesIsrael: Attempting login via HTTP...');
      
      // First get the login page to capture any nonces/cookies
      const loginPage = await this.httpClient.get(this.loginUrl, {
        validateStatus: () => true
      });
      
      // Extract cookies from response
      const initialCookies = this._extractCookies(loginPage.headers);
      
      // Submit login form
      const formData = new URLSearchParams({
        'log': this.credentials.email,
        'pwd': this.credentials.password,
        'wp-submit': 'Log In',
        'redirect_to': this.baseUrl,
        'testcookie': '1'
      });
      
      const loginResponse = await this.httpClient.post(this.loginUrl, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': initialCookies,
          'Referer': this.loginUrl
        },
        maxRedirects: 0,
        validateStatus: (status) => status < 500
      });
      
      // Check for session cookies indicating successful login
      const responseCookies = this._extractCookies(loginResponse.headers);
      
      if (responseCookies.includes('wordpress_logged_in')) {
        this.sessionCookies = responseCookies;
        this.isLoggedIn = true;
        logger.info('KonesIsrael: Login successful');
        return true;
      }
      
      // 302 redirect usually means success
      if (loginResponse.status === 302) {
        this.sessionCookies = responseCookies || initialCookies;
        this.isLoggedIn = true;
        logger.info('KonesIsrael: Login successful (302 redirect)');
        return true;
      }
      
      logger.warn('KonesIsrael: Login may have failed - no session cookie found');
      return false;
      
    } catch (error) {
      logger.error(`KonesIsrael: Login failed - ${error.message}`);
      return false;
    }
  }

  /**
   * Extract cookies from response headers
   */
  _extractCookies(headers) {
    const setCookies = headers['set-cookie'];
    if (!setCookies) return '';
    
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
    return cookies.map(c => c.split(';')[0]).join('; ');
  }

  /**
   * Fetch listings via HTTP + cheerio parsing
   */
  async fetchListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      logger.info(`KonesIsrael: Returning ${this.listingsCache.data.length} cached listings`);
      return this.listingsCache.data;
    }

    try {
      logger.info('KonesIsrael: Fetching listings via HTTP...');
      
      const requestHeaders = {};
      if (this.sessionCookies) {
        requestHeaders['Cookie'] = this.sessionCookies;
      }
      
      // Fetch the main real estate listings page
      const response = await this.httpClient.get(this.realEstateUrl, {
        headers: requestHeaders,
        validateStatus: () => true
      });
      
      if (response.status !== 200) {
        logger.warn(`KonesIsrael: HTTP ${response.status} from listings page`);
      }
      
      // Update cookies if returned
      const newCookies = this._extractCookies(response.headers);
      if (newCookies) {
        this.sessionCookies = newCookies;
      }
      
      const html = response.data;
      logger.info(`KonesIsrael: Received ${(html.length / 1024).toFixed(0)}KB HTML`);
      
      // Parse the HTML
      let listings = this.parseListingsPage(html);
      
      // If no listings found, try paginated pages
      if (listings.length === 0) {
        logger.info('KonesIsrael: No listings on main page, trying paginated URLs...');
        listings = await this._fetchPaginatedListings(requestHeaders);
      }
      
      // Update cache
      this.listingsCache.data = listings;
      this.listingsCache.timestamp = Date.now();
      
      logger.info(`KonesIsrael: Fetched ${listings.length} receivership listings`);
      return listings;
      
    } catch (error) {
      logger.error(`KonesIsrael: Fetch failed - ${error.message}`);
      
      // Return cached data if available
      if (this.listingsCache.data) {
        logger.info('KonesIsrael: Returning stale cache due to fetch error');
        return this.listingsCache.data;
      }
      
      return [];
    }
  }

  /**
   * Try fetching paginated listing pages
   */
  async _fetchPaginatedListings(headers) {
    const allListings = [];
    const pagePaths = [
      '/page/1/', '/page/2/', '/page/3/',
      '?page=1', '?page=2', '?page=3'
    ];
    
    for (const pagePath of pagePaths) {
      try {
        const url = this.realEstateUrl.replace(/\/$/, '') + pagePath;
        const response = await this.httpClient.get(url, {
          headers,
          validateStatus: () => true
        });
        
        if (response.status === 200) {
          const pageListings = this.parseListingsPage(response.data);
          if (pageListings.length > 0) {
            allListings.push(...pageListings);
            logger.info(`KonesIsrael: Found ${pageListings.length} listings on ${pagePath}`);
          }
        }
        
        // Rate limit
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        // Skip failed pages
      }
    }
    
    // Deduplicate by address+city
    const seen = new Set();
    return allListings.filter(l => {
      const key = `${l.city}_${l.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
      logger.info('KonesIsrael: Initial fetch returned no results, attempting login...');
    }
    
    // Try logging in first
    if (this.isConfigured() && !this.isLoggedIn) {
      await this.login();
    }
    
    // Try fetching again with session
    return await this.fetchListings(true);
  }

  /**
   * Parse the HTML page and extract listing data
   */
  parseListingsPage(html) {
    const $ = getCheerio().load(html);
    const listings = [];
    
    // Try multiple table selectors (KonesIsrael uses TablePress)
    const tableSelectors = [
      'table.tablepress tbody tr',
      'table tbody tr',
      '.entry-content table tr',
      '#tablepress-1 tbody tr',
      '.tablepress tbody tr'
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
        if (cells.length < 3) return; // Need at least 3 cells for useful data
        
        // KonesIsrael table format varies, try common layouts
        let listing;
        
        if (cells.length >= 7) {
          // Full format: type, region, city, address, deadline, gush/helka, contact
          listing = {
            id: `kones_${Date.now()}_${index}`,
            source: 'konesisrael',
            propertyType: $(cells[0]).text().trim() || null,
            propertyTypeEn: this.propertyTypes[$(cells[0]).text().trim()] || 'other',
            region: $(cells[1]).text().trim() || null,
            regionEn: this.regions[$(cells[1]).text().trim()] || 'unknown',
            city: $(cells[2]).text().trim() || null,
            address: $(cells[3]).text().trim() || null,
            submissionDeadline: this.parseDate($(cells[4]).text().trim()),
            gushHelka: $(cells[5]).text().trim() || null,
            contactPerson: $(cells[6]).text().trim() || null
          };
        } else if (cells.length >= 5) {
          // Compact format
          listing = {
            id: `kones_${Date.now()}_${index}`,
            source: 'konesisrael',
            propertyType: $(cells[0]).text().trim() || null,
            propertyTypeEn: this.propertyTypes[$(cells[0]).text().trim()] || 'other',
            city: $(cells[1]).text().trim() || null,
            address: $(cells[2]).text().trim() || null,
            submissionDeadline: this.parseDate($(cells[3]).text().trim()),
            contactPerson: $(cells[4]).text().trim() || null
          };
        } else {
          // Minimal format
          listing = {
            id: `kones_${Date.now()}_${index}`,
            source: 'konesisrael',
            city: $(cells[0]).text().trim() || null,
            address: $(cells[1]).text().trim() || null,
            submissionDeadline: cells.length > 2 ? this.parseDate($(cells[2]).text().trim()) : null
          };
        }
        
        // Extract email and phone from row HTML
        const rowHtml = $(row).html() || '';
        listing.email = this.extractEmail(rowHtml);
        listing.phone = this.extractPhone(rowHtml);
        listing.url = this.extractUrl($(row));
        listing.isReceivership = true;
        listing.ssiContribution = 30;
        
        // Parse gush/helka if present
        if (listing.gushHelka) {
          const parsed = this.parseGushHelka(listing.gushHelka);
          listing.gush = parsed.gush;
          listing.helka = parsed.helka;
          listing.tatHelka = parsed.tatHelka;
        }
        
        // Only add if we have meaningful data
        if (listing.city || listing.address || listing.propertyType) {
          listings.push(listing);
        }
      } catch (err) {
        logger.debug(`KonesIsrael: Error parsing row ${index}: ${err.message}`);
      }
    });
    
    // If no table data, try alternative page structures
    if (listings.length === 0) {
      logger.info('KonesIsrael: No table data found, checking alternative formats...');
      
      // Try card/list-based layouts
      const cardSelectors = [
        '.property-item', '.listing-item', 'article.property',
        '.wp-block-table tr', '.elementor-widget-table tr',
        '.real-estate-item', '.auction-item'
      ];
      
      for (const selector of cardSelectors) {
        $(selector).each((index, item) => {
          try {
            const text = $(item).text().trim();
            if (!text || text.length < 10) return;
            
            const listing = {
              id: `kones_card_${Date.now()}_${index}`,
              source: 'konesisrael',
              propertyType: $(item).find('.property-type, .type, td:first').text().trim() || null,
              city: $(item).find('.city, .location, td:nth-child(3)').text().trim() || null,
              address: $(item).find('.address, .street, td:nth-child(4)').text().trim() || null,
              url: $(item).find('a').first().attr('href') || null,
              isReceivership: true,
              ssiContribution: 30
            };
            
            if (listing.city || listing.address) {
              listings.push(listing);
            }
          } catch (err) {
            // Skip individual parse errors
          }
        });
        
        if (listings.length > 0) break;
      }
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
    
    const normalizedStreet = (street || '').toLowerCase().replace(/\s+/g, ' ');
    const normalizedCity = (city || '').toLowerCase();
    
    if (!normalizedCity) return [];
    
    return listings.filter(l => {
      const listingCity = (l.city || '').toLowerCase();
      const listingAddress = (l.address || '').toLowerCase().replace(/\s+/g, ' ');
      
      return listingCity.includes(normalizedCity) && 
             (normalizedStreet ? listingAddress.includes(normalizedStreet) : true);
    });
  }

  async matchWithComplexes(complexes) {
    const listings = await this.fetchWithLogin();
    if (!listings || listings.length === 0) return [];
    
    const matches = [];
    
    for (const complex of complexes) {
      const city = complex.city;
      const addresses = complex.addresses || complex.name || '';
      
      const matchingListings = listings.filter(l => {
        if (!l.city || !city) return false;
        
        const cityMatch = l.city.includes(city) || city.includes(l.city);
        if (!cityMatch) return false;
        
        if (addresses && l.address) {
          return l.address.includes(addresses) || addresses.includes(l.address);
        }
        
        return cityMatch;
      });
      
      if (matchingListings.length > 0) {
        matches.push({
          complexId: complex.id,
          complexName: complex.name || `${city} - ${addresses}`,
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
      method: 'http_axios',
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
