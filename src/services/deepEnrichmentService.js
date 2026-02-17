const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * Deep Enrichment Service v1.1
 * Fills ALL missing fields in complexes table using multiple data sources:
 * 1. Perplexity AI (addresses, developer info, neighborhood, news, prices)
 * 2. nadlan.gov.il API (actual transaction prices -> actual_premium calculation)
 * 3. Internal data (calculate city_avg from existing transactions)
 * 
 * v1.1: Added retry with backoff for 429 rate limits, async batch tracking
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';
const NADLAN_API_URL = 'https://www.nadlan.gov.il/Nadlan.REST/Main/GetAssestAndDeals';
const DELAY_MS = 8000;         // 8s between phases (was 4s)
const BETWEEN_COMPLEX_MS = 5000; // 5s between complexes (was 2s)
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 15000;  // 15s initial backoff on 429

// In-memory batch job tracker
const batchJobs = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getBatchStatus(jobId) {
  return batchJobs[jobId] || null;
}

function getAllBatchJobs() {
  return Object.entries(batchJobs).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    progress: `${job.enriched}/${job.total}`,
    fieldsUpdated: job.totalFieldsUpdated,
    errors: job.errors,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  }));
}

async function queryPerplexity(prompt, systemPrompt, retryCount = 0) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  try {
    const response = await axios.post(PERPLEXITY_API_URL, {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });

    return response.data.choices[0].message.content;
  } catch (err) {
    // Retry on 429 with exponential backoff
    if (err.response && err.response.status === 429 && retryCount < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      logger.info(`Rate limited (429), retry ${retryCount + 1}/${MAX_RETRIES} after ${backoffMs/1000}s`);
      await sleep(backoffMs);
      return queryPerplexity(prompt, systemPrompt, retryCount + 1);
    }
    throw err;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch(e) {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) try { return JSON.parse(m[1].trim()); } catch(e) {}
  const o = text.match(/\{[\s\S]*\}/);
  if (o) try { return JSON.parse(o[0]); } catch(e) {}
  return null;
}

// ============================================================
// PHASE 1: Address + Neighborhood + Building Details
// ============================================================
function buildAddressQuery(complex) {
  return `חפש מידע מדויק על מתחם פינוי-בינוי "${complex.name}" ב${complex.city}.
כתובות ידועות: ${complex.addresses || 'לא ידוע'}
מספר תוכנית: ${complex.plan_number || 'לא ידוע'}

החזר JSON בלבד:
{
  "precise_addresses": [
    {"street": "שם רחוב", "building_numbers": [1,3,5], "num_units": 12}
  ],
  "neighborhood": "שם שכונה",
  "num_buildings": 0,
  "total_existing_units": 0,
  "area_dunam": 0,
  "signature_percent": null,
  "plan_stage": "שלב התוכנית (הוכרזה/הופקדה/אושרה/היתר/בביצוע)",
  "permit_expected": "YYYY-MM-DD או null",
  "objections_count": 0,
  "has_objections": false,
  "objections_status": "תיאור קצר או null"
}

חפש ב: mavat.iplan.gov.il, dira.moch.gov.il, עיריית ${complex.city}, globes, calcalist
החזר JSON בלבד ללא טקסט נוסף.`;
}

// ============================================================
// PHASE 2: Developer Intelligence
// ============================================================
function buildDeveloperQuery(complex) {
  return `חפש מידע על חברת "${complex.developer}" (יזם נדל"ן בישראל).

החזר JSON בלבד:
{
  "company_number": "מספר חברה ברשם החברות או null",
  "developer_status": "פעיל/בקשיים/בפירוק/לא ידוע",
  "risk_level": "low/medium/high",
  "risk_score": 0,
  "reputation_score": 0,
  "red_flags": ["רשימת דגלים אדומים אם יש"],
  "active_projects_count": 0,
  "completed_projects_count": 0,
  "news_sentiment": "positive/neutral/negative/mixed",
  "recent_news": "סיכום חדשות אחרונות על החברה"
}

חפש ב: רשם החברות, globes.co.il, calcalist.co.il, themarker.com, madlan.co.il
החזר JSON בלבד.`;
}

