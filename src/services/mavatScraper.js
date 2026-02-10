/**
 * mavat Planning Scraper + Claude Validation (Phase 4.4)
 * 
 * Enhanced scraper that:
 * 1. Queries Perplexity for mavat/iplan planning data
 * 2. Uses Claude to validate and enrich the data
 * 3. Tracks committee approvals (critical price triggers)
 * 4. Monitors upcoming hearings for early warnings
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const DELAY_MS = 4000;

/**
 * Query Perplexity for planning status
 */
async function queryPerplexity(complex) {
  if (!process.env.PERPLEXITY_API_KEY) return null;

  const prompt = `חפש מידע עדכני על תכנית פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : ''}

מצא:
1. סטטוס התכנית
2. אישור ועדה מקומית - תאריך
3. אישור ועדה מחוזית - תאריך  
4. ישיבות ועדה קרובות
5. מספר תכנית

החזר JSON:
{
  "status": "declared|planning|deposited|approved|permit|construction",
  "plan_number": "מספר או null",
  "local_committee": {"approved": true/false, "date": "YYYY-MM-DD"},
  "district_committee": {"approved": true/false, "date": "YYYY-MM-DD"},
  "upcoming_hearing": {"description": "תיאור", "date": "YYYY-MM-DD"},
  "developer": "שם היזם",
  "notes": "הערות"
}`;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'השב ב-JSON בלבד.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return response.data.choices?.[0]?.message?.content || '';
  } catch (err) {
    logger.warn(`Perplexity mavat failed: ${err.message}`);
    return null;
  }
}

/**
 * Query Claude to validate planning data
 */
async function queryClaude(complex, perplexityData) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) return null;

  const prompt = `אמת את המידע על תכנית "${complex.name}" ב${complex.city}:

**מידע קיים:**
- סטטוס: ${complex.status}
- ועדה מקומית: ${complex.local_committee_date || 'לא'}
- ועדה מחוזית: ${complex.district_committee_date || 'לא'}

**מידע מאינטרנט:**
${perplexityData || 'לא זמין'}

**החזר JSON:**
{
  "validated_status": "סטטוס מאומת",
  "status_confidence": "high|medium|low",
  "local_committee": {"approved": bool, "date": "YYYY-MM-DD", "confidence": "high|medium|low"},
  "district_committee": {"approved": bool, "date": "YYYY-MM-DD", "confidence": "high|medium|low"},
  "upcoming_hearing": "תיאור או null",
  "developer": "יזם מאומת",
  "conflicts": ["סתירות"],
  "recommendation": "המלצה"
}`;

  try {
    const response = await axios.post(CLAUDE_API, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      system: 'אתה מומחה פינוי-בינוי. החזר JSON בלבד.'
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    return response.data.content?.[0]?.text || '';
  } catch (err) {
    logger.warn(`Claude mavat failed: ${err.message}`);
    return null;
  }
}

/**
 * Parse JSON from AI response
 */
