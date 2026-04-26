/**
 * Israeli Real Estate Service — Internal Tool
 *
 * Based on: skills-il/government-services/israeli-real-estate (MIT)
 * Purpose: Internal enrichment only — NOT exposed to clients or voice agents.
 *
 * Used by:
 *   - IAI calculator (investor cost basis)
 *   - Morning report (true entry cost per opportunity)
 *   - Perplexity enrichment (land type, Tabu status flags)
 *   - Dashboard (display investor net premium after tax)
 */

'use strict';

// ── Purchase Tax Brackets 2026 (frozen at 2025 levels) ────────────────────────
// Source: Israel Tax Authority — first-apartment brackets frozen until Jan 15, 2028
const MAS_RECHISHA = {
  firstApartment: [
    { upTo: 1_978_745,  rate: 0.00 },
    { upTo: 2_347_040,  rate: 0.035 },
    { upTo: 6_055_070,  rate: 0.05  },
    { upTo: 20_183_565, rate: 0.08  },
    { upTo: Infinity,   rate: 0.10  },
  ],
  investor: [
    // Pays 8% from first shekel — no exemption
    { upTo: 6_055_070, rate: 0.08 },
    { upTo: Infinity,  rate: 0.10 },
  ]
};

/**
 * Calculate purchase tax (mas rechisha)
 * @param {number} price - Property price in NIS
 * @param {'first'|'investor'} buyerType
 * @returns {{ tax: number, effectiveRate: number, breakdown: Array }}
 */
function calcMasRechisha(price, buyerType = 'investor') {
  const brackets = buyerType === 'first'
    ? MAS_RECHISHA.firstApartment
    : MAS_RECHISHA.investor;

  let remaining = price;
  let prevUpTo  = 0;
  let totalTax  = 0;
  const breakdown = [];

  for (const bracket of brackets) {
    if (remaining <= 0) break;
    const bandSize  = Math.min(remaining, bracket.upTo - prevUpTo);
    const taxInBand = bandSize * bracket.rate;
    if (bandSize > 0) {
      breakdown.push({
        from: prevUpTo,
        to: Math.min(price, bracket.upTo),
        rate: bracket.rate,
        tax: Math.round(taxInBand)
      });
    }
    totalTax  += taxInBand;
    remaining -= bandSize;
    prevUpTo   = bracket.upTo;
  }

  return {
    tax:           Math.round(totalTax),
    effectiveRate: price > 0 ? totalTax / price : 0,
    breakdown
  };
}

/**
 * Full investor cost analysis for a pinuy-binuy opportunity
 * @param {object} params
 * @param {number} params.currentPrice    - Current market price of existing unit (NIS)
 * @param {number} params.newUnitValue    - Expected value of replacement unit (NIS)
 * @param {number} params.premiumPct      - Developer premium percentage (e.g. 0.35 for 35%)
 * @param {string} [params.city]          - City name (for future location-based enrichment)
 * @returns {object} Full cost breakdown
 */
function calcInvestorCostBasis(params) {
  const { currentPrice, newUnitValue, premiumPct = 0, city = '' } = params;

  // Purchase tax on entry (investor rate — no exemption)
  const { tax: purchaseTax, effectiveRate } = calcMasRechisha(currentPrice, 'investor');

  // Estimated notary + legal fees (~1% industry standard)
  const legalFees = Math.round(currentPrice * 0.01);

  // Total entry cost
  const totalEntry = currentPrice + purchaseTax + legalFees;

  // Gross profit from urban renewal
  const grossProfit = newUnitValue - totalEntry;

  // Net premium percentage (after tax and fees)
  const netPremiumPct = totalEntry > 0 ? grossProfit / totalEntry : 0;

  // Effective premium erosion from tax
  const taxErosionPct = premiumPct > 0
    ? (purchaseTax / currentPrice) / premiumPct
    : 0;

  return {
    currentPrice,
    purchaseTax,
    legalFees,
    totalEntry,
    newUnitValue,
    grossProfit,
    netPremiumPct:   Math.round(netPremiumPct * 1000) / 10,   // e.g. 23.5
    grossPremiumPct: Math.round(premiumPct * 1000) / 10,
    taxErosionPct:   Math.round(taxErosionPct * 1000) / 10,
    effectiveMasRate: Math.round(effectiveRate * 1000) / 10,
    city
  };
}

