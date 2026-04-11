/**
 * Facebook Groups Scraper — Perplexity Sonar
 *
 * Two modes:
 *   1. GROUP SCAN — search known pinuy-binuy FB groups for listings
 *   2. COMPLEX SCAN — search the entire web (FB + Yad2 + forums) for a
 *      specific complex by name+city. Used for the investor pilot programme.
 *
 * v2: Auto phone extraction from listing URLs (for listings without phones)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const BATCH_SIZE = 3;
const DELAY_MS = 1500;
const ENRICH_DELAY_MS = 500;

// Israeli phone regex — mobile + landline
const IL_PHONE_REGEX = /(?:\+972|972|0)[-\s.]?(?:5[0-9]|[2-9])[-\s.]?\d{3}[-\s.]?\d{4}/g;

// ============================================================
// PILOT COMPLEXES — targeted search (Track B)
// ============================================================
const PILOT_COMPLEXES = [
  { id: 250,  name: 'שיכון ויצמן',                city: 'הרצליה',    addresses: 'שכונת וייצמן' },
  { id: 205,  name: 'מתחם דליה',                   city: 'בת ים',     addresses: 'דליה, כ"ט בנובמבר, אנה פרנק' },
  { id: 1077, name: 'מתחם הטייסים - בן צבי',       city: 'נס ציונה',  addresses: 'הטייסים 20-32' },
  { id: 64,   name: 'רמת ורבר',                    city: 'פתח תקווה', addresses: 'כצנלסון, יצחק שדה, צה"ל' },
  { id: 122,  name: 'מעגלי יבנה (גוננים)',          city: 'ירושלים',   addresses: 'מעגלי יבנה, גוננים' },
  { id: 458,  name: 'מתחם העצמאות',               city: 'נס ציונה',  addresses: 'העצמאות 17-25' },
  { id: 1240, name: 'מתחם בוליביה - אברהם שטרן',   city: 'רמת גן',    addresses: 'אברהם שטרן, בוליביה' },
  { id: 769,  name: 'כיכר התחנה',                  city: 'לוד',       addresses: 'דוד המלך, רבי טרפון, הנשיא' }
];

// ============================================================
// KNOWN PINUY-BINUY FACEBOOK GROUPS
// ============================================================
const FB_GROUPS = [
  { id: '374280285021074',  name: 'פינוי בינוי | התחדשות עירונית',                         url: 'https://www.facebook.com/groups/374280285021074',  cities: null },
  { id: '1920472201728581', name: 'עסקאות מכר נדל"ן - פינוי בינוי חתום 100%',             url: 'https://www.facebook.com/groups/1920472201728581', cities: null },
  { id: '1281594211934148', name: 'יזמות תמ"א 38 פינוי בינוי / פרויקטים למכירה וקנייה',  url: 'https://www.facebook.com/groups/1281594211934148', cities: null },
  { id: '715476131887115',  name: 'כרישי נדל"ן - פינוי-בינוי | פריסייל | ערך',           url: 'https://www.facebook.com/groups/715476131887115',  cities: null },
  { id: '1778188822296883', name: 'פריסייל ישראל | דירות חדשות מקבלן | התחדשות עירונית', url: 'https://www.facebook.com/groups/1778188822296883', cities: null },
  { id: '1833093740933553', name: 'דירות למכירה / פינוי בינוי / מציאות נדל"ן',           url: 'https://www.facebook.com/groups/1833093740933553', cities: null },
  { id: '1061700308964053', name: 'דירות למכירה פינוי בינוי בחולון',                      url: 'https://www.facebook.com/groups/1061700308964053', cities: ['חולון'] },
  { id: '1374467126144215', name: 'דירות למכירה בתל אביב',                                url: 'https://www.facebook.com/groups/1374467126144215', cities: ['תל אביב', 'תל אביב יפו'] },
  { id: '570765253256345',  name: 'דירות למכירה בתל אביב (2)',                            url: 'https://www.facebook.com/groups/570765253256345',  cities: ['תל אביב', 'תל אביב יפו'] },
  { id: '525610664799369',  name: 'הקבוצה של רמת גן גבעתיים',                            url: 'https://www.facebook.com/groups/525610664799369',  cities: ['רמת גן', 'גבעתיים'] },
  { id: '446273700552631',  name: 'דירות למכירה בתל אביב - שפירא',                       url: 'https://www.facebook.com/groups/446273700552631',  cities: ['תל אביב', 'תל אביב יפו'] },
  { id: '3303947573209051', name: 'פורום נפגעי התמ"א ופינוי בינוי',                      url: 'https://www.facebook.com/groups/3303947573209051', cities: null }
];

// ============================================================
// PHONE CLEANUP
// ============================================================
function cleanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  return digits.startsWith('0') ? digits : '0' + digits;
}

// ============================================================
// EXTRACT PHONE FROM URL — fetch page HTML, find Israeli phone
// ============================================================
async function extractPhoneFromUrl(url) {
  if (!url) return null;

  // Skip Facebook URLs (require login) and generic search URLs
  if (url.includes('facebook.com') || url.includes('google.com')) return null;

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxContentLength: 500 * 1024, // 500KB max
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QUANTUM/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      validateStatus: s => s < 400
    });

    const html = String(res.data || '');

    // Strip HTML tags for cleaner matching
    const text = html.replace(/<[^>]+>/g, ' ');

    // Find all Israeli phone matches
    const matches = [...text.matchAll(IL_PHONE_REGEX)];
    if (matches.length === 0) return null;

    // Prefer mobile numbers (05X) over landlines
    const phones = matches.map(m => cleanPhone(m[0])).filter(Boolean);
    const mobile = phones.find(p => p.startsWith('05'));
    return mobile || phones[0] || null;

  } catch (err) {
    // Silently fail — phone extraction is best-effort
    return null;
  }
}

// ============================================================
// ENRICH PHONES FOR LISTINGS WITHOUT PHONE
// Called after saving batch of pilot listings
// ============================================================
async function enrichMissingPhones(listingIds) {
  if (!listingIds || listingIds.length === 0) return;

  const { rows } = await pool.query(
    `SELECT id, url FROM listings WHERE id = ANY($1) AND phone IS NULL AND url IS NOT NULL`,
    [listingIds]
  );

  if (rows.length === 0) return;
  logger.info(`[FBGroups] Phone extraction: ${rows.length} listings without phone`);

  let found = 0;
  for (const row of rows) {
    try {
      const phone = await extractPhoneFromUrl(row.url);
      if (phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2 AND phone IS NULL`,
          [phone, row.id]
        );
        found++;
        logger.info(`[FBGroups] Extracted phone ${phone} for listing ${row.id}`);
      }
      await new Promise(r => setTimeout(r, 800)); // polite delay
    } catch (e) {
      logger.warn(`[FBGroups] Phone extract error for listing ${row.id}: ${e.message}`);
    }
  }

  logger.info(`[FBGroups] Phone extraction done: ${found}/${rows.length} found`);
  return { total: rows.length, found };
}

// ============================================================
// PERPLEXITY: search a specific FB group
// ============================================================
async function searchGroup(group) {
  const apiKey = process.env.SONAR_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) { logger.warn('[FBGroups] No Perplexity API key'); return []; }

  const cityFilter = group.cities ? `בערים: ${group.cities.join(', ')}` : 'בכל הארץ';
  const prompt = `חפש מודעות נדל"ן למכירה בקבוצת הפייסבוק: "${group.name}" (${group.url})
אני מחפש דירות למכירה במתחמי פינוי-בינוי ${cityFilter}.

החזר JSON בלבד:
{
  "listings": [
    {
      "group_id": "${group.id}",
      "post_id": "מזהה הפוסט אם זמין",
      "url": "https://www.facebook.com/groups/${group.id}/posts/...",
      "address": "כתובת מדויקת",
      "city": "שם העיר",
      "price": 1500000,
      "rooms": 3,
      "area_sqm": 75,
      "floor": 2,
      "phone": "0501234567",
      "contact_name": "שם המוכר",
      "description": "תיאור קצר",
      "is_pinuy_binuy": true,
      "posted_date": "תאריך אם זמין"
    }
  ]
}
חשוב: רק מודעות פינוי בינוי / בניין חתום / התחדשות עירונית. רק מכירה, לא שכירות. אם אין — החזר {"listings": []}`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown. Search Facebook groups for real estate listings.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 3000, temperature: 0.1
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 25000
    });
    return parseGroupListings(res.data.choices?.[0]?.message?.content || '', group);
  } catch (err) {
    logger.warn(`[FBGroups] Perplexity failed for "${group.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// PERPLEXITY: search the ENTIRE WEB for a specific complex
// ============================================================
async function searchComplex(complex) {
  const apiKey = process.env.SONAR_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) { logger.warn('[FBGroups] No Perplexity API key'); return []; }

  const prompt = `חפש ברשת (פייסבוק, יד2, מדלן, וואטסאפ, פורומים) מודעות למכירת דירה במתחם פינוי-בינוי הספציפי הזה:
שם מתחם: "${complex.name}"
עיר: ${complex.city}
רחובות: ${complex.addresses}

אני מחפש בעלי דירות שמוכרים את דירתם במתחם הזה. גם מודעות דרך מתווך וגם ישירות מהמוכר.

החזר JSON בלבד:
{
  "listings": [
    {
      "post_id": "מזהה ייחודי או URL",
      "url": "קישור מלא למודעה",
      "source_platform": "facebook / yad2 / madlan / forum / whatsapp",
      "address": "כתובת מדויקת כולל רחוב ומספר",
      "city": "${complex.city}",
      "price": 2500000,
      "rooms": 3,
      "area_sqm": 80,
      "floor": 2,
      "phone": "0501234567",
      "contact_name": "שם איש הקשר",
      "description": "תיאור קצר של המודעה",
      "is_seller_direct": true,
      "posted_date": "תאריך אם זמין"
    }
  ]
}
חשוב: העדף מודעות ישירות מבעל הדירה. כלול URL מלא לכל מודעה. אם אין מודעות — החזר {"listings": []}`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown. Search the web for real estate listings for this specific urban renewal complex. Include full URLs.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 3000, temperature: 0.1
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return parseComplexListings(res.data.choices?.[0]?.message?.content || '', complex);
  } catch (err) {
    logger.warn(`[FBGroups] Complex search failed for "${complex.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// PARSE GROUP RESPONSE
// ============================================================
function parseGroupListings(content, group) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return (parsed.listings || [])
      .filter(l => l && l.is_pinuy_binuy !== false)
      .map(l => ({
        source: 'facebook_group',
        listing_id: l.post_id || l.url || `fb_${group.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        url: l.url || group.url,
        address: l.address || null,
        city: l.city || (group.cities ? group.cities[0] : null),
        price: l.price ? parseFloat(l.price) : null,
        rooms: l.rooms ? parseFloat(l.rooms) : null,
        area_sqm: l.area_sqm ? parseFloat(l.area_sqm) : null,
        floor: l.floor ? parseInt(l.floor) : null,
        phone: cleanPhone(l.phone),
        contact_name: l.contact_name || null,
        description: (l.description || '').substring(0, 500),
        group_id: group.id,
        group_name: group.name
      }));
  } catch (err) {
    logger.warn(`[FBGroups] Parse error for group "${group.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// PARSE COMPLEX RESPONSE
// ============================================================
function parseComplexListings(content, complex) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return (parsed.listings || [])
      .filter(l => l)
      .map(l => ({
        source: l.source_platform === 'facebook' ? 'facebook_group' : `web_${l.source_platform || 'search'}`,
        listing_id: l.post_id || l.url || `complex_${complex.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        url: l.url || null,
        address: l.address || null,
        city: l.city || complex.city,
        price: l.price ? parseFloat(l.price) : null,
        rooms: l.rooms ? parseFloat(l.rooms) : null,
        area_sqm: l.area_sqm ? parseFloat(l.area_sqm) : null,
        floor: l.floor ? parseInt(l.floor) : null,
        phone: cleanPhone(l.phone),
        contact_name: l.contact_name || null,
        description: (l.description || '').substring(0, 500),
        complex_id: complex.id,
        is_seller_direct: l.is_seller_direct || false
      }));
  } catch (err) {
    logger.warn(`[FBGroups] Parse error for complex "${complex.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// MATCH LISTING TO COMPLEX
// ============================================================
async function matchToComplex(listing) {
  if (listing.complex_id) return listing.complex_id;
  if (!listing.address || !listing.city) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM complexes
       WHERE city ILIKE $1
         AND (addresses ILIKE $2 OR name ILIKE $2 OR neighborhood ILIKE $2)
       ORDER BY iai_score DESC NULLS LAST LIMIT 1`,
      [`%${listing.city}%`, `%${listing.address.split(' ').slice(0, 3).join('%')}%`]
    );
    return rows[0]?.id || null;
  } catch (e) { return null; }
}

// ============================================================
// SAVE LISTING TO DB
// ============================================================
async function saveListing(listing) {
  try {
    const sourceId = listing.listing_id;
    if (!sourceId) return { status: 'skip' };
    const complexId = await matchToComplex(listing);
    const r = await pool.query(
      `INSERT INTO listings (
        source, source_listing_id, url, phone, contact_name,
        asking_price, rooms, area_sqm, floor,
        address, city, description_snippet, complex_id,
        first_seen, last_seen, is_active, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CURRENT_DATE, CURRENT_DATE, TRUE, NOW(), NOW())
      ON CONFLICT (source, source_listing_id)
      WHERE source_listing_id IS NOT NULL
      DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, listings.phone),
        contact_name = COALESCE(EXCLUDED.contact_name, listings.contact_name),
        asking_price = COALESCE(EXCLUDED.asking_price, listings.asking_price),
        complex_id = COALESCE(listings.complex_id, EXCLUDED.complex_id),
        last_seen = CURRENT_DATE, updated_at = NOW()
      RETURNING id, (xmax = 0) as is_new`,
      [
        listing.source, sourceId, listing.url || null, listing.phone || null,
        listing.contact_name || null, listing.price || null, listing.rooms || null,
        listing.area_sqm || null, listing.floor || null, listing.address || null,
        listing.city || null, listing.description || '', complexId
      ]
    );
    if (r.rows[0]?.is_new) return { status: 'inserted', id: r.rows[0].id };
    return { status: 'updated', id: r.rows[0]?.id };
  } catch (err) {
    logger.warn(`[FBGroups] Save error for ${listing.listing_id}: ${err.message}`);
    return { status: 'error' };
  }
}

// ============================================================
// ENRICH NEW LISTINGS (ad enrichment + SSI)
// ============================================================
async function enrichNewListingIds(listingIds) {
  if (!listingIds || listingIds.length === 0) return;
  try {
    const { enrichListing } = require('./adEnrichmentService');
    for (const lid of listingIds) {
      try {
        const { rows } = await pool.query(
          `SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor,
                  l.description_snippet, l.source, l.phone,
                  COALESCE(c.iai_score, 0) as iai_score
           FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`, [lid]
        );
        if (rows[0]) { await enrichListing(rows[0]); await new Promise(r => setTimeout(r, ENRICH_DELAY_MS)); }
      } catch (e) { logger.warn(`[FBGroups] Enrich error ${lid}: ${e.message}`); }
    }
  } catch (e) { logger.warn(`[FBGroups] Enrichment batch error: ${e.message}`); }
}

// ============================================================
// SCAN SINGLE GROUP
// ============================================================
async function scanGroup(group) {
  logger.info(`[FBGroups] Scanning group: "${group.name}"`);
  const rawListings = await searchGroup(group);
  if (!rawListings || rawListings.length === 0) {
    return { group_id: group.id, name: group.name, found: 0, inserted: 0, updated: 0, new_ids: [] };
  }
  let inserted = 0, updated = 0;
  const newIds = [];
  for (const listing of rawListings) {
    const result = await saveListing(listing);
    if (result.status === 'inserted') { inserted++; if (result.id) newIds.push(result.id); }
    else if (result.status === 'updated') updated++;
  }
  logger.info(`[FBGroups] "${group.name}": ${inserted} new, ${updated} updated`);
  if (newIds.length > 0) setImmediate(() => enrichNewListingIds(newIds));
  return { group_id: group.id, name: group.name, found: rawListings.length, inserted, updated, new_ids: newIds };
}

// ============================================================
// SCAN PILOT COMPLEXES — Track B targeted search
// ============================================================
async function scanPilotComplexes(complexIds = null) {
  const targets = complexIds
    ? PILOT_COMPLEXES.filter(c => complexIds.includes(c.id))
    : PILOT_COMPLEXES;

  logger.info(`[FBGroups] Pilot complex scan: ${targets.length} complexes`);

  let totalInserted = 0, totalUpdated = 0, totalPhonesFound = 0;
  const results = [];

  for (const complex of targets) {
    logger.info(`[FBGroups] Searching web for: "${complex.name}" (${complex.city})`);
    const rawListings = await searchComplex(complex);

    if (!rawListings || rawListings.length === 0) {
      logger.info(`[FBGroups] No listings found for "${complex.name}"`);
      results.push({ complex_id: complex.id, name: complex.name, city: complex.city, found: 0, inserted: 0, updated: 0, direct_sellers: 0, phones_extracted: 0 });
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }

    let inserted = 0, updated = 0, directSellers = 0;
    const newIds = [];

    for (const listing of rawListings) {
      const result = await saveListing(listing);
      if (result.status === 'inserted') {
        inserted++;
        if (result.id) newIds.push(result.id);
        if (listing.is_seller_direct) directSellers++;
      } else if (result.status === 'updated') {
        updated++;
      }
    }

    logger.info(`[FBGroups] "${complex.name}": ${inserted} new (${directSellers} direct sellers), ${updated} updated`);

    // Phase 2: Extract phones from URLs for listings without phone
    let phonesFound = 0;
    if (newIds.length > 0) {
      try {
        const phoneResult = await enrichMissingPhones(newIds);
        phonesFound = phoneResult?.found || 0;
        totalPhonesFound += phonesFound;
      } catch (e) {
        logger.warn(`[FBGroups] Phone enrichment error for "${complex.name}": ${e.message}`);
      }

      // Phase 3: Ad enrichment (SSI, urgency, etc.)
      setImmediate(() => enrichNewListingIds(newIds));
    }

    totalInserted += inserted;
    totalUpdated += updated;
    results.push({
      complex_id: complex.id,
      name: complex.name,
      city: complex.city,
      found: rawListings.length,
      inserted,
      updated,
      direct_sellers: directSellers,
      phones_extracted: phonesFound,
      new_ids: newIds
    });

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const summary = {
    total_complexes: targets.length,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    total_phones_found: totalPhonesFound,
    results
  };
  logger.info(`[FBGroups] Pilot scan done: ${totalInserted} new, ${totalUpdated} updated, ${totalPhonesFound} phones extracted`);
  return summary;
}

// ============================================================
// ENRICH PHONES — run on existing pilot listings (manual trigger)
// ============================================================
async function enrichPilotPhones(complexIds = null) {
  const ids = complexIds || PILOT_COMPLEXES.map(c => c.id);
  const { rows } = await pool.query(
    `SELECT id, url FROM listings
     WHERE complex_id = ANY($1)
       AND phone IS NULL
       AND url IS NOT NULL
       AND source ILIKE 'web_%'
       AND is_active = TRUE
     ORDER BY created_at DESC
     LIMIT 100`,
    [ids]
  );
  logger.info(`[FBGroups] Manual phone enrichment: ${rows.length} listings`);
  return enrichMissingPhones(rows.map(r => r.id));
}

// ============================================================
// SCAN ALL GROUPS (main entry point)
// ============================================================
async function scanAll(options = {}) {
  const { groupIds = null, scanId = null, includePilotComplexes = false } = options;

  const groups = groupIds ? FB_GROUPS.filter(g => groupIds.includes(g.id)) : FB_GROUPS;
  logger.info(`[FBGroups] Starting group scan: ${groups.length} groups`);

  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(groups.length / BATCH_SIZE);

    const batchResults = await Promise.allSettled(batch.map(group => scanGroup(group)));
    for (const br of batchResults) {
      if (br.status === 'fulfilled') { totalInserted += br.value.inserted || 0; totalUpdated += br.value.updated || 0; results.push(br.value); }
      else { logger.error(`[FBGroups] Batch error: ${br.reason?.message}`); results.push({ error: br.reason?.message }); }
    }

    if (scanId) {
      try {
        await pool.query(
          `UPDATE scan_logs SET complexes_scanned = $1, new_listings = $2, summary = $3 WHERE id = $4`,
          [Math.min(i + BATCH_SIZE, groups.length), totalInserted, `FB Groups: batch ${batchNum}/${totalBatches}, ${totalInserted} new`, scanId]
        );
      } catch (e) { /* ignore */ }
    }

    if (i + BATCH_SIZE < groups.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (includePilotComplexes) {
    const pilotResults = await scanPilotComplexes();
    totalInserted += pilotResults.total_inserted;
    totalUpdated += pilotResults.total_updated;
    results.push({ type: 'pilot_complexes', ...pilotResults });
  }

  const summary = { total_groups: groups.length, total_inserted: totalInserted, total_updated: totalUpdated, results };
  logger.info(`[FBGroups] Scan complete: ${totalInserted} inserted, ${totalUpdated} updated`);
  return summary;
}

module.exports = { scanAll, scanGroup, scanPilotComplexes, enrichPilotPhones, FB_GROUPS, PILOT_COMPLEXES };
