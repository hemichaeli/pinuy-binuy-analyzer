/**
 * Government Data Service - Real Israeli Government APIs
 * Integrates with data.gov.il and other public sources
 * Version: 1.0.0
 * 
 * Data Sources:
 * - רשם המשכונות (Liens Registry) - 8M+ records
 * - רשם הירושות (Inheritance Registry) - 1.2M+ records
 * - Bank of Israel mortgage rates
 * - News RSS for receivership
 */

const axios = require('axios');

class GovernmentDataService {
  constructor() {
    this.dataGovBaseUrl = 'https://data.gov.il/api/3/action';
    
    // Resource IDs from data.gov.il
    this.resources = {
      mashkonot: 'e7266a9c-fed6-40e4-a28e-8cddc9f44842',  // רשם המשכונות
      yerusha: '7691b4a2-fe1d-44ec-9f1b-9f2f0a15381b',    // רשם הירושות
      boiFixedRate: '8900966f-b1e0-4fcf-942b-0d31cb6a4ca9', // ריבית קבועה
      boiCpiLinked: '96ba107d-cc15-41cf-b223-5bb592e14666'  // ריבית צמודה
    };
    
    // News RSS sources
    this.newsSources = {
      globes: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585',
      calcalist: 'https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml',
      themarker: 'https://www.themarker.com/cmlink/1.145',
      bizportal: 'https://www.bizportal.co.il/rss/realestate'
    };
  }

  /**
   * Query data.gov.il datastore
   */
  async queryDatastore(resourceId, filters = {}, limit = 100, offset = 0) {
    try {
      const params = {
        resource_id: resourceId,
        limit,
        offset
      };
      
      if (Object.keys(filters).length > 0) {
        params.filters = JSON.stringify(filters);
      }
      
      const response = await axios.get(`${this.dataGovBaseUrl}/datastore_search`, {
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
   * Get liens (משכונות) statistics
   */
  async getLiensStatistics() {
    try {
      const result = await this.queryDatastore(
        this.resources.mashkonot,
        {},
        1000,
        0
      );
      
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
   * Get inheritance requests by district
   */
  async getInheritanceByDistrict(district = null) {
    try {
      const filters = district ? { 'מחוז': district } : {};
      const result = await this.queryDatastore(
        this.resources.yerusha,
        filters,
        1000,
        0
      );
      
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
   * Get recent inheritance activity
   */
  async getRecentInheritanceActivity(limit = 100) {
    try {
      const result = await this.queryDatastore(
        this.resources.yerusha,
        {},
        limit,
        0
      );
      
      if (result.success) {
        const completed = result.records.filter(r => 
          r['החלטת רשם'] && r['החלטת רשם'].includes('מתן צו')
        );
        
        return {
          success: true,
          source: 'data.gov.il - רשם הירושות',
          recentCompletedOrders: completed.length,
          totalFetched: result.records.length,
          sampleData: completed.slice(0, 10)
        };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Search news for receivership/foreclosure (כינוס נכסים)
   */
  async searchReceivershipNews() {
    const keywords = [
      'כינוס נכסים',
      'כונס נכסים', 
      'מכירה בהוצאה לפועל',
      'מימוש משכנתא',
      'דירות מכונס'
    ];
    
    const results = [];
    
    for (const [source, url] of Object.entries(this.newsSources)) {
      try {
        const response = await axios.get(url, { 
          timeout: 10000,
          headers: { 'User-Agent': 'QUANTUM-Bot/1.0' }
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
      sourcesChecked: Object.keys(this.newsSources).length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get BOI mortgage rate data URLs
   */
  getBOIMortgageDataUrls() {
    return {
      fixedRate: `https://data.gov.il/dataset/374/resource/${this.resources.boiFixedRate}`,
      cpiLinked: `https://data.gov.il/dataset/371/resource/${this.resources.boiCpiLinked}`,
      note: 'XLS files - download and parse for rate data'
    };
  }

  /**
   * Get comprehensive data summary
   */
  async getDataSummary() {
    const [liensStats, inheritanceStats, newsResults] = await Promise.all([
      this.getLiensStatistics(),
      this.getInheritanceByDistrict(),
      this.searchReceivershipNews()
    ]);
    
    return {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      sources: {
        liens: {
          name: 'רשם המשכונות',
          status: liensStats.success ? 'active' : 'error',
          totalRecords: liensStats.totalRecords || 0
        },
        inheritance: {
          name: 'רשם הירושות', 
          status: inheritanceStats.success ? 'active' : 'error',
          totalRecords: inheritanceStats.totalRecords || 0,
          byDistrict: inheritanceStats.byDistrict || {}
        },
        news: {
          name: 'חדשות כינוס נכסים',
          status: 'active',
          sourcesChecked: newsResults.sourcesChecked,
          resultsFound: newsResults.newsResults?.length || 0
        },
        mortgageRates: {
          name: 'ריביות משכנתאות בנק ישראל',
          status: 'available',
          urls: this.getBOIMortgageDataUrls()
        }
      }
    };
  }
}

module.exports = GovernmentDataService;