/**
 * IAI penalty points based on purchase tax burden
 * A high tax burden reduces investment attractiveness.
 * @param {number} currentPrice
 * @returns {number} penalty (0 to -8)
 */
function masRechishaPenalty(currentPrice) {
  const { tax } = calcMasRechisha(currentPrice, 'investor');
  const taxPct = currentPrice > 0 ? tax / currentPrice : 0;
  // 8% tax = -6 points, 10% = -8 points
  if (taxPct >= 0.10) return -8;
  if (taxPct >= 0.08) return -6;
  if (taxPct >= 0.05) return -4;
  return -2;
}

/**
 * Format cost analysis as a human-readable Hebrew summary (for morning report)
 * @param {object} analysis - output of calcInvestorCostBasis
 * @returns {string}
 */
function formatForReport(analysis) {
  const fmt = (n) => n ? n.toLocaleString('he-IL') : '—';
  return [
    `מחיר כניסה: ₪${fmt(analysis.currentPrice)}`,
    `מס רכישה (8%): ₪${fmt(analysis.purchaseTax)}`,
    `עו"ד ונוטריון: ₪${fmt(analysis.legalFees)}`,
    `סה"כ עלות כניסה: ₪${fmt(analysis.totalEntry)}`,
    `שווי יחידה חדשה: ₪${fmt(analysis.newUnitValue)}`,
    `פרמייה נטו למשקיע: ${analysis.netPremiumPct}% (ברוטו: ${analysis.grossPremiumPct}%)`,
    `שחיקת פרמייה ממס: ${analysis.taxErosionPct}%`,
  ].join('\n');
}

/**
 * Classify land type for enrichment context
 * Based on Tabu (private) vs Israel Land Authority (minhelet)
 * This is a heuristic — actual lookup requires nadlan.gov.il or tabu API
 * @param {string} city
 * @returns {{ landType: string, ilaRisk: boolean, notes: string }}
 */
function classifyLandType(city = '') {
  const ilaHeavyCities = ['תל אביב','בת ים','חולון','רמת גן','גבעתיים','בני ברק','פתח תקווה','ראשון לציון'];
  const mixedCities    = ['חיפה','ירושלים','אשדוד','אשקלון','באר שבע','נתניה','הרצליה','רעננה'];

  const isIlaHeavy = ilaHeavyCities.some(c => city.includes(c));
  const isMixed    = mixedCities.some(c => city.includes(c));

  if (isIlaHeavy) {
    return { landType: 'private_dominant', ilaRisk: false, notes: 'רוב הקרקע פרטית — טאבו. ביצוע פינוי-בינוי נוח יחסית.' };
  } else if (isMixed) {
    return { landType: 'mixed', ilaRisk: true, notes: 'ייתכן קרקע מינהל — נדרש בדיקת נסח לפני הערכה.' };
  } else {
    return { landType: 'unknown', ilaRisk: true, notes: 'עיר לא ידועה — נדרש בדיקת נסח ורשות מקרקעי ישראל.' };
  }
}

/**
 * Quick reference: what questions to Perplexity/enrichment to improve data quality
 * @param {object} complex - complex record from DB
 * @returns {string[]} list of enrichment queries
 */
function buildEnrichmentQueries(complex) {
  const name = complex.name || '';
  const city = complex.city || '';
  const queries = [
    `"${name}" "${city}" נסח טאבו גוש חלקה`,
    `"${name}" "${city}" פינוי בינוי שלב תכנון ועדה מקומית`,
    `"${name}" "${city}" יזם פינוי בינוי הסכם`,
  ];
  if (complex.ilaRisk) {
    queries.push(`"${name}" "${city}" רשות מקרקעי ישראל קרקע מינהל`);
  }
  return queries;
}

module.exports = {
  calcMasRechisha,
  calcInvestorCostBasis,
  masRechishaPenalty,
  formatForReport,
  classifyLandType,
  buildEnrichmentQueries,
};
