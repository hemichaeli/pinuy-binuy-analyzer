/**
 * Committee Tracker Service (Phase 4.1)
 * 
 * Enhanced tracking of planning committee approvals - the #1 price trigger.
 * 
 * Committee Types:
 * - ועדה מקומית (Local) - First major price jump (~10-20%)
 * - ועדה מחוזית (District) - Second major jump (~15-25%)
 * - ועדה ארצית (National) - For large projects, biggest impact
 * 
 * This service:
 * 1. Queries Perplexity for recent committee decisions
 * 2. Tracks upcoming hearings as early warnings
 * 3. Generates CRITICAL alerts when approvals are detected
 * 4. Updates IAI scores based on certainty increase
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { recalculateComplex } = require('./iaiCalculator');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_MS = 3500;

// Committee approval impact on certainty factor
const COMMITTEE_CERTAINTY_BOOST = {
  local: 0.15,    // After local approval
  district: 0.25, // After district approval
  national: 0.35  // After national approval
};

/**
 * Query for recent committee decisions on a specific complex
 */
async function queryCommitteeStatus(complex) {
  if (!process.env.PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY not configured');
  }

  const prompt = `חפש החלטות ועדות תכנון עדכניות לגבי פרויקט פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : ''}
${complex.addresses ? `כתובת: ${complex.addresses}` : ''}

אני מחפש מידע על:
1. האם התכנית נדונה לאחרונה בוועדה מקומית לתכנון ובנייה? מה ההחלטה?
2. האם התכנית נדונה בוועדה המחוזית? מה ההחלטה?
3. האם יש ישיבות ועדה מתוכננות בחודשים הקרובים?
4. מה סטטוס ההפקדה/אישור של התכנית?

חפש באתר מנהל התכנון, iplan, ובאתרי העיריות.

השב בפורמט JSON בלבד:
{
  "local_committee": {
    "discussed": true/false,
    "decision": "approved|rejected|deferred|pending|null",
    "decision_date": "YYYY-MM-DD או null",
    "notes": "פרטי ההחלטה"
  },
  "district_committee": {
    "discussed": true/false,
    "decision": "approved|rejected|deferred|pending|null",
    "decision_date": "YYYY-MM-DD או null",
    "notes": "פרטי ההחלטה"
  },
  "national_committee": {
    "discussed": true/false,
    "decision": "approved|rejected|deferred|pending|null",
    "decision_date": "YYYY-MM-DD או null",
    "notes": "פרטי ההחלטה"
  },
  "upcoming_hearings": [
    {
      "committee": "local|district|national",
      "date": "YYYY-MM-DD",
      "agenda_item": "תיאור"
    }
  ],
  "current_status": "התיאור המילולי של הסטטוס הנוכחי",
  "sources": ["רשימת מקורות"],
  "confidence": "high|medium|low",
  "last_update_found": "YYYY-MM-DD או null"
}`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'אתה מומחה בתכנון ובנייה בישראל. השב בפורמט JSON בלבד. בדוק באתרי iplan.gov.il, מנהל התכנון, ואתרי עיריות.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1200,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    return parseCommitteeResponse(content);
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('Rate limit hit, waiting...');
      await new Promise(r => setTimeout(r, 15000));
      return null;
    }
    logger.error(`Committee query failed: ${complex.name}`, { error: err.message });
    return null;
  }
}

/**
 * Parse committee response JSON
 */
function parseCommitteeResponse(content) {
  try {
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    else {
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }

    const data = JSON.parse(jsonStr);
    
    return {
      local: parseCommitteeDecision(data.local_committee),
      district: parseCommitteeDecision(data.district_committee),
      national: parseCommitteeDecision(data.national_committee),
      upcomingHearings: data.upcoming_hearings || [],
      currentStatus: data.current_status || null,
      sources: data.sources || [],
      confidence: data.confidence || 'low',
      lastUpdateFound: parseDate(data.last_update_found)
    };
  } catch (err) {
    logger.warn('Failed to parse committee response', { error: err.message });
    return null;
  }
}

function parseCommitteeDecision(committee) {
  if (!committee) return { discussed: false, decision: null, date: null, notes: null };
  return {
    discussed: !!committee.discussed,
    decision: normalizeDecision(committee.decision),
    date: parseDate(committee.decision_date),
    notes: committee.notes || null
  };
}

