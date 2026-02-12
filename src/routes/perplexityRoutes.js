/**
 * Perplexity Integration Routes
 * Public endpoints for Perplexity AI to crawl and index QUANTUM data
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

/**
 * GET /perplexity/complexes.html
 * HTML page with all complexes for Perplexity to crawl
 */
router.get('/complexes.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, street, status, developer, 
             housing_units, year_built, current_price_per_sqm,
             iai_score, ssi_score, stage,
             local_committee_status, district_committee_status,
             is_officially_declared, official_track
      FROM complexes 
      ORDER BY iai_score DESC NULLS LAST
    `);

    const complexes = result.rows;
    
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="QUANTUM - מאגר מתחמי פינוי-בינוי בישראל. ${complexes.length} מתחמים עם נתוני השקעה, מדדי IAI ו-SSI.">
  <meta name="keywords" content="פינוי בינוי, התחדשות עירונית, השקעות נדלן, ישראל, QUANTUM">
  <title>QUANTUM - מאגר מתחמי פינוי-בינוי | ${complexes.length} מתחמים</title>
</head>
<body>
  <h1>QUANTUM - מאגר מתחמי פינוי-בינוי בישראל</h1>
  <p>מעודכן ל: ${new Date().toLocaleDateString('he-IL')}</p>
  <p>סה"כ מתחמים במאגר: ${complexes.length}</p>
  
  <h2>מדדים מרכזיים</h2>
  <ul>
    <li><strong>IAI (מדד אטרקטיביות השקעה)</strong> - ציון 0-100, מעל 30 = כדאי להשקעה</li>
    <li><strong>SSI (מדד לחץ מוכר)</strong> - ציון 0-100, גבוה יותר = מוכר במצוקה = הזדמנות</li>
  </ul>

  <h2>רשימת מתחמים</h2>
  <table border="1" cellpadding="8">
    <thead>
      <tr>
        <th>שם/כתובת</th>
        <th>עיר</th>
        <th>יזם</th>
        <th>יח"ד</th>
        <th>IAI</th>
        <th>SSI</th>
        <th>שלב</th>
        <th>סטטוס</th>
      </tr>
    </thead>
    <tbody>
      ${complexes.map(c => `
      <tr>
        <td>${c.name || c.street || '-'}</td>
        <td>${c.city || '-'}</td>
        <td>${c.developer || '-'}</td>
        <td>${c.housing_units || '-'}</td>
        <td>${c.iai_score || '-'}</td>
        <td>${c.ssi_score || '-'}</td>
        <td>${c.stage || '-'}</td>
        <td>${c.status || '-'}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <h2>מקרא שלבים</h2>
  <ul>
    <li><strong>תכנון מוקדם</strong> - לפני הגשה לוועדות</li>
    <li><strong>ועדה מקומית</strong> - בהליך אישור מקומי</li>
    <li><strong>ועדה מחוזית</strong> - בהליך אישור מחוזי</li>
    <li><strong>מאושר</strong> - התוכנית אושרה</li>
    <li><strong>בביצוע</strong> - בבנייה פעילה</li>
  </ul>

  <footer>
    <p>QUANTUM - משרד תיווך NEXT-GEN להתחדשות עירונית</p>
    <p>מח חד. הבנה עמוקה. גישה לסודות השוק.</p>
  </footer>
</body>
</html>
    `;

    res.type('html').send(html);
    logger.info(`Perplexity: Served complexes.html with ${complexes.length} complexes`);
    
  } catch (error) {
    logger.error('Perplexity complexes.html error:', error);
    res.status(500).send('Error generating page');
  }
});

/**
 * GET /perplexity/opportunities.html
 * Top investment opportunities for Perplexity
 */
router.get('/opportunities.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, street, developer,
             housing_units, current_price_per_sqm,
             iai_score, ssi_score, stage, status,
             local_committee_status, local_committee_date,
             district_committee_status
      FROM complexes 
      WHERE iai_score >= 30
      ORDER BY iai_score DESC
      LIMIT 100
    `);

    const opportunities = result.rows;
    
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="QUANTUM - הזדמנויות השקעה מובילות בפינוי-בינוי. ${opportunities.length} מתחמים עם IAI מעל 30.">
  <title>QUANTUM - הזדמנויות השקעה בפינוי-בינוי | Top ${opportunities.length}</title>
