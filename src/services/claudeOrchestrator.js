/**
 * Claude AI Orchestrator (Phase 4.3)
 * 
 * Uses Claude as the central intelligence to:
 * 1. Query Perplexity for real-time web data
 * 2. Use Claude's reasoning to validate, enrich and consolidate
 * 3. Resolve conflicts between sources
 * 4. Write unified, high-confidence data to DB
 * 
 * Architecture:
 * Perplexity (web search) + Claude (reasoning) → Unified Data → DB
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { recalculateComplex } = require('./iaiCalculator');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const DELAY_MS = 3500;

/**
 * Query Perplexity for real-time web data
 */
async function queryPerplexity(prompt, options = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.post(PERPLEXITY_API, {
      model: options.model || 'sonar',
      messages: [
        { role: 'system', content: options.systemPrompt || 'השב בעברית. החזר מידע מדויק ועדכני.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: options.maxTokens || 2000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    return {
      source: 'perplexity',
      content: response.data.choices?.[0]?.message?.content || '',
      citations: response.data.citations || []
    };
  } catch (err) {
    logger.warn('Perplexity query failed', { error: err.message });
    return null;
  }
}

/**
 * Query Claude for reasoning and validation
 */
async function queryClaude(prompt, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    logger.warn('Claude API key not configured');
    return null;
  }

  try {
    const response = await axios.post(CLAUDE_API, {
      model: options.model || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens || 2000,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: options.systemPrompt || 'אתה מומחה בנדל"ן ישראלי ופינוי-בינוי. נתח מידע בקפידה והחזר JSON מדויק.'
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return {
      source: 'claude',
      content: response.data.content?.[0]?.text || ''
    };
  } catch (err) {
    logger.warn('Claude query failed', { error: err.message });
    return null;
  }
}

/**
 * Parse JSON from AI response (handles markdown code blocks)
 */
function parseJsonResponse(content) {
  if (!content) return null;
  try {
    // Remove markdown code blocks
    let cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    
    // Find JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return JSON.parse(cleaned);
  } catch (e) {
    logger.debug('JSON parse failed', { content: content.substring(0, 200) });
    return null;
  }
}

/**
 * Scan complex using both Perplexity and Claude
 */
async function scanComplexUnified(complexId) {
  const complexResult = await pool.query(
    `SELECT id, name, city, addresses, plan_number, status, developer,
            local_committee_date, district_committee_date,
            theoretical_premium_min, theoretical_premium_max, actual_premium
     FROM complexes WHERE id = $1`,
    [complexId]
  );

  if (complexResult.rows.length === 0) {
    return { status: 'error', error: 'Complex not found' };
  }

  const complex = complexResult.rows[0];
  logger.info(`Unified scan: ${complex.name} (${complex.city})`);

  // Step 1: Query Perplexity for real-time web data
  const perplexityPrompt = `חפש מידע עדכני על פרויקט פינוי בינוי "${complex.name}" ב${complex.city}.
${complex.plan_number ? `מספר תכנית: ${complex.plan_number}` : ''}
${complex.addresses ? `כתובות: ${complex.addresses}` : ''}

מצא:
1. סטטוס התכנית (הוכרזה/בתכנון/הופקדה/אושרה/היתר/בביצוע)
2. אישורי ועדות (מקומית/מחוזית) - תאריכים אם יש
3. שם היזם והחוזק שלו
4. מספר יחידות קיימות ומתוכננות
5. מודעות למכירה פעילות עם מחירים
6. חדשות אחרונות על הפרויקט

החזר JSON:
{
  "status": "declared|planning|pre_deposit|deposited|approved|permit|construction",
  "developer": "שם היזם",
  "developer_strength": "strong|medium|weak",
  "existing_units": מספר,
  "planned_units": מספר,
  "local_committee_date": "YYYY-MM-DD או null",
  "district_committee_date": "YYYY-MM-DD או null",
  "listings": [{"address": "...", "price": מספר, "rooms": מספר, "sqm": מספר}],
  "recent_news": "סיכום חדשות",
  "sources": ["רשימת מקורות"]
}`;

  const perplexityResult = await queryPerplexity(perplexityPrompt, {
    systemPrompt: 'אתה חוקר נדל"ן. החזר JSON בלבד עם מידע עדכני ומדויק.'
  });

  await new Promise(r => setTimeout(r, 1000));

  // Step 2: Query Claude to validate and enrich
  const claudePrompt = `אתה מומחה בפינוי-בינוי בישראל. נתח את המידע הבא על פרויקט "${complex.name}" ב${complex.city}:

**מידע קיים במערכת:**
- סטטוס: ${complex.status}
- יזם: ${complex.developer || 'לא ידוע'}
- ועדה מקומית: ${complex.local_committee_date || 'לא אושר'}
- ועדה מחוזית: ${complex.district_committee_date || 'לא אושר'}
- פרמיה תיאורטית: ${complex.theoretical_premium_min}-${complex.theoretical_premium_max}%

**מידע מ-Perplexity (חיפוש אינטרנט):**
${perplexityResult?.content || 'לא זמין'}

**משימתך:**
1. אמת את המידע מ-Perplexity
2. זהה סתירות בין המקורות
3. העשר עם הידע שלך על שוק הנדל"ן הישראלי
4. הערך את אמינות המידע

החזר JSON:
{
  "validated_status": "הסטטוס המאומת",
  "status_confidence": "high|medium|low",
  "developer": "היזם המאומת",
  "developer_strength": "strong|medium|weak",
  "local_committee": {
    "approved": true/false,
    "date": "YYYY-MM-DD או null",
    "confidence": "high|medium|low"
  },
  "district_committee": {
    "approved": true/false,
    "date": "YYYY-MM-DD או null",
    "confidence": "high|medium|low"
  },
  "units": {
    "existing": מספר או null,
    "planned": מספר או null
  },
  "listings_found": מספר,
  "avg_asking_price_sqm": מספר או null,
  "market_assessment": "הערכת שוק קצרה",
  "recommended_premium": {
    "min": מספר,
    "max": מספר
  },
  "data_conflicts": ["רשימת סתירות אם יש"],
  "update_recommendations": ["מה לעדכן במערכת"],
  "overall_confidence": "high|medium|low"
}`;

  const claudeResult = await queryClaude(claudePrompt, {
    systemPrompt: 'אתה מומחה בכיר בפינוי-בינוי. נתח מידע בקפידה, זהה סתירות, והחזר JSON מדויק בלבד.'
  });

  // Step 3: Parse and unify results
  const perplexityData = parseJsonResponse(perplexityResult?.content);
  const claudeData = parseJsonResponse(claudeResult?.content);

  if (!perplexityData && !claudeData) {
    return {
      status: 'no_data',
      complexId,
      name: complex.name
    };
  }

  // Step 4: Apply unified updates to DB
  const updates = {};
  const changes = [];

  // Use Claude's validated data when available (higher confidence)
  if (claudeData) {
    // Status update (only if high confidence)
    if (claudeData.validated_status && claudeData.status_confidence === 'high') {
      const statusMap = {
        'הוכרז': 'declared', 'בתכנון': 'planning', 'להפקדה': 'pre_deposit',
        'הופקדה': 'deposited', 'אושרה': 'approved', 'היתר': 'permit', 'בביצוע': 'construction'
      };
      const newStatus = statusMap[claudeData.validated_status] || claudeData.validated_status;
      if (newStatus !== complex.status) {
        updates.status = newStatus;
        changes.push({ type: 'status', old: complex.status, new: newStatus });
      }
    }

    // Developer update
    if (claudeData.developer && !complex.developer) {
      updates.developer = claudeData.developer;
    }
    if (claudeData.developer_strength) {
      updates.developer_strength = claudeData.developer_strength;
    }

    // Committee dates (high confidence only)
    if (claudeData.local_committee?.approved && claudeData.local_committee?.date && 
        claudeData.local_committee.confidence === 'high' && !complex.local_committee_date) {
      updates.local_committee_date = claudeData.local_committee.date;
      changes.push({ type: 'committee', committee: 'local', date: claudeData.local_committee.date });
    }

    if (claudeData.district_committee?.approved && claudeData.district_committee?.date &&
        claudeData.district_committee.confidence === 'high' && !complex.district_committee_date) {
      updates.district_committee_date = claudeData.district_committee.date;
      changes.push({ type: 'committee', committee: 'district', date: claudeData.district_committee.date });
    }

    // Units
    if (claudeData.units?.existing && !complex.existing_units) {
      updates.existing_units = claudeData.units.existing;
    }
    if (claudeData.units?.planned && !complex.planned_units) {
      updates.planned_units = claudeData.units.planned;
    }

    // Premium recommendation
    if (claudeData.recommended_premium?.min && claudeData.recommended_premium?.max) {
      if (!complex.theoretical_premium_min) {
        updates.theoretical_premium_min = claudeData.recommended_premium.min;
        updates.theoretical_premium_max = claudeData.recommended_premium.max;
      }
    }
  }

  // Fallback to Perplexity data for missing fields
  if (perplexityData && !claudeData) {
    if (perplexityData.status) {
      const statusMap = {
        'declared': 'declared', 'planning': 'planning', 'pre_deposit': 'pre_deposit',
        'deposited': 'deposited', 'approved': 'approved', 'permit': 'permit', 'construction': 'construction'
      };
      if (statusMap[perplexityData.status] && statusMap[perplexityData.status] !== complex.status) {
        updates.status = statusMap[perplexityData.status];
      }
    }
    if (perplexityData.developer && !complex.developer) {
      updates.developer = perplexityData.developer;
    }
  }

  // Store AI summary
  const summary = [
    claudeData?.market_assessment,
    perplexityData?.recent_news
  ].filter(Boolean).join(' | ');

  if (summary) {
    updates.perplexity_summary = summary.substring(0, 2000);
  }

  // Apply updates
  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    const values = Object.values(updates);
    values.push(complexId);

    await pool.query(
      `UPDATE complexes SET ${setClauses.join(', ')}, 
       last_perplexity_update = NOW(), updated_at = NOW()
       WHERE id = $${values.length}`,
      values
    );

    // Recalculate IAI if significant changes
    if (changes.length > 0) {
      await recalculateComplex(complexId);
    }
  }

  // Process listings from Perplexity
  let listingsProcessed = 0;
  if (perplexityData?.listings?.length > 0) {
    for (const listing of perplexityData.listings) {
      try {
        await processListingFromAI(listing, complexId, complex.city);
        listingsProcessed++;
      } catch (e) {
        logger.debug('Listing process failed', { error: e.message });
      }
    }
  }

  return {
    status: 'success',
    complexId,
    name: complex.name,
    city: complex.city,
    sources: {
      perplexity: !!perplexityData,
      claude: !!claudeData
    },
    confidence: claudeData?.overall_confidence || 'medium',
    changes,
    updatedFields: Object.keys(updates),
    listingsProcessed,
    conflicts: claudeData?.data_conflicts || []
  };
}

/**
 * Process a listing from AI response
 */
async function processListingFromAI(listing, complexId, city) {
  const price = parseFloat(listing.price) || null;
  const rooms = parseFloat(listing.rooms) || null;
  const sqm = parseFloat(listing.sqm || listing.area_sqm) || null;
  const address = listing.address || '';

  if (!price || !address) return;

  const pricePsm = (price && sqm) ? Math.round(price / sqm) : null;
  const sourceId = `ai-${complexId}-${address}-${price}`;

  await pool.query(
    `INSERT INTO listings (
      complex_id, source, source_listing_id,
      asking_price, rooms, area_sqm, price_per_sqm,
      address, city, first_seen, last_seen, is_active
    ) VALUES ($1, 'ai_scan', $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE, CURRENT_DATE, TRUE)
    ON CONFLICT DO NOTHING`,
    [complexId, sourceId, price, rooms, sqm, pricePsm, address, city]
  );
}

/**
 * Scan all complexes with unified AI
 */
async function scanAllUnified(options = {}) {
  const { city, limit = 20, staleOnly = true } = options;

  let query = `
    SELECT id, name, city 
    FROM complexes 
    WHERE status NOT IN ('construction', 'unknown')
  `;
  const params = [];
  let paramIdx = 1;

  if (city) {
    query += ` AND city = $${paramIdx}`;
    params.push(city);
    paramIdx++;
  }

  if (staleOnly) {
    query += ` AND (last_perplexity_update IS NULL OR last_perplexity_update < NOW() - INTERVAL '5 days')`;
  }

  query += ` ORDER BY iai_score DESC NULLS LAST LIMIT $${paramIdx}`;
  params.push(limit);

  const result = await pool.query(query, params);
  const complexes = result.rows;

  logger.info(`Unified AI scan: ${complexes.length} complexes`);

  const results = {
    total: complexes.length,
    scanned: 0,
    succeeded: 0,
    changes: 0,
    details: []
  };

  for (const complex of complexes) {
    try {
      const scanResult = await scanComplexUnified(complex.id);
      results.scanned++;

      if (scanResult.status === 'success') {
        results.succeeded++;
        results.changes += scanResult.changes?.length || 0;
      }

      results.details.push(scanResult);
      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      logger.error(`Unified scan failed: ${complex.name}`, { error: err.message });
      results.details.push({ status: 'error', complexId: complex.id, error: err.message });
    }
  }

  logger.info(`Unified scan complete: ${results.succeeded}/${results.total} ok, ${results.changes} changes`);
  return results;
}

/**
 * Check if Claude API is configured
 */
function isClaudeConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
}

module.exports = {
  scanComplexUnified,
  scanAllUnified,
  queryPerplexity,
  queryClaude,
  isClaudeConfigured
};
