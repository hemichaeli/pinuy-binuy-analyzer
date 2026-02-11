/**
 * Government Data Service - Real Israeli Government APIs
 * Integrates with data.gov.il and other public sources
 * Version: 2.0.0
 * 
 * Data Sources:
 * - רשם המשכונות (Liens Registry) - 8M+ records
 * - רשם הירושות (Inheritance Registry) - 1.2M+ records  
 * - חדלות פירעון (Insolvency Database)
 * - News RSS for receivership monitoring
 */

const axios = require('axios');

// Base URLs
const DATA_GOV_BASE = 'https://data.gov.il/api/3/action';
const INSOLVENCY_BASE = 'https://insolvency.justice.gov.il';

// Resource IDs from data.gov.il
const RESOURCE_IDS = {
  mashkonot: 'e7266a9c-fed6-40e4-a28e-8cddc9f44842',  // רשם המשכונות - 8M+ records
  yerusha: '7691b4a2-fe1d-44ec-9f1b-9f2f0a15381b',    // רשם הירושות - 1.2M+ records
  boiFixedRate: '8900966f-b1e0-4fcf-942b-0d31cb6a4ca9', // ריבית קבועה
  boiCpiLinked: '96ba107d-cc15-41cf-b223-5bb592e14666'  // ריבית צמודה
};

// News RSS sources for receivership monitoring
const NEWS_SOURCES = {
  globes: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585',
  calcalist: 'https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml',
  themarker: 'https://www.themarker.com/cmlink/1.145',
  bizportal: 'https://www.bizportal.co.il/rss/realestate'
};

/**
 * Query data.gov.il datastore
 */
