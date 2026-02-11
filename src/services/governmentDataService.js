/**
 * Government Data Service - Real Israeli Government APIs
 * Integrates with data.gov.il and other public sources
 * Version: 2.0.0
 * 
 * Data Sources:
 * - רשם המשכונות (Liens Registry) - 8M+ records
 * - רשם הירושות (Inheritance Registry) - 1.2M+ records  
 * - חדלות פירעון (Insolvency) - bankruptcy data
 * - Bank of Israel mortgage rates
 * - News RSS for receivership
 */

const axios = require('axios');

// Base URLs
const DATA_GOV_BASE = 'https://data.gov.il/api/3/action';
const INSOLVENCY_BASE = 'https://insolvency.justice.gov.il';

// Resource IDs from data.gov.il
const RESOURCE_IDS = {
  mashkonot: 'e7266a9c-fed6-40e4-a28e-8cddc9f44842',     // רשם המשכונות - 8M+ records
  yerusha: '7691b4a2-fe1d-44ec-9f1b-9f2f0a15381b',       // רשם הירושות - 1.2M+ records
  boiFixedRate: '8900966f-b1e0-4fcf-942b-0d31cb6a4ca9',  // ריבית קבועה
  boiCpiLinked: '96ba107d-cc15-41cf-b223-5bb592e14666'   // ריבית צמודה
};

// News RSS sources for receivership monitoring
const NEWS_SOURCES = {
  globes: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585',
  calcalist: 'https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml',
  themarker: 'https://www.themarker.com/cmlink/1.145',
  bizportal: 'https://www.bizportal.co.il/rss/realestate'
};

/**
 * Generic query to data.gov.il datastore
 */
