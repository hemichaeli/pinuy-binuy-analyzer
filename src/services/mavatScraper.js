/**
 * mavat Planning Scraper + Committee Tracking (Tasks 5 & 6)
 * 
 * Uses Perplexity AI to query Israel's planning authority (mavat/iplan)
 * for status updates and committee approval events.
 * 
 * Key triggers tracked:
 * - Local committee (ועדה מקומית) approvals
 * - District committee (ועדה מחוזית) approvals
 * - Plan deposits (הפקדה)
 * - Plan approvals (אישור תכנית)
 * - Permit issuance (היתר בנייה)
 * 
 * Committee approvals are critical price triggers:
 * - Local committee approval = first major price jump
 * - District committee = second wave
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_MS = 4000; // Rate limit between API calls

/**
 * Query Perplexity for planning status of a specific complex
 */
async function queryPlanningStatus(complex) {
  if (!process.env.PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY not configured');
  }

  const prompt = `חפש מידע עדכני על תכנית פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : ''}
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}

אני מחפש מידע ספציפי על:
1. סטטוס עדכני של התכנית (הוכרזה/בתכנון/הופקדה/אושרה/היתר/בביצוע)
2. האם התכנית עברה אישור ועדה מקומית? אם כן, מתי?
3. האם התכנית עברה אישור ועדה מחוזית? אם כן, מתי?
4. האם יש ישיבות ועדה קרובות הקשורות לתכנית?
5. מספר תכנית (אם ידוע)
6. תאריכי אבני דרך: הכרזה, הפקדה, אישור, היתר

השב בפורמט JSON בלבד:
{
  "status": "declared|planning|pre_deposit|deposited|approved|permit|construction",
  "plan_number": "מספר תכנית או null",
  "local_committee_approved": true/false,
  "local_committee_date": "YYYY-MM-DD או null",
  "district_committee_approved": true/false,
  "district_committee_date": "YYYY-MM-DD או null",
  "upcoming_hearing": "תיאור ישיבה קרובה או null",
  "upcoming_hearing_date": "YYYY-MM-DD או null",
  "milestones": {
    "declaration_date": "YYYY-MM-DD או null",
    "deposit_date": "YYYY-MM-DD או null",
    "approval_date": "YYYY-MM-DD או null",
    "permit_date": "YYYY-MM-DD או null"
  },
  "notes": "הערות נוספות",
  "confidence": "high|medium|low"
}`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'אתה מומחה בתכנון ובנייה בישראל. השב בפורמט JSON בלבד, ללא טקסט נוסף. אם אינך בטוח, סמן confidence כ-low.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data.choices?.[0]?.message?.content || '';
    return parseResponse(content);
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('Perplexity rate limit hit, waiting 10s...');
      await new Promise(r => setTimeout(r, 10000));
      return null;
    }
    logger.error(`Perplexity mavat query failed for ${complex.name}`, { error: err.message });
    return null;
  }
}

/**
 * Parse Perplexity JSON response
 */
function parseResponse(content) {
  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else {
      // Try to find raw JSON object
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }

    const data = JSON.parse(jsonStr);
    return {
      status: normalizeStatus(data.status),
      plan_number: data.plan_number || null,
      local_committee_approved: !!data.local_committee_approved,
      local_committee_date: parseDate(data.local_committee_date),
      district_committee_approved: !!data.district_committee_approved,
      district_committee_date: parseDate(data.district_committee_date),
      upcoming_hearing: data.upcoming_hearing || null,
      upcoming_hearing_date: parseDate(data.upcoming_hearing_date),
      milestones: data.milestones || {},
      notes: data.notes || null,
      confidence: data.confidence || 'low'
    };
  } catch (err) {
    logger.warn('Failed to parse mavat response', { error: err.message, content: content.substring(0, 200) });
    return null;
  }
}

/**
 * Normalize status string to DB enum
 */
function normalizeStatus(status) {
  if (!status) return null;
  const statusMap = {
    'declared': 'declared', 'הוכרז': 'declared', 'הוכרזה': 'declared',
    'planning': 'planning', 'בתכנון': 'planning', 'תכנון': 'planning',
    'pre_deposit': 'pre_deposit', 'להפקדה': 'pre_deposit',
    'deposited': 'deposited', 'הופקדה': 'deposited', 'הפקדה': 'deposited',
    'approved': 'approved', 'אושרה': 'approved', 'אושר': 'approved', 'מאושר': 'approved',
    'permit': 'permit', 'היתר': 'permit', 'היתר בנייה': 'permit',
    'construction': 'construction', 'בביצוע': 'construction', 'בנייה': 'construction'
  };
  return statusMap[status.toLowerCase().trim()] || null;
}

/**
 * Parse date string, return null if invalid
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'null' || dateStr === 'undefined') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/**
 * Scan a single complex for planning updates
 */
