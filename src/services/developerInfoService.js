/**
 * Developer Info Service - מידע על יזמים מרשם החברות
 * 
 * Provides intelligence on developers and construction companies:
 * - רשם החברות data
 * - Financial health indicators
 * - Past project track record
 * - Legal issues and liens
 * - Company ownership structure
 * 
 * Red flags to identify:
 * - הגבלה חמורה בבנק ישראל
 * - שעבודים ומשכונות
 * - תביעות משפטיות
 * - פירוק/כינוס נכסים
 * - היסטוריית פרויקטים בעייתיים
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryPerplexity, parseJsonResponse } = require('./perplexityService');

// Registrar of Companies URL
const COMPANIES_REGISTRAR = 'https://ica.justice.gov.il/GenericCorporarionInfo/SearchCorporation?unit=8';

/**
 * Build query for developer information
 */
function buildDeveloperQuery(developerName, city = null) {
  const locationHint = city ? `באזור ${city}` : 'בישראל';
  
  return `חפש מידע על חברת הנדל"ן/היזם "${developerName}" ${locationHint}.

חפש ב:
1. רשם החברות (ica.justice.gov.il)
2. אתרי חדשות עסקיים (גלובס, כלכליסט, דה מרקר)
3. בתי משפט (נט המשפט)
4. פרויקטים קודמים ומוניטין

החזר JSON:
{
  "company_name": "${developerName}",
  "registration_number": "ח.פ.",
  "registration_status": "פעילה/מחוקה/בפירוק",
  "founded_year": 0,
  "registered_address": "כתובת רשומה",
  "financial_health": {
    "status": "good/warning/critical",
    "bank_restrictions": true/false,
    "liens_count": 0,
    "mortgages_count": 0,
    "recent_financial_news": "חדשות פיננסיות אחרונות"
  },
  "ownership": {
    "owners": [
      {
        "name": "שם הבעלים",
        "role": "בעל מניות/דירקטור",
        "share_percent": 0
      }
    ],
    "parent_company": "חברת אם אם יש",
    "subsidiaries": ["חברות בנות"]
  },
  "track_record": {
    "total_projects": 0,
    "completed_projects": 0,
    "ongoing_projects": 0,
    "notable_projects": [
      {
        "name": "שם הפרויקט",
        "location": "עיר",
        "units": 0,
        "status": "הושלם/בבנייה/בעיות",
        "year": 0
      }
    ],
    "delivery_history": "בזמן/עיכובים/בעיות",
    "customer_satisfaction": "high/medium/low/unknown"
  },
  "legal_issues": {
    "has_lawsuits": true/false,
    "lawsuit_count": 0,
    "lawsuit_types": ["סוגי תביעות"],
    "notable_cases": ["תיאור תביעות משמעותיות"],
    "receiver_appointed": false,
    "bankruptcy_proceedings": false
  },
  "contractor_license": {
    "has_license": true/false,
    "license_category": "סיווג קבלן",
    "valid_until": "YYYY-MM-DD או null"
  },
  "risk_score": {
    "overall": "low/medium/high/critical",
    "factors": ["גורמי סיכון"]
  },
  "news": [
    {
      "date": "YYYY-MM-DD",
      "source": "מקור",
      "headline": "כותרת",
      "sentiment": "positive/negative/neutral"
    }
  ],
  "confidence": "high/medium/low",
  "sources": ["רשימת מקורות"]
}`;
}

const DEVELOPER_SYSTEM_PROMPT = `You are a business intelligence analyst specializing in Israeli real estate developers.
Extract comprehensive data about construction companies and developers.
Focus on risk indicators and financial health.
Return ONLY valid JSON in Hebrew.
Be especially careful about:
- Bank restrictions (הגבלות)
- Liens and mortgages (שעבודים ומשכונות)
- Lawsuits (תביעות)
- Project delivery history
- Financial stability`;

/**
 * Fetch developer information
 */
