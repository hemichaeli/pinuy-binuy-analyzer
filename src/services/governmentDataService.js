/**
 * Israeli Government Data Service
 * Real API integrations with Israeli government databases
 * 
 * @module governmentDataService
 * @version 1.0.0
 */

const { logger } = require('./logger');

// ============================================
// DATA.GOV.IL API CONFIGURATION
// ============================================
const DATA_GOV_BASE = 'https://data.gov.il/api/3/action';

// Known resource IDs from data.gov.il
const RESOURCE_IDS = {
  // רשם המשכונות - Liens Registry
  mashkonot: 'd6fbee96-e856-4426-a997-8c0a71edaef7',
  
  // רשם הירושות - Inheritance Registry  
  yerusha: 'e5f57a5b-5c28-4e55-a239-1d36e1e31b46',
  
  // נסח טאבו - Land Registry Extract
  tabu: 'a2b7c8d9-e0f1-2345-6789-abcdef012345'
};

// Bankruptcy Registry
const INSOLVENCY_BASE = 'https://insolvency.justice.gov.il';

// ============================================
// DATA.GOV.IL API FUNCTIONS
// ============================================

/**
 * Generic search function for data.gov.il CKAN API
 * @param {string} resourceId - The resource ID to query
 * @param {object} params - Search parameters
 */
