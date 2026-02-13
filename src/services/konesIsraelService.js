/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * Uses axios + cheerio (no Puppeteer) for reliable scraping on Railway
 * NOTE: cheerio and axios are lazy-loaded to avoid undici/File errors on Node 18
 */

const { logger } = require('./logger');

// Lazy-load dependencies to avoid Node 18 compatibility issues
let _axios = null;
let _cheerio = null;

function getAxios() {
  if (!_axios) {
    _axios = require('axios');
  }
  return _axios;
}

function getCheerio() {
  if (!_cheerio) {
    // Polyfill File global for Node 18 (required by undici used in cheerio 1.x)
    if (typeof globalThis.File === 'undefined') {
      try {
        const { File } = require('node:buffer');
        globalThis.File = File;
      } catch (e) {
        // Node 18 may not have File in buffer, create minimal stub
        globalThis.File = class File {
          constructor(bits, name, options = {}) {
            this.name = name;
            this.lastModified = options.lastModified || Date.now();
          }
        };
      }
    }
    _cheerio = require('cheerio');
  }
  return _cheerio;
}

class KonesIsraelService {
  constructor() {
    this.baseUrl = 'https://konesisrael.co.il';
    this.realEstateUrl = `${this.baseUrl}/%D7%A0%D7%93%D7%9C%D7%9F-%D7%9E%D7%9B%D7%95%D7%A0%D7%A1-%D7%A0%D7%9B%D7%A1%D7%99%D7%9D/`;
    this.loginUrl = `${this.baseUrl}/wp-login.php`;
    
    this.credentials = {
      email: process.env.KONES_EMAIL || '',
      password: process.env.KONES_PASSWORD || ''
    };
    
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
    
    this.regions = {
      'מרכז': 'center',
      'דרום': 'south',
      'צפון': 'north',
      'ירושלים': 'jerusalem',
      'יהודה ושומרון': 'judea_samaria'
    };
    
    this.listingsCache = {
      data: null,
      timestamp: null,
      ttl: 4 * 60 * 60 * 1000
    };
    
    this.cookies = '';
    this.isLoggedIn = false;
  }

  _getClient() {
    const axios = getAxios();
    return axios.create({
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
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    });
  }

  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  async login() {
    if (!this.isConfigured()) {
      logger.info('KonesIsrael: No credentials configured');
      return false;
    }

    try {
      logger.info('KonesIsrael: Attempting login via HTTP...');
      const client = this._getClient();
      
      const loginPageRes = await client.get(this.loginUrl);
      const setCookies = loginPageRes.headers['set-cookie'] || [];
      this.cookies = setCookies.map(c => c.split(';')[0]).join('; ');
      
      const formData = new URLSearchParams({
        log: this.credentials.email,
        pwd: this.credentials.password,
        'wp-submit': 'התחבר',
        redirect_to: this.baseUrl,
        testcookie: '1'
      });

      const loginRes = await client.post(this.loginUrl, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.cookies,
          'Referer': this.loginUrl
        },
        maxRedirects: 0,
        validateStatus: (s) => s < 500
      });

      const newCookies = loginRes.headers['set-cookie'] || [];
      if (newCookies.length > 0) {
        const allCookies = [...setCookies, ...newCookies];
        this.cookies = allCookies.map(c => c.split(';')[0]).join('; ');
      }

      const hasAuthCookie = this.cookies.includes('wordpress_logged_in');
      
      if (hasAuthCookie || loginRes.status === 302) {
        this.isLoggedIn = true;
        logger.info('KonesIsrael: Login successful');
        return true;
      }
      
