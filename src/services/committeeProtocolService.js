/**
 * Committee Protocol Service - פרוטוקולי ועדות תכנון
 * 
 * Extended service for tracking planning committee decisions and protocols.
 * Monitors:
 * - ועדה מקומית לתכנון ובנייה
 * - ועדה מחוזית לתכנון ובנייה  
 * - ועדת ההתנגדויות
 * - ועדת המשנה להתחדשות עירונית
 * 
 * Key events that trigger price increases:
 * - אישור להפקדה
 * - אישור תכנית
 * - אישור היתר בנייה
 * - דחיית התנגדויות
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { queryPerplexity, parseJsonResponse } = require('./perplexityService');

// Municipal planning committee pages
const COMMITTEE_PAGES = {
  'תל אביב': 'https://www.tel-aviv.gov.il/Transparency/Pages/Local.aspx',
  'ירושלים': 'https://www.jerusalem.muni.il/he/municipality/planning/',
  'חיפה': 'https://www.haifa.muni.il/planning/',
  'רמת גן': 'https://www.ramat-gan.muni.il/planning/',
  'גבעתיים': 'https://www.givatayim.muni.il/',
  'הרצליה': 'https://www.herzliya.muni.il/',
  'רעננה': 'https://www.raanana.muni.il/',
  'כפר סבא': 'https://www.kfar-saba.muni.il/',
  'פתח תקווה': 'https://www.petah-tikva.muni.il/',
  'ראשון לציון': 'https://www.rishonlezion.muni.il/',
  'בני ברק': 'https://www.bnei-brak.muni.il/',
  'רמת השרון': 'https://ramat-hasharon.muni.il/',
  'קריית מוצקין': 'https://www.motzkin.muni.il/',
  'קריית ביאליק': 'https://www.qbialik.org.il/',
  'קריית אתא': 'https://www.qiryat-ata.muni.il/'
};

/**
 * Build query for committee protocols
 */
function buildProtocolQuery(complex) {
  return `חפש פרוטוקולים והחלטות של ועדת התכנון והבנייה בעיר ${complex.city} הנוגעים למתחם "${complex.name}".

חפש ב:
1. אתר העירייה - ועדה מקומית לתכנון ובנייה
2. mavat.iplan.gov.il - מידע תכנוני
3. פרוטוקולים של ועדות משנה
4. החלטות ועדה מחוזית

מספר תכנית (אם ידוע): ${complex.plan_number || 'לא ידוע'}

החזר JSON:
{
  "complex_name": "${complex.name}",
  "city": "${complex.city}",
  "recent_decisions": [
    {
      "date": "YYYY-MM-DD",
      "committee": "שם הוועדה (מקומית/מחוזית/התנגדויות)",
      "decision_type": "אישור/דחייה/החזרה לתיקונים/המשך דיון",
      "subject": "נושא ההחלטה",
      "details": "פירוט ההחלטה",
      "vote": "אושר פה אחד / רוב / אחר",
      "conditions": ["תנאים שנקבעו"],
      "next_steps": "מה השלב הבא",
      "protocol_reference": "מספר פרוטוקול"
    }
  ],
  "upcoming_hearings": [
    {
      "date": "YYYY-MM-DD",
      "committee": "שם הוועדה",
      "subject": "נושא הדיון",
      "agenda_item": "מספר סעיף בסדר היום"
    }
  ],
  "objections_status": {
    "has_objections": true/false,
    "count": 0,
    "status": "ממתין לדיון/נדחו/התקבלו חלקית",
    "next_hearing": "YYYY-MM-DD או null"
  },
  "plan_status": {
    "plan_number": "מספר תכנית",
    "current_stage": "הכנה/הפקדה/התנגדויות/אישור",
    "deposit_date": "YYYY-MM-DD או null",
    "approval_date": "YYYY-MM-DD או null",
    "permit_expected": "YYYY-MM או null"
  },
  "price_impact_events": [
    {
      "event": "תיאור האירוע",
      "date": "YYYY-MM-DD",
      "expected_price_change": "עליית מחיר צפויה באחוזים"
    }
  ],
  "sources": ["רשימת מקורות"]
}`;
}

