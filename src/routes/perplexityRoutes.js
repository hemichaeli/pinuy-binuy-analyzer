/**
 * Perplexity Integration Routes
 * Public endpoints for Perplexity AI to crawl and index QUANTUM data
 * 
 * KEY ENDPOINTS FOR AI:
 * - /api/perplexity/brain.html - COMPACT single page (~12KB) with all essential data
 * - /api/perplexity/brain.json - COMPACT JSON (~10KB) for programmatic access
 * - /api/perplexity/complexes.html - Full complex list (paginated)
 * - /api/perplexity/full-export.json - Complete DB dump (VERY LARGE ~2.6MB)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const htmlWrapper = (title, description, content) => `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="${description}">
  <meta name="keywords" content="פינוי בינוי, התחדשות עירונית, השקעות נדלן, ישראל, QUANTUM">
  <title>QUANTUM - ${title}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:20px;background:#f5f5f5}
    h1{color:#1a365d}h2{color:#2d3748;margin-top:30px}
    table{border-collapse:collapse;width:100%;background:#fff;margin:10px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:right}
    th{background:#1a365d;color:#fff}
    tr:nth-child(even){background:#f9f9f9}
    .highlight{background:#fff3cd}.good{color:#28a745}.warning{color:#ffc107}.danger{color:#dc3545}
    footer{margin-top:40px;padding:20px;background:#1a365d;color:#fff;text-align:center}
  </style>
</head>
<body>
  ${content}
  <footer>
    <p><strong>QUANTUM</strong> - משרד תיווך NEXT-GEN להתחדשות עירונית</p>
    <p>עודכן: ${new Date().toLocaleString('he-IL')}</p>
  </footer>
</body>
</html>`;

// =====================================================
// BRAIN.HTML - COMPACT single page (~12KB, ~3000 tokens)
// PRIMARY ENDPOINT FOR PERPLEXITY AI
// =====================================================
router.get('/brain.html', async (req, res) => {
  try {
    const [statsR, topIAI, topSSI, citiesR, konesR, alertsR, listingsR, txR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, COUNT(*) FILTER (WHERE iai_score >= 70) as excellent, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed, COUNT(DISTINCT city) as cities, ROUND(AVG(iai_score)) as avg_iai, ROUND(AVG(enhanced_ssi_score) FILTER (WHERE enhanced_ssi_score > 0)) as avg_ssi FROM complexes`),
      pool.query(`SELECT name, city, addresses, developer, iai_score, enhanced_ssi_score, status, planned_units FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 30`),
      pool.query(`SELECT name, city, addresses, enhanced_ssi_score, iai_score, ssi_enhancement_factors, is_receivership, is_inheritance_property FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 20`),
      pool.query(`SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed, ROUND(AVG(iai_score)) as avg_iai FROM complexes WHERE city IS NOT NULL GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC LIMIT 25`),
      pool.query(`SELECT address, city, property_type, price, region, source, gush_helka, submission_deadline FROM kones_listings WHERE is_active = true ORDER BY created_at DESC LIMIT 15`),
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
        <li>${ls.total} מודעות yad2, ${ls.urgent} דחופות</li>
        <li>${txR.rows[0].total} עסקאות היסטוריות</li>
        <li>IAI ממוצע: ${s.avg_iai} | SSI ממוצע: ${s.avg_ssi || 'N/A'}</li>
      </ul>

      <h2>מה זה IAI ו-SSI?</h2>
      <p><strong>IAI (מדד אטרקטיביות השקעה)</strong>: 0-100. פער בין פרמיה תיאורטית לבפועל + שלב תכנוני + יזם. מעל 30 = כדאי, מעל 70 = מצוין.</p>
      <p><strong>SSI (מדד לחץ מוכר)</strong>: 0-100. כינוס, הוצל"פ, פשיטת רגל, עיקולים, ירושות, הורדות מחיר. SSI גבוה = מחיר מתחת לשוק.</p>

      <h2>טופ 30 הזדמנויות (IAI 30+)</h2>
      <table>
        <thead><tr><th>#</th><th>מתחם</th><th>עיר</th><th>יזם</th><th>IAI</th><th>SSI</th><th>יח"ד</th><th>שלב</th></tr></thead>
        <tbody>${topIAI.rows.map((c, i) => `<tr${c.iai_score >= 70 ? ' class="highlight"' : ''}><td>${i+1}</td><td>${c.name || c.addresses || '-'}</td><td>${c.city}</td><td>${c.developer || '-'}</td><td class="good"><strong>${c.iai_score}</strong></td><td>${c.enhanced_ssi_score || '-'}</td><td>${c.planned_units || '-'}</td><td>${c.status || '-'}</td></tr>`).join('')}</tbody>
      </table>

      <h2>טופ 20 מוכרים לחוצים (SSI)</h2>
      <table>
        <thead><tr><th>מתחם</th><th>עיר</th><th>SSI</th><th>IAI</th><th>כינוס</th><th>ירושה</th><th>גורמים</th></tr></thead>
        <tbody>${topSSI.rows.map(c => {
          let f = c.ssi_enhancement_factors;
          if (typeof f === 'string') { try { f = JSON.parse(f); } catch(e) { f = []; } }
          if (!Array.isArray(f)) f = [];
          return `<tr><td>${c.name || c.addresses || '-'}</td><td>${c.city}</td><td class="danger"><strong>${c.enhanced_ssi_score}</strong></td><td>${c.iai_score || '-'}</td><td>${c.is_receivership ? 'כן' : '-'}</td><td>${c.is_inheritance_property ? 'כן' : '-'}</td><td>${f.slice(0,2).join('; ') || '-'}</td></tr>`;
        }).join('')}</tbody>
      </table>

      <h2>כינוס נכסים (${konesR.rows.length} פעילים)</h2>
      <table>
        <thead><tr><th>כתובת</th><th>עיר</th><th>סוג</th><th>אזור</th><th>גוש/חלקה</th><th>מחיר</th><th>מועד אחרון</th></tr></thead>
        <tbody>${konesR.rows.map(k => `<tr><td>${k.address || '-'}</td><td>${k.city || '-'}</td><td>${k.property_type || '-'}</td><td>${k.region || '-'}</td><td>${k.gush_helka || '-'}</td><td>${k.price ? '₪' + Number(k.price).toLocaleString() : '-'}</td><td>${k.submission_deadline || '-'}</td></tr>`).join('')}</tbody>
      </table>

      <h2>פילוח ערים (טופ 25)</h2>
      <table>
        <thead><tr><th>עיר</th><th>מתחמים</th><th>הזדמנויות</th><th>לחוצים</th><th>IAI ממוצע</th></tr></thead>
        <tbody>${citiesR.rows.map(c => `<tr><td><strong>${c.city}</strong></td><td>${c.total}</td><td class="${c.opp > 5 ? 'good' : ''}">${c.opp}</td><td class="${c.stressed > 0 ? 'danger' : ''}">${c.stressed}</td><td>${c.avg_iai || '-'}</td></tr>`).join('')}</tbody>
      </table>

      <h2>התראות אחרונות</h2>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>חומרה</th><th>עיר</th><th>כותרת</th></tr></thead>
        <tbody>${alertsR.rows.map(a => `<tr><td>${a.created_at ? new Date(a.created_at).toLocaleDateString('he-IL') : '-'}</td><td>${a.alert_type}</td><td class="${a.severity === 'critical' ? 'danger' : 'warning'}">${a.severity}</td><td>${a.city || '-'}</td><td>${(a.title || '').substring(0, 60)}</td></tr>`).join('')}</tbody>
      </table>

      <h2>עוד נתונים</h2>
      <ul>
        <li><a href="/api/perplexity/opportunities.html">הזדמנויות מלאות</a></li>
        <li><a href="/api/perplexity/stressed-sellers.html">מוכרים במצוקה מלא</a></li>
        <li><a href="/api/perplexity/kones.html">כינוס נכסים</a></li>
        <li><a href="/api/perplexity/transactions.html">עסקאות</a></li>
        <li><a href="/api/perplexity/decisions.html">החלטות ועדות</a></li>
        <li>עיר ספציפית: /api/perplexity/city/[שם].html</li>
      </ul>`;

    res.type('html').send(htmlWrapper('QUANTUM Brain - מודיעין נדל"ן', 'QUANTUM - סיכום מתחמים, הזדמנויות, מוכרים במצוקה, כינוסים. פינוי-בינוי ישראל.', content));
    logger.info('Perplexity: Served brain.html');
  } catch (error) {
    logger.error('brain.html error:', error);
    res.status(500).send('Error generating brain page');
  }
});

// =====================================================
// BRAIN.JSON - Compact JSON (~10KB)
// =====================================================
router.get('/brain.json', async (req, res) => {
  try {
    const [statsR, topIAI, topSSI, citiesR, konesR, goldR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opportunities, COUNT(*) FILTER (WHERE iai_score >= 70) as excellent, COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed_sellers, COUNT(DISTINCT city) as cities, ROUND(AVG(iai_score)) as avg_iai FROM complexes`),
      pool.query(`SELECT name, city, developer, iai_score, enhanced_ssi_score as ssi, status FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 25`),
      pool.query(`SELECT name, city, enhanced_ssi_score as ssi, iai_score, is_receivership, is_inheritance_property FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 15`),
      pool.query(`SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp, ROUND(AVG(iai_score)) as avg_iai FROM complexes WHERE city IS NOT NULL GROUP BY city HAVING COUNT(*) >= 3 ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC LIMIT 20`),
      pool.query(`SELECT address, city, property_type, price, region, source FROM kones_listings WHERE is_active = true ORDER BY created_at DESC LIMIT 10`),
      pool.query(`SELECT name, city, iai_score, enhanced_ssi_score as ssi FROM complexes WHERE iai_score >= 40 AND enhanced_ssi_score >= 30 ORDER BY (iai_score + enhanced_ssi_score) DESC LIMIT 10`)
    ]);
    res.json({
      source: 'QUANTUM Intelligence - Pinuy Binuy Israel',
      updated: new Date().toISOString(),
      metrics: { IAI: 'Investment Attractiveness (0-100). 30+=good, 70+=excellent', SSI: 'Seller Stress (0-100). High=distressed=below-market price' },
      summary: statsR.rows[0],
      golden_opportunities: goldR.rows,
      top_investments: topIAI.rows,
      stressed_sellers: topSSI.rows,
      receivership_properties: konesR.rows,
      city_breakdown: citiesR.rows,
      pages: { brain: '/api/perplexity/brain.html', opportunities: '/api/perplexity/opportunities.html', stressed: '/api/perplexity/stressed-sellers.html', kones: '/api/perplexity/kones.html', transactions: '/api/perplexity/transactions.html', city: '/api/perplexity/city/{name}.html' }
    });
    logger.info('Perplexity: Served brain.json');
  } catch (error) {
    logger.error('brain.json error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// COMPLEXES (paginated)
// =====================================================
router.get('/complexes.html', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const city = req.query.city || null;
    let where = '', params = [];
    if (city) { where = 'WHERE city ILIKE $1'; params = [`%${city}%`]; }
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM complexes ${where}`, params)).rows[0].count);
    const pages = Math.ceil(total / limit);
    const rows = (await pool.query(`SELECT id, name, city, addresses, status, developer, planned_units, iai_score, enhanced_ssi_score, is_receivership FROM complexes ${where} ORDER BY iai_score DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`, params)).rows;
    const nav = pages > 1 ? `<p>עמוד ${page}/${pages} (${total} סה"כ) | ${page > 1 ? `<a href="?page=${page-1}${city?'&city='+city:''}">הקודם</a> | ` : ''}${page < pages ? `<a href="?page=${page+1}${city?'&city='+city:''}">הבא</a>` : ''}</p>` : '';
    const content = `<h1>מתחמי פינוי-בינוי</h1><p>${total} מתחמים${city ? ` (${city})` : ''}</p>${nav}<table><thead><tr><th>שם</th><th>עיר</th><th>יזם</th><th>יח"ד</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead><tbody>${rows.map(c => `<tr class="${c.iai_score >= 30 ? 'highlight' : ''}"><td>${c.name || c.addresses || '-'}</td><td>${c.city || '-'}</td><td>${c.developer || '-'}</td><td>${c.planned_units || '-'}</td><td class="${c.iai_score >= 30 ? 'good' : ''}">${c.iai_score || '-'}</td><td>${c.enhanced_ssi_score || '-'}</td><td>${c.status || '-'}</td></tr>`).join('')}</tbody></table>${nav}`;
    res.type('html').send(htmlWrapper(`מתחמים ${page}/${pages}`, `${total} מתחמי פינוי-בינוי.`, content));
  } catch (error) { logger.error('complexes.html error:', error); res.status(500).send('Error'); }
});

// =====================================================
// OPPORTUNITIES
// =====================================================
router.get('/opportunities.html', async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT name, city, addresses, developer, iai_score, enhanced_ssi_score, status FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 100`)).rows;
    const content = `<h1>הזדמנויות השקעה</h1><p>${rows.length} מתחמים עם IAI 30+</p><table><thead><tr><th>#</th><th>מתחם</th><th>עיר</th><th>יזם</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead><tbody>${rows.map((o, i) => `<tr><td>${i+1}</td><td>${o.name || o.addresses || '-'}</td><td>${o.city || '-'}</td><td>${o.developer || '-'}</td><td class="good"><strong>${o.iai_score}</strong></td><td>${o.enhanced_ssi_score || '-'}</td><td>${o.status || '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('הזדמנויות השקעה', `${rows.length} הזדמנויות.`, content));
  } catch (error) { logger.error('opportunities error:', error); res.status(500).send('Error'); }
});

// =====================================================
// STRESSED SELLERS
// =====================================================
router.get('/stressed-sellers.html', async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT name, city, addresses, iai_score, enhanced_ssi_score, ssi_enhancement_factors, is_receivership, has_enforcement_cases, is_inheritance_property FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 100`)).rows;
    const content = `<h1>מוכרים במצוקה (SSI)</h1><p>${rows.length} מתחמים</p><table><thead><tr><th>מתחם</th><th>עיר</th><th>SSI</th><th>IAI</th><th>כינוס</th><th>הוצל"פ</th><th>ירושה</th></tr></thead><tbody>${rows.map(s => `<tr><td>${s.name || s.addresses || '-'}</td><td>${s.city || '-'}</td><td class="danger"><strong>${s.enhanced_ssi_score}</strong></td><td>${s.iai_score || '-'}</td><td>${s.is_receivership ? 'V' : '-'}</td><td>${s.has_enforcement_cases ? 'V' : '-'}</td><td>${s.is_inheritance_property ? 'V' : '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('מוכרים במצוקה', `${rows.length} מוכרים במצוקה.`, content));
  } catch (error) { logger.error('stressed error:', error); res.status(500).send('Error'); }
});

// =====================================================
// COMMITTEE DECISIONS
// =====================================================
router.get('/decisions.html', async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT cd.*, c.name as cn, c.city, c.addresses FROM committee_decisions cd LEFT JOIN complexes c ON cd.complex_id = c.id ORDER BY cd.decision_date DESC NULLS LAST LIMIT 200`)).rows;
    const content = `<h1>החלטות ועדות תכנון</h1><p>${rows.length} החלטות</p><table><thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>ועדה</th><th>סוג</th><th>הצבעה</th></tr></thead><tbody>${rows.map(d => `<tr><td>${d.decision_date ? new Date(d.decision_date).toLocaleDateString('he-IL') : '-'}</td><td>${d.cn || d.addresses || '-'}</td><td>${d.city || '-'}</td><td>${d.committee || '-'}</td><td>${d.decision_type || '-'}</td><td>${d.vote || '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('החלטות ועדות', `${rows.length} החלטות.`, content));
  } catch (error) { logger.error('decisions error:', error); res.status(500).send('Error'); }
});

// =====================================================
// HEARINGS
// =====================================================
router.get('/hearings.html', async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT uh.*, c.name as cn, c.city, c.addresses, c.iai_score FROM upcoming_hearings uh LEFT JOIN complexes c ON uh.complex_id = c.id WHERE uh.hearing_date >= CURRENT_DATE ORDER BY uh.hearing_date ASC LIMIT 100`)).rows;
    const content = `<h1>דיונים עתידיים</h1><p>${rows.length} דיונים</p><table><thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>ועדה</th><th>נושא</th><th>IAI</th></tr></thead><tbody>${rows.map(h => `<tr><td>${h.hearing_date ? new Date(h.hearing_date).toLocaleDateString('he-IL') : '-'}</td><td>${h.cn || h.addresses || '-'}</td><td>${h.city || '-'}</td><td>${h.committee || '-'}</td><td>${h.subject || '-'}</td><td>${h.iai_score || '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('דיונים עתידיים', `${rows.length} דיונים.`, content));
  } catch (error) { logger.error('hearings error:', error); res.status(500).send('Error'); }
});

// =====================================================
// KONES
// =====================================================
router.get('/kones.html', async (req, res) => {
  try {
    let rows = []; try { rows = (await pool.query('SELECT address, city, property_type, price, region, source, gush_helka, submission_deadline FROM kones_listings ORDER BY created_at DESC LIMIT 200')).rows; } catch (e) {}
    const content = `<h1>נכסי כינוס נכסים</h1><p>${rows.length} נכסים</p><table><thead><tr><th>כתובת</th><th>עיר</th><th>סוג</th><th>אזור</th><th>גוש/חלקה</th><th>מחיר</th><th>מועד אחרון</th></tr></thead><tbody>${rows.map(l => `<tr><td>${l.address || '-'}</td><td>${l.city || '-'}</td><td>${l.property_type || '-'}</td><td>${l.region || '-'}</td><td>${l.gush_helka || '-'}</td><td>${l.price ? '₪' + Number(l.price).toLocaleString() : '-'}</td><td>${l.submission_deadline || '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('כינוס נכסים', `${rows.length} נכסי כינוס.`, content));
  } catch (error) { logger.error('kones error:', error); res.status(500).send('Error'); }
});

// =====================================================
// TRANSACTIONS
// =====================================================
router.get('/transactions.html', async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT t.*, c.name as cn, c.city FROM transactions t LEFT JOIN complexes c ON t.complex_id = c.id ORDER BY t.transaction_date DESC NULLS LAST LIMIT 500`)).rows;
    const content = `<h1>עסקאות נדל"ן</h1><p>${rows.length} עסקאות</p><table><thead><tr><th>תאריך</th><th>מתחם</th><th>עיר</th><th>כתובת</th><th>שטח</th><th>מחיר</th><th>מחיר/מ"ר</th></tr></thead><tbody>${rows.map(t => `<tr><td>${t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('he-IL') : '-'}</td><td>${t.cn || '-'}</td><td>${t.city || '-'}</td><td>${t.address || '-'}</td><td>${t.size_sqm ? t.size_sqm + ' מ"ר' : '-'}</td><td>${t.price ? '₪' + Number(t.price).toLocaleString() : '-'}</td><td>${t.price_per_sqm ? '₪' + Number(t.price_per_sqm).toLocaleString() : '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper('עסקאות', `${rows.length} עסקאות.`, content));
  } catch (error) { logger.error('transactions error:', error); res.status(500).send('Error'); }
});

// NEWS, REGULATIONS, DEVELOPERS
router.get('/news.html', async (req, res) => { try { const rows = (await pool.query(`SELECT na.*, c.name as cn, c.city FROM news_alerts na LEFT JOIN complexes c ON na.complex_id = c.id ORDER BY na.created_at DESC LIMIT 100`)).rows; const content = `<h1>חדשות</h1><p>${rows.length}</p><table><thead><tr><th>תאריך</th><th>סוג</th><th>מתחם</th><th>כותרת</th></tr></thead><tbody>${rows.map(n => `<tr><td>${n.created_at ? new Date(n.created_at).toLocaleDateString('he-IL') : '-'}</td><td>${n.alert_type || '-'}</td><td>${n.cn || '-'}</td><td>${n.title || '-'}</td></tr>`).join('')}</tbody></table>`; res.type('html').send(htmlWrapper('חדשות', 'חדשות.', content)); } catch (error) { res.status(500).send('Error'); }});
router.get('/regulations.html', async (req, res) => { try { const rows = (await pool.query('SELECT * FROM regulation_updates ORDER BY effective_date DESC NULLS LAST LIMIT 50')).rows; const content = `<h1>רגולציה</h1><p>${rows.length}</p><table><thead><tr><th>תאריך</th><th>סוג</th><th>כותרת</th><th>השפעה</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.effective_date ? new Date(r.effective_date).toLocaleDateString('he-IL') : '-'}</td><td>${r.update_type || '-'}</td><td>${r.title || '-'}</td><td>${r.impact || '-'}</td></tr>`).join('')}</tbody></table>`; res.type('html').send(htmlWrapper('רגולציה', 'רגולציה.', content)); } catch (error) { res.status(500).send('Error'); }});
router.get('/developers.html', async (req, res) => { try { const rows = (await pool.query(`SELECT d.*, COUNT(c.id) as projects, ROUND(AVG(c.iai_score)) as avg_iai FROM developers d LEFT JOIN complexes c ON c.developer = d.name GROUP BY d.id ORDER BY projects DESC`)).rows; const content = `<h1>יזמים</h1><p>${rows.length}</p><table><thead><tr><th>שם</th><th>סיכון</th><th>פרויקטים</th><th>IAI</th></tr></thead><tbody>${rows.map(d => `<tr><td>${d.name || '-'}</td><td>${d.risk_score || '-'}</td><td>${d.projects || 0}</td><td>${d.avg_iai || '-'}</td></tr>`).join('')}</tbody></table>`; res.type('html').send(htmlWrapper('יזמים', 'יזמים.', content)); } catch (error) { res.status(500).send('Error'); }});

// =====================================================
// CITY
// =====================================================
router.get('/city/:city.html', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const rows = (await pool.query(`SELECT name, city, addresses, developer, planned_units, iai_score, enhanced_ssi_score, status FROM complexes WHERE city ILIKE $1 ORDER BY iai_score DESC NULLS LAST`, [`%${city}%`])).rows;
    const content = `<h1>פינוי-בינוי ב${city}</h1><p>${rows.length} מתחמים, ${rows.filter(c => c.iai_score >= 30).length} הזדמנויות</p><table><thead><tr><th>מתחם</th><th>יזם</th><th>יח"ד</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead><tbody>${rows.map(c => `<tr class="${c.iai_score >= 30 ? 'highlight' : ''}"><td>${c.name || c.addresses || '-'}</td><td>${c.developer || '-'}</td><td>${c.planned_units || '-'}</td><td class="${c.iai_score >= 30 ? 'good' : ''}">${c.iai_score || '-'}</td><td>${c.enhanced_ssi_score || '-'}</td><td>${c.status || '-'}</td></tr>`).join('')}</tbody></table>`;
    res.type('html').send(htmlWrapper(`${city}`, `${rows.length} מתחמים ב${city}.`, content));
  } catch (error) { res.status(500).send('Error'); }
});

// =====================================================
// FULL EXPORT (LARGE ~2.6MB)
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
    let kones = []; try { kones = (await pool.query('SELECT * FROM kones_listings WHERE is_active = true')).rows; } catch (e) {}
    let distressed = []; try { distressed = (await pool.query('SELECT * FROM distressed_sellers')).rows; } catch (e) {}
    const all = complexes.rows;
    res.json({
      metadata: { source: 'QUANTUM', version: '4.10.1', exported_at: new Date().toISOString(), note: 'LARGE file. Use /api/perplexity/brain.json for AI.' },
      data: { complexes: all, transactions: transactions.rows, yad2_listings: listings.rows, kones_listings: kones, distressed_sellers: distressed, committee_decisions: decisions.rows, upcoming_hearings: hearings.rows, regulation_updates: regulations.rows, developers: developers.rows, news_alerts: news.rows, alerts: alerts.rows, scan_logs: scanLogs.rows, benchmarks: benchmarks.rows }
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/export.json', async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST')).rows;
    res.json({ metadata: { source: 'QUANTUM', exported_at: new Date().toISOString(), total: rows.length }, complexes: rows });
  } catch (error) { res.status(500).json({ error: 'Export failed' }); }
});

// SITEMAP
router.get('/sitemap.xml', async (req, res) => {
  try {
    const cities = (await pool.query('SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL')).rows;
    const base = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/perplexity';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/brain.html','/brain.json','/opportunities.html','/stressed-sellers.html','/kones.html','/complexes.html','/decisions.html','/transactions.html'].map(p => `  <url><loc>${base}${p}</loc><changefreq>daily</changefreq><priority>${p.includes('brain') ? '1.0' : '0.8'}</priority></url>`).join('\n')}\n${cities.map(c => `  <url><loc>${base}/city/${encodeURIComponent(c.city)}.html</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('\n')}\n</urlset>`;
    res.type('application/xml').send(xml);
  } catch (error) { res.status(500).send('Error'); }
});

// INDEX
router.get('/', (req, res) => {
  const content = `<h1>QUANTUM - Perplexity AI Integration</h1>
    <h2>AI-Optimized (Compact)</h2><ul>
      <li><a href="/api/perplexity/brain.html"><strong>brain.html</strong></a> - כל הנתונים בעמוד אחד (~12KB)</li>
      <li><a href="/api/perplexity/brain.json"><strong>brain.json</strong></a> - JSON קומפקטי (~10KB)</li>
    </ul>
    <h2>Detailed Pages</h2><ul>
      <li><a href="/api/perplexity/opportunities.html">opportunities</a> | <a href="/api/perplexity/stressed-sellers.html">stressed-sellers</a> | <a href="/api/perplexity/kones.html">kones</a></li>
      <li><a href="/api/perplexity/transactions.html">transactions</a> | <a href="/api/perplexity/decisions.html">decisions</a> | <a href="/api/perplexity/hearings.html">hearings</a></li>
      <li><a href="/api/perplexity/complexes.html?page=1">complexes (paginated)</a> | city: /city/{name}.html</li>
    </ul>
    <h2>Bulk</h2><ul><li><a href="/api/perplexity/full-export.json">full-export.json (~2.6MB)</a></li></ul>`;
  res.type('html').send(htmlWrapper('Perplexity Integration', 'QUANTUM data portal.', content));
});

module.exports = router;