function parseJson(content) {
  if (!content) return null;
  try {
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize status string
 */
function normalizeStatus(status) {
  if (!status) return null;
  const map = {
    'declared': 'declared', 'הוכרז': 'declared', 'הוכרזה': 'declared',
    'planning': 'planning', 'בתכנון': 'planning',
    'pre_deposit': 'pre_deposit', 'להפקדה': 'pre_deposit',
    'deposited': 'deposited', 'הופקדה': 'deposited',
    'approved': 'approved', 'אושרה': 'approved', 'אושר': 'approved',
    'permit': 'permit', 'היתר': 'permit',
    'construction': 'construction', 'בביצוע': 'construction'
  };
  return map[status.toLowerCase().trim()] || null;
}

/**
 * Parse date string
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'null') return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

/**
 * Create alert for committee approval
 */
async function createCommitteeAlert(complexId, complexName, city, committeeType, date) {
  const impact = committeeType === 'local' ? '10-20%' : '15-25%';
  const hebrewType = committeeType === 'local' ? 'מקומית' : 'מחוזית';
  
  await pool.query(
    `INSERT INTO alerts (complex_id, alert_type, severity, title, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      complexId,
      'committee_approval',
      'high',
      `🎯 אישור ועדה ${hebrewType}: ${complexName}`,
      `${complexName} (${city}) קיבל אישור ועדה ${hebrewType} ב-${date}. צפי לעליית מחירים של ${impact}.`,
      JSON.stringify({ committee_type: committeeType, date, expected_impact: impact })
    ]
  );
}

/**
 * Scan a single complex with Perplexity + Claude
 */
async function scanComplex(complexId) {
  const result = await pool.query(
    `SELECT id, name, city, addresses, plan_number, status, developer,
            local_committee_date, district_committee_date
     FROM complexes WHERE id = $1`,
    [complexId]
  );

  if (result.rows.length === 0) {
    return { status: 'error', error: 'Complex not found' };
  }

  const complex = result.rows[0];
  logger.info(`mavat scan: ${complex.name} (${complex.city})`);

  // Query Perplexity
  const perplexityRaw = await queryPerplexity(complex);
  const perplexityData = parseJson(perplexityRaw);

  // Query Claude for validation
  const claudeRaw = await queryClaude(complex, perplexityRaw);
  const claudeData = parseJson(claudeRaw);

  const changes = [];
  const updates = {};

  // Use Claude data if available (higher confidence), fallback to Perplexity
  const data = claudeData || perplexityData;
  if (!data) {
    await pool.query('UPDATE complexes SET last_mavat_update = NOW() WHERE id = $1', [complexId]);
    return { status: 'no_data', complexId, name: complex.name };
  }

  // Status update (high confidence only from Claude)
  const newStatus = normalizeStatus(data.validated_status || data.status);
  if (newStatus && newStatus !== complex.status) {
    const statusOrder = ['declared', 'planning', 'pre_deposit', 'deposited', 'approved', 'permit', 'construction'];
    const oldIdx = statusOrder.indexOf(complex.status);
    const newIdx = statusOrder.indexOf(newStatus);

    if (newIdx > oldIdx || (claudeData?.status_confidence === 'high')) {
      updates.status = newStatus;
      changes.push({ type: 'status_change', old: complex.status, new: newStatus });
    }
  }

  // Local committee
  const localCommittee = data.local_committee || {};
  if (localCommittee.approved && !complex.local_committee_date) {
    const date = parseDate(localCommittee.date);
    if (date && (!claudeData || localCommittee.confidence !== 'low')) {
      updates.local_committee_date = date;
      changes.push({ type: 'committee_approval', committee: 'local', date });
      await createCommitteeAlert(complexId, complex.name, complex.city, 'local', date);
    }
  }

  // District committee
  const districtCommittee = data.district_committee || {};
  if (districtCommittee.approved && !complex.district_committee_date) {
    const date = parseDate(districtCommittee.date);
    if (date && (!claudeData || districtCommittee.confidence !== 'low')) {
      updates.district_committee_date = date;
      changes.push({ type: 'committee_approval', committee: 'district', date });
      await createCommitteeAlert(complexId, complex.name, complex.city, 'district', date);
    }
  }

  // Developer
  if (data.developer && !complex.developer) {
    updates.developer = data.developer;
  }

  // Plan number
  if (data.plan_number && !complex.plan_number) {
    updates.plan_number = data.plan_number;
  }

  // Upcoming hearing
  if (data.upcoming_hearing) {
    updates.planning_notes = typeof data.upcoming_hearing === 'string' 
      ? data.upcoming_hearing 
      : `ישיבה: ${data.upcoming_hearing.description || ''} ${data.upcoming_hearing.date || ''}`.trim();
  }

  // Apply updates
  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    const values = [...Object.values(updates), complexId];
    
    await pool.query(
      `UPDATE complexes SET ${setClauses.join(', ')}, last_mavat_update = NOW() WHERE id = $${values.length}`,
      values
    );
  } else {
    await pool.query('UPDATE complexes SET last_mavat_update = NOW() WHERE id = $1', [complexId]);
  }

  return {
    status: 'success',
    complexId,
    name: complex.name,
    city: complex.city,
    sources: { perplexity: !!perplexityData, claude: !!claudeData },
    changes,
    updatedFields: Object.keys(updates),
    conflicts: claudeData?.conflicts || []
  };
}

/**
 * Scan all complexes
 */
async function scanAll(options = {}) {
  const { city, limit, staleOnly = true } = options;

  let query = `SELECT id, name, city FROM complexes WHERE status != 'construction'`;
  const params = [];
  let idx = 1;

  if (city) {
    query += ` AND city = $${idx}`;
    params.push(city);
    idx++;
  }

  if (staleOnly) {
    query += ` AND (last_mavat_update IS NULL OR last_mavat_update < NOW() - INTERVAL '5 days')`;
  }

  query += ` ORDER BY CASE status 
    WHEN 'pre_deposit' THEN 1 WHEN 'deposited' THEN 2 WHEN 'planning' THEN 3 
    WHEN 'declared' THEN 4 ELSE 5 END`;

  if (limit) {
    query += ` LIMIT $${idx}`;
    params.push(limit);
  }

  const result = await pool.query(query, params);
  const complexes = result.rows;

  logger.info(`mavat scan: ${complexes.length} complexes`);

  const results = {
    total: complexes.length,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    statusChanges: 0,
    committeeApprovals: 0,
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
      } else {
        results.failed++;
      }

      results.details.push(scanResult);
      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      results.failed++;
      results.scanned++;
      logger.error(`mavat error: ${complex.name}`, { error: err.message });
    }
  }

  logger.info(`mavat complete: ${results.succeeded}/${results.total}, ${results.statusChanges} status, ${results.committeeApprovals} approvals`);
  return results;
}

module.exports = {
  scanComplex,
  scanAll,
  queryPerplexity,
  queryClaude,
  normalizeStatus
};
