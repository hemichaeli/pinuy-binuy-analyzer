/**
 * KonesIsrael Receivership Scraper Service
 * Integrates with konesisrael.co.il to identify distressed properties in urban renewal areas
 * 
 * Key value for SSI: Receivership (כינוס נכסים) has weight of 30 in SSI calculation
 * This service provides DIRECT data instead of relying on Perplexity AI searches
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('./logger');

// KonesIsrael credentials (environment variables)
const KONES_EMAIL = process.env.KONES_EMAIL || '';
const KONES_PASSWORD = process.env.KONES_PASSWORD || '';

// Target cities for QUANTUM (Pinuy-Binuy focus areas)
const TARGET_CITIES = [
  // Gush Dan
  'תל אביב', 'רמת גן', 'גבעתיים', 'בני ברק', 'בת ים', 'חולון', 'אור יהודה', 'קרית אונו', 'יהוד',
  // Sharon
  'הרצליה', 'רעננה', 'כפר סבא', 'הוד השרון', 'רמת השרון', 'נתניה', 'רמה"ש',
  // Center
  'פתח תקווה', 'ראש העין', 'לוד', 'רמלה', 'נס ציונה', 'ראשון לציון', 'רחובות',
  // Jerusalem Area
  'ירושלים', 'מבשרת ציון', 'בית שמש', 'מעלה אדומים',
  // Haifa Area
  'חיפה', 'קרית ים', 'קרית מוצקין', 'קרית ביאליק', 'קרית אתא', 'נשר'
];

// Property types of interest for urban renewal
const RELEVANT_PROPERTY_TYPES = ['דירה', 'דירת גן', 'פנטהאוז', 'דופלקס', 'חד משפחתי', 'דו משפחתי'];

class KonesIsraelService {
  constructor() {
    this.sessionCookie = null;
    this.lastFetch = null;
    this.cachedListings = [];
    this.cacheExpiry = 6 * 60 * 60 * 1000; // 6 hours cache
  }

  /**
   * Login to KonesIsrael website
   */
  async login() {
    if (!KONES_EMAIL || !KONES_PASSWORD) {
      logger.warn('KonesIsrael credentials not configured');
      return false;
    }

    try {
      // First get the login page to extract any CSRF tokens
      const loginPageResponse = await axios.get('https://konesisrael.co.il/אזור-אישי/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // Perform login
      const loginResponse = await axios.post('https://konesisrael.co.il/wp-login.php', 
        new URLSearchParams({
          'log': KONES_EMAIL,
          'pwd': KONES_PASSWORD,
          'wp-submit': 'התחבר',
          'redirect_to': 'https://konesisrael.co.il/אזור-אישי/',
          'testcookie': '1'
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': loginPageResponse.headers['set-cookie']?.join('; ') || ''
          },
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400
        }
      );

      // Extract session cookies
      const cookies = loginResponse.headers['set-cookie'];
      if (cookies) {
        this.sessionCookie = cookies.join('; ');
        logger.info('KonesIsrael login successful');
        return true;
      }

      logger.warn('KonesIsrael login may have failed - no session cookie');
      return false;

    } catch (error) {
      logger.error('KonesIsrael login error:', { error: error.message });
      return false;
    }
  }

  /**
   * Fetch receivership real estate listings
   * The public page shows basic info; logged-in users see full details
   */
  async fetchReceivershipListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.cachedListings.length > 0 && 
        this.lastFetch && (Date.now() - this.lastFetch < this.cacheExpiry)) {
      logger.info('Using cached KonesIsrael listings', { count: this.cachedListings.length });
      return this.cachedListings;
    }

    try {
      logger.info('Fetching KonesIsrael receivership listings...');
      
      const response = await axios.get('https://konesisrael.co.il/%D7%A0%D7%93%D7%9C%D7%9F-%D7%9E%D7%9B%D7%95%D7%A0%D7%A1-%D7%A0%D7%9B%D7%A1%D7%99%D7%9D/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': this.sessionCookie || ''
        },
        timeout: 30000
      });

      const $ = cheerio.load(response.data);
      const listings = [];

      // Parse the table rows
      $('table tbody tr').each((index, element) => {
        try {
          const row = $(element);
          const cells = row.find('td');
          
          if (cells.length >= 10) {
            const listing = {
              date: $(cells[0]).text().trim(),
              propertyType: $(cells[2]).text().trim(),
              area: $(cells[3]).text().trim(),
              city: $(cells[4]).text().trim(),
              address: $(cells[5]).text().trim(),
              submissionDate: $(cells[6]).text().trim(),
              daysRemaining: $(cells[7]).text().trim(),
              gushHelka: $(cells[8]).text().trim(),
              contactName: $(cells[9]).text().trim(),
              contactEmail: $(cells[10])?.text()?.trim() || '',
              contactPhone: $(cells[11])?.text()?.trim() || '',
              details: $(cells[13])?.text()?.trim() || '',
              source: 'konesisrael.co.il',
              type: 'receivership',
              fetchedAt: new Date().toISOString()
            };

            // Filter for relevant properties
            if (this.isRelevantListing(listing)) {
              listings.push(listing);
            }
          }
        } catch (e) {
          // Skip malformed rows
        }
      });

      this.cachedListings = listings;
      this.lastFetch = Date.now();
      
      logger.info('KonesIsrael listings fetched', { 
        total: listings.length,
        targetCities: listings.filter(l => TARGET_CITIES.includes(l.city)).length
      });

      return listings;

    } catch (error) {
      logger.error('Error fetching KonesIsrael listings:', { error: error.message });
      return this.cachedListings; // Return cached data on error
    }
  }

  /**
   * Check if a listing is relevant for our urban renewal focus
   */
  isRelevantListing(listing) {
    // Check if in target cities
    const inTargetCity = TARGET_CITIES.some(city => 
      listing.city?.includes(city) || listing.address?.includes(city)
    );

    // Check if relevant property type
    const relevantType = RELEVANT_PROPERTY_TYPES.some(type => 
      listing.propertyType?.includes(type)
    );

    return inTargetCity || relevantType;
  }

  /**
   * Search for receivership properties in a specific city
   */
  async searchByCity(city) {
    const allListings = await this.fetchReceivershipListings();
    return allListings.filter(listing => 
      listing.city?.includes(city) || 
      listing.address?.includes(city)
    );
  }

  /**
   * Search for receivership properties by address/street
   */
  async searchByAddress(address) {
    const allListings = await this.fetchReceivershipListings();
    const searchTerms = address.toLowerCase().split(/\s+/);
    
    return allListings.filter(listing => {
      const listingAddress = (listing.address || '').toLowerCase();
      const listingCity = (listing.city || '').toLowerCase();
      const combined = `${listingAddress} ${listingCity}`;
      
      return searchTerms.some(term => combined.includes(term));
    });
  }

  /**
   * Search by gush/helka (block/parcel)
   */
  async searchByGushHelka(gush, helka) {
    const allListings = await this.fetchReceivershipListings();
    const searchPattern = `גוש ${gush}`;
    
    return allListings.filter(listing => {
      const gushHelka = (listing.gushHelka || '').toLowerCase();
      return gushHelka.includes(searchPattern.toLowerCase()) &&
             (!helka || gushHelka.includes(`חלקה ${helka}`));
    });
  }

  /**
   * Cross-reference with QUANTUM complexes to identify receivership overlap
   * This is the key integration point for SSI enhancement
   */
  async findReceivershipInComplex(complex) {
    if (!complex?.city || !complex?.address) {
      return { found: false, matches: [] };
    }

    const matches = await this.searchByAddress(`${complex.address} ${complex.city}`);
    
    // Also try gush/helka if available
    if (complex.gush && matches.length === 0) {
      const gushMatches = await this.searchByGushHelka(complex.gush, complex.helka);
      matches.push(...gushMatches);
    }

    return {
      found: matches.length > 0,
      matches: matches,
      count: matches.length,
      isReceivership: matches.length > 0,
      receivershipScore: Math.min(matches.length * 10, 30), // Max 30 (SSI weight for receivership)
      details: matches.map(m => ({
        type: m.propertyType,
        address: m.address,
        attorney: m.contactName,
        phone: m.contactPhone,
        deadline: m.submissionDate
      }))
    };
  }

  /**
   * Get statistics about current receivership listings
   */
  async getStatistics() {
    const listings = await this.fetchReceivershipListings();
    
    const stats = {
      total: listings.length,
      byCity: {},
      byType: {},
      byArea: {},
      inTargetCities: 0,
      recentListings: listings.filter(l => {
        const days = parseInt(l.daysRemaining) || 999;
        return days <= 14; // Within 2 weeks deadline
      }).length
    };

    listings.forEach(listing => {
      // Count by city
      stats.byCity[listing.city] = (stats.byCity[listing.city] || 0) + 1;
      
      // Count by type
      stats.byType[listing.propertyType] = (stats.byType[listing.propertyType] || 0) + 1;
      
      // Count by area
      stats.byArea[listing.area] = (stats.byArea[listing.area] || 0) + 1;

      // Count target cities
      if (TARGET_CITIES.includes(listing.city)) {
        stats.inTargetCities++;
      }
    });

    return stats;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      service: 'konesIsrael',
      type: 'receivership',
      configured: !!(KONES_EMAIL && KONES_PASSWORD),
      authenticated: !!this.sessionCookie,
      cacheStatus: {
        hasCache: this.cachedListings.length > 0,
        cacheAge: this.lastFetch ? Date.now() - this.lastFetch : null,
        listingCount: this.cachedListings.length
      },
      ssiWeight: 30,
      description: 'KonesIsrael.co.il - Receivership real estate database'
    };
  }
}

// Singleton instance
const konesIsraelService = new KonesIsraelService();

module.exports = konesIsraelService;