async function queryDatastore(resourceId, options = {}) {
  try {
    const { limit = 100, offset = 0, filters = {}, q = null } = options;
    
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
 * Search data.gov.il with free text
 */
async function searchDataGovIL(resourceId, options = {}) {
  return queryDatastore(resourceId, options);
}

/**
 * Search liens registry (רשם המשכונות)
 */
async function searchLiensRegistry(term, options = {}) {
  const { limit = 50 } = options;
  
  try {
    const result = await queryDatastore(RESOURCE_IDS.mashkonot, {
      q: term,
      limit
    });
    
    return {
      success: result.success,
      source: 'data.gov.il - רשם המשכונות',
      searchTerm: term,
      totalMatches: result.total || 0,
      recordsReturned: result.records?.length || 0,
      records: result.records || [],
      note: 'Registry contains registration metadata only, not owner names'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Search inheritance registry (רשם הירושות)
 */
async function searchInheritanceRegistry(term, options = {}) {
  const { limit = 30 } = options;
  
  try {
    const result = await queryDatastore(RESOURCE_IDS.yerusha, {
      q: term,
      limit
    });
    
    return {
      success: result.success,
      source: 'data.gov.il - רשם הירושות',
      searchTerm: term,
      totalMatches: result.total || 0,
      recordsReturned: result.records?.length || 0,
      records: result.records || [],
      note: 'Registry contains request metadata only, not beneficiary names'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Search bankruptcy/insolvency registry (חדלות פירעון)
 * Note: The official site has SSL issues, so we use alternative approach
 */
async function searchBankruptcyRegistry(term, type = 'individual') {
  try {
    // The insolvency.justice.gov.il has SSL issues
    // We return information about how to access it
    return {
      success: true,
      source: 'insolvency.justice.gov.il',
      searchTerm: term,
      type,
      note: 'Bankruptcy database requires manual access due to SSL configuration',
      manualUrl: `${INSOLVENCY_BASE}/poshtim/main/tikim/wfrmlisttikim.aspx`,
      instructions: [
        'Navigate to the URL above',
        'Enter search term in the form',
        'Results show active insolvency cases'
      ],
      alternatives: [
        'Monitor RSS news feeds for bankruptcy announcements',
        'Use commercial services like govo.co.il'
      ]
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Monitor receivership announcements via RSS
 */
async function monitorReceivershipAnnouncements(options = {}) {
  const { city, searchTerm } = options;
  
  const keywords = [
    'כינוס נכסים',
    'כונס נכסים',
    'מכירה בהוצאה לפועל',
    'מימוש משכנתא',
    'דירות מכונס'
  ];
  
  if (city) keywords.push(city);
  if (searchTerm) keywords.push(searchTerm);
  
  const results = [];
  
  for (const [source, url] of Object.entries(NEWS_SOURCES)) {
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
    source: 'RSS News Monitoring',
    filters: { city, searchTerm },
    keywordsChecked: keywords,
    matches: results,
    sourcesChecked: Object.keys(NEWS_SOURCES).length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Test connectivity to all government data sources
 */
async function testGovernmentConnectivity() {
  const results = {
    timestamp: new Date().toISOString(),
    sources: {}
  };
  
  // Test data.gov.il - Mashkonot
  try {
    const mashkonot = await queryDatastore(RESOURCE_IDS.mashkonot, { limit: 1 });
    results.sources.mashkonot = {
      name: 'רשם המשכונות',
      status: mashkonot.success ? 'connected' : 'error',
      totalRecords: mashkonot.total || 0,
      error: mashkonot.error
    };
  } catch (e) {
    results.sources.mashkonot = { status: 'error', error: e.message };
  }
  
  // Test data.gov.il - Yerusha
  try {
    const yerusha = await queryDatastore(RESOURCE_IDS.yerusha, { limit: 1 });
    results.sources.yerusha = {
      name: 'רשם הירושות',
      status: yerusha.success ? 'connected' : 'error',
      totalRecords: yerusha.total || 0,
      error: yerusha.error
    };
  } catch (e) {
    results.sources.yerusha = { status: 'error', error: e.message };
  }
  
  // Test insolvency (will likely fail due to SSL)
  try {
    await axios.get(INSOLVENCY_BASE, { timeout: 5000 });
    results.sources.insolvency = { name: 'חדלות פירעון', status: 'connected' };
  } catch (e) {
    results.sources.insolvency = {
      name: 'חדלות פירעון',
      status: 'ssl_error',
      note: 'Requires browser access',
      manualUrl: `${INSOLVENCY_BASE}/poshtim/main/tikim/wfrmlisttikim.aspx`
    };
  }
  
  // Test news RSS
  let rssWorking = 0;
  for (const [name, url] of Object.entries(NEWS_SOURCES)) {
    try {
      await axios.get(url, { timeout: 5000 });
      rssWorking++;
    } catch (e) {}
  }
  results.sources.newsRss = {
    name: 'RSS News Feeds',
    status: rssWorking > 0 ? 'connected' : 'error',
    workingSources: rssWorking,
    totalSources: Object.keys(NEWS_SOURCES).length
  };
  
  return results;
}

/**
 * Comprehensive government check for an entity
 */
async function comprehensiveGovernmentCheck(entity) {
  const { name, idNumber, companyNumber, address, city } = entity;
  
  const results = {
    entity,
    timestamp: new Date().toISOString(),
    checks: {}
  };
  
  // Search liens registry
  if (name || companyNumber) {
    const searchTerm = companyNumber || name;
    results.checks.liens = await searchLiensRegistry(searchTerm, { limit: 20 });
  }
  
  // Search inheritance registry
  if (name) {
    results.checks.inheritance = await searchInheritanceRegistry(name, { limit: 20 });
  }
  
  // Search bankruptcy
  if (name || companyNumber) {
    results.checks.bankruptcy = await searchBankruptcyRegistry(name || companyNumber);
  }
  
  // Monitor receivership
  if (city || address) {
    results.checks.receivership = await monitorReceivershipAnnouncements({
      city,
      searchTerm: address
    });
  }
  
  // Calculate overall risk score
  let riskScore = 0;
  let riskFactors = [];
  
  if (results.checks.liens?.totalMatches > 0) {
    riskScore += 15;
    riskFactors.push('liens_found');
  }
  
  if (results.checks.inheritance?.totalMatches > 0) {
    riskScore += 10;
    riskFactors.push('inheritance_cases');
  }
  
  if (results.checks.receivership?.matches?.length > 0) {
    riskScore += 30;
    riskFactors.push('receivership_news');
  }
  
  results.riskAssessment = {
    score: riskScore,
    level: riskScore >= 30 ? 'high' : riskScore >= 15 ? 'medium' : 'low',
    factors: riskFactors
  };
  
  return results;
}

/**
 * Get data summary from all sources
 */
async function getDataSummary() {
  const connectivity = await testGovernmentConnectivity();
  
  return {
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    connectivity: connectivity.sources,
    availableResources: RESOURCE_IDS,
    newsSources: Object.keys(NEWS_SOURCES),
    capabilities: {
      liensSearch: 'Full-text search on 8M+ liens records',
      inheritanceSearch: 'Full-text search on 1.2M+ inheritance cases',
      bankruptcyInfo: 'Manual access info (SSL issues)',
      receivershipMonitoring: 'Real-time RSS monitoring for כינוס נכסים'
    }
  };
}

/**
 * Get available datasets from data.gov.il
 */
async function getAvailableDatasets() {
  try {
    const response = await axios.get(`${DATA_GOV_BASE}/package_search`, {
      params: {
        q: 'משפטים OR נדל"ן OR מקרקעין',
        rows: 100
      },
      timeout: 30000
    });
    
    if (response.data.success) {
      return response.data.result.results.map(pkg => ({
        name: pkg.name,
        title: pkg.title,
        organization: pkg.organization?.title,
        resources: pkg.resources?.length || 0,
        lastModified: pkg.metadata_modified
      }));
    }
    return [];
  } catch (error) {
    console.error('Error fetching datasets:', error.message);
    return [];
  }
}

// Export all functions and constants
module.exports = {
  // Constants
  DATA_GOV_BASE,
  INSOLVENCY_BASE,
  RESOURCE_IDS,
  NEWS_SOURCES,
  
  // Core functions
  queryDatastore,
  searchDataGovIL,
  
  // Search functions
  searchLiensRegistry,
  searchInheritanceRegistry,
  searchBankruptcyRegistry,
  
  // Monitoring
  monitorReceivershipAnnouncements,
  
  // Utility functions
  testGovernmentConnectivity,
  comprehensiveGovernmentCheck,
  getDataSummary,
  getAvailableDatasets
};