async function fetchDeveloperInfo(developerName, city = null) {
  logger.info(`Fetching developer info: ${developerName}`);

  const prompt = buildDeveloperQuery(developerName, city);

  try {
    const rawResponse = await queryPerplexity(prompt, DEVELOPER_SYSTEM_PROMPT);
    const data = parseJsonResponse(rawResponse);

    if (!data) {
      return { name: developerName, status: 'no_data' };
    }

    // Store developer info
    const result = await pool.query(
      `INSERT INTO developers (
        name, registration_number, registration_status, founded_year,
        registered_address, financial_status, bank_restrictions,
        liens_count, mortgages_count, total_projects, completed_projects,
        has_lawsuits, lawsuit_count, receiver_appointed, bankruptcy_proceedings,
        contractor_license_category, license_valid_until,
        risk_score, risk_factors, ownership_data, track_record_data,
        last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
      ON CONFLICT (name) DO UPDATE SET
        registration_status = EXCLUDED.registration_status,
        financial_status = EXCLUDED.financial_status,
        bank_restrictions = EXCLUDED.bank_restrictions,
        liens_count = EXCLUDED.liens_count,
        has_lawsuits = EXCLUDED.has_lawsuits,
        lawsuit_count = EXCLUDED.lawsuit_count,
        risk_score = EXCLUDED.risk_score,
        risk_factors = EXCLUDED.risk_factors,
        last_updated = NOW()
      RETURNING id`,
      [
        developerName,
        data.registration_number || null,
        data.registration_status,
        data.founded_year || null,
        data.registered_address || null,
        data.financial_health?.status || 'unknown',
        data.financial_health?.bank_restrictions || false,
        data.financial_health?.liens_count || 0,
        data.financial_health?.mortgages_count || 0,
        data.track_record?.total_projects || 0,
        data.track_record?.completed_projects || 0,
        data.legal_issues?.has_lawsuits || false,
        data.legal_issues?.lawsuit_count || 0,
        data.legal_issues?.receiver_appointed || false,
        data.legal_issues?.bankruptcy_proceedings || false,
        data.contractor_license?.license_category || null,
        data.contractor_license?.valid_until || null,
        data.risk_score?.overall || 'unknown',
        JSON.stringify(data.risk_score?.factors || []),
        JSON.stringify(data.ownership || {}),
        JSON.stringify(data.track_record || {})
      ]
    );

    const developerId = result.rows[0]?.id;

    // Create alerts for high-risk developers
    if (data.risk_score?.overall === 'high' || data.risk_score?.overall === 'critical') {
      // Find complexes with this developer
      const complexes = await pool.query(
        `SELECT id, name FROM complexes WHERE developer ILIKE $1`,
        [`%${developerName}%`]
      );

      for (const complex of complexes.rows) {
        await pool.query(
          `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
           VALUES ($1, 'developer_risk', $2, $3, 'high', NOW())
           ON CONFLICT DO NOTHING`,
          [
            complex.id,
            `⚠️ סיכון יזם גבוה: ${developerName}`,
            `גורמי סיכון: ${data.risk_score?.factors?.join(', ') || 'לא ידוע'}`
          ]
        );
      }
    }

    // Store notable news
    if (data.news && data.news.length > 0) {
      for (const news of data.news.slice(0, 5)) {
        try {
          await pool.query(
            `INSERT INTO developer_news (developer_id, news_date, source, headline, sentiment)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [developerId, news.date, news.source, news.headline, news.sentiment]
          );
        } catch (err) {
          // Ignore
        }
      }
    }

    return {
      name: developerName,
      status: 'success',
      registrationNumber: data.registration_number,
      financialHealth: data.financial_health?.status,
      riskScore: data.risk_score?.overall,
      hasLawsuits: data.legal_issues?.has_lawsuits,
      projectCount: data.track_record?.total_projects,
      developerId
    };

  } catch (err) {
    logger.error(`Developer fetch error for ${developerName}: ${err.message}`);
    return { name: developerName, status: 'error', error: err.message };
  }
}

/**
 * Get developer by ID
 */
async function getDeveloper(developerId) {
  const result = await pool.query(
    'SELECT * FROM developers WHERE id = $1',
    [developerId]
  );
  return result.rows[0] || null;
}

/**
 * Get developer by name
 */
async function getDeveloperByName(name) {
  const result = await pool.query(
    'SELECT * FROM developers WHERE name ILIKE $1',
    [`%${name}%`]
  );
  return result.rows[0] || null;
}

/**
 * Update all developers associated with complexes
 */
async function updateAllDevelopers() {
  // Get unique developers from complexes
  const developers = await pool.query(`
    SELECT DISTINCT developer 
    FROM complexes 
    WHERE developer IS NOT NULL AND developer != ''
  `);

  logger.info(`Updating ${developers.rows.length} developers`);

  const results = {
    total: developers.rows.length,
    updated: 0,
    failed: 0,
    highRisk: 0
  };

  for (const dev of developers.rows) {
    try {
      const result = await fetchDeveloperInfo(dev.developer);
      
      if (result.status === 'success') {
        results.updated++;
        if (result.riskScore === 'high' || result.riskScore === 'critical') {
          results.highRisk++;
        }
      } else {
        results.failed++;
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 3500));
    } catch (err) {
      results.failed++;
    }
  }

  logger.info('Developer update completed', results);
  return results;
}

/**
 * Get risk report for all developers
 */
async function getDeveloperRiskReport() {
  const result = await pool.query(`
    SELECT d.*, 
           COUNT(c.id) as complex_count,
           SUM(COALESCE(c.official_planned_units, 0)) as total_planned_units
    FROM developers d
    LEFT JOIN complexes c ON c.developer ILIKE '%' || d.name || '%'
    WHERE d.risk_score IN ('high', 'critical')
    GROUP BY d.id
    ORDER BY 
      CASE d.risk_score 
        WHEN 'critical' THEN 1 
        WHEN 'high' THEN 2 
        ELSE 3 
      END,
      complex_count DESC
  `);

  return result.rows;
}

/**
 * Check developer before investing in a complex
 */
async function checkDeveloperForComplex(complexId) {
  const complex = await pool.query(
    'SELECT id, name, city, developer FROM complexes WHERE id = $1',
    [complexId]
  );

  if (complex.rows.length === 0 || !complex.rows[0].developer) {
    return { status: 'no_developer' };
  }

  const developerName = complex.rows[0].developer;
  
  // Check if we have recent data
  const existing = await pool.query(
    `SELECT * FROM developers 
     WHERE name ILIKE $1 
     AND last_updated > NOW() - INTERVAL '7 days'`,
    [`%${developerName}%`]
  );

  if (existing.rows.length > 0) {
    return {
      status: 'cached',
      developer: existing.rows[0],
      recommendation: getDeveloperRecommendation(existing.rows[0])
    };
  }

  // Fetch fresh data
  const result = await fetchDeveloperInfo(developerName, complex.rows[0].city);
  
  if (result.status === 'success') {
    const developer = await getDeveloperByName(developerName);
    return {
      status: 'fresh',
      developer,
      recommendation: getDeveloperRecommendation(developer)
    };
  }

  return { status: 'error', error: result.error };
}

/**
 * Generate investment recommendation based on developer profile
 */
function getDeveloperRecommendation(developer) {
  if (!developer) return { recommendation: 'unknown', reason: 'No developer data' };

  const warnings = [];
  const positives = [];

  // Financial health
  if (developer.bank_restrictions) {
    warnings.push('הגבלה בבנק ישראל');
  }
  if (developer.liens_count > 5) {
    warnings.push(`${developer.liens_count} שעבודים רשומים`);
  }

  // Legal issues
  if (developer.bankruptcy_proceedings) {
    warnings.push('הליכי פשיטת רגל');
    return { recommendation: 'avoid', reason: warnings.join(', '), warnings, positives };
  }
  if (developer.receiver_appointed) {
    warnings.push('מונה כונס נכסים');
    return { recommendation: 'avoid', reason: warnings.join(', '), warnings, positives };
  }
  if (developer.has_lawsuits && developer.lawsuit_count > 10) {
    warnings.push(`${developer.lawsuit_count} תביעות פתוחות`);
  }

  // Track record
  if (developer.completed_projects > 10) {
    positives.push(`${developer.completed_projects} פרויקטים הושלמו`);
  }
  if (developer.financial_status === 'good') {
    positives.push('מצב פיננסי טוב');
  }

  // Risk score
  if (developer.risk_score === 'critical') {
    return { 
      recommendation: 'avoid', 
      reason: 'סיכון קריטי', 
      warnings, 
      positives 
    };
  }
  if (developer.risk_score === 'high') {
    return { 
      recommendation: 'caution', 
      reason: 'סיכון גבוה - נדרשת בדיקה מעמיקה', 
      warnings, 
      positives 
    };
  }
  if (warnings.length >= 3) {
    return { 
      recommendation: 'caution', 
      reason: 'מספר דגלים אדומים', 
      warnings, 
      positives 
    };
  }

  if (positives.length >= 2 && warnings.length === 0) {
    return { 
      recommendation: 'positive', 
      reason: 'יזם אמין', 
      warnings, 
      positives 
    };
  }

  return { 
    recommendation: 'neutral', 
    reason: 'נדרשת בדיקה נוספת', 
    warnings, 
    positives 
  };
}

module.exports = {
  fetchDeveloperInfo,
  getDeveloper,
  getDeveloperByName,
  updateAllDevelopers,
  getDeveloperRiskReport,
  checkDeveloperForComplex,
  getDeveloperRecommendation,
  COMPANIES_REGISTRAR
};