      logger.warn('KonesIsrael: Login may have failed - no auth cookie found');
      return false;
      
    } catch (error) {
      logger.error(`KonesIsrael: Login failed - ${error.message}`);
      return false;
    }
  }

  async fetchListings(forceRefresh = false) {
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      logger.info(`KonesIsrael: Returning ${this.listingsCache.data.length} cached listings`);
      return this.listingsCache.data;
    }

    try {
      logger.info('KonesIsrael: Fetching listings via HTTP...');
      const client = this._getClient();
      
      const allListings = [];
      let page = 1;
      const maxPages = 20;
      
      while (page <= maxPages) {
        const url = page === 1 
          ? this.realEstateUrl 
          : `${this.realEstateUrl}page/${page}/`;
        
        logger.info(`KonesIsrael: Fetching page ${page}`);
        
        const response = await client.get(url, {
          headers: { 'Cookie': this.cookies || '' }
        });
        
        if (response.status === 404 || response.status >= 400) {
          logger.info(`KonesIsrael: Page ${page} returned ${response.status}, stopping`);
          break;
        }
        
        const html = response.data;
        
        const newCookies = response.headers['set-cookie'] || [];
        if (newCookies.length > 0) {
          this.cookies = newCookies.map(c => c.split(';')[0]).join('; ');
        }
        
        const pageListings = this.parseListingsPage(html);
        
        if (pageListings.length === 0) {
          logger.info(`KonesIsrael: No listings on page ${page}, stopping`);
          break;
        }
        
        allListings.push(...pageListings);
        logger.info(`KonesIsrael: Page ${page}: ${pageListings.length} listings (total: ${allListings.length})`);
        
        const cheerio = getCheerio();
        const $ = cheerio.load(html);
        const hasNextPage = $('a.next, .pagination .next, .nav-links .next').length > 0 ||
                           $(`a[href*="page/${page + 1}"]`).length > 0;
        
        if (!hasNextPage) break;
        
        page++;
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // Deduplicate
      const seen = new Set();
      const uniqueListings = allListings.filter(l => {
        const key = `${l.city || ''}_${l.address || ''}_${l.propertyType || ''}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      this.listingsCache.data = uniqueListings;
      this.listingsCache.timestamp = Date.now();
      
      logger.info(`KonesIsrael: Fetched ${uniqueListings.length} unique listings (${allListings.length} raw, ${page} pages)`);
      return uniqueListings;
      
    } catch (error) {
      logger.error(`KonesIsrael: Fetch failed - ${error.message}`);
      
      if (this.listingsCache.data) {
        logger.info('KonesIsrael: Returning stale cache due to fetch error');
        return this.listingsCache.data;
      }
      
      throw error;
    }
  }

  async fetchWithLogin(forceRefresh = false) {
    try {
      const listings = await this.fetchListings(forceRefresh);
      if (listings && listings.length > 0) return listings;
    } catch (e) {
      logger.info('KonesIsrael: Initial fetch failed, attempting login...');
    }
    
    if (this.isConfigured() && !this.isLoggedIn) {
      await this.login();
    }
    
    return await this.fetchListings(true);
  }

  parseListingsPage(html) {
    const cheerio = getCheerio();
    const $ = cheerio.load(html);
    const listings = [];
    
    const tableSelectors = [
      'table.tablepress tbody tr',
      '#tablepress-1 tbody tr',
      '#tablepress-2 tbody tr',
      'table tbody tr',
      '.entry-content table tr'
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
        if (cells.length < 3) return;
        
        const firstCellText = $(cells[0]).text().trim();
        if (firstCellText === 'סוג נכס' || firstCellText === 'סוג' || firstCellText === '#') return;
        
        const listing = {
          id: `kones_${Date.now()}_${index}`,
          source: 'konesisrael',
          propertyType: $(cells[0]).text().trim() || null,
          propertyTypeEn: this.propertyTypes[$(cells[0]).text().trim()] || 'other',
          isReceivership: true,
          ssiContribution: 30
        };
        
        if (cells.length >= 7) {
          listing.region = $(cells[1]).text().trim() || null;
          listing.regionEn = this.regions[listing.region] || 'unknown';
          listing.city = $(cells[2]).text().trim() || null;
          listing.address = $(cells[3]).text().trim() || null;
          listing.submissionDeadline = this.parseDate($(cells[4]).text().trim());
          listing.gushHelka = $(cells[5]).text().trim() || null;
          listing.contactPerson = $(cells[6]).text().trim() || null;
        } else if (cells.length >= 5) {
          listing.region = $(cells[1]).text().trim() || null;
          listing.regionEn = this.regions[listing.region] || 'unknown';
          listing.city = $(cells[2]).text().trim() || null;
          listing.address = $(cells[3]).text().trim() || null;
          listing.submissionDeadline = this.parseDate($(cells[4]).text().trim());
        } else {
          listing.city = $(cells[1]).text().trim() || null;
          listing.address = $(cells[2]).text().trim() || null;
        }
        
        const rowHtml = $(row).html() || '';
        listing.email = this.extractEmail(rowHtml);
        listing.phone = this.extractPhone(rowHtml);
        listing.url = this.extractUrl($(row));
        
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
      logger.info('KonesIsrael: No table data, checking card layouts...');
      
      const cardSelectors = [
        '.property-item', '.listing-item', 'article.property',
        '.real-estate-item', '.kones-listing', '.wp-block-table tr'
      ];
      
      for (const sel of cardSelectors) {
        $(sel).each((index, item) => {
          try {
            const listing = {
              id: `kones_${Date.now()}_${index}`,
              source: 'konesisrael',
              propertyType: $(item).find('.property-type, .type, .col-type').text().trim() || null,
              city: $(item).find('.city, .location, .col-city').text().trim() || null,
              address: $(item).find('.address, .street, .col-address').text().trim() || null,
              url: $(item).find('a').first().attr('href') || null,
              isReceivership: true,
              ssiContribution: 30
            };
            
            if (listing.city || listing.address) {
              listings.push(listing);
            }
          } catch (err) {
            logger.debug(`KonesIsrael: Error parsing card ${index}: ${err.message}`);
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
      const address = complex.addresses || complex.address || complex.name || '';
      
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
    
    stats.upcomingDeadlines.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    stats.upcomingDeadlines = stats.upcomingDeadlines.slice(0, 20);
    
    return stats;
  }

  async getStatus() {
    return {
      status: 'ready',
      method: 'http_axios_cheerio',
      configured: this.isConfigured(),
      authenticated: this.isLoggedIn,
      source: 'konesisrael.co.il',
      cached: !!(this.listingsCache.data),
      cachedCount: this.listingsCache.data ? this.listingsCache.data.length : 0,
      cacheAge: this.listingsCache.timestamp 
        ? Math.round((Date.now() - this.listingsCache.timestamp) / 60000) + ' minutes'
        : 'no cache'
    };
  }
}

const konesIsraelService = new KonesIsraelService();

module.exports = konesIsraelService;