function normalizeDecision(decision) {
  if (!decision || decision === 'null') return null;
  const map = {
    'approved': 'approved', 'אושר': 'approved', 'אושרה': 'approved',
    'rejected': 'rejected', 'נדחה': 'rejected', 'נדחתה': 'rejected',
    'deferred': 'deferred', 'נדחה להמשך דיון': 'deferred', 'הוחזר': 'deferred',
    'pending': 'pending', 'ממתין': 'pending', 'בדיון': 'pending'
  };
  return map[decision.toLowerCase().trim()] || null;
}

function parseDate(dateStr) {
  if (!dateStr || dateStr === 'null') return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

/**
 * Generate alert for committee approval
 */
async function createCommitteeAlert(complexId, complex, committeeType, approvalDate) {
  const committeeNames = {
    local: 'ועדה מקומית',
    district: 'ועדה מחוזית',
    national: 'ועדה ארצית'
  };

  const severityMap = {
    local: 'high',
    district: 'high',
    national: 'high'
  };

  const priceImpact = {
    local: '10-20%',
    district: '15-25%',
    national: '20-30%'
  };

  const title = `🎯 אישור ${committeeNames[committeeType]}: ${complex.name} (${complex.city})`;
  const message = `התכנית אושרה ב${committeeNames[committeeType]} בתאריך ${approvalDate}. ` +
    `צפי לעליית מחירים של ${priceImpact[committeeType]}! ` +
    `זהו טריגר קריטי לרכישה.`;

  await pool.query(
    `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      complexId,
      'committee_approval',
      severityMap[committeeType],
      title,
      message,
      JSON.stringify({
        committee_type: committeeType,
        approval_date: approvalDate,
        expected_price_impact: priceImpact[committeeType]
      })
    ]
  );

  logger.info(`Created committee approval alert: ${complex.name} - ${committeeType}`);
}

/**
 * Generate alert for upcoming hearing
 */
async function createHearingAlert(complexId, complex, hearing) {
  const committeeNames = {
    local: 'ועדה מקומית',
    district: 'ועדה מחוזית',
    national: 'ועדה ארצית'
  };

  const title = `📅 ישיבה קרובה: ${complex.name} (${complex.city})`;
  const message = `התכנית מתוכננת לדיון ב${committeeNames[hearing.committee] || hearing.committee} ` +
    `בתאריך ${hearing.date}. ${hearing.agenda_item || ''}`;

  await pool.query(
    `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      complexId,
      'upcoming_hearing',
      'medium',
      title,
      message,
      JSON.stringify(hearing)
    ]
  );
}

/**
 * Track committee status for a single complex
 */
async function trackComplex(complexId) {
  try {
    const result = await pool.query(
      `SELECT id, name, city, addresses, plan_number, status,
              local_committee_date, district_committee_date, national_committee_date,
              certainty_factor
       FROM complexes WHERE id = $1`,
      [complexId]
    );

    if (result.rows.length === 0) {
      return { status: 'error', error: 'Complex not found' };
    }

    const complex = result.rows[0];
    const data = await queryCommitteeStatus(complex);

    if (!data) {
      return { status: 'no_data', complexId, name: complex.name };
    }

    const updates = {};
    const alerts = [];
    let certaintyBoost = 0;

    // Check local committee
    if (data.local.decision === 'approved' && data.local.date && !complex.local_committee_date) {
      updates.local_committee_date = data.local.date;
      alerts.push({ type: 'local', date: data.local.date });
      certaintyBoost += COMMITTEE_CERTAINTY_BOOST.local;
    }

    // Check district committee
    if (data.district.decision === 'approved' && data.district.date && !complex.district_committee_date) {
      updates.district_committee_date = data.district.date;
      alerts.push({ type: 'district', date: data.district.date });
      certaintyBoost += COMMITTEE_CERTAINTY_BOOST.district;
    }

    // Check national committee (if exists)
    if (data.national.decision === 'approved' && data.national.date && !complex.national_committee_date) {
      updates.national_committee_date = data.national.date;
      alerts.push({ type: 'national', date: data.national.date });
      certaintyBoost += COMMITTEE_CERTAINTY_BOOST.national;
    }

    // Update certainty factor if committees approved
    if (certaintyBoost > 0) {
      const newCertainty = Math.min(2.0, parseFloat(complex.certainty_factor || 1.0) + certaintyBoost);
      updates.certainty_factor = newCertainty.toFixed(2);
    }

    // Apply DB updates
    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
      const values = Object.values(updates);
      values.push(complexId);

      await pool.query(
        `UPDATE complexes SET ${setClauses.join(', ')}, last_mavat_update = NOW() 
         WHERE id = $${values.length}`,
        values
      );

      // Create alerts for new approvals
      for (const alert of alerts) {
        await createCommitteeAlert(complexId, complex, alert.type, alert.date);
      }

      // Recalculate IAI score with new certainty
      if (certaintyBoost > 0) {
        await recalculateComplex(complexId);
      }
    }

    // Track upcoming hearings
    for (const hearing of (data.upcomingHearings || [])) {
      if (hearing.date) {
        await createHearingAlert(complexId, complex, hearing);
      }
    }

    return {
      status: 'success',
      complexId,
      name: complex.name,
      city: complex.city,
      newApprovals: alerts.length,
      upcomingHearings: data.upcomingHearings?.length || 0,
      certaintyBoost,
      confidence: data.confidence
    };

  } catch (err) {
    logger.error(`Committee tracking failed: ${complexId}`, { error: err.message });
    return { status: 'error', complexId, error: err.message };
  }
}

