/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * Provides access to properties being sold by receivers (כונס נכסים)
 * Key SSI indicator: Properties in receivership are distressed sales by definition
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('./logger');

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
    
    this.session = null;
  }

  /**
   * Check if credentials are configured
   */
  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  /**
   * Login to KonesIsrael (if credentials provided)
   */
  async login() {
    if (!this.isConfigured()) {
      logger.info('KonesIsrael: No credentials configured, using public access');
      return false;
    }

    try {
      // Create session with cookies
      const response = await axios.post(this.loginUrl, 
        new URLSearchParams({
          'log': this.credentials.email,
          'pwd': this.credentials.password,
          'wp-submit': 'התחבר',
          'redirect_to': this.baseUrl,
          'testcookie': '1'
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          maxRedirects: 0,
          validateStatus: status => status >= 200 && status < 400
        }
      );

      if (response.headers['set-cookie']) {
        this.session = response.headers['set-cookie'].join('; ');
        logger.info('KonesIsrael: Login successful');
        return true;
      }
    } catch (error) {
      logger.warn(`KonesIsrael: Login failed - ${error.message}`);
    }
    
    return false;
  }

  /**
   * Fetch and parse receivership listings from KonesIsrael
   */
  async fetchListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      logger.info('KonesIsrael: Returning cached listings');
      return this.listingsCache.data;
    }

    try {
      logger.info('KonesIsrael: Fetching fresh listings...');
      
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
      };
      
      if (this.session) {
        headers['Cookie'] = this.session;
      }

      const response = await axios.get(this.realEstateUrl, {
        headers,
        timeout: 30000
      });

      const listings = this.parseListingsPage(response.data);
      
      // Update cache
      this.listingsCache.data = listings;
      this.listingsCache.timestamp = Date.now();
      
      logger.info(`KonesIsrael: Fetched ${listings.length} receivership listings`);
      return listings;
      
    } catch (error) {
      logger.error(`KonesIsrael: Fetch failed - ${error.message}`);
      
      // Return cached data if available
      if (this.listingsCache.data) {
        return this.listingsCache.data;
      }
      
      throw error;
    }
  }

  /**
   * Parse the HTML page and extract listing data
   */
  parseListingsPage(html) {
    const $ = cheerio.load(html);
    const listings = [];
    
    // Parse table rows
    $('table tbody tr').each((index, row) => {
      try {
        const cells = $(row).find('td');
        if (cells.length < 10) return;
        
        const listing = {
          id: `kones_${Date.now()}_${index}`,
          source: 'konesisrael',
          datePosted: this.parseDate($(cells[0]).text().trim()),
          propertyType: $(cells[2]).text().trim(),
          propertyTypeEn: this.propertyTypes[$(cells[2]).text().trim()] || 'other',
          region: $(cells[3]).text().trim(),
          regionEn: this.regions[$(cells[3]).text().trim()] || 'unknown',
          city: $(cells[4]).text().trim(),
          address: $(cells[5]).text().trim(),
          submissionDeadline: this.parseDate($(cells[6]).text().trim()),
          daysUntilDeadline: parseInt($(cells[7]).text().trim()) || null,
          gushHelka: $(cells[8]).text().trim(),
          contactPerson: $(cells[9]).text().trim(),
          email: this.extractEmail($(row).html()),
          phone: this.extractPhone($(row).html()),
          details: this.extractDetails($(row).html()),
          url: this.extractUrl($(row)),
          isReceivership: true, // All listings on this site are receivership
          ssiContribution: 30 // Maximum receivership weight
        };
        
        // Parse gush/helka into structured format
        if (listing.gushHelka) {
          const parsed = this.parseGushHelka(listing.gushHelka);
          listing.gush = parsed.gush;
          listing.helka = parsed.helka;
          listing.tatHelka = parsed.tatHelka;
        }
        
        listings.push(listing);
      } catch (err) {
        logger.debug(`KonesIsrael: Error parsing row ${index}: ${err.message}`);
      }
    });
    
    return listings;
  }

  /**
   * Parse Hebrew date format to ISO
   */
  parseDate(dateStr) {
    if (!dateStr) return null;
    
    // Format: DD/MM/YYYY or timestamp
    const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) {
      return `${match[3]}-${match[2]}-${match[1]}`;
    }
    
    return null;
  }

  /**
   * Extract email from HTML
   */
  extractEmail(html) {
    const match = html.match(/mailto:([^\s"'>]+)/);
    return match ? match[1] : null;
  }

  /**
   * Extract phone from HTML
   */
  extractPhone(html) {
    const match = html.match(/(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4})/);
    return match ? match[1].replace(/\s/g, '') : null;
  }

  /**
   * Extract property details
   */
  extractDetails(html) {
    const $ = cheerio.load(html);
    // Look for the details column content
    const detailsMatch = html.match(/פרטים:([^<]+)/);
    return detailsMatch ? detailsMatch[1].trim() : null;
  }

  /**
   * Extract listing URL
   */
  extractUrl($row) {
    const link = $row.find('a[href*="apartments"]').first();
    return link.attr('href') || null;
  }

  /**
   * Parse gush/helka/tat format
   */
  parseGushHelka(str) {
    const result = { gush: null, helka: null, tatHelka: null };
    
    // Format: "גוש 1234 חלקה 56 תת חלקה 7"
    const gushMatch = str.match(/גוש\s*(\d+)/);
    const helkaMatch = str.match(/חלקה\s*(\d+)/);
    const tatMatch = str.match(/תת\s*חלקה?\s*(\d+)/);
    
    if (gushMatch) result.gush = parseInt(gushMatch[1]);
    if (helkaMatch) result.helka = parseInt(helkaMatch[1]);
    if (tatMatch) result.tatHelka = parseInt(tatMatch[1]);
    
    return result;
  }

  /**
   * Search listings by city
   */
  async searchByCity(city) {
    const listings = await this.fetchListings();
    
    return listings.filter(l => 
      l.city && l.city.includes(city)
    );
  }

  /**
   * Search listings by region
   */
  async searchByRegion(region) {
    const listings = await this.fetchListings();
    
    return listings.filter(l => 
      l.region === region || l.regionEn === region
    );
  }

  /**
   * Search by gush/helka
   */
  async searchByGushHelka(gush, helka = null) {
    const listings = await this.fetchListings();
    
    return listings.filter(l => {
      if (l.gush !== gush) return false;
      if (helka && l.helka !== helka) return false;
      return true;
    });
  }

  /**
   * Check if a specific address appears in receivership listings
   */
  async checkAddress(city, street) {
    const listings = await this.fetchListings();
    
    const normalizedStreet = street.toLowerCase().replace(/\s+/g, ' ');
    const normalizedCity = city.toLowerCase();
    
    return listings.filter(l => {
      const listingCity = (l.city || '').toLowerCase();
      const listingAddress = (l.address || '').toLowerCase().replace(/\s+/g, ' ');
      
      return listingCity.includes(normalizedCity) && 
             listingAddress.includes(normalizedStreet);
    });
  }

  /**
   * Match listings with QUANTUM complexes
   */
  async matchWithComplexes(complexes) {
    const listings = await this.fetchListings();
    const matches = [];
    
    for (const complex of complexes) {
      const city = complex.city;
      const street = complex.street || complex.address || '';
      
      const matchingListings = listings.filter(l => {
        if (!l.city || !city) return false;
        
        const cityMatch = l.city.includes(city) || city.includes(l.city);
        if (!cityMatch) return false;
        
        // If we have street info, also check that
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
          ssiBoost: 30 // Receivership indicator
        });
      }
    }
    
    return matches;
  }

  /**
   * Get statistics about current listings
   */
  async getStatistics() {
    const listings = await this.fetchListings();
    
    const stats = {
      total: listings.length,
      byPropertyType: {},
      byRegion: {},
      byCity: {},
      upcomingDeadlines: [],
      urgentDeadlines: [] // Within 7 days
    };
    
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (const listing of listings) {
      // By property type
      const type = listing.propertyType || 'אחר';
      stats.byPropertyType[type] = (stats.byPropertyType[type] || 0) + 1;
      
      // By region
      const region = listing.region || 'לא ידוע';
      stats.byRegion[region] = (stats.byRegion[region] || 0) + 1;
      
      // By city
      const city = listing.city || 'לא ידוע';
      stats.byCity[city] = (stats.byCity[city] || 0) + 1;
      
      // Check deadlines
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
    
    // Sort upcoming deadlines
    stats.upcomingDeadlines.sort((a, b) => 
      new Date(a.deadline) - new Date(b.deadline)
    );
    stats.upcomingDeadlines = stats.upcomingDeadlines.slice(0, 20);
    
    return stats;
  }

  /**
   * Get service status
   */
  async getStatus() {
    try {
      const stats = await this.getStatistics();
      
      return {
        status: 'connected',
        configured: this.isConfigured(),
        authenticated: !!this.session,
        source: 'konesisrael.co.il',
        totalListings: stats.total,
        cacheAge: this.listingsCache.timestamp 
          ? Math.round((Date.now() - this.listingsCache.timestamp) / 60000) + ' minutes'
          : 'no cache',
        urgentDeadlines: stats.urgentDeadlines.length,
        propertyTypes: Object.keys(stats.byPropertyType).length,
        regions: Object.keys(stats.byRegion).length,
        cities: Object.keys(stats.byCity).length
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        configured: this.isConfigured()
      };
    }
  }
}

// Singleton instance
const konesIsraelService = new KonesIsraelService();

module.exports = konesIsraelService;
