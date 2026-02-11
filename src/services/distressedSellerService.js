/**
 * Distressed Seller Service - Phase 4.5 SSI Enhancement
 * 
 * מקורות לזיהוי מוכרים לחוצים:
 * 1. הוצאה לפועל - תיקים פתוחים
 * 2. פשיטות רגל ופירוקים
 * 3. שעבודים ועיקולים
 * 4. כינוס נכסים
 * 5. ירושות מרובות יורשים
 * 
 * @module distressedSellerService
 */

const { logger } = require('./logger');

// Perplexity AI for searching public records
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// SSI Enhancement Weights
const SSI_WEIGHTS = {
  enforcement: 20,        // תיקי הוצאה לפועל
  bankruptcy: 25,         // פשיטת רגל
  liens: 15,              // שעבודים
  receivership: 30,       // כינוס נכסים
  inheritance: 10,        // ירושה מרובת יורשים
  longListing: 5,         // מודעה ארוכה (60+ ימים)
  priceDrops: 10,         // הורדות מחיר מרובות
  urgentLanguage: 5       // שפה דחופה במודעה
};

/**
 * Search using Perplexity AI
 */
async function searchWithPerplexity(query, context = '') {
  if (!PERPLEXITY_API_KEY) {
    logger.warn('Perplexity API key not configured');
    return null;
  }

  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{
          role: 'system',
          content: `אתה עוזר מחקר נדל"ן ישראלי. תן מידע עובדתי בלבד מהמקורות הישראליים. ${context}`
        }, {
          role: 'user',
          content: query
        }],
        temperature: 0.1,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.error('Perplexity search failed', { error: err.message, query });
    return null;
  }
}

/**
 * Check Enforcement Office (הוצאה לפועל) for open cases
 */
async function checkEnforcementOffice(ownerName, idNumber = null) {
  logger.info('Checking enforcement office', { ownerName });

  const query = `
    חפש מידע על תיקי הוצאה לפועל פתוחים בישראל עבור "${ownerName}".
    מקורות: רשות האכיפה והגבייה, פרסומים רשמיים.
    החזר JSON: {"found": boolean, "cases": number, "totalDebt": number, "details": string}
  `;

  const result = await searchWithPerplexity(query, 'חפש רק מידע ציבורי ורשמי');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        source: 'enforcement_office',
        found: parsed.found || false,
        cases: parsed.cases || 0,
        totalDebt: parsed.totalDebt || 0,
        score: parsed.found ? SSI_WEIGHTS.enforcement : 0,
        rawResponse: result
      };
    }
  } catch (e) {}

  const hasIndicators = result && (
    result.includes('הוצאה לפועל') || result.includes('חוב') || result.includes('עיקול')
  );

  return {
    source: 'enforcement_office',
    found: hasIndicators,
    score: hasIndicators ? SSI_WEIGHTS.enforcement : 0,
    rawResponse: result
  };
}

/**
 * Check for bankruptcy proceedings (פשיטת רגל)
 */
async function checkBankruptcyProceedings(ownerName, companyName = null) {
  logger.info('Checking bankruptcy proceedings', { ownerName, companyName });

  const searchTarget = companyName || ownerName;
  const query = `
    חפש מידע על הליכי פשיטת רגל או פירוק בישראל עבור "${searchTarget}".
    מקורות: כונס הנכסים הרשמי, בתי משפט, רשם החברות.
    החזר JSON: {"inProceedings": boolean, "type": "bankruptcy|liquidation|none", "status": string}
  `;

  const result = await searchWithPerplexity(query, 'חפש רק מידע ציבורי מבתי משפט ורשויות');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        source: 'bankruptcy',
        inProceedings: parsed.inProceedings || false,
        type: parsed.type || 'none',
        score: parsed.inProceedings ? SSI_WEIGHTS.bankruptcy : 0,
        rawResponse: result
      };
    }
  } catch (e) {}

  const hasIndicators = result && (
    result.includes('פשיטת רגל') || result.includes('פירוק') || result.includes('כונס')
  );

  return {
    source: 'bankruptcy',
    inProceedings: hasIndicators,
    score: hasIndicators ? SSI_WEIGHTS.bankruptcy : 0,
    rawResponse: result
  };
}

/**
 * Check for property liens (שעבודים)
 */
