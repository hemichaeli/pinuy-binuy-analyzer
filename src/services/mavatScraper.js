const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_BETWEEN_REQUESTS = 4000;

/**
 * Query Perplexity for planning status from mavat/iplan
 */
async function queryPlanStatus(complex) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');

  const planInfo = complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : '';
  
  const prompt = `חפש במערכת התכנון הארצית (mavat.iplan.gov.il) ובמקורות רשמיים מידע עדכני על תכנית פינוי בינוי:
מתחם: ${complex.name}
עיר: ${complex.city}
${planInfo}
כתובות: ${complex.addresses || 'לא צוינו'}

החזר את המידע בפורמט JSON בלבד:
{
  "plan_number": "מספר תכנית אם נמצא",
  "current_status": "אחד מ: declared/planning/pre_deposit/deposited/approved/permit/construction",
  "status_hebrew": "הסטטוס בעברית",
  "last_committee": {
    "type": "local/regional/national",
    "name": "שם הוועדה",
    "date": "YYYY-MM-DD אם ידוע",
    "decision": "תיאור ההחלטה",
    "approved": true/false
  },
  "milestones": [
    {
      "event": "תיאור אירוע",
      "date": "YYYY-MM-DD",
      "status_after": "הסטטוס לאחר האירוע"
    }
  ],
  "next_expected": "מה הצעד הבא הצפוי",
  "objections_period": {
    "active": true/false,
    "deadline": "YYYY-MM-DD אם רלוונטי",
    "num_objections": "מספר התנגדויות אם ידוע"
  },
  "developer": "שם היזם אם נמצא",
  "planned_units": "מספר יחידות מתוכננות",
  "existing_units": "מספר יחידות קיימות",
  "signature_percent": "אחוז חתימות אם ידוע",
  "notes": "הערות נוספות",
  "data_source": "מקור המידע (mavat/עיריה/חדשות)",
  "confidence": "high/medium/low"
}

חשוב:
- אם הסטטוס שונה ממה שידוע (${complex.status}), ציין זאת
- בדוק אם יש החלטות ועדה חדשות מהחודשים האחרונים
- חפש גם באתר העירייה ובחדשות מקומיות
- אם אין מידע, החזר JSON עם confidence: "low"`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are an Israeli urban planning data analyst. Return ONLY valid JSON, no markdown, no explanations.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    return parsePlanResponse(content);
  } catch (err) {
    logger.warn(`Perplexity mavat query failed for ${complex.name}`, { error: err.message });
    return null;
  }
}

/**
 * Parse Perplexity response into structured plan data
 */
function parsePlanResponse(content) {
  try {
    const cleaned = content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const jsonMatch = content.match(/\{[\s\S]*"current_status"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        logger.warn('Failed to parse mavat plan JSON');
      }
    }
    return null;
  }
}

/**
 * Map Hebrew/mixed status to normalized English status
 */
function normalizeStatus(statusStr) {
  if (!statusStr) return null;
  const s = statusStr.toLowerCase().trim();
  const map = {
    'declared': 'declared', 'הוכרז': 'declared',
    'planning': 'planning', 'בתכנון': 'planning', 'תכנון': 'planning',
    'pre_deposit': 'pre_deposit', 'להפקדה': 'pre_deposit',
    'deposited': 'deposited', 'הופקדה': 'deposited', 'הפקדה': 'deposited',
    'approved': 'approved', 'אושרה': 'approved', 'אישור': 'approved',
    'permit': 'permit', 'היתר': 'permit', 'היתר בנייה': 'permit',
    'construction': 'construction', 'בביצוע': 'construction', 'בנייה': 'construction'
  };
  return map[s] || null;
}

/**
 * Status progression order for detecting advancement
 */
const STATUS_ORDER = ['unknown', 'declared', 'planning', 'pre_deposit', 'deposited', 'approved', 'permit', 'construction'];

function isStatusAdvancement(oldStatus, newStatus) {
  const oldIdx = STATUS_ORDER.indexOf(oldStatus || 'unknown');
  const newIdx = STATUS_ORDER.indexOf(newStatus || 'unknown');
  return newIdx > oldIdx;
}

/**
 * Scan and update a single complex from mavat data
 */
