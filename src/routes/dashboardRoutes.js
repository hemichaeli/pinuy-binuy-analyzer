const express = require('express');
const router = express.Router();
const db = require('../db/database');
const fs = require('fs').promises;
const path = require('path');

// Helper: Get committees summary
async function getCommitteesSummary() {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
            FROM committees
        `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0] || { total: 0, approved: 0, pending: 0, rejected: 0 });
        });
    });
}

// Helper: Get enrichment stats
async function getEnrichmentStats() {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN enrichment_data IS NOT NULL THEN 1 ELSE 0 END) as enriched,
                SUM(CASE WHEN last_enrichment > datetime('now', '-7 days') THEN 1 ELSE 0 END) as recent
            FROM complexes
        `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0] || { total: 0, enriched: 0, recent: 0 });
        });
    });
}

// Helper: Get yad2 stats
async function getYad2Stats() {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                COUNT(*) as total_listings,
                COUNT(DISTINCT complex_id) as complexes_with_listings,
                SUM(CASE WHEN last_updated > datetime('now', '-7 days') THEN 1 ELSE 0 END) as recent_updates
            FROM yad2_listings
        `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0] || { total_listings: 0, complexes_with_listings: 0, recent_updates: 0 });
        });
    });
}

// Helper: Get kones stats
async function getKonesStats() {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                COUNT(*) as total_listings,
                COUNT(DISTINCT complex_name) as unique_complexes,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_listings
            FROM kones_listings
        `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0] || { total_listings: 0, unique_complexes: 0, active_listings: 0 });
        });
    });
}

