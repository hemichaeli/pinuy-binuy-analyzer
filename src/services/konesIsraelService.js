/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Source: konesisrael.co.il
 * 
 * ARCHITECTURE: Database-first with optional live scraping
 * - Primary: Reads from kones_listings table in PostgreSQL
 * - Secondary: Attempts live scraping (blocked by SiteGround CAPTCHA)
 * - Import: Manual data import via /api/kones/import endpoint
 * 
 * The site uses bot protection (SiteGround CAPTCHA) which blocks automated
 * HTTP requests. Data is imported manually or via Perplexity AI searches.
 */

const { logger } = require('./logger');

// Lazy-load to avoid undici/File issues on Node 18
let _axios = null;
let _cheerio = null;

function getAxios() {
  if (!_axios) _axios = require('axios');
  return _axios;
}

function getCheerio() {
  if (!_cheerio) {
    if (typeof globalThis.File === 'undefined') {
      try {
        const { File } = require('node:buffer');
        globalThis.File = File;
      } catch (e) {
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
    
    this.credentials = {
      email: process.env.KONES_EMAIL || '',
      password: process.env.KONES_PASSWORD || ''
    };
    
    this.propertyTypes = {
      'דירה': 'apartment', 'דירת גן': 'garden_apartment',
      'פנטהאוז': 'penthouse', 'דופלקס': 'duplex',
      'בית פרטי': 'house', 'חד משפחתי': 'single_family',
      'דו משפחתי': 'duplex_house', 'מגרש': 'land',
      'חנות': 'store', 'מבנה מסחרי': 'commercial', 'יחידה': 'unit'
    };
    
    this.regions = {
      'מרכז': 'center', 'דרום': 'south', 'צפון': 'north',
      'ירושלים': 'jerusalem', 'יהודה ושומרון': 'judea_samaria'
    };
    
    this.listingsCache = { data: null, timestamp: null, ttl: 4 * 60 * 60 * 1000 };
    this.isLoggedIn = false;
    this._pool = null;
  }

  _getPool() {
    if (!this._pool) {
      this._pool = require('../db/pool');
    }
    return this._pool;
  }

  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  /**
   * Primary data source: PostgreSQL kones_listings table
   */
  async fetchFromDatabase() {
    try {
      const pool = this._getPool();
      
      // Ensure table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kones_listings (
          id SERIAL PRIMARY KEY,
          source VARCHAR(50) DEFAULT 'konesisrael',
          property_type VARCHAR(100),
          property_type_en VARCHAR(50),
          region VARCHAR(100),
          region_en VARCHAR(50),
          city VARCHAR(200),
          address TEXT,
          submission_deadline DATE,
          gush_helka VARCHAR(200),
          gush INTEGER,
          helka INTEGER,
          tat_helka INTEGER,
          contact_person VARCHAR(200),
          email VARCHAR(200),
          phone VARCHAR(50),
          url TEXT,
          is_receivership BOOLEAN DEFAULT true,
          ssi_contribution INTEGER DEFAULT 30,
          raw_data JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          is_active BOOLEAN DEFAULT true
        )
      `);

      const result = await pool.query(`
        SELECT * FROM kones_listings 
        WHERE is_active = true 
        ORDER BY created_at DESC
      `);

      return result.rows.map(row => ({
        id: `kones_db_${row.id}`,
        dbId: row.id,
        source: row.source || 'konesisrael',
        propertyType: row.property_type,
        propertyTypeEn: row.property_type_en || this.propertyTypes[row.property_type] || 'other',
        region: row.region,
        regionEn: row.region_en || this.regions[row.region] || 'unknown',
        city: row.city,
        address: row.address,
        submissionDeadline: row.submission_deadline ? row.submission_deadline.toISOString().split('T')[0] : null,
        gushHelka: row.gush_helka,
        gush: row.gush,
        helka: row.helka,
        tatHelka: row.tat_helka,
        contactPerson: row.contact_person,
        email: row.email,
        phone: row.phone,
        url: row.url,
        isReceivership: true,
        ssiContribution: row.ssi_contribution || 30,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      logger.error(`KonesIsrael DB fetch error: ${error.message}`);
      return [];
    }
  }

  /**
   * Import listings into database
   */
  async importListings(listings) {
    const pool = this._getPool();
    let imported = 0;
    let skipped = 0;
    
    for (const listing of listings) {
      try {
        // Check for duplicates by city+address+property_type
        const existing = await pool.query(`
          SELECT id FROM kones_listings 
          WHERE city = $1 AND address = $2 AND property_type = $3 AND is_active = true
        `, [listing.city || '', listing.address || '', listing.propertyType || listing.property_type || '']);
        
        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Parse gush/helka
        const gushHelka = listing.gushHelka || listing.gush_helka || '';
        let gush = listing.gush || null;
        let helka = listing.helka || null;
        let tatHelka = listing.tatHelka || listing.tat_helka || null;
        
        if (gushHelka && !gush) {
          const parsed = this.parseGushHelka(gushHelka);
          gush = parsed.gush;
          helka = parsed.helka;
          tatHelka = parsed.tatHelka;
        }

        await pool.query(`
          INSERT INTO kones_listings 
            (source, property_type, property_type_en, region, region_en,
             city, address, submission_deadline, gush_helka, gush, helka, tat_helka,
             contact_person, email, phone, url, ssi_contribution, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `, [
          listing.source || 'konesisrael',
          listing.propertyType || listing.property_type || null,
          listing.propertyTypeEn || listing.property_type_en || this.propertyTypes[listing.propertyType] || 'other',
          listing.region || null,
          listing.regionEn || listing.region_en || this.regions[listing.region] || null,
          listing.city || null,
          listing.address || null,
          listing.submissionDeadline || listing.submission_deadline || null,
          gushHelka || null,
          gush, helka, tatHelka,
          listing.contactPerson || listing.contact_person || null,
          listing.email || null,
          listing.phone || null,
          listing.url || null,
          listing.ssiContribution || listing.ssi_contribution || 30,
          JSON.stringify(listing)
        ]);
        
        imported++;
      } catch (err) {
        logger.warn(`KonesIsrael import error for ${listing.city}/${listing.address}: ${err.message}`);
      }
    }
    
    // Clear cache so next fetch picks up new data
    this.listingsCache.data = null;
    this.listingsCache.timestamp = null;
    
    return { imported, skipped, total: listings.length };
  }

  /**
   * Main fetch method - DB first, then try live scraping as fallback
   */
  async fetchListings(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this.listingsCache.data && 
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      return this.listingsCache.data;
    }

    // Primary: Database
    const dbListings = await this.fetchFromDatabase();
    
    if (dbListings.length > 0) {
      this.listingsCache.data = dbListings;
      this.listingsCache.timestamp = Date.now();
      logger.info(`KonesIsrael: ${dbListings.length} listings from database`);
      return dbListings;
    }

    // Secondary: Try live scraping (may fail due to CAPTCHA)
    try {
      const scraped = await this._tryScraping();
      if (scraped.length > 0) {
        // Store in DB for next time
        await this.importListings(scraped);
        this.listingsCache.data = scraped;
        this.listingsCache.timestamp = Date.now();
        return scraped;
      }
    } catch (e) {
      logger.info(`KonesIsrael: Live scraping unavailable (${e.message}) - site uses bot protection`);
    }

    // Return empty with informative message
    this.listingsCache.data = [];
    this.listingsCache.timestamp = Date.now();
    return [];
  }

  /**
   * Attempt live scraping (usually blocked by SiteGround CAPTCHA)
   */
  async _tryScraping() {
    const axios = getAxios();
    const client = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8'
      },
      maxRedirects: 5
    });
    
    const response = await client.get(this.realEstateUrl);
    const html = response.data;
    
    // Detect CAPTCHA/bot protection
    if (html.includes('sgcaptcha') || html.includes('challenge-platform') || 
        html.includes('cf-browser-verification') || html.length < 1000) {
      throw new Error('Bot protection detected (SiteGround CAPTCHA)');
    }
    
    return this.parseListingsPage(html);
  }

  async fetchWithLogin(forceRefresh = false) {
    return await this.fetchListings(forceRefresh);
  }

  parseListingsPage(html) {
    const cheerio = getCheerio();
    const $ = cheerio.load(html);
    const listings = [];
    
    const tableSelectors = [
      'table.tablepress tbody tr', '#tablepress-1 tbody tr',
      '#tablepress-2 tbody tr', 'table tbody tr', '.entry-content table tr'
    ];
    
    let rows = $();
    for (const selector of tableSelectors) {
      rows = $(selector);
      if (rows.length > 0) break;
    }
    
    rows.each((index, row) => {
      try {
        const cells = $(row).find('td');
        if (cells.length < 3) return;
        
        const firstCellText = $(cells[0]).text().trim();
        if (['סוג נכס', 'סוג', '#'].includes(firstCellText)) return;
        
        const listing = {
          id: `kones_${Date.now()}_${index}`,
          source: 'konesisrael',
          propertyType: $(cells[0]).text().trim() || null,
          propertyTypeEn: this.propertyTypes[$(cells[0]).text().trim()] || 'other',
          isReceivership: true, ssiContribution: 30
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
    const listings = await this.fetchListings();
    return listings.filter(l => l.city && l.city.includes(city));
  }

  async searchByRegion(region) {
    const listings = await this.fetchListings();
    return listings.filter(l => l.region === region || l.regionEn === region);
  }

  async searchByGushHelka(gush, helka = null) {
    const listings = await this.fetchListings();
    return listings.filter(l => {
      if (l.gush !== gush) return false;
      if (helka && l.helka !== helka) return false;
      return true;
    });
  }

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

  async matchWithComplexes(complexes) {
    const listings = await this.fetchListings();
    if (listings.length === 0) return [];
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
    const listings = await this.fetchListings();
    
    const stats = {
      total: listings.length,
      byPropertyType: {}, byRegion: {}, byCity: {},
      upcomingDeadlines: [], urgentDeadlines: []
    };
    
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    for (const listing of listings) {
      stats.byPropertyType[listing.propertyType || 'אחר'] = 
        (stats.byPropertyType[listing.propertyType || 'אחר'] || 0) + 1;
      stats.byRegion[listing.region || 'לא ידוע'] = 
        (stats.byRegion[listing.region || 'לא ידוע'] || 0) + 1;
      stats.byCity[listing.city || 'לא ידוע'] = 
        (stats.byCity[listing.city || 'לא ידוע'] || 0) + 1;
      
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
    let dbCount = 0;
    try {
      const pool = this._getPool();
      const result = await pool.query('SELECT COUNT(*) FROM kones_listings WHERE is_active = true');
      dbCount = parseInt(result.rows[0].count);
    } catch (e) {
      // Table may not exist yet
    }
    
    return {
      status: 'ready',
      method: 'database_first',
      scraping: 'blocked_by_captcha',
      note: 'konesisrael.co.il uses SiteGround CAPTCHA - use /api/kones/import for data',
      configured: this.isConfigured(),
      authenticated: this.isLoggedIn,
      source: 'konesisrael.co.il',
      dbListings: dbCount,
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