async function scanComplex(complexId) {
  const complexResult = await pool.query(
    'SELECT id, name, city, addresses, plan_number, status, developer, existing_units, planned_units, signature_percent FROM complexes WHERE id = $1',
    [complexId]
  );
  if (complexResult.rows.length === 0) throw new Error(`Complex ${complexId} not found`);

  const complex = complexResult.rows[0];
  logger.info(`mavat scan: ${complex.name} (${complex.city})`);

  const planData = await queryPlanStatus(complex);
  if (!planData) {
    return { complex: complex.name, status: 'no_data', updated: false };
  }

  const updates = {};
  let statusChanged = false;
  let committeeUpdate = false;

  // Check for status change
  const newStatus = normalizeStatus(planData.current_status);
  if (newStatus && newStatus !== complex.status) {
    if (isStatusAdvancement(complex.status, newStatus)) {
      updates.status = newStatus;
      statusChanged = true;
      logger.info(`Status change for ${complex.name}: ${complex.status} -> ${newStatus}`);
    }
  }

  // Update plan number if found
  if (planData.plan_number && !complex.plan_number) {
    updates.plan_number = planData.plan_number;
  }

  // Update developer if found
  if (planData.developer && (!complex.developer || complex.developer === 'unknown')) {
    updates.developer = planData.developer;
  }

  // Update units if found
  if (planData.planned_units && !complex.planned_units) {
    const units = parseInt(planData.planned_units);
    if (units > 0) updates.planned_units = units;
  }
  if (planData.existing_units && !complex.existing_units) {
    const units = parseInt(planData.existing_units);
    if (units > 0) updates.existing_units = units;
  }

  // Update signature percent
  if (planData.signature_percent) {
    const pct = parseInt(planData.signature_percent);
    if (pct > 0 && pct <= 100) updates.signature_percent = pct;
  }

  // Store committee decision
  if (planData.last_committee && planData.last_committee.date) {
    committeeUpdate = true;
    // Store in perplexity_summary as structured note
    const committeeNote = `ועדה: ${planData.last_committee.name || planData.last_committee.type} | ` +
      `${planData.last_committee.date} | ` +
      `${planData.last_committee.decision || 'ללא פירוט'} | ` +
      `${planData.last_committee.approved ? 'אושר' : 'לא אושר'}`;
    
    const existingSummary = complex.perplexity_summary || '';
    if (!existingSummary.includes(committeeNote.substring(0, 30))) {
      updates.perplexity_summary = existingSummary
        ? `${existingSummary}\n${committeeNote}`
        : committeeNote;
    }
  }

  // Apply updates
  if (Object.keys(updates).length > 0) {
    const setClauses = [];
    const values = [];
    let paramCount = 0;

    for (const [key, value] of Object.entries(updates)) {
      paramCount++;
      setClauses.push(`${key} = $${paramCount}`);
      values.push(value);
    }

    paramCount++;
    setClauses.push(`last_perplexity_update = NOW()`);

    paramCount++;
    values.push(complexId);

    await pool.query(
      `UPDATE complexes SET ${setClauses.join(', ')} WHERE id = $${paramCount}`,
      values
    );
  }

  return {
    complex: complex.name,
    city: complex.city,
    status: 'ok',
    statusChanged,
    oldStatus: complex.status,
    newStatus: newStatus || complex.status,
    committeeUpdate,
    updatedFields: Object.keys(updates),
    confidence: planData.confidence || 'unknown',
    nextExpected: planData.next_expected || null
  };
}

/**
 * Scan all complexes for planning status updates
 */
async function scanAll(options = {}) {
  const { staleOnly = true, limit = 30, city = null, prioritizeActive = true } = options;

  let query = 'SELECT id, name, city FROM complexes WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (city) {
    paramCount++;
    query += ` AND city = $${paramCount}`;
    params.push(city);
  }

  if (staleOnly) {
    query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '7 days')`;
  }

  // Prioritize complexes in active planning stages
  if (prioritizeActive) {
    query += ` ORDER BY CASE 
      WHEN status IN ('deposited', 'pre_deposit') THEN 1
      WHEN status = 'planning' THEN 2
      WHEN status = 'approved' THEN 3
      WHEN status = 'declared' THEN 4
      ELSE 5
    END, iai_score DESC NULLS LAST`;
  } else {
    query += ' ORDER BY iai_score DESC NULLS LAST';
  }

  paramCount++;
  query += ` LIMIT $${paramCount}`;
  params.push(limit);

  const complexes = await pool.query(query, params);
  const total = complexes.rows.length;

  logger.info(`mavat batch scan: ${total} complexes to scan`);

  let succeeded = 0;
  let failed = 0;
  let statusChanges = 0;
  let committeeUpdates = 0;
  const details = [];

  for (const complex of complexes.rows) {
    try {
      const result = await scanComplex(complex.id);
      succeeded++;
      if (result.statusChanged) statusChanges++;
      if (result.committeeUpdate) committeeUpdates++;
      details.push(result);

      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS));
    } catch (err) {
      failed++;
      details.push({
        complex: complex.name, city: complex.city,
        status: 'error', error: err.message
      });
      logger.warn(`mavat scan failed for ${complex.name}`, { error: err.message });
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info(`mavat batch scan complete: ${succeeded}/${total} ok, ${statusChanges} status changes, ${committeeUpdates} committee updates`);

  return {
    total,
    succeeded,
    failed,
    statusChanges,
    committeeUpdates,
    details
  };
}

module.exports = {
  scanComplex,
  scanAll,
  queryPlanStatus,
  normalizeStatus,
  isStatusAdvancement,
  STATUS_ORDER
};