// ============================================================
// PHASE 3: Pricing + Market Intelligence  
// ============================================================
function buildPricingQuery(complex) {
  const addr = complex.addresses || complex.name;
  return `חפש מחירי נדל"ן עדכניים באזור "${addr}" ב${complex.city}.
שכונה: ${complex.neighborhood || 'לא ידוע'}

החזר JSON בלבד:
{
  "avg_price_sqm_old_buildings": 0,
  "avg_price_sqm_new_buildings": 0,
  "city_avg_price_sqm": 0,
  "price_trend": "rising/stable/falling",
  "yearly_price_change_percent": 0,
  "comparable_new_projects": [
    {"name": "שם", "price_per_sqm": 0, "developer": "יזם"}
  ],
  "estimated_new_price_sqm": 0,
  "estimated_old_price_sqm": 0,
  "actual_premium_percent": 0,
  "premium_calculation": "הסבר חישוב הפרמיה: (מחיר_חדש - מחיר_ישן) / מחיר_ישן * 100"
}

מחיר_ישן = מחיר דירה ישנה באזור המתחם (לפני פינוי-בינוי)
מחיר_חדש = מחיר דירה חדשה שהדיירים יקבלו (פרויקטים חדשים באזור)
פרמיה = (חדש - ישן) / ישן * 100

חפש ב: nadlan.gov.il, madlan.co.il, yad2.co.il
החזר JSON בלבד.`;
}

// ============================================================
// PHASE 4: News + Sentiment
// ============================================================
function buildNewsQuery(complex) {
  return `חפש חדשות אחרונות (6 חודשים אחרונים) על מתחם פינוי-בינוי "${complex.name}" ב${complex.city}.
יזם: ${complex.developer || 'לא ידוע'}

החזר JSON בלבד:
{
  "has_negative_news": false,
  "news_sentiment": "positive/neutral/negative/mixed",
  "news_summary": "סיכום קצר של החדשות",
  "key_events": [
    {"date": "YYYY-MM-DD", "event": "תיאור", "source": "מקור"}
  ],
  "enforcement_cases": false,
  "bankruptcy_proceedings": false,
  "property_liens": false,
  "receivership": false,
  "inheritance_property": false
}

חפש ב: globes, calcalist, themarker, ynet, mako, הודעות בתי משפט
החזר JSON בלבד.`;
}

const SYSTEM_PROMPT = `You are a real estate data extraction specialist for Israeli Pinuy-Binuy projects.
Return ONLY valid JSON. No explanations, no markdown, no text outside JSON.
If you don't have data, use null (not "null" string). Numbers as numbers, not strings.
All prices in ILS. Search Hebrew sources for accuracy.
IMPORTANT: Do not invent data. If unsure, use null.`;