const PROTOCOL_SYSTEM_PROMPT = `You are a planning committee protocol analyst.
Extract decision data from Israeli municipal planning committees.
Focus on events that affect property values:
- Plan approvals (אישורים)
- Deposit announcements (הפקדה)
- Objection decisions (התנגדויות)
- Building permits (היתרים)
Return ONLY valid JSON in Hebrew.
Be precise with dates and committee names.`;

/**
 * Fetch committee decisions for a complex
 */
async function fetchCommitteeDecisions(complexId) {
  const result = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (result.rows.length === 0) {
    throw new Error(`Complex ${complexId} not found`);
  }

  const complex = result.rows[0];
  const prompt = buildProtocolQuery(complex);

  logger.info(`Fetching committee decisions for: ${complex.name} (${complex.city})`);

  try {
    const rawResponse = await queryPerplexity(prompt, PROTOCOL_SYSTEM_PROMPT);
    const data = parseJsonResponse(rawResponse);

    if (!data) {
      return { complexId, name: complex.name, status: 'no_data' };
    }

    // Store recent decisions
    let newDecisions = 0;
    if (data.recent_decisions && data.recent_decisions.length > 0) {
      for (const decision of data.recent_decisions) {
        try {
          // Check for duplicate
          const existing = await pool.query(
            `SELECT id FROM committee_decisions 
             WHERE complex_id = $1 AND decision_date = $2 
             AND committee = $3 AND subject ILIKE $4`,
            [complexId, decision.date || null, decision.committee, `%${decision.subject?.substring(0, 50)}%`]
          );

          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO committee_decisions 
               (complex_id, decision_date, committee, decision_type, subject, 
                details, vote, conditions, next_steps, protocol_reference)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                complexId,
                decision.date || null,
                decision.committee,
                decision.decision_type,
                decision.subject,
                decision.details,
                decision.vote,
                JSON.stringify(decision.conditions || []),
                decision.next_steps,
                decision.protocol_reference
              ]
            );
            newDecisions++;

            // Create alert for important decisions
            if (['אישור', 'אישור להפקדה', 'אושר'].includes(decision.decision_type)) {
              await pool.query(
                `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
                 VALUES ($1, 'committee_approval', $2, $3, 'high', NOW())`,
                [
                  complexId,
                  `✅ ${decision.decision_type}: ${complex.name}`,
                  `${decision.committee}: ${decision.subject}. ${decision.details || ''}`
                ]
              );
            }
          }
        } catch (err) {
          logger.warn(`Error storing decision: ${err.message}`);
        }
      }
    }

    // Store upcoming hearings
    if (data.upcoming_hearings && data.upcoming_hearings.length > 0) {
      for (const hearing of data.upcoming_hearings) {
        try {
          await pool.query(
            `INSERT INTO upcoming_hearings 
             (complex_id, hearing_date, committee, subject, agenda_item)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (complex_id, hearing_date, committee) DO UPDATE
             SET subject = EXCLUDED.subject, agenda_item = EXCLUDED.agenda_item`,
            [
              complexId,
              hearing.date,
              hearing.committee,
              hearing.subject,
              hearing.agenda_item
            ]
          );

          // Create calendar alert for upcoming hearing
          const hearingDate = new Date(hearing.date);
          const today = new Date();
          const daysUntil = Math.ceil((hearingDate - today) / (1000 * 60 * 60 * 24));

          if (daysUntil > 0 && daysUntil <= 14) {
            await pool.query(
              `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
               VALUES ($1, 'upcoming_hearing', $2, $3, 'medium', NOW())
               ON CONFLICT DO NOTHING`,
              [
                complexId,
                `📅 דיון ועדה בעוד ${daysUntil} ימים: ${complex.name}`,
                `${hearing.committee}: ${hearing.subject}`
              ]
            );
          }
        } catch (err) {
          // Ignore duplicates
        }
      }
    }

    // Update objections status
    if (data.objections_status) {
      await pool.query(
        `UPDATE complexes SET 
         has_objections = $1,
         objections_count = $2,
         objections_status = $3,
         next_objection_hearing = $4
         WHERE id = $5`,
        [
          data.objections_status.has_objections,
          data.objections_status.count || 0,
          data.objections_status.status,
          data.objections_status.next_hearing || null,
          complexId
        ]
      );
    }

    // Update plan status
    if (data.plan_status) {
      await pool.query(
        `UPDATE complexes SET 
         plan_number = COALESCE($1, plan_number),
         plan_stage = $2,
         deposit_date = $3,
         approval_date = $4,
         permit_expected = $5,
         last_committee_update = NOW()
         WHERE id = $6`,
        [
          data.plan_status.plan_number,
          data.plan_status.current_stage,
          data.plan_status.deposit_date || null,
          data.plan_status.approval_date || null,
          data.plan_status.permit_expected || null,
          complexId
        ]
      );
    }

    // Store price impact events
    if (data.price_impact_events && data.price_impact_events.length > 0) {
      for (const event of data.price_impact_events) {
        await pool.query(
          `INSERT INTO alerts (complex_id, alert_type, title, description, severity, created_at)
           VALUES ($1, 'price_trigger', $2, $3, 'high', NOW())
           ON CONFLICT DO NOTHING`,
          [
            complexId,
            `💰 אירוע עליית מחיר: ${complex.name}`,
            `${event.event} (${event.date}). צפי: ${event.expected_price_change}`
          ]
        );
      }
    }

    return {
      complexId,
      name: complex.name,
      status: 'success',
      newDecisions,
      upcomingHearings: data.upcoming_hearings?.length || 0,
      hasObjections: data.objections_status?.has_objections || false,
      planStage: data.plan_status?.current_stage,
      priceEvents: data.price_impact_events?.length || 0
    };

  } catch (err) {
    logger.error(`Committee fetch error for ${complex.name}: ${err.message}`);
    return { complexId, name: complex.name, status: 'error', error: err.message };
  }
}