async function checkPropertyLiens(address, city, gush = null, helka = null) {
  logger.info('Checking property liens', { address, city });

  const locationInfo = gush && helka ? `גוש ${gush} חלקה ${helka}` : `${address}, ${city}`;

  const query = `
    חפש מידע על שעבודים או עיקולים על נכס ב${locationInfo}.
    מקורות: רשם המקרקעין, טאבו.
    החזר JSON: {"hasLiens": boolean, "count": number, "totalAmount": number}
  `;

  const result = await searchWithPerplexity(query, 'מידע מרשם המקרקעין והטאבו');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const isDistressed = parsed.count > 2 || parsed.totalAmount > 2000000;
      return {
        source: 'liens',
        hasLiens: parsed.hasLiens || false,
        count: parsed.count || 0,
        isDistressed,
        score: isDistressed ? SSI_WEIGHTS.liens : 0,
        rawResponse: result
      };
    }
  } catch (e) {}

  return { source: 'liens', hasLiens: false, score: 0, rawResponse: result };
}

/**
 * Search for receivership listings (כינוס נכסים)
 */
async function findReceivershipListings(city, street = null) {
  logger.info('Searching receivership listings', { city, street });

  const locationFilter = street ? `ברחוב ${street} ב${city}` : `ב${city}`;

  const query = `
    חפש נכסים למכירה בכינוס נכסים ${locationFilter}.
    מקורות: גלובס, כלכליסט, yad2 כינוס, פרסומי בתי משפט.
    החזר JSON: {"found": boolean, "listings": [{"address": "", "price": 0, "source": ""}]}
  `;

  const result = await searchWithPerplexity(query, 'חפש מודעות כינוס נכסים עדכניות');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        source: 'receivership',
        found: parsed.found || false,
        listings: parsed.listings || [],
        score: parsed.found ? SSI_WEIGHTS.receivership : 0,
        rawResponse: result
      };
    }
  } catch (e) {}

  return { source: 'receivership', found: false, score: 0, rawResponse: result };
}

/**
 * Check inheritance registry (ירושות)
 */
async function checkInheritanceRegistry(address, city) {
  logger.info('Checking inheritance registry', { address, city });

  const query = `
    חפש מידע על צווי ירושה הקשורים לנכס ב${address}, ${city}.
    מקורות: רשם הירושות.
    החזר JSON: {"isInheritance": boolean, "heirsCount": number, "status": "open|closed|disputed"}
  `;

  const result = await searchWithPerplexity(query, 'מידע מרשם הירושות');

  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const isDistressed = parsed.heirsCount > 3 || parsed.status === 'disputed';
      return {
        source: 'inheritance',
        isInheritance: parsed.isInheritance || false,
        heirsCount: parsed.heirsCount || 0,
        isDistressed,
        score: isDistressed ? SSI_WEIGHTS.inheritance : 0,
        rawResponse: result
      };
    }
  } catch (e) {}

  return { source: 'inheritance', isInheritance: false, score: 0, rawResponse: result };
}

/**
 * Analyze listing for distress signals
 */
function analyzeListingDistress(listing) {
  const signals = { longListing: false, priceDrops: false, urgentLanguage: false, score: 0 };

  if (listing.days_on_market && listing.days_on_market > 60) {
    signals.longListing = true;
    signals.score += SSI_WEIGHTS.longListing;
  }

  if (listing.price_changes && listing.price_changes > 2) {
    signals.priceDrops = true;
    signals.score += SSI_WEIGHTS.priceDrops;
  }

  const urgentTerms = ['דחוף', 'מכירה מהירה', 'הזדמנות', 'מוכרחים למכור', 'מחיר מציאה'];
  const text = `${listing.title || ''} ${listing.description || ''}`.toLowerCase();
  
  for (const term of urgentTerms) {
    if (text.includes(term)) {
      signals.urgentLanguage = true;
      signals.score += SSI_WEIGHTS.urgentLanguage;
      break;
    }
  }

  return signals;
}

/**
 * Calculate enhanced SSI for a complex
 */