async function scanComplex(complexId) {
  try {
    const result = await pool.query(
      `SELECT id, name, city, addresses, plan_number, status, 
              local_committee_date, district_committee_date,
              declaration_date, deposit_date, approval_date, permit_date
       FROM complexes WHERE id = $1`,
      [complexId]
    );

    if (result.rows.length === 0) {
      return { status: 'error', error: 'Complex not found', complexId };
    }

    const complex = result.rows[0];
    const data = await queryPlanningStatus(complex);

    if (!data) {
      return { status: 'no_data', complexId, name: complex.name };
    }

    // Track what changed
    const changes = [];
    const updates = {};

    // Status change detection
    if (data.status && data.status !== complex.status) {
      const statusOrder = ['declared', 'planning', 'pre_deposit', 'deposited', 'approved', 'permit', 'construction'];
      const oldIdx = statusOrder.indexOf(complex.status);
      const newIdx = statusOrder.indexOf(data.status);

      // Only update if moving forward (or if confidence is high)
      if (newIdx > oldIdx || data.confidence === 'high') {
        changes.push({
          type: 'status_change',
          old: complex.status,
          new: data.status
        });
        updates.status = data.status;
      }
    }

    // Plan number update
    if (data.plan_number && !complex.plan_number) {
      updates.plan_number = data.plan_number;
    }

    // Committee tracking
    if (data.local_committee_approved && data.local_committee_date && !complex.local_committee_date) {
      updates.local_committee_date = data.local_committee_date;
      changes.push({
        type: 'committee_approval',
        committee: 'local',
        date: data.local_committee_date
      });
    }

    if (data.district_committee_approved && data.district_committee_date && !complex.district_committee_date) {
      updates.district_committee_date = data.district_committee_date;
      changes.push({
        type: 'committee_approval',
        committee: 'district',
        date: data.district_committee_date
      });
    }

    // Milestone dates (only fill in missing dates)
    const milestones = data.milestones || {};
    if (milestones.declaration_date && !complex.declaration_date) {
      updates.declaration_date = milestones.declaration_date;
    }
    if (milestones.deposit_date && !complex.deposit_date) {
      updates.deposit_date = milestones.deposit_date;
    }
    if (milestones.approval_date && !complex.approval_date) {
      updates.approval_date = milestones.approval_date;
    }
    if (milestones.permit_date && !complex.permit_date) {
      updates.permit_date = milestones.permit_date;
    }

    // Upcoming hearing info stored in notes
    if (data.upcoming_hearing) {
      const hearingNote = `ישיבה קרובה: ${data.upcoming_hearing}${data.upcoming_hearing_date ? ` (${data.upcoming_hearing_date})` : ''}`;
      updates.planning_notes = hearingNote;
    }

    // Apply updates to DB
    if (Object.keys(updates).length > 0) {
      const setClauses = [];
      const values = [];
      let paramIdx = 1;

      for (const [key, value] of Object.entries(updates)) {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }

      setClauses.push(`last_mavat_update = NOW()`);
      values.push(complexId);

      await pool.query(
        `UPDATE complexes SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
        values
      );
    } else {
      // Just update the timestamp
      await pool.query(
        `UPDATE complexes SET last_mavat_update = NOW() WHERE id = $1`,
        [complexId]
      );
    }

    return {
      status: 'success',
      complexId,
      name: complex.name,
      city: complex.city,
      changes,
      updatedFields: Object.keys(updates),
      confidence: data.confidence,
      upcomingHearing: data.upcoming_hearing || null,
      source: 'perplexity_mavat'
    };
  } catch (err) {
    logger.error(`mavat scan failed for complex ${complexId}`, { error: err.message });
    return { status: 'error', complexId, error: err.message };
  }
}

/**
 * Scan all complexes for planning updates
 */
async function scanAll(options = {}) {
  const { city, limit, staleOnly = true, statusFilter } = options;

  let query = 'SELECT id, name, city, status FROM complexes WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  if (city) {
    query += ` AND city = $${paramIdx}`;
    params.push(city);
    paramIdx++;
  }

  if (statusFilter) {
    query += ` AND status = $${paramIdx}`;
    params.push(statusFilter);
    paramIdx++;
  }

  // Skip complexes in construction (no more planning changes expected)
  query += ` AND status != 'construction'`;

  if (staleOnly) {
    query += ` AND (last_mavat_update IS NULL OR last_mavat_update < NOW() - INTERVAL '7 days')`;
  }

  // Prioritize complexes in active planning stages
  query += ` ORDER BY CASE status 
    WHEN 'pre_deposit' THEN 1
    WHEN 'deposited' THEN 2
    WHEN 'planning' THEN 3
    WHEN 'declared' THEN 4
    WHEN 'approved' THEN 5
    WHEN 'permit' THEN 6
    ELSE 7
  END, last_mavat_update ASC NULLS FIRST`;

  if (limit) {
    query += ` LIMIT $${paramIdx}`;
    params.push(limit);
  }

  const result = await pool.query(query, params);
  const complexes = result.rows;

  logger.info(`mavat scan: ${complexes.length} complexes to scan`);

  const results = {
    total: complexes.length,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    statusChanges: 0,
    committeeApprovals: 0,
    upcomingHearings: 0,
    details: []
  };

  for (const complex of complexes) {
    try {
      const scanResult = await scanComplex(complex.id);
      results.scanned++;

      if (scanResult.status === 'success') {
        results.succeeded++;
        
        for (const change of (scanResult.changes || [])) {
          if (change.type === 'status_change') results.statusChanges++;
          if (change.type === 'committee_approval') results.committeeApprovals++;
        }
        if (scanResult.upcomingHearing) results.upcomingHearings++;
      } else {
        results.failed++;
      }

      results.details.push(scanResult);

      // Rate limiting
      if (results.scanned < complexes.length) {
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    } catch (err) {
      logger.error(`mavat scan error for ${complex.name}`, { error: err.message });
      results.failed++;
      results.scanned++;
    }
  }

  logger.info(`mavat scan complete: ${results.succeeded}/${results.total} ok, ` +
    `${results.statusChanges} status changes, ${results.committeeApprovals} committee approvals, ` +
    `${results.upcomingHearings} upcoming hearings`);

  return results;
}

module.exports = {
  scanComplex,
  scanAll,
  queryPlanningStatus,
  normalizeStatus
};
