/**
 * WhatsApp Subscription Management Dashboard
 * Visual UI for managing WhatsApp auto-alerts
 */

const express = require('express');
const router = express.Router();

router.get('/whatsapp-subscriptions', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM - ניהול מנויי WhatsApp</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #f5f5f5;
      direction: rtl;
    }

    .top-nav {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px 30px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }

    .nav-content {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .nav-brand {
      color: white;
      font-size: 24px;
      font-weight: bold;
      text-decoration: none;
    }

    .nav-links {
      display: flex;
      gap: 20px;
    }

    .nav-links a {
      color: white;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 6px;
      transition: all 0.3s;
    }

    .nav-links a:hover {
      background: rgba(255,255,255,0.2);
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 30px 20px;
    }

    .page-header {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }

    .page-header h1 {
      color: #667eea;
      font-size: 32px;
      margin-bottom: 10px;
    }

    .page-header p {
      color: #666;
      font-size: 16px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      text-align: center;
    }

    .stat-card .number {
      font-size: 42px;
      font-weight: bold;
      color: #667eea;
      margin-bottom: 10px;
    }

    .stat-card .label {
      color: #666;
      font-size: 15px;
    }

    .main-content {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
    }

    @media (max-width: 1024px) {
      .main-content {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }

    .card h2 {
      color: #333;
      font-size: 24px;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid #f0f0f0;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      color: #555;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }

    .form-group input, .form-group select {
      width: 100%;
      padding: 12px 15px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 15px;
      transition: all 0.3s;
      font-family: inherit;
    }

    .form-group input:focus, .form-group select:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }

    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      font-family: inherit;
    }

    .btn-primary {
      background: #667eea;
      color: white;
      width: 100%;
    }

    .btn-primary:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .btn-test {
      background: #10b981;
      color: white;
      margin-bottom: 20px;
    }

    .btn-test:hover {
      background: #059669;
    }

    .btn-danger {
      background: #ef4444;
      color: white;
      font-size: 13px;
      padding: 8px 16px;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .subscription-item {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 12px;
      margin-bottom: 15px;
      border-right: 4px solid #667eea;
    }

    .subscription-item.inactive {
      opacity: 0.6;
      border-right-color: #ccc;
    }

    .subscription-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .subscription-id {
      font-weight: bold;
      color: #667eea;
      font-size: 16px;
    }

    .subscription-actions {
      display: flex;
      gap: 10px;
    }

    .criteria-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }

    .tag {
      background: white;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      color: #555;
      border: 1px solid #e0e0e0;
    }

    .subscription-stats {
      display: flex;
      gap: 20px;
      font-size: 13px;
      color: #666;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #e0e0e0;
    }

    .alert {
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }

    .alert-success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #10b981;
    }

    .alert-error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #ef4444;
    }

    .alert-info {
      background: #dbeafe;
      color: #1e40af;
      border: 1px solid #3b82f6;
    }

    .loader {
      text-align: center;
      padding: 40px;
      color: #667eea;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #999;
    }

    .test-results {
      max-height: 400px;
      overflow-y: auto;
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
      margin-top: 15px;
    }

    .listing-item {
      background: white;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 10px;
      border-right: 3px solid #10b981;
    }

    .listing-item h4 {
      color: #333;
      margin-bottom: 8px;
    }

    .listing-details {
      display: flex;
      gap: 15px;
      font-size: 13px;
      color: #666;
      flex-wrap: wrap;
    }

    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 50px;
      height: 26px;
    }

    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      right: 0;
      left: 0;
      bottom: 0;
      background-color: #ccc;
      transition: 0.4s;
      border-radius: 26px;
    }

    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      right: 4px;
      bottom: 4px;
      background-color: white;
      transition: 0.4s;
      border-radius: 50%;
    }

    input:checked + .toggle-slider {
      background-color: #10b981;
    }

    input:checked + .toggle-slider:before {
      transform: translateX(-24px);
    }

    .city-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }

    .chip {
      background: #667eea;
      color: white;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .chip button {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 16px;
      padding: 0;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .chip button:hover {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="top-nav">
    <div class="nav-content">
      <a href="/api/dashboard" class="nav-brand">⚡ QUANTUM Analyzer</a>
      <div class="nav-links">
        <a href="/api/dashboard">🏠 Dashboard</a>
        <a href="/api/whatsapp-subscriptions">📲 מנויי WhatsApp</a>
        <a href="/api/whatsapp/analytics">📊 Analytics</a>
        <a href="/health">🔧 Health</a>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="page-header">
      <h1>📲 ניהול מנויי WhatsApp</h1>
      <p>ניהול התראות אוטומטיות לנכסים חדשים - משולב במערכת QUANTUM</p>
    </div>

    <div class="stats-grid" id="statsGrid">
      <div class="stat-card">
        <div class="number" id="totalSubs">-</div>
        <div class="label">מנויים פעילים</div>
      </div>
      <div class="stat-card">
        <div class="number" id="totalLeads">-</div>
        <div class="label">לידים ייחודיים</div>
      </div>
      <div class="stat-card">
        <div class="number" id="alertsToday">-</div>
        <div class="label">התראות היום</div>
      </div>
      <div class="stat-card">
        <div class="number" id="alertsWeek">-</div>
        <div class="label">התראות השבוע</div>
      </div>
    </div>

    <div class="main-content">
      <div class="card">
        <h2>➕ יצירת מנוי חדש</h2>
        
        <div id="createAlert"></div>

        <form id="createForm">
          <div class="form-group">
            <label>Lead ID *</label>
            <input type="number" id="leadId" required placeholder="הזן מזהה ליד">
          </div>

          <div class="form-group">
            <label>ערים (הקלד והקש Enter)</label>
            <input type="text" id="cityInput" placeholder="תל אביב, רמת גן..." onkeypress="handleCityInput(event)">
            <div class="city-chips" id="cityChips"></div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>חדרים - מינימום</label>
              <input type="number" step="0.5" id="roomsMin" placeholder="3">
            </div>
            <div class="form-group">
              <label>חדרים - מקסימום</label>
              <input type="number" step="0.5" id="roomsMax" placeholder="4">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>שטח מינימום (מ"ר)</label>
              <input type="number" id="sizeMin" placeholder="80">
            </div>
            <div class="form-group">
              <label>שטח מקסימום (מ"ר)</label>
              <input type="number" id="sizeMax" placeholder="120">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>מחיר מינימום (₪)</label>
              <input type="number" id="priceMin" placeholder="1500000">
            </div>
            <div class="form-group">
              <label>מחיר מקסימום (₪)</label>
              <input type="number" id="priceMax" placeholder="3000000">
            </div>
          </div>

          <button type="button" class="btn btn-test" onclick="testCriteria()">🔍 בדוק מה יתאים</button>
          <div id="testResults"></div>

          <button type="submit" class="btn btn-primary">💾 צור מנוי</button>
        </form>
      </div>

      <div class="card">
        <h2>📋 מנויים פעילים</h2>
        
        <div class="form-group">
          <label>חפש לפי Lead ID</label>
          <input type="number" id="searchLeadId" placeholder="הזן מזהה ליד" onchange="loadSubscriptions()">
        </div>

        <div id="subscriptionsList">
          <div class="empty-state">הזן Lead ID לצפייה במנויים</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin + '/api';
    let selectedCities = [];

    loadStats();

    function handleCityInput(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        const input = event.target;
        const city = input.value.trim();
        if (city && !selectedCities.includes(city)) {
          selectedCities.push(city);
          renderCityChips();
          input.value = '';
        }
      }
    }

    function removeCity(city) {
      selectedCities = selectedCities.filter(c => c !== city);
      renderCityChips();
    }

    function renderCityChips() {
      const container = document.getElementById('cityChips');
      container.innerHTML = selectedCities.map(city => \`
        <div class="chip">
          \${city}
          <button onclick="removeCity('\${city}')">×</button>
        </div>
      \`).join('');
    }

    async function loadStats() {
      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions/stats\`);
        const data = await response.json();
        
        if (data.success) {
          document.getElementById('totalSubs').textContent = data.stats.active_subscriptions;
          document.getElementById('totalLeads').textContent = data.stats.unique_leads;
          document.getElementById('alertsToday').textContent = data.stats.alerts_last_24h;
          document.getElementById('alertsWeek').textContent = data.stats.alerts_last_7d;
        }
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    }

    async function loadSubscriptions() {
      const searchLeadId = document.getElementById('searchLeadId').value;
      const container = document.getElementById('subscriptionsList');
      
      if (!searchLeadId) {
        container.innerHTML = '<div class="empty-state">הזן Lead ID לצפייה במנויים</div>';
        return;
      }

      container.innerHTML = '<div class="loader">טוען...</div>';

      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions/\${searchLeadId}\`);
        const data = await response.json();

        if (data.success && data.subscriptions.length > 0) {
          container.innerHTML = data.subscriptions.map(sub => renderSubscription(sub)).join('');
        } else {
          container.innerHTML = '<div class="empty-state">אין מנויים עבור ליד זה</div>';
        }
      } catch (error) {
        container.innerHTML = '<div class="alert alert-error">שגיאה בטעינת מנויים</div>';
      }
    }

    function renderSubscription(sub) {
      const criteria = sub.criteria || {};
      const tags = [];
      
      if (criteria.cities) tags.push(\`ערים: \${criteria.cities.join(', ')}\`);
      if (criteria.rooms_min || criteria.rooms_max) {
        tags.push(\`חדרים: \${criteria.rooms_min || '?'}-\${criteria.rooms_max || '?'}\`);
      }
      if (criteria.size_min || criteria.size_max) {
        tags.push(\`שטח: \${criteria.size_min || '?'}-\${criteria.size_max || '?'} מ"ר\`);
      }
      if (criteria.price_min || criteria.price_max) {
        const priceMin = criteria.price_min ? (criteria.price_min / 1000000).toFixed(1) : '?';
        const priceMax = criteria.price_max ? (criteria.price_max / 1000000).toFixed(1) : '?';
        tags.push(\`מחיר: \${priceMin}-\${priceMax}M ₪\`);
      }

      return \`
        <div class="subscription-item \${sub.active ? '' : 'inactive'}">
          <div class="subscription-header">
            <div class="subscription-id">#\${sub.id}</div>
            <div class="subscription-actions">
              <label class="toggle-switch">
                <input type="checkbox" \${sub.active ? 'checked' : ''} 
                  onchange="toggleSubscription(\${sub.id}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
              <button class="btn btn-danger" onclick="deleteSubscription(\${sub.id})">🗑️</button>
            </div>
          </div>
          
          <div class="criteria-tags">
            \${tags.map(tag => \`<div class="tag">\${tag}</div>\`).join('')}
          </div>

          <div class="subscription-stats">
            <span>📨 \${sub.alerts_sent || 0} התראות נשלחו</span>
            \${sub.last_alert_at ? \`<span>🕐 אחרון: \${new Date(sub.last_alert_at).toLocaleDateString('he-IL')}</span>\` : ''}
          </div>
        </div>
      \`;
    }

    async function toggleSubscription(id, active) {
      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions/\${id}/toggle\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active })
        });

        if (response.ok) {
          loadSubscriptions();
          loadStats();
        }
      } catch (error) {
        alert('שגיאה בעדכון מנוי');
      }
    }

    async function deleteSubscription(id) {
      if (!confirm('למחוק מנוי זה?')) return;

      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions/\${id}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          loadSubscriptions();
          loadStats();
        }
      } catch (error) {
        alert('שגיאה במחיקת מנוי');
      }
    }

    async function testCriteria() {
      const resultsDiv = document.getElementById('testResults');
      resultsDiv.innerHTML = '<div class="loader">מחפש...</div>';

      const criteria = buildCriteria();

      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions/test\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ criteria, limit: 10 })
        });

        const data = await response.json();

        if (data.success && data.matches.length > 0) {
          resultsDiv.innerHTML = \`
            <div class="alert alert-success">נמצאו \${data.matchCount} נכסים תואמים!</div>
            <div class="test-results">
              \${data.matches.map(listing => \`
                <div class="listing-item">
                  <h4>\${listing.address || 'כתובת לא ידועה'} - \${listing.city}</h4>
                  <div class="listing-details">
                    <span>💰 \${(listing.price / 1000000).toFixed(2)}M ₪</span>
                    <span>🛏 \${listing.rooms} חד'</span>
                    <span>📐 \${listing.size_sqm}מ"ר</span>
                  </div>
                </div>
              \`).join('')}
            </div>
          \`;
        } else {
          resultsDiv.innerHTML = '<div class="alert alert-info">לא נמצאו נכסים תואמים בשבוע האחרון</div>';
        }
      } catch (error) {
        resultsDiv.innerHTML = '<div class="alert alert-error">שגיאה בבדיקה</div>';
      }
    }

    function buildCriteria() {
      const criteria = {};
      
      if (selectedCities.length > 0) criteria.cities = selectedCities;
      
      const roomsMin = document.getElementById('roomsMin').value;
      const roomsMax = document.getElementById('roomsMax').value;
      const sizeMin = document.getElementById('sizeMin').value;
      const sizeMax = document.getElementById('sizeMax').value;
      const priceMin = document.getElementById('priceMin').value;
      const priceMax = document.getElementById('priceMax').value;

      if (roomsMin) criteria.rooms_min = parseFloat(roomsMin);
      if (roomsMax) criteria.rooms_max = parseFloat(roomsMax);
      if (sizeMin) criteria.size_min = parseInt(sizeMin);
      if (sizeMax) criteria.size_max = parseInt(sizeMax);
      if (priceMin) criteria.price_min = parseInt(priceMin);
      if (priceMax) criteria.price_max = parseInt(priceMax);

      return criteria;
    }

    document.getElementById('createForm').onsubmit = async (e) => {
      e.preventDefault();
      
      const alertDiv = document.getElementById('createAlert');
      const leadId = document.getElementById('leadId').value;
      const criteria = buildCriteria();

      try {
        const response = await fetch(\`\${API_BASE}/whatsapp/subscriptions\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: parseInt(leadId), criteria })
        });

        const data = await response.json();

        if (data.success) {
          alertDiv.innerHTML = '<div class="alert alert-success">✅ מנוי נוצר בהצלחה!</div>';
          
          document.getElementById('createForm').reset();
          selectedCities = [];
          renderCityChips();
          document.getElementById('testResults').innerHTML = '';
          
          loadStats();
          if (document.getElementById('searchLeadId').value) {
            loadSubscriptions();
          }

          setTimeout(() => alertDiv.innerHTML = '', 3000);
        } else {
          alertDiv.innerHTML = \`<div class="alert alert-error">❌ שגיאה: \${data.error || 'נכשל'}</div>\`;
        }
      } catch (error) {
        alertDiv.innerHTML = '<div class="alert alert-error">❌ שגיאה ביצירת מנוי</div>';
      }
    };
  </script>
</body>
</html>
  `);
});

module.exports = router;