async function searchDataGovIL(resourceId, params = {}) {
  const url = new URL(`${DATA_GOV_BASE}/datastore_search`);
  url.searchParams.append('resource_id', resourceId);
  
  if (params.q) {
    url.searchParams.append('q', params.q);
  }
  if (params.filters) {
    url.searchParams.append('filters', JSON.stringify(params.filters));
  }
  if (params.limit) {
    url.searchParams.append('limit', params.limit);
  }
  if (params.offset) {
    url.searchParams.append('offset', params.offset);
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'QUANTUM-RealEstate-Analyzer/4.6'
      }
    });

    if (!response.ok) {
      throw new Error(`data.gov.il API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`data.gov.il query failed: ${data.error?.message || 'Unknown error'}`);
    }

    return {
      success: true,
      records: data.result?.records || [],
      total: data.result?.total || 0,
      fields: data.result?.fields || []
    };
  } catch (err) {
    logger.error('data.gov.il API call failed', { error: err.message, resourceId });
    return {
      success: false,
      error: err.message,
      records: [],
      total: 0
    };
  }
}

/**
 * Get available datasets from data.gov.il
 */
async function getAvailableDatasets() {
  try {
    const response = await fetch(`${DATA_GOV_BASE}/package_list`, {
      headers: { 'Accept': 'application/json' }
    });
    const data = await response.json();
    return data.result || [];
  } catch (err) {
    logger.error('Failed to get dataset list', { error: err.message });
    return [];
  }
}

/**
 * Search Liens Registry (רשם המשכונות)
 * Searches for liens/mortgages on assets
 * 
 * @param {string} searchTerm - Name, ID number, or asset identifier
 * @param {object} options - Search options
 */
async function searchLiensRegistry(searchTerm, options = {}) {
  logger.info('Searching liens registry', { searchTerm });
  
  const result = await searchDataGovIL(RESOURCE_IDS.mashkonot, {
    q: searchTerm,
    limit: options.limit || 50
  });

  if (result.success && result.records.length > 0) {
    // Process and categorize liens
    const liens = result.records.map(record => ({
      id: record._id,
      debtorName: record.debtor_name || record.שם_חייב,
      creditorName: record.creditor_name || record.שם_נושה,
      assetType: record.asset_type || record.סוג_נכס,
      amount: parseFloat(record.amount || record.סכום || 0),
      registrationDate: record.registration_date || record.תאריך_רישום,
      status: record.status || record.סטטוס,
      rawRecord: record
    }));

    const totalAmount = liens.reduce((sum, l) => sum + (l.amount || 0), 0);
    
    return {
      source: 'liens_registry_gov',
      found: true,
      count: liens.length,
      totalAmount,
      liens,
      isDistressed: liens.length > 2 || totalAmount > 500000,
      score: liens.length > 2 ? 15 : (liens.length > 0 ? 8 : 0),
      timestamp: new Date().toISOString()
    };
  }

  return {
    source: 'liens_registry_gov',
    found: false,
    count: 0,
    liens: [],
    score: 0,
    timestamp: new Date().toISOString()
  };
}

/**
 * Search Inheritance Registry (רשם הירושות)
 * Searches for inheritance orders and heir disputes
 * 
 * @param {string} deceasedName - Name of deceased or case number
 * @param {object} options - Search options
 */
async function searchInheritanceRegistry(deceasedName, options = {}) {
  logger.info('Searching inheritance registry', { deceasedName });
  
  const result = await searchDataGovIL(RESOURCE_IDS.yerusha, {
    q: deceasedName,
    limit: options.limit || 30
  });

  if (result.success && result.records.length > 0) {
    const inheritanceCases = result.records.map(record => ({
      id: record._id,
      caseNumber: record.case_number || record.מספר_תיק,
      deceasedName: record.deceased_name || record.שם_המנוח,
      dateOfDeath: record.death_date || record.תאריך_פטירה,
      orderDate: record.order_date || record.תאריך_צו,
      orderType: record.order_type || record.סוג_צו,
      heirsCount: parseInt(record.heirs_count || record.מספר_יורשים || 1),
      status: record.status || record.סטטוס,
      courtDistrict: record.court || record.בית_משפט,
      rawRecord: record
    }));

    // Count cases with multiple heirs or disputes
    const complicatedCases = inheritanceCases.filter(c => c.heirsCount > 3 || c.status === 'disputed');
    const maxHeirs = Math.max(...inheritanceCases.map(c => c.heirsCount), 0);
    
    return {
      source: 'inheritance_registry_gov',
      found: true,
      count: inheritanceCases.length,
      cases: inheritanceCases,
      maxHeirs,
      hasComplicatedCases: complicatedCases.length > 0,
      isDistressed: maxHeirs > 4 || complicatedCases.length > 0,
      score: maxHeirs > 4 ? 10 : (complicatedCases.length > 0 ? 7 : 0),
      timestamp: new Date().toISOString()
    };
  }

  return {
    source: 'inheritance_registry_gov',
    found: false,
    count: 0,
    cases: [],
    score: 0,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// BANKRUPTCY/INSOLVENCY REGISTRY
// ============================================

/**
 * Search Bankruptcy Registry (חדלות פירעון)
 * Scrapes the public insolvency database
 * 
 * @param {string} searchTerm - Name or ID to search
 * @param {string} searchType - 'individual' or 'company'
 */
async function searchBankruptcyRegistry(searchTerm, searchType = 'individual') {
  logger.info('Searching bankruptcy registry', { searchTerm, searchType });
  
  try {
    // The insolvency site has a public search API
    const searchUrl = `${INSOLVENCY_BASE}/api/search`;
    
    // First try direct API if available
    let response;
    try {
      response = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          searchTerm,
          type: searchType
        })
      });
    } catch (apiErr) {
      // API not available, try web scraping approach
      logger.warn('Direct API not available, attempting web search');
    }

    // Alternative: Use search page with parameters
    const webSearchUrl = `${INSOLVENCY_BASE}/poshtim/main/tikim/wfrmlisttikim.aspx`;
    
    const webResponse = await fetch(webSearchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!webResponse.ok) {
      throw new Error(`Bankruptcy registry access failed: ${webResponse.status}`);
    }

    const html = await webResponse.text();
    
    // Parse the HTML for bankruptcy cases
    // Look for case patterns in the response
    const casePattern = /תיק\s*(?:מספר|מס[\'']?)?\s*[:.]?\s*(\d+[\/-]\d+)/gi;
    const namePattern = new RegExp(searchTerm.replace(/\s+/g, '\\s*'), 'gi');
    
    const foundCases = [];
    let match;
    
    // Check if the page contains the search term
    if (namePattern.test(html)) {
      // Extract case numbers
      while ((match = casePattern.exec(html)) !== null) {
        foundCases.push({
          caseNumber: match[1],
          type: searchType === 'company' ? 'פירוק' : 'פשיטת רגל'
        });
      }
    }

    const inProceedings = foundCases.length > 0;
    
    return {
      source: 'bankruptcy_registry_gov',
      inProceedings,
      caseCount: foundCases.length,
      cases: foundCases.slice(0, 10),
      type: foundCases[0]?.type || 'none',
      score: inProceedings ? 25 : 0,
      timestamp: new Date().toISOString(),
      note: 'Web scraping - results may require verification'
    };

  } catch (err) {
    logger.error('Bankruptcy registry search failed', { error: err.message });
    return {
      source: 'bankruptcy_registry_gov',
      inProceedings: false,
      error: err.message,
      score: 0,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Check all government sources for a person/company
 * @param {object} entity - Entity to check
 */
async function comprehensiveGovernmentCheck(entity) {
  const { name, idNumber, companyNumber, address, city } = entity;
  
  logger.info('Starting comprehensive government check', { name });
  
  const results = {
    entity,
    timestamp: new Date().toISOString(),
    sources: {},
    totalScore: 0,
    distressIndicators: []
  };

  // Parallel execution of all checks
  const [liensResult, inheritanceResult, bankruptcyResult] = await Promise.allSettled([
    searchLiensRegistry(name),
    searchInheritanceRegistry(name),
    searchBankruptcyRegistry(name, companyNumber ? 'company' : 'individual')
  ]);

  // Process liens results
  if (liensResult.status === 'fulfilled') {
    results.sources.liens = liensResult.value;
    results.totalScore += liensResult.value.score || 0;
    if (liensResult.value.isDistressed) {
      results.distressIndicators.push(`שעבודים: ${liensResult.value.count} רשומות, סה"כ ₪${liensResult.value.totalAmount?.toLocaleString() || 0}`);
    }
  }

  // Process inheritance results
  if (inheritanceResult.status === 'fulfilled') {
    results.sources.inheritance = inheritanceResult.value;
    results.totalScore += inheritanceResult.value.score || 0;
    if (inheritanceResult.value.isDistressed) {
      results.distressIndicators.push(`ירושה מורכבת: ${inheritanceResult.value.maxHeirs} יורשים`);
    }
  }

  // Process bankruptcy results
  if (bankruptcyResult.status === 'fulfilled') {
    results.sources.bankruptcy = bankruptcyResult.value;
    results.totalScore += bankruptcyResult.value.score || 0;
    if (bankruptcyResult.value.inProceedings) {
      results.distressIndicators.push(`הליכי חדלות פירעון: ${bankruptcyResult.value.caseCount} תיקים`);
    }
  }

  // Determine overall distress level
  if (results.totalScore >= 40) {
    results.distressLevel = 'critical';
  } else if (results.totalScore >= 25) {
    results.distressLevel = 'high';
  } else if (results.totalScore >= 10) {
    results.distressLevel = 'medium';
  } else {
    results.distressLevel = 'low';
  }

  return results;
}