/**
 * Track all complexes in active planning stages
 */
async function trackAll(options = {}) {
  const { city, limit, staleOnly = true } = options;

  // Focus on complexes that are most likely to have committee activity
  let query = `
    SELECT id, name, city, status 
    FROM complexes 
    WHERE status IN ('planning', 'pre_deposit', 'deposited', 'approved')
  `;
  const params = [];
  let paramIdx = 1;

  if (city) {
    query += ` AND city = $${paramIdx}`;
    params.push(city);
    paramIdx++;
  }

  if (staleOnly) {
    query += ` AND (last_mavat_update IS NULL OR last_mavat_update < NOW() - INTERVAL '3 days')`;
  }

  // Prioritize pre_deposit and deposited - most likely to have committee decisions
  query += ` ORDER BY CASE status 
    WHEN 'deposited' THEN 1
    WHEN 'pre_deposit' THEN 2
    WHEN 'approved' THEN 3
    WHEN 'planning' THEN 4
    ELSE 5
  END`;

  if (limit) {
    query += ` LIMIT $${paramIdx}`;
    params.push(limit);
  }

  const result = await pool.query(query, params);
  const complexes = result.rows;

  logger.info(`Committee tracker: scanning ${complexes.length} complexes`);

  const results = {
    total: complexes.length,
    scanned: 0,
    newApprovals: 0,
    upcomingHearings: 0,
    details: []
  };

  for (const complex of complexes) {
    const trackResult = await trackComplex(complex.id);
    results.scanned++;

    if (trackResult.status === 'success') {
      results.newApprovals += trackResult.newApprovals || 0;
      results.upcomingHearings += trackResult.upcomingHearings || 0;
    }

    results.details.push(trackResult);

    if (results.scanned < complexes.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  logger.info(`Committee tracking complete: ${results.newApprovals} new approvals, ${results.upcomingHearings} upcoming hearings`);

  return results;
}

/**
 * Get committee status summary for dashboard
 */
async function getCommitteeSummary() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL) as local_approved,
      COUNT(*) FILTER (WHERE district_committee_date IS NOT NULL) as district_approved,
      COUNT(*) FILTER (WHERE national_committee_date IS NOT NULL) as national_approved,
      COUNT(*) FILTER (WHERE status = 'deposited' AND local_committee_date IS NULL) as awaiting_local,
      COUNT(*) FILTER (WHERE local_committee_date IS NOT NULL AND district_committee_date IS NULL AND status != 'approved') as awaiting_district
    FROM complexes
    WHERE status NOT IN ('unknown', 'construction')
  `);

  const upcomingAlerts = await pool.query(`
    SELECT COUNT(*) as count 
    FROM alerts 
    WHERE alert_type = 'upcoming_hearing' 
      AND created_at > NOW() - INTERVAL '30 days'
      AND is_read = FALSE
  `);

  return {
    localApproved: parseInt(result.rows[0].local_approved),
    districtApproved: parseInt(result.rows[0].district_approved),
    nationalApproved: parseInt(result.rows[0].national_approved),
    awaitingLocal: parseInt(result.rows[0].awaiting_local),
    awaitingDistrict: parseInt(result.rows[0].awaiting_district),
    upcomingHearings: parseInt(upcomingAlerts.rows[0].count)
  };
}

module.exports = {
  trackComplex,
  trackAll,
  queryCommitteeStatus,
  getCommitteeSummary,
  createCommitteeAlert
};
