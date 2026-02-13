/**
 * Perplexity Integration Routes
 * Public endpoints for Perplexity AI to crawl and index QUANTUM data
 * Covers ALL database tables for complete knowledge access
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
// 1. COMPLEXES - All urban renewal complexes
// =====================================================
router.get('/complexes.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, addresses, status, developer, 
             planned_units, existing_units, actual_premium,
             iai_score, enhanced_ssi_score,
             is_receivership, has_enforcement_cases, is_inheritance_property
      FROM complexes 
      ORDER BY iai_score DESC NULLS LAST
    `);

    const complexes = result.rows;
    
    const content = `
      <h1>QUANTUM - מאגר מתחמי פינוי-בינוי בישראל</h1>
      <p>סה"כ מתחמים במאגר: <strong>${complexes.length}</strong></p>
      
      <h2>מדדים מרכזיים</h2>
      <ul>
        <li><strong>IAI (מדד אטרקטיביות השקעה)</strong> - ציון 0-100, מעל 30 = כדאי להשקעה</li>
        <li><strong>SSI (מדד לחץ מוכר)</strong> - ציון 0-100, גבוה יותר = מוכר במצוקה = הזדמנות</li>
      </ul>

      <h2>רשימת מתחמים</h2>
      <table>
        <thead>
          <tr>
            <th>שם/כתובת</th>
            <th>עיר</th>
            <th>יזם</th>
            <th>יח"ד מתוכננות</th>
            <th>IAI</th>
            <th>SSI</th>
            <th>שלב</th>
            <th>כינוס</th>
            <th>הוצל"פ</th>
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
            <td>${c.is_receivership ? '✓' : '-'}</td>
            <td>${c.has_enforcement_cases ? '✓' : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper(
      `מאגר מתחמי פינוי-בינוי | ${complexes.length} מתחמים`,
      `QUANTUM - מאגר מתחמי פינוי-בינוי בישראל. ${complexes.length} מתחמים עם נתוני השקעה, מדדי IAI ו-SSI.`,
      content
    ));
    logger.info(`Perplexity: Served complexes.html with ${complexes.length} complexes`);
    
  } catch (error) {
    logger.error('Perplexity complexes.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 2. OPPORTUNITIES - High IAI investments
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
      <p>מתחמים עם IAI (מדד אטרקטיביות השקעה) מעל 30</p>
      <p>סה"כ הזדמנויות: <strong>${opportunities.length}</strong></p>

      <h2>למה IAI מעל 30?</h2>
      <p>מתחמים עם IAI מעל 30 מציגים פער משמעותי בין הפרמיה התיאורטית לפרמיה בפועל, 
         שלב תכנוני מתקדם, ויזם אמין - מה שמעיד על פוטנציאל תשואה גבוה.</p>

      <h2>טבלת הזדמנויות</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>מתחם</th>
            <th>עיר</th>
            <th>יזם</th>
            <th>IAI</th>
            <th>SSI</th>
            <th>שלב</th>
          </tr>
        </thead>
        <tbody>
          ${opportunities.map((o, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${o.name || o.addresses || '-'}</td>
            <td>${o.city || '-'}</td>
            <td>${o.developer || '-'}</td>
            <td class="good"><strong>${o.iai_score}</strong></td>
            <td>${o.enhanced_ssi_score || '-'}</td>
            <td>${o.status || '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper(
      `הזדמנויות השקעה בפינוי-בינוי | Top ${opportunities.length}`,
      `QUANTUM - הזדמנויות השקעה מובילות בפינוי-בינוי. ${opportunities.length} מתחמים עם IAI מעל 30.`,
      content
    ));
    logger.info(`Perplexity: Served opportunities.html with ${opportunities.length} items`);
    
  } catch (error) {
    logger.error('Perplexity opportunities.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 3. STRESSED SELLERS - High SSI distressed
// =====================================================
router.get('/stressed-sellers.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, addresses, developer,
             planned_units, actual_premium,
             iai_score, enhanced_ssi_score, status,
             is_receivership, has_enforcement_cases,
             has_bankruptcy_proceedings, is_inheritance_property
      FROM complexes 
      WHERE enhanced_ssi_score >= 40
      ORDER BY enhanced_ssi_score DESC
      LIMIT 100
    `);

    const sellers = result.rows;
    
    const content = `
      <h1>QUANTUM - מוכרים במצוקה (SSI גבוה)</h1>
      <p>מתחמים עם SSI (מדד לחץ מוכר) מעל 40</p>
      <p>סה"כ: <strong>${sellers.length}</strong></p>

      <h2>מה זה SSI?</h2>
      <p>מדד לחץ מוכר (Seller Stress Index) מזהה מוכרים במצוקה:</p>
      <ul>
        <li>כינוס נכסים - 30 נקודות</li>
        <li>הליכי פשיטת רגל - 25 נקודות</li>
        <li>תיקי הוצאה לפועל - 20 נקודות</li>
        <li>עיקולים ושעבודים - 15 נקודות</li>
        <li>נכסי ירושה - 10 נקודות</li>
      </ul>
      <p><strong>SSI גבוה = מוכר שצריך למכור מהר = הזדמנות למחיר טוב</strong></p>

      <h2>טבלת מוכרים במצוקה</h2>
      <table>
        <thead>
          <tr>
            <th>מתחם</th>
            <th>עיר</th>
            <th>SSI</th>
            <th>כינוס</th>
            <th>הוצל"פ</th>
            <th>פש"ר</th>
            <th>ירושה</th>
          </tr>
        </thead>
        <tbody>
          ${sellers.map(s => `
          <tr>
            <td>${s.name || s.addresses || '-'}</td>
            <td>${s.city || '-'}</td>
            <td class="danger"><strong>${s.enhanced_ssi_score}</strong></td>
            <td>${s.is_receivership ? '✓' : '-'}</td>
            <td>${s.has_enforcement_cases ? '✓' : '-'}</td>
            <td>${s.has_bankruptcy_proceedings ? '✓' : '-'}</td>
            <td>${s.is_inheritance_property ? '✓' : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper(
      'מוכרים במצוקה | SSI גבוה',
      'QUANTUM - מוכרים במצוקה בפינוי-בינוי. מתחמים עם SSI גבוה - הזדמנות למחיר נמוך.',
      content
    ));
    logger.info(`Perplexity: Served stressed-sellers.html with ${sellers.length} items`);
    
  } catch (error) {
    logger.error('Perplexity stressed-sellers.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 4. COMMITTEE DECISIONS - Planning approvals
// =====================================================
router.get('/decisions.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cd.*, c.name as complex_name, c.city, c.addresses
      FROM committee_decisions cd
      LEFT JOIN complexes c ON cd.complex_id = c.id
      ORDER BY cd.decision_date DESC NULLS LAST
      LIMIT 200
    `);

    const decisions = result.rows;
    
    const content = `
      <h1>QUANTUM - החלטות ועדות תכנון</h1>
      <p>סה"כ החלטות: <strong>${decisions.length}</strong></p>
      
      <h2>למה זה חשוב?</h2>
      <p>החלטות ועדות תכנון הן טריגר מרכזי לעליית מחירים. אישור ועדה מקומית יכול להעלות ערך נכס ב-15-25%.</p>

      <h2>החלטות אחרונות</h2>
      <table>
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מתחם</th>
            <th>עיר</th>
            <th>ועדה</th>
            <th>סוג החלטה</th>
            <th>נושא</th>
            <th>הצבעה</th>
          </tr>
        </thead>
        <tbody>
          ${decisions.map(d => `
          <tr>
            <td>${d.decision_date ? new Date(d.decision_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${d.complex_name || d.addresses || '-'}</td>
            <td>${d.city || '-'}</td>
            <td>${d.committee || '-'}</td>
            <td>${d.decision_type || '-'}</td>
            <td>${d.subject || '-'}</td>
            <td>${d.vote || '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper(
      'החלטות ועדות תכנון',
      'QUANTUM - החלטות ועדות תכנון בפרויקטי פינוי-בינוי. אישורים, דחיות, והתקדמות תכנונית.',
      content
    ));
    logger.info(`Perplexity: Served decisions.html with ${decisions.length} decisions`);
    
  } catch (error) {
    logger.error('Perplexity decisions.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 5. UPCOMING HEARINGS
// =====================================================
router.get('/hearings.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT uh.*, c.name as complex_name, c.city, c.addresses, c.iai_score
      FROM upcoming_hearings uh
      LEFT JOIN complexes c ON uh.complex_id = c.id
      WHERE uh.hearing_date >= CURRENT_DATE
      ORDER BY uh.hearing_date ASC
      LIMIT 100
    `);

    const hearings = result.rows;
    
    const content = `
      <h1>QUANTUM - דיונים עתידיים בוועדות</h1>
      <p>סה"כ דיונים קרובים: <strong>${hearings.length}</strong></p>
      
      <h2>דיונים קרובים</h2>
      <table>
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מתחם</th>
            <th>עיר</th>
            <th>ועדה</th>
            <th>נושא</th>
            <th>IAI</th>
          </tr>
        </thead>
        <tbody>
          ${hearings.map(h => `
          <tr class="${h.iai_score >= 30 ? 'highlight' : ''}">
            <td><strong>${h.hearing_date ? new Date(h.hearing_date).toLocaleDateString('he-IL') : '-'}</strong></td>
            <td>${h.complex_name || h.addresses || '-'}</td>
            <td>${h.city || '-'}</td>
            <td>${h.committee || '-'}</td>
            <td>${h.subject || '-'}</td>
            <td class="${h.iai_score >= 30 ? 'good' : ''}">${h.iai_score || '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper(
      'דיונים עתידיים בוועדות תכנון',
      'QUANTUM - דיונים קרובים בוועדות תכנון.',
      content
    ));
  } catch (error) {
    logger.error('Perplexity hearings.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 6. DEVELOPERS
// =====================================================
router.get('/developers.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*,
             COUNT(c.id) as active_projects,
             AVG(c.iai_score) as avg_iai
      FROM developers d
      LEFT JOIN complexes c ON c.developer = d.name
      GROUP BY d.id
      ORDER BY d.risk_score ASC NULLS LAST, active_projects DESC
    `);

    const developers = result.rows;
    
    const content = `
      <h1>QUANTUM - מאגר יזמים</h1>
      <p>סה"כ יזמים: <strong>${developers.length}</strong></p>

      <h2>רשימת יזמים</h2>
      <table>
        <thead>
          <tr>
            <th>שם יזם</th>
            <th>ציון סיכון</th>
            <th>פרויקטים פעילים</th>
          </tr>
        </thead>
        <tbody>
          ${developers.map(d => `
          <tr>
            <td>${d.name || '-'}</td>
            <td>${d.risk_score || '-'}</td>
            <td>${d.active_projects || 0}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper('מאגר יזמים', 'QUANTUM - מידע על יזמי נדל"ן בישראל.', content));
  } catch (error) {
    logger.error('Perplexity developers.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 7. KONES/RECEIVERSHIP
// =====================================================
router.get('/kones.html', async (req, res) => {
  try {
    let listings = [];
    try {
      const result = await pool.query(`SELECT * FROM kones_listings ORDER BY created_at DESC LIMIT 200`);
      listings = result.rows;
    } catch (e) {
      try {
        const result = await pool.query(`
          SELECT ds.*, c.name as complex_name, c.city, c.addresses
          FROM distressed_sellers ds
          LEFT JOIN complexes c ON ds.complex_id = c.id
          WHERE ds.distress_type = 'receivership'
          ORDER BY ds.created_at DESC LIMIT 200
        `);
        listings = result.rows;
      } catch (e2) {
        // Tables don't exist yet
      }
    }
    
    const content = `
      <h1>QUANTUM - נכסי כינוס נכסים</h1>
      <p>סה"כ נכסים בכינוס: <strong>${listings.length}</strong></p>

      <h2>נכסים זמינים</h2>
      <table>
        <thead>
          <tr>
            <th>כתובת</th>
            <th>עיר</th>
            <th>סוג נכס</th>
            <th>מחיר</th>
            <th>תאריך</th>
          </tr>
        </thead>
        <tbody>
          ${listings.map(l => `
          <tr>
            <td>${l.address || l.addresses || l.complex_name || '-'}</td>
            <td>${l.city || '-'}</td>
            <td>${l.property_type || l.distress_type || '-'}</td>
            <td>${l.price ? `₪${l.price.toLocaleString()}` : '-'}</td>
            <td>${l.created_at ? new Date(l.created_at).toLocaleDateString('he-IL') : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper('נכסי כינוס נכסים', 'QUANTUM - נכסי כינוס נכסים בישראל.', content));
  } catch (error) {
    logger.error('Perplexity kones.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 8. TRANSACTIONS
// =====================================================
router.get('/transactions.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, c.name as complex_name, c.city
      FROM transactions t
      LEFT JOIN complexes c ON t.complex_id = c.id
      ORDER BY t.transaction_date DESC NULLS LAST
      LIMIT 500
    `);

    const transactions = result.rows;
    const avgPrice = transactions.length > 0 
      ? Math.round(transactions.reduce((sum, t) => sum + (t.price_per_sqm || 0), 0) / Math.max(transactions.filter(t => t.price_per_sqm).length, 1))
      : 0;
    
    const content = `
      <h1>QUANTUM - עסקאות נדל"ן היסטוריות</h1>
      <p>סה"כ עסקאות: <strong>${transactions.length}</strong></p>
      <p>מחיר ממוצע למ"ר: <strong>₪${avgPrice.toLocaleString()}</strong></p>

      <h2>עסקאות אחרונות</h2>
      <table>
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מתחם</th>
            <th>עיר</th>
            <th>כתובת</th>
            <th>שטח</th>
            <th>מחיר</th>
            <th>מחיר/מ"ר</th>
          </tr>
        </thead>
        <tbody>
          ${transactions.map(t => `
          <tr>
            <td>${t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${t.complex_name || '-'}</td>
            <td>${t.city || '-'}</td>
            <td>${t.address || '-'}</td>
            <td>${t.size_sqm ? `${t.size_sqm} מ"ר` : '-'}</td>
            <td>${t.price ? `₪${t.price.toLocaleString()}` : '-'}</td>
            <td>${t.price_per_sqm ? `₪${t.price_per_sqm.toLocaleString()}` : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    res.type('html').send(htmlWrapper('עסקאות נדל"ן היסטוריות', 'QUANTUM - היסטוריית עסקאות נדל"ן בפינוי-בינוי.', content));
  } catch (error) {
    logger.error('Perplexity transactions.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 9. NEWS ALERTS
// =====================================================
router.get('/news.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT na.*, c.name as complex_name, c.city
      FROM news_alerts na
      LEFT JOIN complexes c ON na.complex_id = c.id
      ORDER BY na.created_at DESC LIMIT 100
    `);
    const news = result.rows;
    const content = `
      <h1>QUANTUM - חדשות והתראות שוק</h1>
      <p>סה"כ התראות: <strong>${news.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>מתחם</th><th>כותרת</th></tr></thead>
        <tbody>
          ${news.map(n => `<tr>
            <td>${n.created_at ? new Date(n.created_at).toLocaleDateString('he-IL') : '-'}</td>
            <td>${n.alert_type || '-'}</td>
            <td>${n.complex_name || '-'}</td>
            <td>${n.title || '-'}</td>
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
// 10. REGULATIONS
// =====================================================
router.get('/regulations.html', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM regulation_updates ORDER BY effective_date DESC NULLS LAST, created_at DESC LIMIT 50`);
    const regulations = result.rows;
    const content = `
      <h1>QUANTUM - עדכוני רגולציה</h1>
      <p>סה"כ עדכונים: <strong>${regulations.length}</strong></p>
      <table>
        <thead><tr><th>תאריך</th><th>סוג</th><th>כותרת</th><th>השפעה</th></tr></thead>
        <tbody>
          ${regulations.map(r => `<tr>
            <td>${r.effective_date ? new Date(r.effective_date).toLocaleDateString('he-IL') : '-'}</td>
            <td>${r.update_type || '-'}</td>
            <td>${r.title || '-'}</td>
            <td>${r.impact || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper('עדכוני רגולציה', 'QUANTUM - עדכוני רגולציה בהתחדשות עירונית.', content));
  } catch (error) {
    logger.error('Perplexity regulations.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 11. CITY-SPECIFIC DATA
// =====================================================
router.get('/city/:city.html', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const result = await pool.query(`
      SELECT id, name, city, addresses, developer,
             planned_units, actual_premium,
             iai_score, enhanced_ssi_score, status
      FROM complexes 
      WHERE city ILIKE $1
      ORDER BY iai_score DESC NULLS LAST
    `, [`%${city}%`]);

    const complexes = result.rows;
    const content = `
      <h1>פינוי-בינוי ב${city}</h1>
      <p>סה"כ מתחמים: <strong>${complexes.length}</strong></p>
      <p>IAI מעל 30: <strong>${complexes.filter(c => c.iai_score >= 30).length}</strong></p>
      <table>
        <thead><tr><th>מתחם</th><th>יזם</th><th>יח"ד</th><th>IAI</th><th>SSI</th><th>שלב</th></tr></thead>
        <tbody>
          ${complexes.map(c => `<tr class="${c.iai_score >= 30 ? 'highlight' : ''}">
            <td>${c.name || c.addresses || '-'}</td>
            <td>${c.developer || '-'}</td>
            <td>${c.planned_units || '-'}</td>
            <td class="${c.iai_score >= 30 ? 'good' : ''}">${c.iai_score || '-'}</td>
            <td class="${c.enhanced_ssi_score >= 40 ? 'danger' : ''}">${c.enhanced_ssi_score || '-'}</td>
            <td>${c.status || '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    res.type('html').send(htmlWrapper(`פינוי-בינוי ב${city}`, `פינוי-בינוי ב${city} - ${complexes.length} מתחמים.`, content));
  } catch (error) {
    logger.error('Perplexity city.html error:', error);
    res.status(500).send('Error generating page');
  }
});

// =====================================================
// 12. FULL EXPORT JSON
// =====================================================
router.get('/full-export.json', async (req, res) => {
  try {
    const [complexes, decisions, hearings, developers, transactions, news, regulations] = await Promise.all([
      pool.query('SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST'),
      pool.query('SELECT * FROM committee_decisions ORDER BY decision_date DESC LIMIT 500'),
      pool.query('SELECT * FROM upcoming_hearings WHERE hearing_date >= CURRENT_DATE ORDER BY hearing_date ASC'),
      pool.query('SELECT * FROM developers ORDER BY risk_score NULLS LAST'),
      pool.query('SELECT * FROM transactions ORDER BY transaction_date DESC LIMIT 1000'),
      pool.query('SELECT * FROM news_alerts ORDER BY created_at DESC LIMIT 200'),
      pool.query('SELECT * FROM regulation_updates ORDER BY effective_date DESC')
    ]);

    let konesListings = [];
    try { konesListings = (await pool.query('SELECT * FROM kones_listings')).rows; } catch (e) {}

    let distressedSellers = [];
    try { distressedSellers = (await pool.query('SELECT * FROM distressed_sellers ORDER BY created_at DESC')).rows; } catch (e) {}

    res.json({
      metadata: {
        source: 'QUANTUM',
        exported_at: new Date().toISOString(),
        version: '4.8.7',
        stats: {
          total_complexes: complexes.rows.length,
          high_iai: complexes.rows.filter(c => c.iai_score >= 30).length,
          high_ssi: complexes.rows.filter(c => c.enhanced_ssi_score >= 40).length,
          cities: [...new Set(complexes.rows.map(c => c.city).filter(Boolean))].length,
          transactions: transactions.rows.length
        }
      },
      data: {
        complexes: complexes.rows,
        committee_decisions: decisions.rows,
        upcoming_hearings: hearings.rows,
        developers: developers.rows,
        transactions: transactions.rows,
        kones_listings: konesListings,
        distressed_sellers: distressedSellers,
        news_alerts: news.rows,
        regulation_updates: regulations.rows
      }
    });
  } catch (error) {
    logger.error('Perplexity full-export.json error:', error);
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// =====================================================
// 13. SIMPLE JSON EXPORT
// =====================================================
router.get('/export.json', async (req, res) => {
  try {
    const complexes = await pool.query('SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST');
    const stats = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE iai_score >= 30) as high_iai,
        COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as high_ssi,
        COUNT(DISTINCT city) as cities
      FROM complexes
    `);
    res.json({
      metadata: { source: 'QUANTUM', exported_at: new Date().toISOString(), stats: stats.rows[0] },
      complexes: complexes.rows
    });
  } catch (error) {
    logger.error('Perplexity export.json error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// =====================================================
// 14. SITEMAP
// =====================================================
router.get('/sitemap.xml', async (req, res) => {
  try {
    const cities = await pool.query('SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL');
    const baseUrl = 'https://pinuy-binuy-analyzer-production.up.railway.app/perplexity';
    const pages = [
      { path: '/complexes.html', priority: '1.0', freq: 'daily' },
      { path: '/opportunities.html', priority: '0.9', freq: 'daily' },
      { path: '/stressed-sellers.html', priority: '0.9', freq: 'daily' },
      { path: '/decisions.html', priority: '0.8', freq: 'daily' },
      { path: '/hearings.html', priority: '0.9', freq: 'daily' },
      { path: '/developers.html', priority: '0.7', freq: 'weekly' },
      { path: '/kones.html', priority: '0.9', freq: 'daily' },
      { path: '/transactions.html', priority: '0.7', freq: 'weekly' },
      { path: '/news.html', priority: '0.8', freq: 'daily' },
      { path: '/regulations.html', priority: '0.6', freq: 'weekly' }
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
// 15. INDEX PAGE
// =====================================================
router.get('/', (req, res) => {
  const content = `
    <h1>QUANTUM - Perplexity Integration</h1>
    <h2>דפים זמינים</h2>
    <ul>
      <li><a href="/perplexity/complexes.html">כל המתחמים</a></li>
      <li><a href="/perplexity/opportunities.html">הזדמנויות השקעה</a></li>
      <li><a href="/perplexity/stressed-sellers.html">מוכרים במצוקה</a></li>
      <li><a href="/perplexity/decisions.html">החלטות ועדות</a></li>
      <li><a href="/perplexity/hearings.html">דיונים קרובים</a></li>
      <li><a href="/perplexity/developers.html">יזמים</a></li>
      <li><a href="/perplexity/kones.html">כינוס נכסים</a></li>
      <li><a href="/perplexity/transactions.html">עסקאות</a></li>
      <li><a href="/perplexity/news.html">חדשות</a></li>
      <li><a href="/perplexity/regulations.html">רגולציה</a></li>
    </ul>
    <h2>ייצוא נתונים</h2>
    <ul>
      <li><a href="/perplexity/export.json">export.json</a></li>
      <li><a href="/perplexity/full-export.json">full-export.json</a></li>
      <li><a href="/perplexity/sitemap.xml">sitemap.xml</a></li>
    </ul>`;
  res.type('html').send(htmlWrapper('Perplexity Integration', 'QUANTUM - Perplexity Integration Index', content));
});

module.exports = router;
