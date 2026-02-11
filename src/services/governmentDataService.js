/**
 * Government Data Service - Real Israeli Government APIs
 * Version: 2.0.0
 * 
 * Data Sources:
 * - רשם המשכונות (Liens Registry) - 8M+ records
 * - רשם הירושות (Inheritance Registry) - 1.2M+ records
 * - Bank of Israel mortgage rates
 * - News RSS for receivership monitoring
 * 
 * IMPORTANT LIMITATION:
 * Government datasets contain ONLY metadata (dates, status, IDs)
 * NOT searchable by property address or owner name
 * Data is for aggregate/statistical analysis, not individual case lookup
 */

const axios = require('axios');

class GovernmentDataService {
  constructor() {
    this.DATA_GOV_BASE = 'https://data.gov.il/api/3/action';
    this.INSOLVENCY_BASE = 'https://insolvency.justice.gov.il';
    
    // Resource IDs from data.gov.il
    this.RESOURCE_IDS = {
      mashkonot: 'e7266a9c-fed6-40e4-a28e-8cddc9f44842',  // רשם המשכונות - 8M+ records
      yerusha: '7691b4a2-fe1d-44ec-9f1b-9f2f0a15381b',    // רשם הירושות - 1.2M+ records
      boiFixedRate: '8900966f-b1e0-4fcf-942b-0d31cb6a4ca9', // ריבית קבועה
      boiCpiLinked: '96ba107d-cc15-41cf-b223-5bb592e14666'  // ריבית צמודה
    };
    
    // News RSS sources for receivership monitoring
    this.NEWS_SOURCES = {
      globes: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585',
      calcalist: 'https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml',
      themarker: 'https://www.themarker.com/cmlink/1.145',
      bizportal: 'https://www.bizportal.co.il/rss/realestate'
    };
    
    this.cache = new Map();
    this.CACHE_TTL = 3600000; // 1 hour
  }