async function calculateEnhancedSSI(complex, listings = [], options = {}) {
  logger.info('Calculating enhanced SSI', { complexId: complex.id });

  const results = {
    complexId: complex.id,
    complexName: complex.name,
    baseSSI: complex.ssi_score || 0,
    checks: [],
    totalEnhancement: 0,
    finalSSI: 0,
    distressIndicators: [],
    timestamp: new Date().toISOString()
  };

  try {
    // Check receivership in area
    if (!options.skipReceivership) {
      const receivership = await findReceivershipListings(complex.city, complex.street);
      results.checks.push(receivership);
      if (receivership.found) {
        results.totalEnhancement += receivership.score;
        results.distressIndicators.push('כינוס נכסים באזור');
      }
    }

    // Analyze listings for distress signals
    let listingDistressScore = 0;
    for (const listing of listings.slice(0, 10)) {
      const listingSignals = analyzeListingDistress(listing);
      listingDistressScore += listingSignals.score;
      
      if (listingSignals.longListing) results.distressIndicators.push(`מודעה ארוכה: ${listing.days_on_market} ימים`);
      if (listingSignals.priceDrops) results.distressIndicators.push(`הורדות מחיר: ${listing.price_changes} פעמים`);
      if (listingSignals.urgentLanguage) results.distressIndicators.push('שפה דחופה במודעה');
    }
    results.totalEnhancement += Math.min(listingDistressScore, 30);

    // Deep scan checks
    if (options.deepScan) {
      const liens = await checkPropertyLiens(complex.address || complex.street, complex.city);
      results.checks.push(liens);
      if (liens.hasLiens && liens.isDistressed) {
        results.totalEnhancement += liens.score;
        results.distressIndicators.push('שעבודים מרובים');
      }

      const inheritance = await checkInheritanceRegistry(complex.address || complex.street, complex.city);
      results.checks.push(inheritance);
      if (inheritance.isInheritance && inheritance.isDistressed) {
        results.totalEnhancement += inheritance.score;
        results.distressIndicators.push(`ירושה עם ${inheritance.heirsCount} יורשים`);
      }
    }

    // Calculate final SSI
    results.finalSSI = Math.min(results.baseSSI + results.totalEnhancement, 100);
    results.ssiIncrease = results.finalSSI - results.baseSSI;

    // Determine urgency level
    if (results.finalSSI >= 80) {
      results.urgencyLevel = 'critical';
      results.recommendation = 'הזדמנות קריטית - יש לפעול מיידית';
    } else if (results.finalSSI >= 60) {
      results.urgencyLevel = 'high';
      results.recommendation = 'הזדמנות טובה - מומלץ ליצור קשר בקרוב';
    } else if (results.finalSSI >= 40) {
      results.urgencyLevel = 'medium';
      results.recommendation = 'פוטנציאל - כדאי לעקוב';
    } else {
      results.urgencyLevel = 'low';
      results.recommendation = 'אין סימני מצוקה משמעותיים';
    }

    logger.info('Enhanced SSI calculated', { complexId: complex.id, finalSSI: results.finalSSI });

  } catch (err) {
    logger.error('Enhanced SSI calculation failed', { error: err.message });
    results.error = err.message;
    results.finalSSI = results.baseSSI;
  }

  return results;
}

/**
 * Scan for distressed sellers in a city
 */
async function scanCityForDistressedSellers(city, pool) {
  logger.info('Scanning city for distressed sellers', { city });

  const results = {
    city,
    scannedAt: new Date().toISOString(),
    receivershipListings: [],
    highDistressComplexes: [],
    alerts: []
  };

  try {
    const receivership = await findReceivershipListings(city);
    results.receivershipListings = receivership.listings || [];

    const complexes = await pool.query(`
      SELECT c.*, COUNT(l.id) as listing_count
      FROM complexes c
      LEFT JOIN listings l ON l.complex_id = c.id AND l.is_active = TRUE
      WHERE c.city = $1
      GROUP BY c.id
      HAVING COUNT(l.id) > 0
      ORDER BY c.ssi_score DESC NULLS LAST
      LIMIT 20
    `, [city]);

    for (const complex of complexes.rows) {
      const listings = await pool.query(
        'SELECT * FROM listings WHERE complex_id = $1 AND is_active = TRUE',
        [complex.id]
      );

      const enhancedSSI = await calculateEnhancedSSI(complex, listings.rows, { skipReceivership: true });

      if (enhancedSSI.finalSSI >= 50) {
        results.highDistressComplexes.push({
          id: complex.id,
          name: complex.name,
          baseSSI: complex.ssi_score,
          enhancedSSI: enhancedSSI.finalSSI,
          urgencyLevel: enhancedSSI.urgencyLevel,
          indicators: enhancedSSI.distressIndicators
        });

        if (enhancedSSI.finalSSI >= 70) {
          results.alerts.push({
            type: 'high_distress_detected',
            complexId: complex.id,
            complexName: complex.name,
            ssi: enhancedSSI.finalSSI,
            indicators: enhancedSSI.distressIndicators
          });
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    results.highDistressComplexes.sort((a, b) => b.enhancedSSI - a.enhancedSSI);

  } catch (err) {
    logger.error('City scan failed', { error: err.message, city });
    results.error = err.message;
  }

  return results;
}

module.exports = {
  checkEnforcementOffice,
  checkBankruptcyProceedings,
  checkPropertyLiens,
  findReceivershipListings,
  checkInheritanceRegistry,
  analyzeListingDistress,
  calculateEnhancedSSI,
  scanCityForDistressedSellers,
  SSI_WEIGHTS
};