// Dashboard main page
router.get('/', async (req, res) => {
    try {
        const committees = await getCommitteesSummary();
        const enrichment = await getEnrichmentStats();
        const yad2 = await getYad2Stats();
        const kones = await getKonesStats();

        res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QUANTUM Dashboard v4.43.0</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; direction: rtl; }
        .header { background: rgba(255, 255, 255, 0.95); padding: 1.5rem 2rem; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header h1 { color: #667eea; font-size: 2rem; font-weight: 700; }
        .header .version { color: #764ba2; font-size: 0.9rem; margin-top: 0.25rem; }
        .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
        .tabs { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
        .tab { background: rgba(255, 255, 255, 0.9); border: none; padding: 1rem 2rem; border-radius: 10px; cursor: pointer; font-size: 1rem; font-weight: 600; color: #555; transition: all 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .tab:hover { background: rgba(255, 255, 255, 1); transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,0.15); }
        .tab.active { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .stat-card { background: rgba(255, 255, 255, 0.95); padding: 1.5rem; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); transition: transform 0.3s; }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-card h3 { color: #667eea; font-size: 0.9rem; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 1px; }
        .stat-card .value { font-size: 2.5rem; font-weight: 700; color: #333; margin-bottom: 0.5rem; }
        .stat-card .label { color: #888; font-size: 0.85rem; }
        .action-section { background: rgba(255, 255, 255, 0.95); padding: 2rem; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); margin-bottom: 2rem; }
        .action-section h2 { color: #667eea; margin-bottom: 1.5rem; font-size: 1.5rem; }
        .action-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
        .action-btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 1rem 1.5rem; border-radius: 10px; cursor: pointer; font-size: 1rem; font-weight: 600; transition: all 0.3s; box-shadow: 0 4px 10px rgba(102, 126, 234, 0.3); }
        .action-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4); }
        .data-table { width: 100%; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .data-table th { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1rem; text-align: right; font-weight: 600; }
        .data-table td { padding: 1rem; border-bottom: 1px solid #eee; text-align: right; }
        .data-table tr:hover { background: #f8f9ff; }
        .status-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
        .status-approved { background: #d4edda; color: #155724; }
        .status-pending { background: #fff3cd; color: #856404; }
        .status-rejected { background: #f8d7da; color: #721c24; }
        .status-active { background: #d1ecf1; color: #0c5460; }
        .loading { text-align: center; padding: 3rem; color: white; font-size: 1.2rem; }
        .form-group { margin-bottom: 1.5rem; }
        .form-group label { display: block; margin-bottom: 0.5rem; color: #333; font-weight: 600; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 0.75rem; border: 2px solid #ddd; border-radius: 8px; font-size: 1rem; transition: border-color 0.3s; }
        .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #667eea; }
        .search-box { position: relative; margin-bottom: 1.5rem; }
        .search-box input { width: 100%; padding: 1rem 1rem 1rem 3rem; border: 2px solid #ddd; border-radius: 10px; font-size: 1rem; }
        .search-box::before { content: '🔍'; position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); font-size: 1.2rem; }
        .grid-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
        @media (max-width: 768px) { .grid-2col { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: 1fr; } }
        .ws-city-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
        .ws-chip { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 0.5rem 1rem; border-radius: 20px; display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
        .ws-chip-remove { background: rgba(255, 255, 255, 0.3); border: none; color: white; cursor: pointer; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; transition: background 0.2s; }
        .ws-chip-remove:hover { background: rgba(255, 255, 255, 0.5); }
        .ws-subscription-card { background: white; border-radius: 10px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 2px 10px rgba(0,0,0,0.1); border-right: 4px solid #667eea; transition: transform 0.2s; }
        .ws-subscription-card:hover { transform: translateX(-5px); }
        .ws-subscription-card.inactive { border-right-color: #ccc; opacity: 0.7; }
        .ws-subscription-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
        .ws-subscription-controls { display: flex; gap: 1rem; align-items: center; }
        .ws-toggle { position: relative; width: 50px; height: 26px; background: #ccc; border-radius: 13px; cursor: pointer; transition: background 0.3s; }
        .ws-toggle.active { background: #667eea; }
        .ws-toggle-handle { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; background: white; border-radius: 50%; transition: transform 0.3s; }
        .ws-toggle.active .ws-toggle-handle { transform: translateX(-24px); }
        .ws-delete-btn { background: #dc3545; color: white; border: none; padding: 0.5rem 1rem; border-radius: 5px; cursor: pointer; font-size: 0.9rem; transition: background 0.2s; }
        .ws-delete-btn:hover { background: #c82333; }
        .ws-criteria-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
        .ws-criteria-tag { background: #e9ecef; padding: 0.25rem 0.75rem; border-radius: 15px; font-size: 0.85rem; color: #495057; }
        .ws-stats { display: flex; gap: 2rem; font-size: 0.9rem; color: #666; }
        .range-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🏢 QUANTUM Dashboard</h1>
        <div class="version">v4.43.0 - מערכת ניהול פרויקטים</div>
    </div>

    <div class="container">
        <div class="tabs">
            <button class="tab active" onclick="switchTab('overview')">סקירה כללית</button>
            <button class="tab" onclick="switchTab('committees')">ועדות</button>
            <button class="tab" onclick="switchTab('enrichment')">העשרת מידע</button>
            <button class="tab" onclick="switchTab('yad2')">יד2</button>
            <button class="tab" onclick="switchTab('kones')">כינוסים</button>
            <button class="tab" onclick="switchTab('whatsapp')">מנויי WhatsApp</button>
            <button class="tab" onclick="switchTab('morning')">☀ בוקר</button>
        </div>

        <div id="overview" class="tab-content active">
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>סה"כ מתחמים</h3>
                    <div class="value">${enrichment.total}</div>
                    <div class="label">פרויקטי פינוי-בינוי</div>
                </div>
                <div class="stat-card">
                    <h3>מתחמים מועשרים</h3>
                    <div class="value">${enrichment.enriched}</div>
                    <div class="label">${Math.round((enrichment.enriched / Math.max(enrichment.total,1)) * 100)}% מסך המתחמים</div>
                </div>
                <div class="stat-card">
                    <h3>ועדות מאושרות</h3>
                    <div class="value">${committees.approved}</div>
                    <div class="label">מתוך ${committees.total} סה"כ</div>
                </div>
                <div class="stat-card">
                    <h3>רישומים ביד2</h3>
                    <div class="value">${yad2.total_listings}</div>
                    <div class="label">${yad2.complexes_with_listings} מתחמים</div>
                </div>
            </div>
            <div class="action-section">
                <h2>פעולות מהירות</h2>
                <div class="action-grid">
                    <button class="action-btn" onclick="runEnrichment()">🔄 הרץ העשרה</button>
                    <button class="action-btn" onclick="updateYad2()">📊 עדכן יד2</button>
                    <button class="action-btn" onclick="scanKones()">⚖️ סרוק כינוסים</button>
                    <button class="action-btn" onclick="exportData()">💾 ייצא נתונים</button>
                </div>
            </div>
        </div>

        <div id="committees" class="tab-content">
            <div class="stats-grid">
                <div class="stat-card"><h3>מאושר</h3><div class="value">${committees.approved}</div><div class="label">ועדות מאושרות</div></div>
                <div class="stat-card"><h3>ממתין</h3><div class="value">${committees.pending}</div><div class="label">ועדות ממתינות</div></div>
                <div class="stat-card"><h3>נדחה</h3><div class="value">${committees.rejected}</div><div class="label">ועדות נדחות</div></div>
                <div class="stat-card"><h3>סה"כ</h3><div class="value">${committees.total}</div><div class="label">כל הועדות</div></div>
            </div>
            <div class="action-section">
                <div class="search-box"><input type="text" id="committeeSearch" placeholder="חיפוש ועדות..." onkeyup="loadCommittees()"></div>
                <div id="committeesTable"></div>
            </div>
        </div>

        <div id="enrichment" class="tab-content">
            <div class="stats-grid">
                <div class="stat-card"><h3>מועשרים</h3><div class="value">${enrichment.enriched}</div><div class="label">מתחמים עם מידע מועשר</div></div>
                <div class="stat-card"><h3>עדכניים</h3><div class="value">${enrichment.recent}</div><div class="label">עודכנו ב-7 ימים האחרונים</div></div>
                <div class="stat-card"><h3>ממתינים</h3><div class="value">${enrichment.total - enrichment.enriched}</div><div class="label">מתחמים שטרם הועשרו</div></div>
                <div class="stat-card"><h3>שיעור השלמה</h3><div class="value">${Math.round((enrichment.enriched / Math.max(enrichment.total,1)) * 100)}%</div><div class="label">מסך המתחמים</div></div>
            </div>
            <div class="action-section">
                <h2>העשרת מידע</h2>
                <div class="form-group">
                    <label>בחר מתחם להעשרה:</label>
                    <select id="complexSelect" onchange="loadComplexData()"><option value="">-- בחר מתחם --</option></select>
                </div>
                <div id="enrichmentData"></div>
            </div>
        </div>

        <div id="yad2" class="tab-content">
            <div class="stats-grid">
                <div class="stat-card"><h3>סה"כ רישומים</h3><div class="value">${yad2.total_listings}</div><div class="label">רישומים פעילים ביד2</div></div>
                <div class="stat-card"><h3>מתחמים</h3><div class="value">${yad2.complexes_with_listings}</div><div class="label">מתחמים עם רישומים</div></div>
                <div class="stat-card"><h3>עדכונים</h3><div class="value">${yad2.recent_updates}</div><div class="label">עודכנו השבוע</div></div>
                <div class="stat-card"><h3>ממוצע</h3><div class="value">${yad2.complexes_with_listings > 0 ? Math.round(yad2.total_listings / yad2.complexes_with_listings) : 0}</div><div class="label">רישומים למתחם</div></div>
            </div>
            <div class="action-section">
                <div class="search-box"><input type="text" id="yad2Search" placeholder="חיפוש רישומים..." onkeyup="searchYad2()"></div>
                <div id="yad2Table"></div>
            </div>
        </div>

        <div id="kones" class="tab-content">
            <div class="stats-grid">
                <div class="stat-card"><h3>סה"כ רישומים</h3><div class="value">${kones.total_listings}</div><div class="label">רישומי כינוס</div></div>
                <div class="stat-card"><h3>מתחמים</h3><div class="value">${kones.unique_complexes}</div><div class="label">מתחמים ייחודיים</div></div>
                <div class="stat-card"><h3>פעילים</h3><div class="value">${kones.active_listings}</div><div class="label">רישומים פעילים</div></div>
                <div class="stat-card"><h3>ממוצע</h3><div class="value">${kones.unique_complexes > 0 ? Math.round(kones.total_listings / kones.unique_complexes) : 0}</div><div class="label">רישומים למתחם</div></div>
            </div>
            <div class="action-section">
                <div class="search-box"><input type="text" id="konesSearch" placeholder="חיפוש כינוסים..." onkeyup="searchKones()"></div>
                <div id="konesTable"></div>
            </div>
        </div>

        <div id="whatsapp" class="tab-content">
            <div class="stats-grid" id="wsStatsGrid">
                <div class="stat-card"><h3>מנויים פעילים</h3><div class="value" id="wsActiveCount">-</div><div class="label">מנויים במעקב</div></div>
                <div class="stat-card"><h3>לידים ייחודיים</h3><div class="value" id="wsUniqueLeads">-</div><div class="label">לקוחות רשומים</div></div>
                <div class="stat-card"><h3>התראות 24 שעות</h3><div class="value" id="wsAlerts24h">-</div><div class="label">נשלחו היום</div></div>
                <div class="stat-card"><h3>התראות שבוע</h3><div class="value" id="wsAlerts7d">-</div><div class="label">נשלחו השבוע</div></div>
            </div>
            <div class="grid-2col">
                <div class="action-section">
                    <h2>יצירת מנוי חדש</h2>
                    <div class="form-group"><label>מזהה ליד (Lead ID):</label><input type="text" id="wsLeadId" placeholder="למשל: lead_12345"></div>
                    <div class="form-group">
                        <label>ערים (הקש Enter להוספה):</label>
                        <input type="text" id="wsCityInput" placeholder="הקלד שם עיר והקש Enter" onkeypress="handleWSCityInput(event)">
                        <div class="ws-city-chips" id="wsCityChips"></div>
                    </div>
                    <div class="form-group"><label>חדרים:</label><div class="range-inputs"><input type="number" id="wsRoomsMin" placeholder="מינימום" step="0.5"><input type="number" id="wsRoomsMax" placeholder="מקסימום" step="0.5"></div></div>
                    <div class="form-group"><label>גודל (מ"ר):</label><div class="range-inputs"><input type="number" id="wsSizeMin" placeholder="מינימום"><input type="number" id="wsSizeMax" placeholder="מקסימום"></div></div>
                    <div class="form-group"><label>מחיר (₪):</label><div class="range-inputs"><input type="number" id="wsPriceMin" placeholder="מינימום"><input type="number" id="wsPriceMax" placeholder="מקסימום"></div></div>
                    <div class="action-grid">
                        <button class="action-btn" onclick="testWSCriteria()">🔍 בדוק קריטריונים</button>
                        <button class="action-btn" onclick="createWSSubscription()">➕ צור מנוי</button>
                    </div>
                </div>
                <div class="action-section">
                    <h2>מנויים קיימים</h2>
                    <div class="search-box"><input type="text" id="wsLeadSearch" placeholder="חיפוש לפי Lead ID..." onkeyup="loadWSSubscriptions()"></div>
                    <div id="wsSubscriptionsList"></div>
                </div>
            </div>
        </div>

        <div id="morning" class="tab-content">
            <div id="morning-loading" style="padding:40px;text-align:center;color:white;font-size:1.3rem">
                ⏳ טוען דיווח בוקר...
            </div>
            <div id="morning-content" style="display:none"></div>
        </div>

    </div>

    <script>
        let selectedWSCities = [];

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');
            if (tabName === 'committees') loadCommittees();
            if (tabName === 'enrichment') loadComplexes();
            if (tabName === 'yad2') loadYad2();
            if (tabName === 'kones') loadKones();
            if (tabName === 'whatsapp') { loadWSStats(); loadWSSubscriptions(); }
            if (tabName === 'morning') loadMorning();
        }

        function handleWSCityInput(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const input = document.getElementById('wsCityInput');
                const city = input.value.trim();
                if (city && !selectedWSCities.includes(city)) { selectedWSCities.push(city); renderWSCityChips(); input.value = ''; }
            }
        }

        function removeWSCity(city) { selectedWSCities = selectedWSCities.filter(c => c !== city); renderWSCityChips(); }

        function renderWSCityChips() {
            document.getElementById('wsCityChips').innerHTML = selectedWSCities.map(city =>
                \`<div class="ws-chip">\${city}<button class="ws-chip-remove" onclick="removeWSCity('\${city}')">×</button></div>\`
            ).join('');
        }

        function buildWSCriteria() {
            const criteria = {};
            if (selectedWSCities.length > 0) criteria.cities = selectedWSCities;
            const roomsMin = parseFloat(document.getElementById('wsRoomsMin').value);
            const roomsMax = parseFloat(document.getElementById('wsRoomsMax').value);
            if (!isNaN(roomsMin) || !isNaN(roomsMax)) { criteria.rooms = {}; if (!isNaN(roomsMin)) criteria.rooms.min = roomsMin; if (!isNaN(roomsMax)) criteria.rooms.max = roomsMax; }
            const sizeMin = parseInt(document.getElementById('wsSizeMin').value);
            const sizeMax = parseInt(document.getElementById('wsSizeMax').value);
            if (!isNaN(sizeMin) || !isNaN(sizeMax)) { criteria.size = {}; if (!isNaN(sizeMin)) criteria.size.min = sizeMin; if (!isNaN(sizeMax)) criteria.size.max = sizeMax; }
            const priceMin = parseInt(document.getElementById('wsPriceMin').value);
            const priceMax = parseInt(document.getElementById('wsPriceMax').value);
            if (!isNaN(priceMin) || !isNaN(priceMax)) { criteria.price = {}; if (!isNaN(priceMin)) criteria.price.min = priceMin; if (!isNaN(priceMax)) criteria.price.max = priceMax; }
            return criteria;
        }

        async function loadWSStats() {
            try {
                const res = await fetch('/api/whatsapp/subscriptions/stats');
                const data = await res.json();
                document.getElementById('wsActiveCount').textContent = data.activeSubscriptions || 0;
                document.getElementById('wsUniqueLeads').textContent = data.uniqueLeads || 0;
                document.getElementById('wsAlerts24h').textContent = data.alerts24h || 0;
                document.getElementById('wsAlerts7d').textContent = data.alerts7d || 0;
            } catch (err) { console.error('WS stats error:', err); }
        }

        async function loadWSSubscriptions() {
            const leadId = document.getElementById('wsLeadSearch').value.trim();
            if (!leadId) { document.getElementById('wsSubscriptionsList').innerHTML = '<p style="color:#666;padding:1rem">הזן Lead ID לחיפוש</p>'; return; }
            try {
                const res = await fetch(\`/api/whatsapp/subscriptions/\${leadId}\`);
                const subs = await res.json();
                document.getElementById('wsSubscriptionsList').innerHTML = subs.length === 0 ? '<p style="color:#666;padding:1rem">לא נמצאו מנויים</p>' : subs.map(renderWSSubscription).join('');
            } catch (err) { document.getElementById('wsSubscriptionsList').innerHTML = '<p style="color:red;padding:1rem">שגיאה בטעינת מנויים</p>'; }
        }

        function renderWSSubscription(sub) {
            const criteria = sub.criteria || {};
            const tags = [];
            if (criteria.cities && criteria.cities.length > 0) tags.push(\`ערים: \${criteria.cities.join(', ')}\`);
            if (criteria.rooms) { const t = []; if (criteria.rooms.min) t.push(\`מ-\${criteria.rooms.min}\`); if (criteria.rooms.max) t.push(\`עד \${criteria.rooms.max}\`); tags.push(\`חדרים: \${t.join(' ')}\`); }
            if (criteria.size) { const t = []; if (criteria.size.min) t.push(\`מ-\${criteria.size.min}\`); if (criteria.size.max) t.push(\`עד \${criteria.size.max}\`); tags.push(\`גודל: \${t.join(' ')} מ"ר\`); }
            if (criteria.price) { const t = []; if (criteria.price.min) t.push(\`מ-₪\${criteria.price.min.toLocaleString()}\`); if (criteria.price.max) t.push(\`עד ₪\${criteria.price.max.toLocaleString()}\`); tags.push(\`מחיר: \${t.join(' ')}\`); }
            return \`<div class="ws-subscription-card \${sub.active ? '' : 'inactive'}">
                <div class="ws-subscription-header"><strong>Lead ID: \${sub.lead_id}</strong>
                <div class="ws-subscription-controls">
                    <div class="ws-toggle \${sub.active ? 'active' : ''}" onclick="toggleWSSubscription('\${sub.id}', \${!sub.active})"><div class="ws-toggle-handle"></div></div>
                    <button class="ws-delete-btn" onclick="deleteWSSubscription('\${sub.id}')">מחק</button>
                </div></div>
                <div class="ws-criteria-tags">\${tags.map(t => \`<span class="ws-criteria-tag">\${t}</span>\`).join('')}</div>
                <div class="ws-stats"><span>📊 התראות: \${sub.alerts_sent || 0}</span><span>📅 אחרונה: \${sub.last_alert ? new Date(sub.last_alert).toLocaleDateString('he-IL') : 'אין'}</span></div>
            </div>\`;
        }

        async function toggleWSSubscription(id, active) {
            try {
                const res = await fetch(\`/api/whatsapp/subscriptions/\${id}/toggle\`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active}) });
                if (res.ok) { loadWSSubscriptions(); loadWSStats(); }
            } catch (err) { alert('שגיאה בעדכון המנוי'); }
        }

        async function deleteWSSubscription(id) {
            if (!confirm('האם אתה בטוח שברצונך למחוק מנוי זה?')) return;
            try {
                const res = await fetch(\`/api/whatsapp/subscriptions/\${id}\`, {method:'DELETE'});
                if (res.ok) { loadWSSubscriptions(); loadWSStats(); }
            } catch (err) { alert('שגיאה במחיקת המנוי'); }
        }

        async function testWSCriteria() {
            const criteria = buildWSCriteria();
            if (Object.keys(criteria).length === 0) { alert('אנא הגדר לפחות קריטריון אחד'); return; }
            try {
                const res = await fetch('/api/whatsapp/subscriptions/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({criteria}) });
                const result = await res.json();
                if (result.listings && result.listings.length > 0) {
                    alert(\`נמצאו \${result.count} רישומים תואמים:\n\n\` + result.listings.map(l => \`• \${l.city}, \${l.rooms} חדרים, \${l.size}מ"ר, ₪\${l.price.toLocaleString()}\`).join('\n'));
                } else { alert('לא נמצאו רישומים תואמים לקריטריונים'); }
            } catch (err) { alert('שגיאה בבדיקת קריטריונים'); }
        }

        async function createWSSubscription() {
            const leadId = document.getElementById('wsLeadId').value.trim();
            if (!leadId) { alert('אנא הזן Lead ID'); return; }
            const criteria = buildWSCriteria();
            if (Object.keys(criteria).length === 0) { alert('אנא הגדר לפחות קריטריון אחד'); return; }
            try {
                const res = await fetch('/api/whatsapp/subscriptions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({leadId, criteria}) });
                if (res.ok) {
                    alert('המנוי נוצר בהצלחה!');
                    document.getElementById('wsLeadId').value = '';
                    selectedWSCities = []; renderWSCityChips();
                    ['wsRoomsMin','wsRoomsMax','wsSizeMin','wsSizeMax','wsPriceMin','wsPriceMax'].forEach(id => document.getElementById(id).value = '');
                    loadWSStats();
                } else { const e = await res.json(); alert('שגיאה: ' + (e.error || 'Unknown')); }
            } catch (err) { alert('שגיאה ביצירת מנוי'); }
        }

        async function loadCommittees() {
            const search = document.getElementById('committeeSearch')?.value.toLowerCase() || '';
            try {
                const committees = await (await fetch('/api/committees')).json();
                const filtered = committees.filter(c => !search || c.complex_name?.toLowerCase().includes(search) || c.city?.toLowerCase().includes(search));
                document.getElementById('committeesTable').innerHTML = \`<table class="data-table"><thead><tr><th>מתחם</th><th>עיר</th><th>תאריך</th><th>סטטוס</th></tr></thead><tbody>\${filtered.map(c => \`<tr><td>\${c.complex_name||'N/A'}</td><td>\${c.city||'N/A'}</td><td>\${c.date?new Date(c.date).toLocaleDateString('he-IL'):'N/A'}</td><td><span class="status-badge status-\${c.status}">\${getStatusText(c.status)}</span></td></tr>\`).join('')}</tbody></table>\`;
            } catch (err) { console.error('Committees error:', err); }
        }

        async function loadComplexes() {
            try {
                const complexes = await (await fetch('/api/complexes')).json();
                document.getElementById('complexSelect').innerHTML = '<option value="">-- בחר מתחם --</option>' + complexes.map(c => \`<option value="\${c.id}">\${c.name} - \${c.city}</option>\`).join('');
            } catch (err) { console.error('Complexes error:', err); }
        }

        async function loadComplexData() {
            const complexId = document.getElementById('complexSelect').value;
            if (!complexId) { document.getElementById('enrichmentData').innerHTML = ''; return; }
            try {
                const complex = await (await fetch(\`/api/complexes/\${complexId}\`)).json();
                document.getElementById('enrichmentData').innerHTML = \`<div class="stat-card"><h3>\${complex.name}</h3><p><strong>עיר:</strong> \${complex.city}</p><p><strong>דירות:</strong> \${complex.total_apartments||'N/A'}</p><p><strong>חתימות:</strong> \${complex.signature_percentage||'N/A'}%</p><p><strong>עדכון:</strong> \${complex.last_enrichment?new Date(complex.last_enrichment).toLocaleDateString('he-IL'):'לא עודכן'}</p><button class="action-btn" onclick="enrichComplex(\${complexId})">🔄 הרץ העשרה</button></div>\`;
            } catch (err) { console.error('Complex data error:', err); }
        }

        async function enrichComplex(complexId) {
            try { const res = await fetch(\`/api/enrich/\${complexId}\`, {method:'POST'}); if (res.ok) { alert('העשרה הושלמה!'); loadComplexData(); } }
            catch (err) { alert('שגיאה בהעשרת מתחם'); }
        }

        async function loadYad2() {
            const search = document.getElementById('yad2Search')?.value.toLowerCase() || '';
            try {
                const listings = await (await fetch('/api/yad2/listings')).json();
                const filtered = listings.filter(l => !search || l.complex_name?.toLowerCase().includes(search) || l.city?.toLowerCase().includes(search));
                document.getElementById('yad2Table').innerHTML = \`<table class="data-table"><thead><tr><th>מתחם</th><th>עיר</th><th>מחיר</th><th>חדרים</th><th>עדכון</th></tr></thead><tbody>\${filtered.slice(0,50).map(l => \`<tr><td>\${l.complex_name||'N/A'}</td><td>\${l.city||'N/A'}</td><td>₪\${l.price?.toLocaleString()||'N/A'}</td><td>\${l.rooms||'N/A'}</td><td>\${l.last_updated?new Date(l.last_updated).toLocaleDateString('he-IL'):'N/A'}</td></tr>\`).join('')}</tbody></table>\`;
            } catch (err) { console.error('Yad2 error:', err); }
        }

        function searchYad2() { loadYad2(); }

        async function loadKones() {
            const search = document.getElementById('konesSearch')?.value.toLowerCase() || '';
            try {
                const listings = await (await fetch('/api/kones/listings')).json();
                const filtered = listings.filter(l => !search || l.complex_name?.toLowerCase().includes(search) || l.city?.toLowerCase().includes(search));
                document.getElementById('konesTable').innerHTML = \`<table class="data-table"><thead><tr><th>מתחם</th><th>עיר</th><th>כתובת</th><th>סטטוס</th><th>תאריך</th></tr></thead><tbody>\${filtered.slice(0,50).map(l => \`<tr><td>\${l.complex_name||'N/A'}</td><td>\${l.city||'N/A'}</td><td>\${l.address||'N/A'}</td><td><span class="status-badge status-\${l.status}">\${l.status||'N/A'}</span></td><td>\${l.date?new Date(l.date).toLocaleDateString('he-IL'):'N/A'}</td></tr>\`).join('')}</tbody></table>\`;
            } catch (err) { console.error('Kones error:', err); }
        }

        function searchKones() { loadKones(); }

        async function runEnrichment() { if (!confirm('להריץ העשרה לכל המתחמים?')) return; alert('העשרה החלה ברקע.'); }
        async function updateYad2() { alert('עדכון יד2 מתחיל...'); }
        async function scanKones() { alert('סריקת כינוסים מתחילה...'); }
        async function exportData() { window.location.href = '/api/export/all'; }

        function getStatusText(status) {
            return {'approved':'מאושר','pending':'ממתין','rejected':'נדחה','active':'פעיל'}[status] || status;
        }

        async function loadMorning() {
            const loading = document.getElementById('morning-loading');
            const mc = document.getElementById('morning-content');
            loading.style.display = 'block';
            mc.style.display = 'none';
            try {
                const [oppRes, alertRes] = await Promise.all([fetch('/api/opportunities'), fetch('/api/alerts')]);
                const opp = await oppRes.json();
                const alertData = await alertRes.json();
                const today = new Date();
                const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
                const dateStr = 'יום ' + dayNames[today.getDay()] + ', ' + today.toLocaleDateString('he-IL');
                const timeStr = today.toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'});
                const totalOpp = opp.total || 0;
                const topOpp = (opp.opportunities || []).slice(0, 5);
                const alerts = (alertData.alerts || []).slice(0, 5);
                let h = '<div style="direction:rtl">';
                h += '<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:12px;padding:24px;margin-bottom:24px;color:white">';
                h += '<div style="font-size:24px;font-weight:700">☀ בוקר QUANTUM</div>';
                h += '<div style="font-size:14px;opacity:0.85;margin-top:6px">' + dateStr + ' \u2022 ' + timeStr + '</div>';
                h += '<div style="font-size:12px;opacity:0.7;margin-top:4px">סיכום יומי \u2014 כל מה שצריך לדעת במשפט אחד</div>';
                h += '<div style="display:flex;gap:16px;margin-top:16px">';
                h += '<div style="background:rgba(255,255,255,0.2);border-radius:8px;padding:12px 20px;text-align:center"><div style="font-size:28px;font-weight:bold">' + totalOpp + '</div><div style="font-size:11px;opacity:0.85">הזדמנויות</div></div>';
                h += '<div style="background:rgba(255,255,255,0.2);border-radius:8px;padding:12px 20px;text-align:center"><div style="font-size:28px;font-weight:bold">' + alerts.length + '</div><div style="font-size:11px;opacity:0.85">התראות</div></div>';
                h += '</div></div>';
                if (topOpp.length > 0) {
                    h += '<div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">';
                    h += '<h3 style="color:#667eea;margin-bottom:12px;font-size:15px">\uD83C\uDFC6 הזדמנויות מובילות היום</h3>';
                    h += '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f8f9fa"><th style="padding:8px;text-align:right;border-bottom:2px solid #eee">מתחם</th><th style="padding:8px;text-align:right">עיר</th><th style="padding:8px;text-align:right">IAI</th><th style="padding:8px;text-align:right">סטטוס</th></tr>';
                    topOpp.forEach(function(o) {
                        h += '<tr style="border-bottom:1px solid #f0f0f0"><td style="padding:8px;font-weight:500">' + (o.name||'') + '</td><td style="padding:8px;color:#555">' + (o.city||'') + '</td><td style="padding:8px"><span style="background:#667eea;color:white;padding:2px 8px;border-radius:10px;font-size:11px">' + (o.iai_score||'-') + '</span></td><td style="padding:8px;color:#764ba2;font-size:12px">' + (o.status||'') + '</td></tr>';
                    });
                    h += '</table></div>';
                }
                if (alerts.length > 0) {
                    h += '<div style="background:white;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">';
                    h += '<h3 style="color:#e63946;margin-bottom:12px;font-size:15px">\uD83D\uDD14 התראות אחרונות</h3>';
                    alerts.forEach(function(a) {
                        const sev = a.severity === 'high' ? '#e63946' : a.severity === 'medium' ? '#f4a261' : '#6b7280';
                        h += '<div style="padding:10px;border-right:3px solid ' + sev + ';margin-bottom:8px;background:#fafafa;border-radius:0 6px 6px 0"><div style="font-size:13px;font-weight:500;color:#333">' + (a.title||'') + '</div><div style="font-size:11px;color:#888;margin-top:3px">' + ((a.message||'').substring(0,120)) + '</div></div>';
                    });
                    h += '</div>';
                }
                h += '</div>';
                mc.innerHTML = h;
                loading.style.display = 'none';
                mc.style.display = 'block';
            } catch (err) {
                loading.innerHTML = '<div style="color:white">❌ שגיאה בטעינת דיווח בוקר</div>';
                console.error('Morning error:', err);
            }
        }
    </script>
</body>
</html>
        `);
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Error loading dashboard');
    }
});

// API: Get all committees
router.get('/api/committees', (req, res) => {
    db.all('SELECT * FROM committees ORDER BY date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Get all complexes
router.get('/api/complexes', (req, res) => {
    db.all('SELECT id, name, city FROM complexes ORDER BY name', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Get complex by ID
router.get('/api/complexes/:id', (req, res) => {
    db.get('SELECT * FROM complexes WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// API: Get yad2 listings
router.get('/api/yad2/listings', (req, res) => {
    db.all('SELECT * FROM yad2_listings ORDER BY last_updated DESC LIMIT 100', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Get kones listings
router.get('/api/kones/listings', (req, res) => {
    db.all('SELECT * FROM kones_listings ORDER BY date DESC LIMIT 100', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: WhatsApp subscription statistics
router.get('/api/whatsapp/subscriptions/stats', (req, res) => {
    db.all(`
        SELECT 
            COUNT(*) as totalSubscriptions,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as activeSubscriptions,
            COUNT(DISTINCT lead_id) as uniqueLeads,
            SUM(alerts_sent) as totalAlertsSent,
            SUM(CASE WHEN last_alert > datetime('now', '-1 day') THEN alerts_sent ELSE 0 END) as alerts24h,
            SUM(CASE WHEN last_alert > datetime('now', '-7 days') THEN alerts_sent ELSE 0 END) as alerts7d
        FROM whatsapp_subscriptions
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows[0] || { totalSubscriptions:0, activeSubscriptions:0, uniqueLeads:0, totalAlertsSent:0, alerts24h:0, alerts7d:0 });
    });
});

// API: Get subscriptions by lead ID
router.get('/api/whatsapp/subscriptions/:leadId', (req, res) => {
    db.all('SELECT * FROM whatsapp_subscriptions WHERE lead_id = ? ORDER BY created_at DESC', [req.params.leadId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => ({ ...row, criteria: row.criteria ? JSON.parse(row.criteria) : {} })));
    });
});

// API: Test subscription criteria
router.post('/api/whatsapp/subscriptions/test', express.json(), (req, res) => {
    const { criteria } = req.body;
    if (!criteria || Object.keys(criteria).length === 0) return res.status(400).json({ error: 'Criteria required' });
    let query = 'SELECT * FROM yad2_listings WHERE 1=1';
    const params = [];
    if (criteria.cities && criteria.cities.length > 0) { query += ` AND city IN (${criteria.cities.map(() => '?').join(',')})`; params.push(...criteria.cities); }
    if (criteria.rooms) { if (criteria.rooms.min !== undefined) { query += ' AND rooms >= ?'; params.push(criteria.rooms.min); } if (criteria.rooms.max !== undefined) { query += ' AND rooms <= ?'; params.push(criteria.rooms.max); } }
    if (criteria.size) { if (criteria.size.min !== undefined) { query += ' AND size >= ?'; params.push(criteria.size.min); } if (criteria.size.max !== undefined) { query += ' AND size <= ?'; params.push(criteria.size.max); } }
    if (criteria.price) { if (criteria.price.min !== undefined) { query += ' AND price >= ?'; params.push(criteria.price.min); } if (criteria.price.max !== undefined) { query += ' AND price <= ?'; params.push(criteria.price.max); } }
    query += ' LIMIT 10';
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: rows.length, listings: rows });
    });
});

// API: Create subscription
router.post('/api/whatsapp/subscriptions', express.json(), (req, res) => {
    const { leadId, criteria } = req.body;
    if (!leadId || !criteria) return res.status(400).json({ error: 'Lead ID and criteria required' });
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    db.run(`INSERT INTO whatsapp_subscriptions (id, lead_id, criteria, active, created_at) VALUES (?, ?, ?, 1, datetime('now'))`,
        [id, leadId, JSON.stringify(criteria)],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, id }); }
    );
});

// API: Toggle subscription active status
router.patch('/api/whatsapp/subscriptions/:id/toggle', express.json(), (req, res) => {
    const { active } = req.body;
    db.run('UPDATE whatsapp_subscriptions SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

// API: Delete subscription
router.delete('/api/whatsapp/subscriptions/:id', (req, res) => {
    db.run('DELETE FROM whatsapp_subscriptions WHERE id = ?', [req.params.id],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

module.exports = router;