// ============================================================
// NADLAN.GOV.IL - Actual transaction prices
// ============================================================
async function fetchNadlanTransactions(street, city) {
  try {
    const payload = {
      ObjectID: '', CurrentLavel: 1, PageNo: 1,
      OrderByFilled: 'DEALDATETIME', OrderByDescend: true,
      TblCity: city, TblStreet: street,
      TblHouseNum: '', TblArea: '', TblDistrict: '',
      FromDate: '', ToDate: '', Rone: '', Polygon: '',
      FromPrice: '', ToPrice: '', FromRoom: '', ToRoom: '',
      FromFloor: '', ToFloor: '', FromBuildYear: '', ToBuildYear: '',
      FromArea: '', ToArea: ''
    };

    const resp = await axios.post(NADLAN_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const results = resp.data.AllResults || resp.data.ResultLavel1 || [];
    if (!Array.isArray(results)) return [];

    return results.map(tx => ({
      date: tx.DEALDATETIME || tx.DEALDATE,
      price: parseFloat(tx.DEALAMOUNT) || 0,
      area_sqm: parseFloat(tx.ASSETAREA) || 0,
      rooms: parseFloat(tx.ASSETROOMNUM) || 0,
      floor: parseInt(tx.FLOORNO) || 0,
      address: `${tx.ASSETADDRESS || street} ${tx.ASSETHOUSENUMBER || ''}`.trim(),
      build_year: parseInt(tx.BUILDINGYEAR) || 0,
      price_per_sqm: 0
    })).map(tx => ({
      ...tx,
      price_per_sqm: tx.area_sqm > 0 ? Math.round(tx.price / tx.area_sqm) : 0
    }));
  } catch (err) {
    logger.warn(`Nadlan fetch failed for ${street}, ${city}: ${err.message}`);
    return [];
  }
}

// ============================================================
// Calculate city average from transactions
// ============================================================
async function calculateCityAverage(city) {
  try {
    const result = await pool.query(
      `SELECT AVG(price_per_sqm) as avg_ppsm, COUNT(*) as count
       FROM transactions 
       WHERE city = $1 AND price_per_sqm > 0 
       AND transaction_date > NOW() - INTERVAL '24 months'`,
      [city]
    );
    if (result.rows[0] && result.rows[0].count > 0) {
      return Math.round(parseFloat(result.rows[0].avg_ppsm));
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ============================================================
// MAIN: Deep Enrich a Single Complex
// ============================================================
async function deepEnrichComplex(complexId) {
  const res = await pool.query('SELECT * FROM complexes WHERE id = $1', [complexId]);
  if (res.rows.length === 0) throw new Error(`Complex ${complexId} not found`);
  const complex = res.rows[0];

  logger.info(`Deep enriching: ${complex.name} (${complex.city}) [ID: ${complexId}]`);

  const updates = {};
  let errors = [];

  // --- PHASE 1: Address + Planning Details ---
  try {
    const addressData = parseJson(await queryPerplexity(buildAddressQuery(complex), SYSTEM_PROMPT));
    if (addressData) {
      if (addressData.neighborhood) updates.neighborhood = addressData.neighborhood;
      if (addressData.num_buildings) updates.num_buildings = addressData.num_buildings;
      if (addressData.signature_percent) updates.signature_percent = addressData.signature_percent;
      if (addressData.plan_stage) updates.plan_stage = addressData.plan_stage;
      if (addressData.permit_expected) updates.permit_expected = addressData.permit_expected;
      if (addressData.objections_count !== undefined) updates.objections_count = addressData.objections_count;
      if (addressData.has_objections !== undefined) updates.has_objections = addressData.has_objections;
      if (addressData.objections_status) updates.objections_status = addressData.objections_status;

      if (addressData.precise_addresses && addressData.precise_addresses.length > 0) {
        const addrParts = addressData.precise_addresses.map(a => {
          const nums = a.building_numbers ? a.building_numbers.join(',') : '';
          return `${a.street} ${nums}`.trim();
        });
        updates.address = addrParts.join('; ');
        if (!complex.addresses || complex.addresses.length < updates.address.length) {
          updates.addresses = updates.address;
        }
      }
    }
  } catch (err) {
    errors.push(`Phase 1 (address): ${err.message}`);
    logger.warn(`Phase 1 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(DELAY_MS);

  // --- PHASE 2: Developer Intelligence ---
  if (complex.developer) {
    try {
      const devData = parseJson(await queryPerplexity(buildDeveloperQuery(complex), SYSTEM_PROMPT));
      if (devData) {
        if (devData.company_number) updates.developer_company_number = devData.company_number;
        if (devData.developer_status) updates.developer_status = devData.developer_status;
        if (devData.risk_score !== undefined) updates.developer_risk_score = devData.risk_score;
        if (devData.risk_level) updates.developer_risk_level = devData.risk_level;
        if (devData.reputation_score !== undefined) updates.developer_reputation_score = devData.reputation_score;
        if (devData.red_flags && devData.red_flags.length > 0) {
          updates.developer_red_flags = JSON.stringify(devData.red_flags);
        }
        if (devData.news_sentiment) updates.developer_news_sentiment = devData.news_sentiment;
        updates.developer_last_verified = new Date().toISOString();
      }
    } catch (err) {
      errors.push(`Phase 2 (developer): ${err.message}`);
      logger.warn(`Phase 2 failed for ${complex.name}`, { error: err.message });
    }
  }

  await sleep(DELAY_MS);

  // --- PHASE 3: Pricing Intelligence ---
  try {
    const priceData = parseJson(await queryPerplexity(buildPricingQuery(complex), SYSTEM_PROMPT));
    if (priceData) {
      if (priceData.estimated_old_price_sqm) updates.accurate_price_sqm = priceData.estimated_old_price_sqm;
      if (priceData.city_avg_price_sqm) updates.city_avg_price_sqm = priceData.city_avg_price_sqm;
      if (priceData.price_trend) updates.price_trend = priceData.price_trend;
      if (priceData.yearly_price_change_percent !== undefined) updates.yearly_price_change = priceData.yearly_price_change_percent;
      if (priceData.actual_premium_percent) updates.actual_premium = priceData.actual_premium_percent;

      if (priceData.estimated_new_price_sqm) {
        updates.estimated_premium_price = Math.round(priceData.estimated_new_price_sqm * 80);
      }

      if (priceData.estimated_old_price_sqm && priceData.city_avg_price_sqm) {
        updates.price_vs_city_avg = Math.round(
          ((priceData.estimated_old_price_sqm - priceData.city_avg_price_sqm) / priceData.city_avg_price_sqm) * 100
        );
      }

      updates.price_confidence_score = priceData.price_trend ? 70 : 30;
      updates.price_last_updated = new Date().toISOString();
      updates.price_sources = JSON.stringify(['perplexity', 'nadlan', 'madlan']);
    }
  } catch (err) {
    errors.push(`Phase 3 (pricing): ${err.message}`);
    logger.warn(`Phase 3 failed for ${complex.name}`, { error: err.message });
  }

  await sleep(DELAY_MS);

  // --- PHASE 3b: nadlan.gov.il direct transactions ---
  try {
    const streets = (complex.addresses || '').split(',').map(s => s.trim()).filter(Boolean);
    let allTx = [];
    for (const street of streets.slice(0, 3)) {
      const cleanStreet = street.replace(/\d+/g, '').replace(/[-]/g, '').trim();
      if (cleanStreet.length > 2) {
        const tx = await fetchNadlanTransactions(cleanStreet, complex.city);
        allTx.push(...tx);
        await sleep(2000);
      }
    }

    if (allTx.length > 0) {
      let newCount = 0;
      for (const tx of allTx) {
        if (!tx.price || tx.price === 0) continue;
        try {
          const existing = await pool.query(
            `SELECT id FROM transactions WHERE complex_id = $1 AND price = $2 
             AND transaction_date::text LIKE $3`,
            [complexId, tx.price, `${(tx.date || '').substring(0, 10)}%`]
          );
          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO transactions (complex_id, transaction_date, price, area_sqm, rooms, floor, price_per_sqm, address, city, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'nadlan_gov')`,
              [complexId, tx.date, tx.price, tx.area_sqm, tx.rooms, tx.floor, tx.price_per_sqm, tx.address, complex.city]
            );
            newCount++;
          }
        } catch (e) { /* skip duplicates */ }
      }

      const recentTx = allTx.filter(t => t.price_per_sqm > 0).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (recentTx.length > 0) {
        const avgPriceSqm = Math.round(recentTx.slice(0, 10).reduce((s, t) => s + t.price_per_sqm, 0) / Math.min(recentTx.length, 10));
        if (!updates.accurate_price_sqm || avgPriceSqm > 0) {
          updates.accurate_price_sqm = avgPriceSqm;
          updates.price_confidence_score = Math.min(95, 50 + recentTx.length * 5);
          updates.price_sources = JSON.stringify(['nadlan_gov', 'perplexity']);
        }
      }

      logger.info(`Nadlan.gov.il: ${newCount} new transactions for ${complex.name}`);
    }
  } catch (err) {
    errors.push(`Phase 3b (nadlan): ${err.message}`);
  }

  // --- PHASE 4: News + Distress Indicators ---
  try {
    const newsData = parseJson(await queryPerplexity(buildNewsQuery(complex), SYSTEM_PROMPT));
    if (newsData) {
      if (newsData.has_negative_news !== undefined) updates.has_negative_news = newsData.has_negative_news;
      if (newsData.news_sentiment) updates.news_sentiment = newsData.news_sentiment;
      if (newsData.news_summary) updates.news_summary = newsData.news_summary;
      if (newsData.enforcement_cases !== undefined) updates.has_enforcement_cases = newsData.enforcement_cases;
      if (newsData.bankruptcy_proceedings !== undefined) updates.has_bankruptcy_proceedings = newsData.bankruptcy_proceedings;
      if (newsData.property_liens !== undefined) updates.has_property_liens = newsData.property_liens;
      if (newsData.receivership !== undefined) updates.is_receivership = newsData.receivership;
      if (newsData.inheritance_property !== undefined) updates.is_inheritance_property = newsData.inheritance_property;
      updates.last_news_check = new Date().toISOString();
    }
  } catch (err) {
    errors.push(`Phase 4 (news): ${err.message}`);
  }

  // --- PHASE 5: Calculate city average from DB ---
  try {
    const cityAvg = await calculateCityAverage(complex.city);
    if (cityAvg && !updates.city_avg_price_sqm) {
      updates.city_avg_price_sqm = cityAvg;
    }
  } catch (err) { /* non-critical */ }

  // --- WRITE ALL UPDATES TO DB ---
  const validUpdates = Object.entries(updates).filter(([k, v]) => v !== undefined && v !== null);
  
  if (validUpdates.length > 0) {
    const setClauses = validUpdates.map(([k], i) => `${k} = $${i + 1}`);
    const values = validUpdates.map(([, v]) => v);
    values.push(complexId);

    const sql = `UPDATE complexes SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`;
    
    try {
      await pool.query(sql, values);
      logger.info(`Deep enrichment complete for ${complex.name}: ${validUpdates.length} fields updated`, {
        fields: validUpdates.map(([k]) => k)
      });
    } catch (err) {
      logger.error(`DB update failed for ${complex.name}`, { error: err.message, sql: sql.substring(0, 200) });
      errors.push(`DB update: ${err.message}`);
    }
  }

  return {
    complexId,
    name: complex.name,
    city: complex.city,
    fieldsUpdated: validUpdates.length,
    updatedFields: validUpdates.map(([k]) => k),
    errors: errors.length > 0 ? errors : null,
    status: errors.length === 0 ? 'success' : 'partial'
  };
}