async function queryDatastore(resourceId, options = {}) {
  try {
    const { q, filters, limit = 100, offset = 0 } = options;
    
    const params = {
      resource_id: resourceId,
      limit,
      offset
    };
    
    if (q) {
      params.q = q;
    }
    
    if (filters && Object.keys(filters).length > 0) {
      params.filters = JSON.stringify(filters);
    }
    
    const response = await axios.get(`${DATA_GOV_BASE}/datastore_search`, {
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
 * Search data.gov.il resource
 */
async function searchDataGovIL(resourceId, options = {}) {
  return queryDatastore(resourceId, options);
}

/**
 * Test connectivity to all government data sources
 */
async function testGovernmentConnectivity() {
  const results = {};
  
  // Test data.gov.il mashkonot
  try {
    const mashkonot = await queryDatastore(RESOURCE_IDS.mashkonot, { limit: 1 });
    results.mashkonot = {
      status: mashkonot.success ? 'connected' : 'error',
      totalRecords: mashkonot.total || 0,
      source: 'data.gov.il - רשם המשכונות'
    };
  } catch (e) {
    results.mashkonot = { status: 'error', error: e.message };
  }
  
  // Test data.gov.il yerusha
  try {
    const yerusha = await queryDatastore(RESOURCE_IDS.yerusha, { limit: 1 });
    results.yerusha = {
      status: yerusha.success ? 'connected' : 'error',
      totalRecords: yerusha.total || 0,
      source: 'data.gov.il - רשם הירושות'
    };
  } catch (e) {
    results.yerusha = { status: 'error', error: e.message };
  }
  
  // Test insolvency (might fail due to SSL)
  results.insolvency = {
    status: 'available',
    note: 'Requires web scraping - SSL handshake issues from server',
    source: 'insolvency.justice.gov.il'
  };
  
  // Test news RSS
  let newsWorking = 0;
  for (const [name, url] of Object.entries(NEWS_SOURCES)) {
    try {
      await axios.get(url, { timeout: 5000 });
      newsWorking++;
    } catch (e) {}
  }
  results.newsRss = {
    status: newsWorking > 0 ? 'connected' : 'error',
    sourcesAvailable: newsWorking,
    totalSources: Object.keys(NEWS_SOURCES).length
  };
  
  return {
    timestamp: new Date().toISOString(),
    sources: results,
    summary: {
      mashkonot: results.mashkonot.status === 'connected',
      yerusha: results.yerusha.status === 'connected',
      insolvency: true, // Available but needs scraping
      news: newsWorking > 0
    }
  };
}

/**
 * Search liens registry (רשם המשכונות)
 * Note: Dataset doesn't contain names - only registration metadata
 */
async function searchLiensRegistry(term, options = {}) {
  const result = await queryDatastore(RESOURCE_IDS.mashkonot, {
    q: term,
    limit: options.limit || 50
  });
  
  if (result.success) {
    return {
      success: true,
      source: 'data.gov.il - רשם המשכונות',
      note: 'Dataset contains registration metadata only (dates, status). Personal identifiers not included in public data.',
      searchTerm: term,
      recordsFound: result.records.length,
      totalInDatabase: result.total,
      records: result.records,
      fields: result.fields?.map(f => f.id) || []
    };
  }
  return result;
}

/**
 * Search inheritance registry (רשם הירושות)
 * Note: Dataset contains request metadata, not personal names
 */
async function searchInheritanceRegistry(term, options = {}) {
  const result = await queryDatastore(RESOURCE_IDS.yerusha, {
    q: term,
    limit: options.limit || 30
  });
  
  if (result.success) {
    // Analyze by district and status
    const byDistrict = {};
    const byStatus = {};
    
    for (const record of result.records) {
      const district = (record['מחוז'] || 'לא ידוע').trim();
      const status = (record['סטטוס בקשה'] || 'לא ידוע').trim();
      byDistrict[district] = (byDistrict[district] || 0) + 1;
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    
    return {
      success: true,
      source: 'data.gov.il - רשם הירושות',
      note: 'Dataset contains request metadata. Personal names not in public data.',
      searchTerm: term,
      recordsFound: result.records.length,
      totalInDatabase: result.total,
      analysis: { byDistrict, byStatus },
      records: result.records,
      fields: result.fields?.map(f => f.id) || []
    };
  }
  return result;
}

/**
 * Search bankruptcy registry (חדלות פירעון)
 * Note: Public website available but requires scraping
 */
async function searchBankruptcyRegistry(term, type = 'individual') {
  // The insolvency.justice.gov.il website requires web scraping
  // SSL issues prevent direct access from server
  return {
    success: true,
    source: 'insolvency.justice.gov.il',
    status: 'manual_check_required',
    note: 'Bankruptcy database available at insolvency.justice.gov.il but requires browser-based access due to SSL configuration.',
    searchTerm: term,
    type: type,
    manualUrl: `${INSOLVENCY_BASE}/poshtim/main/tikim/wfrmlisttikim.aspx`,
    recommendation: 'Use news RSS monitoring for receivership/bankruptcy announcements'
  };
}

/**
 * Comprehensive government check for an entity
 */
async function comprehensiveGovernmentCheck(entity) {
  const { name, idNumber, companyNumber, address, city } = entity;
  
  const results = {
    entity: { name, idNumber, companyNumber, address, city },
    timestamp: new Date().toISOString(),
    checks: {}
  };
  
  // Check liens
  if (name) {
    results.checks.liens = await searchLiensRegistry(name, { limit: 10 });
  }
  
  // Check inheritance
  if (name || city) {
    const searchTerm = city || name;
    results.checks.inheritance = await searchInheritanceRegistry(searchTerm, { limit: 10 });
  }
  
  // Check bankruptcy
  if (name) {
    results.checks.bankruptcy = await searchBankruptcyRegistry(name, companyNumber ? 'company' : 'individual');
  }
  
  // Check news for receivership
  results.checks.receivership = await monitorReceivershipAnnouncements({ 
    searchTerm: name,
    city 
  });
  
  // Calculate distress indicators
  results.distressIndicators = {
    hasLiensRecords: results.checks.liens?.recordsFound > 0,
    hasInheritanceRecords: results.checks.inheritance?.recordsFound > 0,
    bankruptcyCheckRequired: true,
    receivershipMentions: results.checks.receivership?.mentions?.length > 0
  };
  
  return results;
}

/**
 * Monitor receivership announcements from news RSS
 */
async function monitorReceivershipAnnouncements(options = {}) {
  const { city, searchTerm, dateFrom, dateTo } = options;
  
  const keywords = [
    'כינוס נכסים',
    'כונס נכסים',
    'מכירה בהוצאה לפועל',
    'מימוש משכנתא',
    'דירות מכונס',
    'הוצאה לפועל',
    'פשיטת רגל',
    'חדלות פירעון'
  ];
  
  const mentions = [];
  
  for (const [source, url] of Object.entries(NEWS_SOURCES)) {
    try {
      const response = await axios.get(url, { 
        timeout: 10000,
        headers: { 'User-Agent': 'QUANTUM-Bot/2.0' }
      });
      
      const content = response.data;
      
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          // Check if city or search term is mentioned
          const isRelevant = !city || content.includes(city) || 
                            !searchTerm || content.includes(searchTerm);
          
          if (isRelevant) {
            mentions.push({
              source,
              keyword,
              city: city || null,
              searchTerm: searchTerm || null,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      console.log(`News source ${source} error:`, error.message);
    }
  }
  
  return {
    success: true,
    source: 'News RSS Monitoring',
    sourcesChecked: Object.keys(NEWS_SOURCES).length,
    keywords: keywords,
    filters: { city, searchTerm, dateFrom, dateTo },
    mentions: mentions,
    mentionCount: mentions.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get available datasets from data.gov.il
 */
async function getAvailableDatasets() {
  try {
    const response = await axios.get(`${DATA_GOV_BASE}/package_search`, {
      params: { q: 'משפטים', rows: 100 },
      timeout: 30000
    });
    
    if (response.data.success) {
      return response.data.result.results.map(pkg => ({
        id: pkg.id,
        name: pkg.name,
        title: pkg.title,
        resources: pkg.resources?.length || 0,
        organization: pkg.organization?.title || 'N/A'
      }));
    }
    return [];
  } catch (error) {
    console.error('Error fetching datasets:', error.message);
    return [];
  }
}

/**
 * Get comprehensive data summary
 */
async function getDataSummary() {
  const connectivity = await testGovernmentConnectivity();
  const receivership = await monitorReceivershipAnnouncements({});
  
  return {
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    connectivity: connectivity.summary,
    sources: connectivity.sources,
    receivershipAlerts: receivership.mentionCount,
    availableResources: Object.keys(RESOURCE_IDS)
  };
}

module.exports = {
  // Constants (exposed for routes)
  DATA_GOV_BASE,
  INSOLVENCY_BASE,
  RESOURCE_IDS,
  NEWS_SOURCES,
  
  // Core functions
  queryDatastore,
  searchDataGovIL,
  testGovernmentConnectivity,
  
  // Search functions
  searchLiensRegistry,
  searchInheritanceRegistry,
  searchBankruptcyRegistry,
  
  // Monitoring functions
  comprehensiveGovernmentCheck,
  monitorReceivershipAnnouncements,
  
  // Utility functions
  getAvailableDatasets,
  getDataSummary
};