/**
 * Scan all complexes for committee updates
 */
async function scanAllCommittees(options = {}) {
  let query = `
    SELECT id, name, city, plan_number 
    FROM complexes 
    WHERE status IN ('declared', 'planning', 'deposited', 'pre_deposit')
  `;
  const params = [];
  let paramIndex = 1;

  if (options.city) {
    query += ` AND city = $${paramIndex}`;
    params.push(options.city);
    paramIndex++;
  }

  // Only scan if not updated in 3 days
  if (options.staleOnly !== false) {
    query += ` AND (last_committee_update IS NULL OR last_committee_update < NOW() - INTERVAL '3 days')`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';

  if (options.limit) {
    query += ` LIMIT $${paramIndex}`;
    params.push(options.limit);
  }

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`Starting committee scan of ${total} complexes`);

  const results = {
    total,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    totalDecisions: 0,
    totalUpcoming: 0
  };

  for (let i = 0; i < complexes.rows.length; i++) {
    const complex = complexes.rows[i];
    try {
      const result = await fetchCommitteeDecisions(complex.id);
      results.scanned++;
      
      if (result.status === 'success') {
        results.succeeded++;
        results.totalDecisions += result.newDecisions || 0;
        results.totalUpcoming += result.upcomingHearings || 0;
      } else {
        results.failed++;
      }

      logger.info(`[Committee ${i + 1}/${total}] ${complex.name}: ${result.newDecisions || 0} decisions`);
    } catch (err) {
      results.scanned++;
      results.failed++;
      logger.error(`[Committee ${i + 1}/${total}] ${complex.name}: ERROR`);
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 3500));
  }

  logger.info('Committee scan completed', results);
  return results;
}

/**
 * Get upcoming hearings for all complexes
 */
async function getUpcomingHearings(days = 30) {
  const result = await pool.query(`
    SELECT uh.*, c.name as complex_name, c.city, c.iai_score
    FROM upcoming_hearings uh
    JOIN complexes c ON uh.complex_id = c.id
    WHERE uh.hearing_date BETWEEN NOW() AND NOW() + $1::interval
    ORDER BY uh.hearing_date ASC
  `, [`${days} days`]);

  return result.rows;
}

/**
 * Get recent important decisions
 */
async function getRecentDecisions(days = 14) {
  const result = await pool.query(`
    SELECT cd.*, c.name as complex_name, c.city, c.iai_score
    FROM committee_decisions cd
    JOIN complexes c ON cd.complex_id = c.id
    WHERE cd.decision_date > NOW() - $1::interval
    AND cd.decision_type IN ('אישור', 'אישור להפקדה', 'אושר', 'דחיית התנגדות')
    ORDER BY cd.decision_date DESC
  `, [`${days} days`]);

  return result.rows;
}

module.exports = {
  fetchCommitteeDecisions,
  scanAllCommittees,
  getUpcomingHearings,
  getRecentDecisions,
  COMMITTEE_PAGES
};
