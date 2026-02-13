/**
 * Perplexity Integration Routes
 * Public endpoints for Perplexity AI to crawl and index QUANTUM data
 * Covers ALL database tables for complete knowledge access
 * 
 * KEY ENDPOINTS FOR AI:
 * - /api/perplexity/brain.html - COMPACT single page (~8KB) with all essential data
 * - /api/perplexity/brain.json - COMPACT JSON (~10KB) for programmatic access
 * - /api/perplexity/complexes.html - Full complex list (LARGE ~168KB)
 * - /api/perplexity/full-export.json - Complete DB dump (VERY LARGE ~2.6MB)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// =====================================================
// HELPER: Generate HTML wrapper
// =====================================================
const htmlWrapper = (title, description, content) => `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="${description}">
  <meta name="keywords" content="פינוי בינוי, התחדשות עירונית, השקעות נדלן, ישראל, QUANTUM">
  <title>QUANTUM - ${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    h1 { color: #1a365d; }
    h2 { color: #2d3748; margin-top: 30px; }
    table { border-collapse: collapse; width: 100%; background: white; margin: 10px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: right; }
    th { background: #1a365d; color: white; }
    tr:nth-child(even) { background: #f9f9f9; }
    .highlight { background: #fff3cd; }
    .good { color: #28a745; }
    .warning { color: #ffc107; }
    .danger { color: #dc3545; }
    footer { margin-top: 40px; padding: 20px; background: #1a365d; color: white; text-align: center; }
  </style>
</head>
<body>
  ${content}
  <footer>
    <p><strong>QUANTUM</strong> - משרד תיווך NEXT-GEN להתחדשות עירונית</p>
    <p>מח חד. הבנה עמוקה. גישה לסודות השוק.</p>
    <p>עודכן: ${new Date().toLocaleString('he-IL')}</p>
  </footer>
</body>
</html>
`;

// =====================================================
// BRAIN.HTML - COMPACT single page with ALL essential data
// Optimized for AI consumption (~8-12KB, ~3000 tokens)
// THIS IS THE PRIMARY ENDPOINT FOR PERPLEXITY
// =====================================================
router.get('/brain.html', async (req, res) => {
  try {
    const [statsR, topIAI, topSSI, citiesR, konesR, alertsR, listingsR, txR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, COUNT(*) FILTER (WHERE iai_score >= 70) as excellent, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed, COUNT(DISTINCT city) as cities, ROUND(AVG(iai_score)) as avg_iai, ROUND(AVG(enhanced_ssi_score) FILTER (WHERE enhanced_ssi_score > 0)) as avg_ssi FROM complexes`),
      pool.query(`SELECT name, city, addresses, developer, iai_score, enhanced_ssi_score, status, planned_units FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 30`),
      pool.query(`SELECT name, city, addresses, enhanced_ssi_score, iai_score, ssi_enhancement_factors, is_receivership, is_inheritance_property FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 20`),
      pool.query(`SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed, ROUND(AVG(iai_score)) as avg_iai FROM complexes WHERE city IS NOT NULL GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC LIMIT 25`),
      pool.query(`SELECT address, city, property_type, price, rooms, size_sqm FROM kones_listings WHERE is_active = true ORDER BY created_at DESC LIMIT 15`),
      pool.query(`SELECT title, city, alert_type, severity, created_at FROM alerts WHERE severity IN ('high','critical') ORDER BY created_at DESC LIMIT 10`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE has_urgent_keywords = true) as urgent, COUNT(*) FILTER (WHERE ssi_score > 0) as with_ssi FROM listings`),
      pool.query(`SELECT COUNT(*) as total FROM transactions`)
    ]);

    const s = statsR.rows[0];
    const ls = listingsR.rows[0];

    const content = `
      <h1>QUANTUM - מודיעין נדל"ן | פינוי-בינוי ישראל</h1>
      <p><strong>עודכן: ${new Date().toLocaleDateString('he-IL')} ${new Date().toLocaleTimeString('he-IL')}</strong></p>
      
      <h2>סיכום מהיר</h2>
      <ul>
        <li><strong>${s.total} מתחמי פינוי-בינוי</strong> ב-${s.cities} ערים</li>
        <li><strong>${s.opp} הזדמנויות השקעה</strong> (IAI מעל 30), מתוכן ${s.excellent} מצוינות (IAI 70+)</li>
        <li><strong>${s.stressed} מוכרים במצוקה</strong> (SSI מעל 40) - פוטנציאל למחיר נמוך</li>
        <li>${ls.total} מודעות yad2 פעילות, ${ls.urgent} דחופות</li>
        <li>${txR.rows[0].total} עסקאות היסטוריות</li>
        <li>IAI ממוצע: ${s.avg_iai} | SSI ממוצע (מוכרים לחוצים): ${s.avg_ssi || 'N/A'}</li>
      </ul>

      <h2>מה זה IAI ו-SSI?</h2>
      <p><strong>IAI (מדד אטרקטיביות השקעה)</strong>: ציון 0-100 שמודד פוטנציאל רווח. מבוסס על פער בין פרמיה תיאורטית לבפועל, שלב תכנוני, ויזם. מעל 30 = כדאי, מעל 70 = מצוין.</p>
      <p><strong>SSI (מדד לחץ מוכר)</strong>: ציון 0-100 שמזהה מוכרים במצוקה. מבוסס על כינוס נכסים, הוצל"פ, פשיטת רגל, עיקולים, ירושות, הורדות מחיר חוזרות. SSI גבוה = הזדמנות למחיר מתחת לשוק.</p>

      <h2>טופ 30 הזדמנויות השקעה (IAI 30+)</h2>
      <table>
        <thead><tr><th>#</th><th>מתחם</th><th>עיר</th><th>יזם</th><th>IAI</th><th>SSI</th><th>יח"ד</th><th>שלב</th></tr></thead>
        <tbody>
          ${topIAI.rows.map((c, i) => `<tr${c.iai_score >= 70 ? ' class="highlight"' : ''}>
            <td>${i+1}</td><td>${c.name || c.addresses || '-'}</td><td>${c.city}</td>
            <td>${c.developer || '-'}</td><td class="good"><strong>${c.iai_score}</strong></td>
            <td>${c.enhanced_ssi_score || '-'}</td><td>${c.planned_units || '-'}</td><td>${c.status || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <h2>טופ 20 מוכרים לחוצים (SSI גבוה)</h2>
      <table>
        <thead><tr><th>מתחם</th><th>עיר</th><th>SSI</th><th>IAI</th><th>כינוס</th><th>ירושה</th><th>גורמי לחץ</th></tr></thead>
        <tbody>
          ${topSSI.rows.map(c => {
            let factors = c.ssi_enhancement_factors;
            if (typeof factors === 'string') { try { factors = JSON.parse(factors); } catch(e) { factors = []; } }
            if (!Array.isArray(factors)) factors = [];
            return `<tr>
              <td>${c.name || c.addresses || '-'}</td><td>${c.city}</td>
              <td class="danger"><strong>${c.enhanced_ssi_score}</strong></td><td>${c.iai_score || '-'}</td>
              <td>${c.is_receivership ? 'כן' : '-'}</td><td>${c.is_inheritance_property ? 'כן' : '-'}</td>
              <td>${factors.slice(0,2).join('; ') || '-'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <h2>כינוס נכסים (${konesR.rows.length} נכסים פעילים)</h2>
      <table>
        <thead><tr><th>כתובת</th><th>עיר</th><th>סוג</th><th>חדרים</th><th>מ"ר</th><th>מחיר</th></tr></thead>
        <tbody>
          ${konesR.rows.map(k => `<tr>
            <td>${k.address || '-'}</td><td>${k.city || '-'}</td><td>${k.property_type || '-'}</td>
            <td>${k.rooms || '-'}</td><td>${k.size_sqm || '-'}</td>
            <td>${k.price ? '₪' + Number(k.price).toLocaleString() : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <h2>פילוח לפי ערים (טופ 25)</h2>
      <table>
        <thead><tr><th>עיר</th><th>מתחמים</th><th>הזדמנויות</th><th>לחוצים</th><th>IAI ממוצע</th></tr></thead>
        <tbody>
          ${citiesR.rows.map(c => `<tr>
            <td><strong>${c.city}</strong></td><td>${c.total}</td>
            <td class="${c.opp > 5 ? 'good' : ''}">${c.opp}</td>
            <td class="${c.stressed > 0 ? 'danger' : ''}">${c.stressed}</td>
            <td>${c.avg_iai || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <h2>התראות חמורות אחרונות</h2>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>חומרה</th><th>עיר</th><th>כותרת</th></tr></thead>
        <tbody>
          ${alertsR.rows.map(a => `<tr>
            <td>${a.created_at ? new Date(a.created_at).toLocaleDateString('he-IL') : '-'}</td>
            <td>${a.alert_type}</td><td class="${a.severity === 'high' ? 'danger' : 'warning'}">${a.severity}</td>
            <td>${a.city || '-'}</td><td>${(a.title || '').substring(0, 60)}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <h2>דפי נתונים נוספים</h2>
      <ul>
        <li><a href="/api/perplexity/opportunities.html">הזדמנויות השקעה - רשימה מלאה</a></li>
        <li><a href="/api/perplexity/stressed-sellers.html">מוכרים במצוקה - פירוט מלא</a></li>
        <li><a href="/api/perplexity/kones.html">כינוס נכסים - כל הנכסים</a></li>
        <li><a href="/api/perplexity/transactions.html">עסקאות היסטוריות</a></li>
        <li><a href="/api/perplexity/decisions.html">החלטות ועדות תכנון</a></li>
        <li>לחיפוש עיר ספציפית: /api/perplexity/city/[שם-עיר].html</li>
      </ul>
    `;

    res.type('html').send(htmlWrapper(
      'QUANTUM Brain - מודיעין נדל"ן פינוי-בינוי ישראל',
      'QUANTUM - סיכום כל הנתונים: מתחמים, הזדמנויות השקעה, מוכרים במצוקה, כינוס נכסים, ערים. פינוי-בינוי ישראל.',
      content
    ));
    logger.info('Perplexity: Served brain.html (compact)');
  } catch (error) {
    logger.error('Perplexity brain.html error:', error);
    res.status(500).send('Error generating brain page');
  }
});

// =====================================================
// BRAIN.JSON - Compact JSON for programmatic AI access (~10KB)
// =====================================================
router.get('/brain.json', async (req, res) => {
  try {
    const [statsR, topIAI, topSSI, citiesR, konesR, goldR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opportunities, COUNT(*) FILTER (WHERE iai_score >= 70) as excellent, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed_sellers, COUNT(DISTINCT city) as cities, ROUND(AVG(iai_score)) as avg_iai FROM complexes`),
      pool.query(`SELECT name, city, developer, iai_score, enhanced_ssi_score as ssi, status FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 25`),
      pool.query(`SELECT name, city, enhanced_ssi_score as ssi, iai_score, is_receivership, is_inheritance_property FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 15`),
      pool.query(`SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, ROUND(AVG(iai_score)) as avg_iai FROM complexes WHERE city IS NOT NULL GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC LIMIT 20`),
      pool.query(`SELECT address, city, property_type, price, rooms, size_sqm FROM kones_listings WHERE is_active = true ORDER BY created_at DESC LIMIT 10`),
      pool.query(`SELECT name, city, iai_score, enhanced_ssi_score as ssi FROM complexes WHERE iai_score >= 40 AND enhanced_ssi_score >= 30 ORDER BY (iai_score + enhanced_ssi_score) DESC LIMIT 10`)
    ]);

    res.json({
      source: 'QUANTUM Intelligence - Pinuy Binuy Israel',
      updated: new Date().toISOString(),
      description: 'Compact real estate intelligence for Israeli urban renewal (Pinuy-Binuy) investments',
      metrics_explained: {
        IAI: 'Investment Attractiveness Index (0-100). Above 30 = worth investing, above 70 = excellent',
        SSI: 'Seller Stress Index (0-100). High score = distressed seller = opportunity for below-market price'
      },
      summary: statsR.rows[0],
      golden_opportunities: goldR.rows,
      top_investments: topIAI.rows,
      stressed_sellers: topSSI.rows,
      receivership_properties: konesR.rows,
      city_breakdown: citiesR.rows,
      detailed_pages: {
        brain_html: '/api/perplexity/brain.html',
        opportunities: '/api/perplexity/opportunities.html',
        stressed_sellers: '/api/perplexity/stressed-sellers.html',
        kones: '/api/perplexity/kones.html',
        transactions: '/api/perplexity/transactions.html',
        city_search: '/api/perplexity/city/{city_name}.html'
      }
    });
    logger.info('Perplexity: Served brain.json (compact)');
  } catch (error) {
    logger.error('brain.json error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// COMPLEXES - All urban renewal complexes
// =====================================================
router.get('/complexes.html', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const cityFilter = req.query.city || null;
    
    let whereClause = '';
    let params = [];
    if (cityFilter) {
      whereClause = 'WHERE city ILIKE $1';
      params = [`%${cityFilter}%`];
    }

    const countR = await pool.query(`SELECT COUNT(*) FROM complexes ${whereClause}`, params);
    const total = parseInt(countR.rows[0].count);
    const totalPages = Math.ceil(total / limit);
    
    const result = await pool.query(`
      SELECT id, name, city, addresses, status, developer, 
             planned_units, existing_units, actual_premium,
             iai_score, enhanced_ssi_score,
             is_receivership, has_enforcement_cases, is_inheritance_property
      FROM complexes ${whereClause}
      ORDER BY iai_score DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `, params);

    const complexes = result.rows;
    
    const pagination = totalPages > 1 ? `
      <p>עמוד ${page} מתוך ${totalPages} (${total} מתחמים סה"כ) | 
      ${page > 1 ? `<a href="?page=${page-1}${cityFilter ? '&city='+cityFilter : ''}">הקודם</a> | ` : ''}
      ${page < totalPages ? `<a href="?page=${page+1}${cityFilter ? '&city='+cityFilter : ''}">הבא</a>` : ''}</p>
    ` : '';

    const content = `
      <h1>QUANTUM - מאגר מתחמי פינוי-בינוי בישראל</h1>
      <p>סה"כ מתחמים: <strong>${total}</strong>${cityFilter ? ` (מסונן: ${cityFilter})` : ''}</p>
      ${pagination}
      
      <h2>מדדים מרכזיים</h2>
      <ul>
        <li><strong>IAI (מדד אטרקטיביות השקעה)</strong> - ציון 0-100, מעל 30 = כדאי להשקעה</li>
        <li><strong>SSI (מדד לחץ מוכר)</strong> - ציון 0-100, גבוה יותר = מוכר במצוקה = הזדמנות</li>
      </ul>

      <h2>רשימת מתחמים (${complexes.length} בעמוד זה)</h2>
      <table>
        <thead>
          <tr>
            <th>שם/כתובת</th><th>עיר</th><th>יזם</th><th>יח"ד</th><th>IAI</th><th>SSI</th><th>שלב</th><th>כינוס</th>
          </tr>
        </thead>
        <tbody>
          ${complexes.map(c => `
          <tr class="${c.iai_score >= 30 ? 'highlight' : ''}">
            <td>${c.name || c.addresses || '-'}</td>
            <td>${c.city || '-'}</td>
            <td>${c.developer || '-'}</td>
            <td>${c.planned_units || '-'}</td>
            <td class="${c.iai_score >= 30 ? 'good' : ''}">${c.iai_score || '-'}</td>
            <td class="${c.enhanced_ssi_score >= 40 ? 'danger' : ''}">${c.enhanced_ssi_score || '-'}</td>
            <td>${c.status || '-'}</td>
            <td>${c.is_receivership ? 'V' : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
      ${pagination}
      <p><strong>טיפ:</strong> השתמש ב-<a href="/api/perplexity/brain.html">brain.html</a> לסיכום קומפקטי של כל הנתונים.</p>
    `;

    res.type('html').send(htmlWrapper(
      `מתחמי פינוי-בינוי | עמוד ${page}/${totalPages}`,
      `QUANTUM - מאגר מתחמי פינוי-בינוי בישראל. ${total} מתחמים.`,
      content
    ));
    logger.info(`Perplexity: Served complexes.html page ${page}/${totalPages} (${complexes.length} items)`);
    
  } catch (error) {
    logger.error('Perplexity complexes.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// OPPORTUNITIES - High IAI investments
// =====================================================
router.get('/opportunities.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, addresses, developer,
             planned_units, actual_premium,
             iai_score, enhanced_ssi_score, status
      FROM complexes 
      WHERE iai_score >= 30
      ORDER BY iai_score DESC
      LIMIT 100
    `);
    const opportunities = result.rows;
    const content = `
      <h1>QUANTUM - הזדמנויות השקעה מובילות</h1>
      <p>מתחמים עם IAI מעל 30. סה"כ: <strong>${opportunities.length}</strong></p>
      <table>
        <thead><tr><th>#</th><th>מתחם</th><th>עיר</th><th>יזם</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead>
        <tbody>
          ${opportunities.map((o, i) => `<tr>
            <td>${i + 1}</td><td>${o.name || o.addresses || '-'}</td><td>${o.city || '-'}</td>
            <td>${o.developer || '-'}</td><td class="good"><strong>${o.iai_score}</strong></td>
            <td>${o.enhanced_ssi_score || '-'}</td><td>${o.status || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('הזדמנויות השקעה בפינוי-בינוי', `QUANTUM - ${opportunities.length} הזדמנויות השקעה בפינוי-בינוי.`, content));
  } catch (error) {
    logger.error('Perplexity opportunities.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// STRESSED SELLERS - High SSI distressed
// =====================================================
router.get('/stressed-sellers.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, addresses, developer,
             iai_score, enhanced_ssi_score, status, ssi_enhancement_factors,
             is_receivership, has_enforcement_cases,
             has_bankruptcy_proceedings, is_inheritance_property
      FROM complexes 
      WHERE enhanced_ssi_score >= 10
      ORDER BY enhanced_ssi_score DESC
      LIMIT 100
    `);
    const sellers = result.rows;
    const content = `
      <h1>QUANTUM - מוכרים במצוקה (SSI)</h1>
      <p>SSI = מדד לחץ מוכר. גבוה יותר = מצוקה גדולה יותר = הזדמנות. סה"כ: <strong>${sellers.length}</strong></p>
      <table>
        <thead><tr><th>מתחם</th><th>עיר</th><th>SSI</th><th>IAI</th><th>כינוס</th><th>הוצל"פ</th><th>ירושה</th><th>גורמים</th></tr></thead>
        <tbody>
          ${sellers.map(s => {
            let factors = s.ssi_enhancement_factors;
            if (typeof factors === 'string') { try { factors = JSON.parse(factors); } catch(e) { factors = []; } }
            if (!Array.isArray(factors)) factors = [];
            return `<tr>
              <td>${s.name || s.addresses || '-'}</td><td>${s.city || '-'}</td>
              <td class="danger"><strong>${s.enhanced_ssi_score}</strong></td><td>${s.iai_score || '-'}</td>
              <td>${s.is_receivership ? 'V' : '-'}</td>
              <td>${s.has_enforcement_cases ? 'V' : '-'}</td>
              <td>${s.is_inheritance_property ? 'V' : '-'}</td>
              <td>${factors.slice(0,2).join('; ') || '-'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('מוכרים במצוקה', `QUANTUM - ${sellers.length} מוכרים במצוקה בפינוי-בינוי.`, content));
  } catch (error) {
    logger.error('Perplexity stressed-sellers.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// COMMITTEE DECISIONS
// =====================================================
router.get('/decisions.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cd.*, c.name as complex_name, c.city, c.addresses
      FROM committee_decisions cd LEFT JOIN complexes c ON cd.complex_id = c.id
      ORDER BY cd.decision_date DESC NULLS LAST LIMIT 200
    `);
    const decisions = result.rows;
    const content = `
      <h1>QUANTUM - החלטות ועדות תכנון</h1>
      <p>סה"כ: <strong>${decisions.length}</strong>. אישור ועדה = טריגר לעליית מחירים.</p>
      <table>
        <thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>ועדה</th><th>סוג</th><th>הצבעה</th></tr></thead>
        <tbody>
          ${decisions.map(d => `<tr>
            <td>${d.decision_date ? new Date(d.decision_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${d.complex_name || d.addresses || '-'}</td><td>${d.city || '-'}</td>
            <td>${d.committee || '-'}</td><td>${d.decision_type || '-'}</td><td>${d.vote || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('החלטות ועדות תכנון', 'QUANTUM - החלטות ועדות תכנון בפינוי-בינוי.', content));
  } catch (error) {
    logger.error('Perplexity decisions.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// UPCOMING HEARINGS
// =====================================================
router.get('/hearings.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT uh.*, c.name as complex_name, c.city, c.addresses, c.iai_score
      FROM upcoming_hearings uh LEFT JOIN complexes c ON uh.complex_id = c.id
      WHERE uh.hearing_date >= CURRENT_DATE ORDER BY uh.hearing_date ASC LIMIT 100
    `);
    const hearings = result.rows;
    const content = `
      <h1>QUANTUM - דיונים עתידיים בוועדות</h1>
      <p>סה"כ: <strong>${hearings.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>ועדה</th><th>נושא</th><th>IAI</th></tr></thead>
        <tbody>
          ${hearings.map(h => `<tr${h.iai_score >= 30 ? ' class="highlight"' : ''}>
            <td><strong>${h.hearing_date ? new Date(h.hearing_date).toLocaleDateString('he-IL') : '-'}</strong></td>
            <td>${h.complex_name || h.addresses || '-'}</td><td>${h.city || '-'}</td>
            <td>${h.committee || '-'}</td><td>${h.subject || '-'}</td>
            <td class="${h.iai_score >= 30 ? 'good' : ''}">${h.iai_score || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('דיונים עתידיים', 'QUANTUM - דיונים קרובים בוועדות תכנון.', content));
  } catch (error) {
    logger.error('Perplexity hearings.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// KONES/RECEIVERSHIP
// =====================================================
router.get('/kones.html', async (req, res) => {
  try {
    let listings = [];
    try { listings = (await pool.query('SELECT * FROM kones_listings ORDER BY created_at DESC LIMIT 200')).rows; } catch (e) {}
    const content = `
      <h1>QUANTUM - נכסי כינוס נכסים</h1>
      <p>סה"כ: <strong>${listings.length}</strong></p>
      <table>
        <thead><tr><th>כתובת</th><th>עיר</th><th>סוג</th><th>חדרים</th><th>מ"ר</th><th>מחיר</th></tr></thead>
        <tbody>
          ${listings.map(l => `<tr>
            <td>${l.address || '-'}</td><td>${l.city || '-'}</td><td>${l.property_type || '-'}</td>
            <td>${l.rooms || '-'}</td><td>${l.size_sqm || '-'}</td>
            <td>${l.price ? '₪' + Number(l.price).toLocaleString() : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('נכסי כינוס נכסים', 'QUANTUM - נכסי כינוס נכסים בישראל.', content));
  } catch (error) {
    logger.error('Perplexity kones.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// TRANSACTIONS
// =====================================================
router.get('/transactions.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, c.name as complex_name, c.city
      FROM transactions t LEFT JOIN complexes c ON t.complex_id = c.id
      ORDER BY t.transaction_date DESC NULLS LAST LIMIT 500
    `);
    const transactions = result.rows;
    const content = `
      <h1>QUANTUM - עסקאות נדל"ן</h1>
      <p>סה"כ: <strong>${transactions.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>כתובת</th><th>שטח</th><th>מחיר</th><th>מחיר/מ"ר</th></tr></thead>
        <tbody>
          ${transactions.map(t => `<tr>
            <td>${t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${t.complex_name || '-'}</td><td>${t.city || '-'}</td><td>${t.address || '-'}</td>
            <td>${t.size_sqm ? t.size_sqm + ' מ"ר' : '-'}</td>
            <td>${t.price ? '₪' + Number(t.price).toLocaleString() : '-'}</td>
            <td>${t.price_per_sqm ? '₪' + Number(t.price_per_sqm).toLocaleString() : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('עסקאות נדל"ן', 'QUANTUM - עסקאות נדל"ן בפינוי-בינוי.', content));
  } catch (error) {
    logger.error('Perplexity transactions.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// NEWS ALERTS
// =====================================================
router.get('/news.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT na.*, c.name as complex_name, c.city
      FROM news_alerts na LEFT JOIN complexes c ON na.complex_id = c.id
      ORDER BY na.created_at DESC LIMIT 100
    `);
    const news = result.rows;
    const content = `
      <h1>QUANTUM - חדשות והתראות</h1>
      <p>סה"כ: <strong>${news.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>מתחם</th><th>כותרת</th></tr></thead>
        <tbody>
          ${news.map(n => `<tr>
            <td>${n.created_at ? new Date(n.created_at).toLocaleDateString('he-IL') : '-'}</td>
            <td>${n.alert_type || '-'}</td><td>${n.complex_name || '-'}</td><td>${n.title || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('חדשות והתראות', 'QUANTUM - חדשות והתראות שוק.', content));
  } catch (error) {
    logger.error('Perplexity news.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// REGULATIONS
// =====================================================
router.get('/regulations.html', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM regulation_updates ORDER BY effective_date DESC NULLS LAST, created_at DESC LIMIT 50');
    const regulations = result.rows;
    const content = `
      <h1>QUANTUM - עדכוני רגולציה</h1>
      <p>סה"כ: <strong>${regulations.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>כותרת</th><th>השפעה</th></tr></thead>
        <tbody>
          ${regulations.map(r => `<tr>
            <td>${r.effective_date ? new Date(r.effective_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${r.update_type || '-'}</td><td>${r.title || '-'}</td><td>${r.impact || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('עדכוני רגולציה', 'QUANTUM - עדכוני רגולציה.', content));
  } catch (error) {
    logger.error('Perplexity regulations.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// DEVELOPERS
// =====================================================
router.get('/developers.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, COUNT(c.id) as active_projects, ROUND(AVG(c.iai_score)) as avg_iai
      FROM developers d LEFT JOIN complexes c ON c.developer = d.name
      GROUP BY d.id ORDER BY active_projects DESC
    `);
    const developers = result.rows;
    const content = `
      <h1>QUANTUM - מאגר יזמים</h1>
      <p>סה"כ: <strong>${developers.length}</strong></p>
      <table>
        <thead><tr><th>שם יזם</th><th>ציון סיכון</th><th>פרויקטים</th><th>IAI ממוצע</th></tr></thead>
        <tbody>
          ${developers.map(d => `<tr>
            <td>${d.name || '-'}</td><td>${d.risk_score || '-'}</td>
            <td>${d.active_projects || 0}</td><td>${d.avg_iai || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('מאגר יזמים', 'QUANTUM - יזמי נדל"ן.', content));
  } catch (error) {
    logger.error('Perplexity developers.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// CITY-SPECIFIC DATA
// =====================================================
router.get('/city/:city.html', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const result = await pool.query(`
      SELECT id, name, city, addresses, developer, planned_units, actual_premium,
             iai_score, enhanced_ssi_score, status
      FROM complexes WHERE city ILIKE $1 ORDER BY iai_score DESC NULLS LAST
    `, [`%${city}%`]);
    const complexes = result.rows;
    const content = `
      <h1>פינוי-בינוי ב${city}</h1>
      <p>סה"כ: <strong>${complexes.length}</strong> | IAI 30+: <strong>${complexes.filter(c => c.iai_score >= 30).length}</strong></p>
      <table>
        <thead><tr><th>מתחם</th><th>יזם</th><th>יח"ד</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead>
        <tbody>
          ${complexes.map(c => `<tr class="${c.iai_score >= 30 ? 'highlight' : ''}">
            <td>${c.name || c.addresses || '-'}</td><td>${c.developer || '-'}</td>
            <td>${c.planned_units || '-'}</td>
            <td class="${c.iai_score >= 30 ? 'good' : ''}">${c.iai_score || '-'}</td>
            <td class="${c.enhanced_ssi_score >= 40 ? 'danger' : ''}">${c.enhanced_ssi_score || '-'}</td>
            <td>${c.status || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper(`פינוי-בינוי ב${city}`, `${complexes.length} מתחמים ב${city}.`, content));
  } catch (error) {
    logger.error('Perplexity city.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// FULL EXPORT JSON - Complete DB dump (LARGE - ~2.6MB)
// For bulk analysis only, NOT for AI consumption
// =====================================================
router.get('/full-export.json', async (req, res) => {
  try {
    const [complexes, transactions, listings, alerts, scanLogs, benchmarks, decisions, hearings, developers, news, regulations] = await Promise.all([
      pool.query('SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST'),
      pool.query('SELECT * FROM transactions ORDER BY transaction_date DESC LIMIT 2000'),
      pool.query('SELECT * FROM listings ORDER BY created_at DESC LIMIT 2000'),
      pool.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 1000'),
      pool.query('SELECT * FROM scan_logs ORDER BY created_at DESC LIMIT 200'),
      pool.query('SELECT * FROM benchmarks ORDER BY created_at DESC LIMIT 50'),
      pool.query('SELECT * FROM committee_decisions ORDER BY decision_date DESC LIMIT 500'),
      pool.query('SELECT * FROM upcoming_hearings ORDER BY hearing_date ASC'),
      pool.query('SELECT * FROM developers ORDER BY risk_score NULLS LAST'),
      pool.query('SELECT * FROM news_alerts ORDER BY created_at DESC LIMIT 500'),
      pool.query('SELECT * FROM regulation_updates ORDER BY effective_date DESC')
    ]);
    let konesListings = []; try { konesListings = (await pool.query('SELECT * FROM kones_listings WHERE is_active = true ORDER BY created_at DESC')).rows; } catch (e) {}
    let distressedSellers = []; try { distressedSellers = (await pool.query('SELECT * FROM distressed_sellers ORDER BY created_at DESC')).rows; } catch (e) {}
    let priceHistory = []; try { priceHistory = (await pool.query('SELECT * FROM price_history ORDER BY created_at DESC LIMIT 1000')).rows; } catch (e) {}
    let developerNews = []; try { developerNews = (await pool.query('SELECT * FROM developer_news ORDER BY created_at DESC LIMIT 200')).rows; } catch (e) {}

    const allComplexes = complexes.rows;
    const cities = [...new Set(allComplexes.map(c => c.city).filter(Boolean))].sort();
    const cityBreakdown = {};
    for (const c of allComplexes) {
      if (!c.city) continue;
      if (!cityBreakdown[c.city]) cityBreakdown[c.city] = { total: 0, iai30plus: 0, iai70plus: 0 };
      cityBreakdown[c.city].total++;
      if (c.iai_score >= 30) cityBreakdown[c.city].iai30plus++;
      if (c.iai_score >= 70) cityBreakdown[c.city].iai70plus++;
    }

    res.json({
      metadata: {
        source: 'QUANTUM - Pinuy Binuy Investment Analyzer',
        description: 'WARNING: This is a LARGE file (~2.6MB). For AI consumption, use /api/perplexity/brain.json or /api/perplexity/brain.html instead.',
        version: '4.10.1',
        exported_at: new Date().toISOString(),
        stats: {
          total_complexes: allComplexes.length,
          unique_cities: cities.length,
          opportunities_iai30plus: allComplexes.filter(c => c.iai_score >= 30).length,
          stressed_sellers_ssi40plus: allComplexes.filter(c => c.enhanced_ssi_score >= 40).length,
        }
      },
      data: {
        complexes: allComplexes,
        opportunities: allComplexes.filter(c => c.iai_score >= 30).map((c, i) => ({ rank: i+1, id: c.id, name: c.name, city: c.city, iai_score: c.iai_score, enhanced_ssi_score: c.enhanced_ssi_score, status: c.status })),
        stressed_sellers: allComplexes.filter(c => c.enhanced_ssi_score >= 40),
        transactions: transactions.rows,
        yad2_listings: listings.rows,
        kones_listings: konesListings,
        distressed_sellers: distressedSellers,
        price_history: priceHistory,
        committee_decisions: decisions.rows,
        upcoming_hearings: hearings.rows,
        regulation_updates: regulations.rows,
        developers: developers.rows,
        developer_news: developerNews,
        news_alerts: news.rows,
        alerts: alerts.rows,
        scan_logs: scanLogs.rows,
        benchmarks: benchmarks.rows,
        city_breakdown: cityBreakdown,
        cities: cities
      }
    });
    logger.info(`Perplexity: Served full-export.json (${allComplexes.length} complexes)`);
  } catch (error) {
    logger.error('Perplexity full-export.json error:', error);
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// =====================================================
// SIMPLE JSON EXPORT (complexes only)
// =====================================================
router.get('/export.json', async (req, res) => {
  try {
    const complexes = await pool.query('SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST');
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as high_iai, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as high_ssi, COUNT(DISTINCT city) as cities FROM complexes`);
    res.json({ metadata: { source: 'QUANTUM', exported_at: new Date().toISOString(), stats: stats.rows[0] }, complexes: complexes.rows });
  } catch (error) {
    logger.error('Perplexity export.json error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// =====================================================
// SITEMAP
// =====================================================
router.get('/sitemap.xml', async (req, res) => {
  try {
    const cities = await pool.query('SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL');
    const baseUrl = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/perplexity';
    const pages = [
      { path: '/brain.html', priority: '1.0', freq: 'hourly' },
      { path: '/brain.json', priority: '1.0', freq: 'hourly' },
      { path: '/opportunities.html', priority: '0.9', freq: 'daily' },
      { path: '/stressed-sellers.html', priority: '0.9', freq: 'daily' },
      { path: '/kones.html', priority: '0.9', freq: 'daily' },
      { path: '/complexes.html', priority: '0.8', freq: 'daily' },
      { path: '/decisions.html', priority: '0.8', freq: 'daily' },
      { path: '/transactions.html', priority: '0.7', freq: 'weekly' },
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${pages.map(p => `<url><loc>${baseUrl}${p.path}</loc><changefreq>${p.freq}</changefreq><priority>${p.priority}</priority></url>`).join('\n  ')}
  ${cities.rows.map(c => `<url><loc>${baseUrl}/city/${encodeURIComponent(c.city)}.html</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('\n  ')}
</urlset>`;
    res.type('application/xml').send(xml);
  } catch (error) {
    logger.error('Perplexity sitemap error:', error);
    res.status(500).send('Error generating sitemap');
  }
});

// =====================================================
// INDEX PAGE - Entry point
// =====================================================
router.get('/', (req, res) => {
  const content = `
    <h1>QUANTUM - Perplexity AI Integration</h1>
    
    <h2>AI-Optimized Endpoints (Compact)</h2>
    <ul>
      <li><a href="/api/perplexity/brain.html"><strong>brain.html</strong></a> - כל הנתונים החשובים בעמוד אחד קומפקטי (~12KB). <strong>מומלץ לשימוש ראשי.</strong></li>
      <li><a href="/api/perplexity/brain.json"><strong>brain.json</strong></a> - JSON קומפקטי (~10KB) לגישה תכנותית.</li>
    </ul>

    <h2>Detailed Data Pages</h2>
    <ul>
      <li><a href="/api/perplexity/opportunities.html">opportunities.html</a> - הזדמנויות השקעה (~8KB)</li>
      <li><a href="/api/perplexity/stressed-sellers.html">stressed-sellers.html</a> - מוכרים במצוקה (~5KB)</li>
      <li><a href="/api/perplexity/kones.html">kones.html</a> - כינוס נכסים (~3KB)</li>
      <li><a href="/api/perplexity/transactions.html">transactions.html</a> - עסקאות (~13KB)</li>
      <li><a href="/api/perplexity/decisions.html">decisions.html</a> - החלטות ועדות</li>
      <li><a href="/api/perplexity/hearings.html">hearings.html</a> - דיונים קרובים</li>
      <li><a href="/api/perplexity/developers.html">developers.html</a> - יזמים</li>
      <li><a href="/api/perplexity/news.html">news.html</a> - חדשות</li>
      <li><a href="/api/perplexity/regulations.html">regulations.html</a> - רגולציה</li>
      <li><a href="/api/perplexity/complexes.html?page=1&limit=50">complexes.html</a> - כל המתחמים (paginated)</li>
      <li>City search: /api/perplexity/city/{city_name}.html</li>
    </ul>

    <h2>Bulk Export (LARGE - Not for AI)</h2>
    <ul>
      <li><a href="/api/perplexity/export.json">export.json</a> - מתחמים בלבד</li>
      <li><a href="/api/perplexity/full-export.json">full-export.json</a> - כל ה-DB (~2.6MB - bulk only!)</li>
    </ul>`;
  res.type('html').send(htmlWrapper('Perplexity AI Integration', 'QUANTUM - Perplexity AI data access portal.', content));
});

module.exports = router;