</head>
<body>
  <h1>QUANTUM - הזדמנויות השקעה מובילות</h1>
  <p>מעודכן ל: ${new Date().toLocaleDateString('he-IL')}</p>
  <p>מתחמים עם IAI (מדד אטרקטיביות השקעה) מעל 30</p>
  <p>סה"כ הזדמנויות: ${opportunities.length}</p>

  <h2>למה IAI מעל 30?</h2>
  <p>מתחמים עם IAI מעל 30 מציגים פער משמעותי בין הפרמיה התיאורטית לפרמיה בפועל, 
     שלב תכנוני מתקדם, ויזם אמין - מה שמעיד על פוטנציאל תשואה גבוה.</p>

  <h2>טבלת הזדמנויות</h2>
  <table border="1" cellpadding="8">
    <thead>
      <tr>
        <th>#</th>
        <th>מתחם</th>
        <th>עיר</th>
        <th>יזם</th>
        <th>IAI</th>
        <th>SSI</th>
        <th>שלב</th>
        <th>ועדה מקומית</th>
      </tr>
    </thead>
    <tbody>
      ${opportunities.map((o, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${o.name || o.street || '-'}</td>
        <td>${o.city || '-'}</td>
        <td>${o.developer || '-'}</td>
        <td><strong>${o.iai_score}</strong></td>
        <td>${o.ssi_score || '-'}</td>
        <td>${o.stage || '-'}</td>
        <td>${o.local_committee_status || '-'}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <footer>
    <p>QUANTUM - משרד תיווך NEXT-GEN | "אנחנו יודעים על נכסים שאחרים אפילו לא יודעים שקיימים"</p>
  </footer>
</body>
</html>
    `;

    res.type('html').send(html);
    logger.info(`Perplexity: Served opportunities.html with ${opportunities.length} items`);
    
  } catch (error) {
    logger.error('Perplexity opportunities.html error:', error);
    res.status(500).send('Error generating page');
  }
});

/**
 * GET /perplexity/stressed-sellers.html
 * Distressed sellers / high SSI for Perplexity
 */
router.get('/stressed-sellers.html', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, street, developer,
             housing_units, current_price_per_sqm,
             iai_score, ssi_score, stage, status,
             is_receivership, has_enforcement_cases,
             has_bankruptcy_proceedings, is_inheritance_property
      FROM complexes 
      WHERE ssi_score >= 40
      ORDER BY ssi_score DESC
      LIMIT 100
    `);

    const sellers = result.rows;
    
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="QUANTUM - מוכרים במצוקה בפינוי-בינוי. מתחמים עם SSI גבוה - הזדמנות למחיר נמוך.">
  <title>QUANTUM - מוכרים במצוקה | SSI גבוה</title>
</head>
<body>
  <h1>QUANTUM - מוכרים במצוקה (SSI גבוה)</h1>
  <p>מעודכן ל: ${new Date().toLocaleDateString('he-IL')}</p>
  <p>מתחמים עם SSI (מדד לחץ מוכר) מעל 40</p>
  <p>סה"כ: ${sellers.length}</p>

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
  <table border="1" cellpadding="8">
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
        <td>${s.name || s.street || '-'}</td>
        <td>${s.city || '-'}</td>
        <td><strong>${s.ssi_score}</strong></td>
        <td>${s.is_receivership ? '✓' : '-'}</td>
        <td>${s.has_enforcement_cases ? '✓' : '-'}</td>
        <td>${s.has_bankruptcy_proceedings ? '✓' : '-'}</td>
        <td>${s.is_inheritance_property ? '✓' : '-'}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <footer>
    <p>QUANTUM - "מח חד. הבנה עמוקה. גישה לסודות השוק."</p>
  </footer>
</body>
</html>
    `;

    res.type('html').send(html);
    logger.info(`Perplexity: Served stressed-sellers.html with ${sellers.length} items`);
    
  } catch (error) {
    logger.error('Perplexity stressed-sellers.html error:', error);
    res.status(500).send('Error generating page');
  }
});

/**
 * GET /perplexity/city/:city.html
 * City-specific data for Perplexity
 */
router.get('/city/:city.html', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    
    const result = await pool.query(`
      SELECT id, name, city, street, developer,
             housing_units, current_price_per_sqm,
             iai_score, ssi_score, stage, status,
             local_committee_status, district_committee_status
      FROM complexes 
      WHERE city ILIKE $1
      ORDER BY iai_score DESC NULLS LAST
    `, [`%${city}%`]);

    const complexes = result.rows;
    
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="פינוי-בינוי ב${city} - ${complexes.length} מתחמים. נתוני השקעה, יזמים, שלבי תכנון.">
  <title>QUANTUM - פינוי-בינוי ב${city} | ${complexes.length} מתחמים</title>
</head>
<body>
  <h1>פינוי-בינוי ב${city}</h1>
  <p>מעודכן ל: ${new Date().toLocaleDateString('he-IL')}</p>
  <p>סה"כ מתחמים: ${complexes.length}</p>

  <h2>סיכום עירוני</h2>
  <ul>
    <li>מתחמים עם IAI מעל 30: ${complexes.filter(c => c.iai_score >= 30).length}</li>
    <li>מתחמים עם SSI מעל 40: ${complexes.filter(c => c.ssi_score >= 40).length}</li>
    <li>בשלב ועדה מקומית: ${complexes.filter(c => c.local_committee_status).length}</li>
  </ul>

  <h2>רשימת מתחמים ב${city}</h2>
  <table border="1" cellpadding="8">
    <thead>
      <tr>
        <th>כתובת</th>
        <th>יזם</th>
        <th>יח"ד</th>
        <th>IAI</th>
        <th>SSI</th>
        <th>שלב</th>
      </tr>
    </thead>
    <tbody>
      ${complexes.map(c => `
      <tr>
        <td>${c.name || c.street || '-'}</td>
        <td>${c.developer || '-'}</td>
        <td>${c.housing_units || '-'}</td>
        <td>${c.iai_score || '-'}</td>
        <td>${c.ssi_score || '-'}</td>
        <td>${c.stage || '-'}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <footer>
    <p>QUANTUM - משרד תיווך NEXT-GEN להתחדשות עירונית</p>
  </footer>
</body>
</html>
    `;

    res.type('html').send(html);
    logger.info(`Perplexity: Served city/${city}.html with ${complexes.length} complexes`);
    
  } catch (error) {
    logger.error('Perplexity city.html error:', error);
    res.status(500).send('Error generating page');
  }
});

/**
 * GET /perplexity/export.json
 * Full JSON export for Perplexity Space upload
 */
router.get('/export.json', async (req, res) => {
  try {
    const complexes = await pool.query(`
      SELECT * FROM complexes ORDER BY iai_score DESC NULLS LAST
    `);
    
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE iai_score >= 30) as high_iai,
        COUNT(*) FILTER (WHERE ssi_score >= 40) as high_ssi,
        COUNT(DISTINCT city) as cities
      FROM complexes
    `);

    const exportData = {
      metadata: {
        source: 'QUANTUM - משרד תיווך NEXT-GEN',
        description: 'מאגר מתחמי פינוי-בינוי בישראל',
        exported_at: new Date().toISOString(),
        stats: stats.rows[0]
      },
      metrics_explanation: {
        IAI: 'מדד אטרקטיביות השקעה (0-100). מעל 30 = מומלץ להשקעה',
        SSI: 'מדד לחץ מוכר (0-100). גבוה יותר = מוכר במצוקה = הזדמנות למחיר טוב'
      },
      complexes: complexes.rows
    };

    res.json(exportData);
    logger.info(`Perplexity: Exported ${complexes.rows.length} complexes as JSON`);
    
  } catch (error) {
    logger.error('Perplexity export.json error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

/**
 * GET /perplexity/sitemap.xml
 * Sitemap for Perplexity crawler
 */
router.get('/sitemap.xml', async (req, res) => {
  try {
    const cities = await pool.query(`
      SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL
    `);
    
    const baseUrl = 'https://pinuy-binuy-analyzer-production.up.railway.app/perplexity';
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/complexes.html</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/opportunities.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/stressed-sellers.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  ${cities.rows.map(c => `
  <url>
    <loc>${baseUrl}/city/${encodeURIComponent(c.city)}.html</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  `).join('')}
</urlset>`;

    res.type('application/xml').send(xml);
    
  } catch (error) {
    logger.error('Perplexity sitemap error:', error);
    res.status(500).send('Error generating sitemap');
  }
});

module.exports = router;