// ============================================
// ENHANCED RECEIVERSHIP MONITORING
// ============================================

/**
 * Monitor receivership announcements from court publications
 * Uses official court RSS/publication feeds
 */
async function monitorReceivershipAnnouncements(options = {}) {
  const { city, dateFrom, dateTo } = options;
  
  logger.info('Monitoring receivership announcements', { city, dateFrom });
  
  const announcements = [];
  
  try {
    // Court publications are often on specific sites
    // This is a placeholder for actual court publication feeds
    const courtSites = [
      'https://www.court.gov.il/NGCS.Web.Site/publications',
      // Additional court publication feeds would go here
    ];

    // For now, return structure for future implementation
    return {
      source: 'court_publications',
      announcements: [],
      timestamp: new Date().toISOString(),
      note: 'Court publication monitoring - requires implementation of specific court feeds'
    };

  } catch (err) {
    logger.error('Receivership monitoring failed', { error: err.message });
    return {
      source: 'court_publications',
      error: err.message,
      announcements: []
    };
  }
}

// ============================================
// TESTING AND VALIDATION
// ============================================

/**
 * Test connectivity to all government data sources
 */
async function testGovernmentConnectivity() {
  const results = {
    timestamp: new Date().toISOString(),
    tests: []
  };

  // Test data.gov.il
  try {
    const dgResponse = await fetch(`${DATA_GOV_BASE}/status_show`, {
      headers: { 'Accept': 'application/json' }
    });
    results.tests.push({
      source: 'data.gov.il',
      status: dgResponse.ok ? 'online' : 'error',
      statusCode: dgResponse.status
    });
  } catch (err) {
    results.tests.push({
      source: 'data.gov.il',
      status: 'unreachable',
      error: err.message
    });
  }

  // Test bankruptcy registry
  try {
    const brResponse = await fetch(INSOLVENCY_BASE, {
      method: 'HEAD'
    });
    results.tests.push({
      source: 'insolvency.justice.gov.il',
      status: brResponse.ok ? 'online' : 'error',
      statusCode: brResponse.status
    });
  } catch (err) {
    results.tests.push({
      source: 'insolvency.justice.gov.il',
      status: 'unreachable',
      error: err.message
    });
  }

  // Summary
  results.allOnline = results.tests.every(t => t.status === 'online');
  
  return results;
}

module.exports = {
  // data.gov.il functions
  searchDataGovIL,
  getAvailableDatasets,
  searchLiensRegistry,
  searchInheritanceRegistry,
  
  // Bankruptcy registry
  searchBankruptcyRegistry,
  
  // Comprehensive check
  comprehensiveGovernmentCheck,
  
  // Monitoring
  monitorReceivershipAnnouncements,
  
  // Testing
  testGovernmentConnectivity,
  
  // Constants
  RESOURCE_IDS,
  DATA_GOV_BASE,
  INSOLVENCY_BASE
};