  /**
   * Query data.gov.il datastore API
   */
  async queryDatastore(resourceId, options = {}) {
    const { limit = 100, offset = 0, filters = {}, q = null } = options;
    
    try {
      const params = {
        resource_id: resourceId,
        limit,
        offset
      };
      
      if (Object.keys(filters).length > 0) {
        params.filters = JSON.stringify(filters);
      }
      
      if (q) {
        params.q = q;
      }
      
      const response = await axios.get(`${this.DATA_GOV_BASE}/datastore_search`, {
        params,
        timeout: 30000
      });
      
      if (response.data.success) {
        return {
          success: true,
          records: response.data.result.records,
          total: response.data.result.total,
          fields: response.data.result.fields
        };
      }
      return { success: false, error: 'API returned unsuccessful' };
    } catch (error) {
      console.error(`Error querying datastore ${resourceId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search data.gov.il with full-text search
   */
  async searchDataGovIL(resourceId, options = {}) {
    const cacheKey = `search_${resourceId}_${JSON.stringify(options)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    
    const result = await this.queryDatastore(resourceId, options);
    
    if (result.success) {
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    }
    
    return result;
  }

  /**
   * Search liens registry (רשם המשכונות)
   * NOTE: Cannot search by owner/property - only by registration metadata
   */
  async searchLiensRegistry(searchTerm, options = {}) {
    const result = await this.searchDataGovIL(this.RESOURCE_IDS.mashkonot, {
      q: searchTerm,
      limit: options.limit || 50
    });
    
    return {
      success: result.success,
      source: 'data.gov.il - רשם המשכונות',
      limitation: 'Dataset contains registration metadata only, not searchable by owner/property',
      searchTerm,
      totalInDatabase: result.total || 0,
      resultsReturned: result.records?.length || 0,
      records: result.records || [],
      fields: result.fields?.map(f => f.id) || []
    };
  }

  /**
   * Search inheritance registry (רשם הירושות)
   * NOTE: Cannot search by deceased name/property - only by request metadata
   */
  async searchInheritanceRegistry(searchTerm, options = {}) {
    const result = await this.searchDataGovIL(this.RESOURCE_IDS.yerusha, {
      q: searchTerm,
      limit: options.limit || 30
    });
    
    return {
      success: result.success,
      source: 'data.gov.il - רשם הירושות',
      limitation: 'Dataset contains request metadata only, not searchable by deceased name/property',
      searchTerm,
      totalInDatabase: result.total || 0,
      resultsReturned: result.records?.length || 0,
      records: result.records || [],
      fields: result.fields?.map(f => f.id) || []
    };
  }

  /**
   * Search bankruptcy registry
   * NOTE: Insolvency website has TLS issues - using news monitoring as fallback
   */
  async searchBankruptcyRegistry(searchTerm, type = 'individual') {
    // The insolvency.justice.gov.il site has TLS handshake issues
    // Return news-based monitoring instead
    const newsResults = await this.searchReceivershipNews(searchTerm);
    
    return {
      success: true,
      source: 'News RSS monitoring (insolvency.justice.gov.il has TLS issues)',
      limitation: 'Direct API access unavailable - monitoring via news sources',
      searchTerm,
      type,
      newsMonitoring: newsResults,
      recommendation: 'For official bankruptcy data, visit https://insolvency.justice.gov.il directly'
    };
  }

  /**
   * Get liens statistics
   */
  async getLiensStatistics() {
    try {
      const result = await this.queryDatastore(this.RESOURCE_IDS.mashkonot, { limit: 1000 });
      
      if (result.success) {
        const statusCounts = {};
        for (const record of result.records) {
          const status = record['סטטוס רישום'] || 'unknown';
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
        
        return {
          success: true,
          source: 'data.gov.il - רשם המשכונות',
          lastUpdated: new Date().toISOString(),
          totalRecords: result.total,
          sampleStatistics: statusCounts,
          fields: result.fields.map(f => f.id)
        };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get inheritance statistics by district
   */
  async getInheritanceByDistrict(district = null) {
    try {
      const filters = district ? { 'מחוז': district } : {};
      const result = await this.queryDatastore(this.RESOURCE_IDS.yerusha, { filters, limit: 1000 });
      
      if (result.success) {
        const districtCounts = {};
        for (const record of result.records) {
          const dist = (record['מחוז'] || 'unknown').trim();
          districtCounts[dist] = (districtCounts[dist] || 0) + 1;
        }
        
        return {
          success: true,
          source: 'data.gov.il - רשם הירושות',
          lastUpdated: new Date().toISOString(),
          totalRecords: result.total,
          byDistrict: districtCounts,
          filter: district || 'all'
        };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Search news RSS for receivership announcements
   */
  async searchReceivershipNews(searchTerm = null) {
    const keywords = [
      'כינוס נכסים',
      'כונס נכסים',
      'מכירה בהוצאה לפועל',
      'מימוש משכנתא',
      'דירות מכונס',
      'פשיטת רגל',
      'חדלות פירעון'
    ];
    
    if (searchTerm) {
      keywords.push(searchTerm);
    }
    
    const results = [];
    
    for (const [source, url] of Object.entries(this.NEWS_SOURCES)) {
      try {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': 'QUANTUM-Bot/2.0' }
        });
        
        const content = response.data;
        
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            results.push({
              source,
              keyword,
              found: true,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        console.log(`News source ${source} error:`, error.message);
      }
    }
    
    return {
      success: true,
      newsResults: results,
      sourcesChecked: Object.keys(this.NEWS_SOURCES).length,
      keywords: keywords,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Monitor receivership announcements with filters
   */
  async monitorReceivershipAnnouncements(options = {}) {
    const { city, searchTerm, dateFrom, dateTo } = options;
    
    const newsResults = await this.searchReceivershipNews(searchTerm);
    
    return {
      success: true,
      source: 'News RSS Monitoring',
      filters: { city, searchTerm, dateFrom, dateTo },
      ...newsResults,
      note: 'For legal receivership data, official court records require direct access'
    };
  }

  /**
   * Comprehensive government check for an entity
   */
  async comprehensiveGovernmentCheck(entity) {
    const { name, idNumber, companyNumber, address, city } = entity;
    
    const results = {
      entity,
      timestamp: new Date().toISOString(),
      checks: {}
    };
    
    // Check liens registry
    try {
      const liensResult = await this.searchLiensRegistry(name, { limit: 10 });
      results.checks.liens = {
        source: 'רשם המשכונות',
        status: liensResult.success ? 'checked' : 'error',
        totalInDatabase: liensResult.totalInDatabase,
        note: liensResult.limitation
      };
    } catch (e) {
      results.checks.liens = { status: 'error', error: e.message };
    }
    
    // Check inheritance registry
    try {
      const inheritanceResult = await this.searchInheritanceRegistry(name, { limit: 10 });
      results.checks.inheritance = {
        source: 'רשם הירושות',
        status: inheritanceResult.success ? 'checked' : 'error',
        totalInDatabase: inheritanceResult.totalInDatabase,
        note: inheritanceResult.limitation
      };
    } catch (e) {
      results.checks.inheritance = { status: 'error', error: e.message };
    }
    
    // Check news for receivership
    try {
      const newsResult = await this.searchReceivershipNews(name);
      results.checks.receivershipNews = {
        source: 'News RSS',
        status: 'checked',
        mentions: newsResult.newsResults.length
      };
    } catch (e) {
      results.checks.receivershipNews = { status: 'error', error: e.message };
    }
    
    results.summary = {
      checksPerformed: Object.keys(results.checks).length,
      limitations: [
        'Government databases contain metadata only, not searchable by owner/property',
        'Insolvency database has TLS access issues',
        'For official records, direct government portal access is required'
      ]
    };
    
    return results;
  }

  /**
   * Test connectivity to all government data sources
   */
  async testGovernmentConnectivity() {
    const results = {};
    
    // Test data.gov.il
    try {
      const response = await axios.get(`${this.DATA_GOV_BASE}/package_list`, { timeout: 10000 });
      results.dataGovIL = {
        status: response.status === 200 ? 'connected' : 'error',
        url: this.DATA_GOV_BASE,
        datasetsAvailable: response.data?.result?.length || 0
      };
    } catch (e) {
      results.dataGovIL = { status: 'error', error: e.message };
    }
    
    // Test liens registry
    try {
      const liens = await this.queryDatastore(this.RESOURCE_IDS.mashkonot, { limit: 1 });
      results.liensRegistry = {
        status: liens.success ? 'connected' : 'error',
        totalRecords: liens.total || 0,
        resourceId: this.RESOURCE_IDS.mashkonot
      };
    } catch (e) {
      results.liensRegistry = { status: 'error', error: e.message };
    }
    
    // Test inheritance registry
    try {
      const inheritance = await this.queryDatastore(this.RESOURCE_IDS.yerusha, { limit: 1 });
      results.inheritanceRegistry = {
        status: inheritance.success ? 'connected' : 'error',
        totalRecords: inheritance.total || 0,
        resourceId: this.RESOURCE_IDS.yerusha
      };
    } catch (e) {
      results.inheritanceRegistry = { status: 'error', error: e.message };
    }
    
    // Test insolvency (known to have TLS issues)
    try {
      await axios.get(this.INSOLVENCY_BASE, { timeout: 5000 });
      results.insolvency = { status: 'connected' };
    } catch (e) {
      results.insolvency = {
        status: 'error',
        error: 'TLS handshake failure',
        note: 'Known issue - use browser access or news monitoring'
      };
    }
    
    // Test news sources
    let newsWorking = 0;
    for (const [name, url] of Object.entries(this.NEWS_SOURCES)) {
      try {
        await axios.get(url, { timeout: 5000 });
        newsWorking++;
      } catch (e) {}
    }
    results.newsRSS = {
      status: newsWorking > 0 ? 'connected' : 'error',
      sourcesAvailable: newsWorking,
      sourcesTotal: Object.keys(this.NEWS_SOURCES).length
    };
    
    return results;
  }

  /**
   * Get available datasets from data.gov.il
   */
  async getAvailableDatasets() {
    try {
      const response = await axios.get(`${this.DATA_GOV_BASE}/package_list`, { timeout: 15000 });
      if (response.data.success) {
        return response.data.result || [];
      }
      return [];
    } catch (e) {
      console.error('Error fetching datasets:', e.message);
      return [];
    }
  }

  /**
   * Get BOI mortgage rate data URLs
   */
  getBOIMortgageDataUrls() {
    return {
      fixedRate: `https://data.gov.il/dataset/374/resource/${this.RESOURCE_IDS.boiFixedRate}`,
      cpiLinked: `https://data.gov.il/dataset/371/resource/${this.RESOURCE_IDS.boiCpiLinked}`,
      note: 'XLS files - download and parse for rate data'
    };
  }

  /**
   * Get comprehensive data summary
   */
  async getDataSummary() {
    const connectivity = await this.testGovernmentConnectivity();
    
    return {
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      connectivity,
      sources: {
        liens: {
          name: 'רשם המשכונות',
          resourceId: this.RESOURCE_IDS.mashkonot,
          status: connectivity.liensRegistry?.status || 'unknown',
          totalRecords: connectivity.liensRegistry?.totalRecords || 0
        },
        inheritance: {
          name: 'רשם הירושות',
          resourceId: this.RESOURCE_IDS.yerusha,
          status: connectivity.inheritanceRegistry?.status || 'unknown',
          totalRecords: connectivity.inheritanceRegistry?.totalRecords || 0
        },
        insolvency: {
          name: 'חדלות פירעון',
          status: connectivity.insolvency?.status || 'error',
          note: 'TLS issues - use browser or news monitoring'
        },
        news: {
          name: 'חדשות כינוס נכסים',
          status: connectivity.newsRSS?.status || 'unknown',
          sourcesAvailable: connectivity.newsRSS?.sourcesAvailable || 0
        },
        mortgageRates: {
          name: 'ריביות משכנתאות בנק ישראל',
          status: 'available',
          urls: this.getBOIMortgageDataUrls()
        }
      },
      limitations: [
        'Government datasets contain registration metadata only',
        'Cannot search by owner name or property address',
        'Data designed for statistical analysis, not individual case lookup',
        'For specific property/owner lookups, use Perplexity AI search'
      ]
    };
  }
}

// Export singleton instance
const governmentDataService = new GovernmentDataService();
module.exports = governmentDataService;
