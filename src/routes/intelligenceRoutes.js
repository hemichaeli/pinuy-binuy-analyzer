/**
 * Intelligence API - Public readable endpoints for AI assistants (Perplexity, ChatGPT, etc.)
 * 
 * JSON endpoints + HTML report for Perplexity Spaces links
 * 
 * Endpoints:
 *   GET /api/intelligence          - JSON full summary
 *   GET /api/intelligence/report   - HTML report (for Perplexity links!)
 *   GET /api/intelligence/opportunities
 *   GET /api/intelligence/city/:name
 *   GET /api/intelligence/stressed-sellers
 *   GET /api/intelligence/query?q=
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ─── Helper: fetch all intelligence data ─────────────────────

async function getIntelligenceData() {
  const stats = await pool.query(`
    SELECT 
      COUNT(*) as total_complexes,
      COUNT(DISTINCT city) as total_cities,
      COUNT(*) FILTER (WHERE iai_score >= 70) as excellent_opportunities,
      COUNT(*) FILTER (WHERE iai_score >= 50 AND iai_score < 70) as good_opportunities,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'deposited') as deposited,
      COUNT(*) FILTER (WHERE status = 'planning') as planning,
      COUNT(*) FILTER (WHERE status = 'construction') as construction,
      COUNT(*) FILTER (WHERE status = 'declared') as declared,
      ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
      MAX(iai_score) as max_iai,
      COUNT(*) FILTER (WHERE is_receivership = true) as receivership_count
    FROM complexes
  `);

  const topOpps = await pool.query(`
    SELECT name, city, status, iai_score, actual_premium, 
      existing_units, planned_units, developer
    FROM complexes WHERE iai_score >= 50 ORDER BY iai_score DESC LIMIT 20
  `);

  const cities = await pool.query(`
    SELECT city, COUNT(*) as complexes,
      ROUND(AVG(iai_score) FILTER (WHERE iai_score > 0), 1) as avg_iai,
      COUNT(*) FILTER (WHERE iai_score >= 70) as excellent,
      COUNT(*) FILTER (WHERE iai_score >= 50) as investable
    FROM complexes GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC
  `);

  const alerts = await pool.query(`
    SELECT a.alert_type, a.severity, a.title, a.message, 
      a.created_at, c.name as complex_name, c.city
    FROM alerts a LEFT JOIN complexes c ON a.complex_id = c.id
    WHERE a.created_at > NOW() - INTERVAL '7 days'
    ORDER BY a.created_at DESC LIMIT 20
  `);

  const listings = await pool.query(`
    SELECT 
      COUNT(*) as total_listings,
      COUNT(DISTINCT source) as sources,
      COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent,
      COUNT(*) FILTER (WHERE source = 'yad2') as yad2,
      COUNT(*) FILTER (WHERE source = 'facebook') as facebook,
      COUNT(*) FILTER (WHERE source = 'kones') as kones,
      ROUND(AVG(asking_price) FILTER (WHERE asking_price > 100000), 0) as avg_price
    FROM listings WHERE is_active = true
  `);

  const stressed = await pool.query(`
    SELECT c.name, c.city, c.iai_score,
      l.asking_price, l.days_on_market, l.price_changes, l.source,
      l.total_price_drop_percent, l.has_urgent_keywords
    FROM listings l JOIN complexes c ON l.complex_id = c.id
    WHERE l.is_active = true 
      AND (l.days_on_market > 60 OR l.price_changes >= 1 OR l.has_urgent_keywords = true OR c.is_receivership = true)
    ORDER BY l.price_changes DESC NULLS LAST, l.days_on_market DESC NULLS LAST
    LIMIT 20
  `);

  const lastScan = await pool.query(`
    SELECT scan_type, started_at, completed_at, status, summary
    FROM scan_logs ORDER BY id DESC LIMIT 1
  `);

  return { stats: stats.rows[0], topOpps: topOpps.rows, cities: cities.rows, alerts: alerts.rows, listings: listings.rows[0], stressed: stressed.rows, lastScan: lastScan.rows[0] };
}

// ─── HTML Report (for Perplexity Spaces) ─────────────────────

router.get('/report', async (req, res) => {
  try {
    const d = await getIntelligenceData();
    const s = d.stats;
    const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    // Build opportunities table rows
    const oppsRows = d.topOpps.map((o, i) => 
      `<tr><td>${i+1}</td><td>${o.name}</td><td>${o.city}</td><td><strong>${o.iai_score}</strong></td><td>${o.status}</td><td>${o.actual_premium || '-'}%</td><td>${o.existing_units || '-'}</td><td>${o.planned_units || '-'}</td><td>${o.developer || '-'}</td></tr>`
    ).join('\n');

    // Build cities table
    const citiesRows = d.cities.map(c =>
      `<tr><td>${c.city}</td><td>${c.complexes}</td><td>${c.avg_iai || 0}</td><td>${c.excellent}</td><td>${c.investable}</td></tr>`
    ).join('\n');

    // Build stressed sellers table
    const stressedRows = d.stressed.map(ss => {
      const price = ss.asking_price ? `₪${parseInt(ss.asking_price).toLocaleString()}` : '-';
      const drop = ss.total_price_drop_percent ? `${parseFloat(ss.total_price_drop_percent)}%` : '-';
      return `<tr><td>${ss.name}</td><td>${ss.city}</td><td>${ss.iai_score || '-'}</td><td>${price}</td><td>${ss.days_on_market || 0}</td><td>${ss.price_changes || 0}</td><td>${drop}</td><td>${ss.source}</td></tr>`;
    }).join('\n');

    // Build alerts
    const alertsList = d.alerts.map(a => {
      const date = new Date(a.created_at).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      return `<li><strong>[${a.severity}]</strong> ${a.title} - ${a.complex_name || ''} (${a.city || ''}) - ${date}</li>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM Intelligence Report - פינוי בינוי ישראל</title>
  <meta name="description" content="QUANTUM Real Estate Intelligence - Live data on ${s.total_complexes} urban renewal complexes across ${s.total_cities} Israeli cities. ${s.excellent_opportunities} excellent investment opportunities.">
  <meta name="robots" content="index, follow">
  <style>
    body { font-family: Arial, sans-serif; direction: rtl; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f8f9fa; color: #333; }
    h1 { color: #1a237e; border-bottom: 3px solid #1a237e; padding-bottom: 10px; }
    h2 { color: #283593; margin-top: 30px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
    .stat-card { background: white; border-radius: 8px; padding: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
    .stat-card .number { font-size: 2em; font-weight: bold; color: #1a237e; }
    .stat-card .label { color: #666; font-size: 0.9em; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin: 15px 0; }
    th { background: #1a237e; color: white; padding: 10px 8px; text-align: right; font-size: 0.85em; }
    td { padding: 8px; border-bottom: 1px solid #eee; font-size: 0.85em; }
    tr:hover { background: #f5f5f5; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; }
    .badge-excellent { background: #c8e6c9; color: #2e7d32; }
    .badge-good { background: #fff3e0; color: #ef6c00; }
    .updated { color: #999; font-size: 0.85em; margin-top: 5px; }
    .section-note { background: #e8eaf6; padding: 10px 15px; border-radius: 6px; border-right: 4px solid #1a237e; margin: 10px 0; font-size: 0.9em; }
    ul { line-height: 1.8; }
  </style>
</head>
<body>

<h1>🏗️ QUANTUM Intelligence Report - מודיעין נדל"ני פינוי-בינוי</h1>
<p class="updated">עדכון אחרון: ${israelTime} | גרסה 4.20.2 | נתונים חיים מהמאגר</p>

<div class="section-note">
  מסמך זה מכיל מידע חי ממאגר QUANTUM - מערכת מודיעין לניתוח השקעות פינוי-בינוי בישראל.
  הנתונים מתעדכנים אוטומטית בכל סריקה יומית. ציון IAI (Investment Attractiveness Index) מדרג הזדמנויות מ-0 עד 100.
</div>

<h2>📊 סקירה כללית</h2>
<div class="stats-grid">
  <div class="stat-card"><div class="number">${s.total_complexes}</div><div class="label">מתחמים במעקב</div></div>
  <div class="stat-card"><div class="number">${s.total_cities}</div><div class="label">ערים</div></div>
  <div class="stat-card"><div class="number">${s.excellent_opportunities}</div><div class="label">הזדמנויות מצוינות (IAI≥70)</div></div>
  <div class="stat-card"><div class="number">${parseInt(s.excellent_opportunities) + parseInt(s.good_opportunities)}</div><div class="label">הזדמנויות טובות+ (IAI≥50)</div></div>
  <div class="stat-card"><div class="number">${s.max_iai}</div><div class="label">IAI מקסימלי</div></div>
  <div class="stat-card"><div class="number">${s.avg_iai || 0}</div><div class="label">IAI ממוצע</div></div>
  <div class="stat-card"><div class="number">${s.receivership_count}</div><div class="label">כינוס נכסים</div></div>
  <div class="stat-card"><div class="number">${parseInt(d.listings?.total_listings) || 0}</div><div class="label">מודעות פעילות</div></div>
</div>

<h3>סטטוס תכנוני</h3>
<p>אושר: ${s.approved} | הופקד: ${s.deposited} | בתכנון: ${s.planning} | בבנייה: ${s.construction} | הוכרז: ${s.declared}</p>

<h3>מודעות לפי מקור</h3>
<p>yad2: ${parseInt(d.listings?.yad2) || 0} | facebook: ${parseInt(d.listings?.facebook) || 0} | כינוס: ${parseInt(d.listings?.kones) || 0} | מחיר ממוצע: ₪${parseInt(d.listings?.avg_price || 0).toLocaleString()}</p>

<h2>🏆 טופ הזדמנויות השקעה (IAI≥50)</h2>
<table>
<thead><tr><th>#</th><th>מתחם</th><th>עיר</th><th>IAI</th><th>סטטוס</th><th>פרמיה</th><th>יח' קיימות</th><th>יח' מתוכננות</th><th>יזם</th></tr></thead>
<tbody>
${oppsRows}
</tbody>
</table>

<h2>🏙️ ניתוח ערים</h2>
<table>
<thead><tr><th>עיר</th><th>מתחמים</th><th>IAI ממוצע</th><th>מצוינות (70+)</th><th>טובות+ (50+)</th></tr></thead>
<tbody>
${citiesRows}
</tbody>
</table>

<h2>😰 מוכרים בלחץ / מוטיבציוניים</h2>
<div class="section-note">
  מוכרים שמציגים סימני לחץ: זמן רב בשוק (60+ יום), ירידות מחיר, מילות מפתח דחופות, או כינוס נכסים.
</div>
<table>
<thead><tr><th>מתחם</th><th>עיר</th><th>IAI</th><th>מחיר</th><th>ימים בשוק</th><th>ירידות מחיר</th><th>ירידה כוללת</th><th>מקור</th></tr></thead>
<tbody>
${stressedRows}
</tbody>
</table>

<h2>🔔 התראות אחרונות (7 ימים)</h2>
${d.alerts.length > 0 ? `<ul>${alertsList}</ul>` : '<p>אין התראות חדשות</p>'}

${d.lastScan ? `
<h2>🔄 סריקה אחרונה</h2>
<p>סוג: ${d.lastScan.scan_type} | סטטוס: ${d.lastScan.status} | התחלה: ${d.lastScan.started_at ? new Date(d.lastScan.started_at).toLocaleString('he-IL', {timeZone:'Asia/Jerusalem'}) : '-'} | סיום: ${d.lastScan.completed_at ? new Date(d.lastScan.completed_at).toLocaleString('he-IL', {timeZone:'Asia/Jerusalem'}) : '-'}</p>
` : ''}

<hr>
<h2>📡 API Endpoints (למפתחים)</h2>
<ul>
  <li><code>GET /api/intelligence</code> - JSON סיכום מלא</li>
  <li><code>GET /api/intelligence/report</code> - HTML דוח (עמוד זה)</li>
  <li><code>GET /api/intelligence/opportunities?min_iai=60</code> - הזדמנויות</li>
  <li><code>GET /api/intelligence/city/{שם עיר}</code> - ניתוח עיר</li>
  <li><code>GET /api/intelligence/stressed-sellers</code> - מוכרים בלחץ</li>
  <li><code>GET /api/intelligence/query?q={שאלה}</code> - חיפוש חופשי</li>
</ul>

<p class="updated">QUANTUM Real Estate Intelligence System v4.20.2 | © 2026 QUANTUM</p>
</body>
</html>`;

    res.type('html').send(html);
  } catch (err) {
    logger.error('Intelligence HTML report error', { error: err.message });
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// ─── JSON: Full Summary ──────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const d = await getIntelligenceData();
    const s = d.stats;
    const israelTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    res.json({
      _meta: {
        description: 'QUANTUM Real Estate Intelligence - Pinuy Binuy (Urban Renewal) Israel',
        generated_at: israelTime,
        version: '4.20.2',
        html_report: '/api/intelligence/report',
        endpoints: {
          full_summary: '/api/intelligence',
          html_report: '/api/intelligence/report',
          opportunities: '/api/intelligence/opportunities',
          city_deep_dive: '/api/intelligence/city/{cityName}',
          stressed_sellers: '/api/intelligence/stressed-sellers',
          natural_query: '/api/intelligence/query?q={question}'
        }
      },
      overview: {
        total_complexes: parseInt(s.total_complexes),
        total_cities: parseInt(s.total_cities),
        excellent_opportunities_iai_70_plus: parseInt(s.excellent_opportunities),
        good_opportunities_iai_50_plus: parseInt(s.good_opportunities),
        average_iai_score: parseFloat(s.avg_iai) || 0,
        max_iai_score: parseInt(s.max_iai) || 0,
        receivership_properties: parseInt(s.receivership_count),
        status_breakdown: {
          approved: parseInt(s.approved), deposited: parseInt(s.deposited),
          planning: parseInt(s.planning), construction: parseInt(s.construction),
          declared: parseInt(s.declared)
        }
      },
      top_investment_opportunities: d.topOpps.map(o => ({
        name: o.name, city: o.city, iai_score: o.iai_score, status: o.status,
        actual_premium_percent: o.actual_premium, existing_units: o.existing_units,
        planned_units: o.planned_units, developer: o.developer
      })),
      cities_analysis: d.cities.map(c => ({
        city: c.city, total_complexes: parseInt(c.complexes),
        avg_iai: parseFloat(c.avg_iai) || 0,
        excellent_opportunities: parseInt(c.excellent),
        investable_opportunities: parseInt(c.investable)
      })),
      active_listings: {
        total: parseInt(d.listings?.total_listings) || 0,
        urgent: parseInt(d.listings?.urgent) || 0,
        by_source: {
          yad2: parseInt(d.listings?.yad2) || 0,
          facebook: parseInt(d.listings?.facebook) || 0,
          kones_receivership: parseInt(d.listings?.kones) || 0
        },
        average_price_ils: parseInt(d.listings?.avg_price) || 0
      },
      stressed_sellers: d.stressed.map(ss => ({
        complex: ss.name, city: ss.city, iai_score: ss.iai_score,
        asking_price_ils: ss.asking_price ? parseInt(ss.asking_price) : null,
        days_on_market: ss.days_on_market, price_changes: ss.price_changes, source: ss.source
      })),
      recent_alerts: d.alerts.map(a => ({
        type: a.alert_type, severity: a.severity, title: a.title,
        message: a.message, complex: a.complex_name, city: a.city, date: a.created_at
      })),
      last_scan: d.lastScan ? {
        type: d.lastScan.scan_type, started: d.lastScan.started_at,
        completed: d.lastScan.completed_at, status: d.lastScan.status, summary: d.lastScan.summary
      } : null
    });
  } catch (err) {
    logger.error('Intelligence API error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Opportunities ───────────────────────────────────────────

router.get('/opportunities', async (req, res) => {
  try {
    const { city, min_iai = 30, limit = 30 } = req.query;
    let query = `
      SELECT c.name, c.city, c.status, c.iai_score, c.actual_premium,
        c.existing_units, c.planned_units, c.developer, c.addresses,
        c.plan_number, c.is_receivership,
        COUNT(l.id) FILTER (WHERE l.is_active = true) as active_listings,
        MIN(l.asking_price) FILTER (WHERE l.is_active = true AND l.asking_price > 100000) as min_price,
        MAX(l.asking_price) FILTER (WHERE l.is_active = true AND l.asking_price > 100000) as max_price
      FROM complexes c LEFT JOIN listings l ON l.complex_id = c.id
      WHERE c.iai_score >= $1
    `;
    const params = [min_iai];
    if (city) { query += ` AND c.city = $2`; params.push(city); }
    query += ` GROUP BY c.id ORDER BY c.iai_score DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json({
      _meta: { description: `Opportunities IAI >= ${min_iai}${city ? ` in ${city}` : ''}`, count: result.rows.length },
      opportunities: result.rows.map(r => ({
        name: r.name, city: r.city, iai_score: r.iai_score, status: r.status,
        actual_premium_percent: r.actual_premium, existing_units: r.existing_units,
        planned_units: r.planned_units, developer: r.developer, addresses: r.addresses,
        plan_number: r.plan_number, is_receivership: r.is_receivership,
        active_listings: parseInt(r.active_listings),
        price_range_ils: r.min_price ? { min: parseInt(r.min_price), max: parseInt(r.max_price) } : null
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── City Deep Dive ──────────────────────────────────────────

router.get('/city/:cityName', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.cityName);
    const complexes = await pool.query(`
      SELECT name, status, iai_score, actual_premium, existing_units, planned_units, developer, addresses, is_receivership
      FROM complexes WHERE city = $1 ORDER BY iai_score DESC NULLS LAST
    `, [city]);

    const listingStats = await pool.query(`
      SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent,
        ROUND(AVG(asking_price) FILTER (WHERE asking_price > 100000), 0) as avg_price,
        MIN(asking_price) FILTER (WHERE asking_price > 100000) as min_price,
        MAX(asking_price) FILTER (WHERE asking_price > 100000) as max_price
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE c.city = $1 AND l.is_active = true
    `, [city]);

    const statusBreakdown = await pool.query(`
      SELECT status, COUNT(*) as cnt FROM complexes WHERE city = $1 GROUP BY status ORDER BY cnt DESC
    `, [city]);

    res.json({
      _meta: { city, total_complexes: complexes.rows.length },
      status_breakdown: statusBreakdown.rows.reduce((acc, r) => { acc[r.status] = parseInt(r.cnt); return acc; }, {}),
      listings: {
        total_active: parseInt(listingStats.rows[0]?.total) || 0,
        urgent: parseInt(listingStats.rows[0]?.urgent) || 0,
        avg_price_ils: parseInt(listingStats.rows[0]?.avg_price) || 0,
        price_range: listingStats.rows[0]?.min_price ? { min: parseInt(listingStats.rows[0].min_price), max: parseInt(listingStats.rows[0].max_price) } : null
      },
      complexes: complexes.rows.map(c => ({
        name: c.name, status: c.status, iai_score: c.iai_score,
        actual_premium_percent: c.actual_premium, existing_units: c.existing_units,
        planned_units: c.planned_units, developer: c.developer, addresses: c.addresses,
        is_receivership: c.is_receivership
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stressed Sellers ────────────────────────────────────────

router.get('/stressed-sellers', async (req, res) => {
  try {
    const sellers = await pool.query(`
      SELECT c.name as complex_name, c.city, c.iai_score, c.status,
        l.asking_price, l.rooms, l.area_sqm, l.floor,
        l.days_on_market, l.price_changes, l.original_price,
        l.source, l.has_urgent_keywords, l.url, l.total_price_drop_percent
      FROM listings l JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true 
        AND (l.days_on_market > 60 OR l.price_changes >= 1 OR l.has_urgent_keywords = true OR c.is_receivership = true)
      ORDER BY 
        CASE WHEN c.is_receivership THEN 0 ELSE 1 END,
        l.price_changes DESC NULLS LAST, l.days_on_market DESC NULLS LAST
      LIMIT 30
    `);

    res.json({
      _meta: { description: 'Motivated sellers - long DOM, price drops, urgent, receivership', count: sellers.rows.length },
      stressed_listings: sellers.rows.map(s => ({
        complex: s.complex_name, city: s.city, iai_score: s.iai_score, status: s.status,
        asking_price_ils: s.asking_price ? parseInt(s.asking_price) : null,
        rooms: s.rooms ? parseFloat(s.rooms) : null, area_sqm: s.area_sqm ? parseFloat(s.area_sqm) : null,
        floor: s.floor, days_on_market: s.days_on_market, price_changes: s.price_changes,
        original_price_ils: s.original_price ? parseInt(s.original_price) : null,
        total_drop_percent: s.total_price_drop_percent ? parseFloat(s.total_price_drop_percent) : 0,
        has_urgent_keywords: s.has_urgent_keywords, source: s.source, url: s.url
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Natural Language Query ──────────────────────────────────

router.get('/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) {
      return res.json({
        usage: { examples: [
          '/api/intelligence/query?q=בת ים',
          '/api/intelligence/query?q=top opportunities',
          '/api/intelligence/query?q=stressed sellers',
          '/api/intelligence/query?q=approved projects',
          '/api/intelligence/query?q=receivership'
        ]}
      });
    }

    let sqlQuery, params = [];
    
    if (q.includes('stressed') || q.includes('seller') || q.includes('לחוץ')) {
      sqlQuery = `SELECT c.name, c.city, c.iai_score, l.asking_price, l.days_on_market, l.price_changes, l.source
        FROM listings l JOIN complexes c ON l.complex_id = c.id
        WHERE l.is_active = true AND (l.days_on_market > 60 OR l.price_changes >= 1)
        ORDER BY l.days_on_market DESC NULLS LAST LIMIT 20`;
    } else if (q.includes('receiv') || q.includes('כונס') || q.includes('kones')) {
      sqlQuery = `SELECT name, city, iai_score, status FROM complexes WHERE is_receivership = true ORDER BY iai_score DESC LIMIT 20`;
    } else if (q.includes('opportunit') || q.includes('top') || q.includes('best') || q.includes('הזדמנ')) {
      sqlQuery = `SELECT name, city, status, iai_score, actual_premium, developer FROM complexes WHERE iai_score >= 50 ORDER BY iai_score DESC LIMIT 20`;
    } else if (q.includes('approved') || q.includes('אושר')) {
      sqlQuery = `SELECT name, city, iai_score, actual_premium, developer, planned_units FROM complexes WHERE status = 'approved' ORDER BY iai_score DESC LIMIT 30`;
    } else {
      sqlQuery = `SELECT name, city, status, iai_score, actual_premium, existing_units, planned_units, developer
        FROM complexes WHERE city ILIKE $1 OR name ILIKE $1
        ORDER BY iai_score DESC NULLS LAST LIMIT 30`;
      params.push(`%${q}%`);
    }

    const result = await pool.query(sqlQuery, params);
    res.json({ _meta: { query: q, results: result.rows.length }, data: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