// ============================================================
// Batch: Enrich all complexes (prioritize high IAI first)
// Returns job ID for async tracking
// ============================================================
async function enrichAll(options = {}) {
  const { limit = 20, city, minIai = 0, staleOnly = true } = options;

  let query = 'SELECT id, name, city, iai_score FROM complexes WHERE iai_score >= $1';
  const params = [minIai];

  if (city) {
    params.push(city);
    query += ` AND city = $${params.length}`;
  }

  if (staleOnly) {
    query += ` AND (price_last_updated IS NULL OR price_last_updated < NOW() - INTERVAL '14 days')`;
  }

  query += ' ORDER BY iai_score DESC NULLS LAST';
  params.push(limit);
  query += ` LIMIT $${params.length}`;

  const complexes = await pool.query(query, params);
  
  // Create job tracker
  const jobId = `batch_${Date.now()}`;
  batchJobs[jobId] = {
    status: 'running',
    total: complexes.rows.length,
    enriched: 0,
    totalFieldsUpdated: 0,
    errors: 0,
    currentComplex: null,
    details: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  logger.info(`Deep enrichment batch ${jobId}: ${complexes.rows.length} complexes`);

  // Process in background (don't await)
  processEnrichmentBatch(jobId, complexes.rows).catch(err => {
    logger.error(`Batch ${jobId} crashed`, { error: err.message });
    batchJobs[jobId].status = 'error';
    batchJobs[jobId].completedAt = new Date().toISOString();
  });

  return {
    jobId,
    status: 'started',
    total: complexes.rows.length,
    message: `Batch enrichment started. Track progress at GET /api/enrichment/batch/${jobId}`
  };
}

async function processEnrichmentBatch(jobId, complexes) {
  const job = batchJobs[jobId];

  for (const c of complexes) {
    try {
      job.currentComplex = `${c.name} (${c.city})`;
      const result = await deepEnrichComplex(c.id);
      job.enriched++;
      job.totalFieldsUpdated += result.fieldsUpdated;
      if (result.errors) job.errors++;
      job.details.push(result);
      await sleep(BETWEEN_COMPLEX_MS);
    } catch (err) {
      job.errors++;
      job.details.push({ complexId: c.id, name: c.name, status: 'error', error: err.message });
      logger.error(`Deep enrichment failed for ${c.name}`, { error: err.message });
      // Continue with next complex even on error
      await sleep(BETWEEN_COMPLEX_MS);
    }
  }

  job.status = 'completed';
  job.currentComplex = null;
  job.completedAt = new Date().toISOString();
  logger.info(`Batch ${jobId} complete: ${job.enriched}/${job.total} enriched, ${job.totalFieldsUpdated} fields updated`);
}

module.exports = { deepEnrichComplex, enrichAll, getBatchStatus, getAllBatchJobs };
