/**
 * WhatsApp Bot Dashboard Routes
 * Real-time monitoring and management for QUANTUM WhatsApp AI Bot
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const { logger } = require('../services/logger');

// Serve the dashboard HTML
router.get('/whatsapp', (req, res) => {
  try {
    // In production, serve the HTML file from public directory
    const dashboardHTML = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QUANTUM - WhatsApp Bot Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/chart.js"></script>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .card-hover { transition: all 0.3s ease; transform: translateY(0); }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); }
        .status-online { background: #10b981; }
        .status-offline { background: #ef4444; }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: .5; }
        }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    
    <!-- Header -->
    <header class="gradient-bg text-white p-6 mb-6 shadow-lg">
        <div class="max-w-7xl mx-auto">
            <div class="flex justify-between items-center">
                <div>
                    <h1 class="text-3xl font-bold">QUANTUM AI Dashboard</h1>
                    <p class="text-blue-100 mt-2">ניהול בזמן אמת - WhatsApp Bot & Leads</p>
                </div>
                <div class="flex items-center space-x-4">
                    <div class="flex items-center">
                        <div id="botStatus" class="w-3 h-3 rounded-full status-offline"></div>
                        <span id="botStatusText" class="mr-2 text-sm">בוט לא מחובר</span>
                    </div>
                    <button onclick="refreshData()" class="bg-white/20 px-4 py-2 rounded-lg hover:bg-white/30 transition-colors">
                        רענון
                    </button>
                </div>
            </div>
        </div>
    </header>

    <div class="max-w-7xl mx-auto px-6">
        
        <!-- Stats Cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            
            <!-- Total Leads -->
            <div class="bg-white rounded-xl shadow-md p-6 card-hover">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-500 text-sm">כל הליידים</p>
                        <p id="totalLeads" class="text-3xl font-bold text-gray-800">0</p>
                    </div>
                    <div class="bg-blue-100 p-3 rounded-full">
                        <svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                        </svg>
                    </div>
                </div>
            </div>

            <!-- WhatsApp Leads -->
            <div class="bg-white rounded-xl shadow-md p-6 card-hover">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-500 text-sm">WhatsApp Bot</p>
                        <p id="whatsappLeads" class="text-3xl font-bold text-green-600">0</p>
                    </div>
                    <div class="bg-green-100 p-3 rounded-full">
                        <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
                        </svg>
                    </div>
                </div>
            </div>

            <!-- Hot Leads -->
            <div class="bg-white rounded-xl shadow-md p-6 card-hover">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-500 text-sm">ליידים חמים</p>
                        <p id="hotLeads" class="text-3xl font-bold text-orange-600">0</p>
                    </div>
                    <div class="bg-orange-100 p-3 rounded-full">
                        <svg class="w-8 h-8 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z"></path>
                        </svg>
                    </div>
                </div>
            </div>

            <!-- Conversion Rate -->
            <div class="bg-white rounded-xl shadow-md p-6 card-hover">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-500 text-sm">שיעור המרה</p>
                        <p id="conversionRate" class="text-3xl font-bold text-purple-600">0%</p>
                    </div>
                    <div class="bg-purple-100 p-3 rounded-full">
                        <svg class="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H9z"></path>
                        </svg>
                    </div>
                </div>
            </div>
        </div>

        <!-- Recent Leads -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-8">
            <div class="flex items-center justify-between mb-6">
                <h3 class="text-xl font-bold text-gray-800">ליידים אחרונים</h3>
                <button onclick="refreshData()" class="text-blue-600 hover:text-blue-800 text-sm">רענון</button>
            </div>
            
            <div id="recentLeads" class="space-y-4">
                <!-- Leads will be loaded here -->
            </div>
        </div>

        <!-- Bot Controls -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-8">
            <h3 class="text-xl font-bold text-gray-800 mb-6">בקרת בוט</h3>
            
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <button onclick="testBot()" class="bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-lg transition-colors">
                    🤖 בדיקת בוט
                </button>
                <button onclick="viewBotHealth()" class="bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg transition-colors">
                    ❤️ בריאות בוט
                </button>
                <button onclick="exportLeads()" class="bg-purple-500 hover:bg-purple-600 text-white px-6 py-3 rounded-lg transition-colors">
                    📊 יצא ליידים
                </button>
            </div>
        </div>

    </div>

    <script>
        // Dashboard state
        let dashboardData = {
            leads: [],
            stats: {},
            botStatus: 'offline'
        };

        // Initialize dashboard
        async function initDashboard() {
            console.log('Initializing QUANTUM Dashboard...');
            await loadDashboardData();
            
            // Real-time updates every 30 seconds
            setInterval(refreshData, 30000);
        }

        // Load data from APIs
        async function loadDashboardData() {
            try {
                // Check bot health
                await checkBotHealth();
                
                // Load leads
                const leadsResponse = await fetch('/api/leads');
                const leadsData = await leadsResponse.json();
                
                dashboardData.leads = leadsData.leads || [];
                dashboardData.stats = leadsData.counts || {};
                
                updateUI();
                
            } catch (error) {
                console.error('Failed to load dashboard data:', error);
                showError('שגיאה בטעינת נתונים');
            }
        }

        // Check bot health
        async function checkBotHealth() {
            try {
                const response = await fetch('/health');
                if (response.ok) {
                    const health = await response.json();
                    if (health.status === 'ok') {
                        dashboardData.botStatus = 'online';
                        document.getElementById('botStatus').className = 'w-3 h-3 rounded-full status-online pulse';
                        document.getElementById('botStatusText').textContent = 'מערכת פעילה';
                    }
                } else {
                    dashboardData.botStatus = 'offline';
                }
            } catch (error) {
                dashboardData.botStatus = 'offline';
                document.getElementById('botStatus').className = 'w-3 h-3 rounded-full status-offline';
                document.getElementById('botStatusText').textContent = 'מערכת לא זמינה';
            }
        }

        // Update UI with data
        function updateUI() {
            const stats = dashboardData.stats;
            
            // Update stats cards
            document.getElementById('totalLeads').textContent = stats.total || '0';
            document.getElementById('whatsappLeads').textContent = 
                dashboardData.leads.filter(l => l.source === 'whatsapp_bot').length;
            document.getElementById('hotLeads').textContent = stats.urgent || '0';
            
            // Calculate conversion rate
            const conversionRate = stats.total > 0 ? 
                ((stats.urgent || 0) / stats.total * 100).toFixed(1) : '0';
            document.getElementById('conversionRate').textContent = conversionRate + '%';
            
            // Update recent leads
            updateRecentLeads();
        }

        // Update recent leads list
        function updateRecentLeads() {
            const container = document.getElementById('recentLeads');
            const recentLeads = dashboardData.leads.slice(0, 8);
            
            if (recentLeads.length === 0) {
                container.innerHTML = '<p class="text-gray-500 text-center py-8">אין ליידים עדיין</p>';
                return;
            }
            
            container.innerHTML = recentLeads.map(lead => {
                const isWhatsApp = lead.source === 'whatsapp_bot';
                const isUrgent = lead.is_urgent || lead.status === 'urgent';
                
                return \`
                <div class="border-r-4 \${isUrgent ? 'border-red-500' : isWhatsApp ? 'border-green-500' : 'border-blue-500'} border-gray-200 bg-gray-50 p-4 rounded-lg">
                    <div class="flex justify-between items-start">
                        <div class="flex-1">
                            <div class="flex items-center space-x-2 mb-2">
                                <h4 class="font-semibold text-gray-800">\${lead.name || lead.phone || 'אלמוני'}</h4>
                                <span class="px-2 py-1 text-xs rounded-full \${getLeadTypeClass(lead.user_type)}">
                                    \${getLeadTypeText(lead.user_type)}
                                </span>
                                \${isWhatsApp ? '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">🤖 WhatsApp</span>' : ''}
                                \${isUrgent ? '<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">🔥 דחוף</span>' : ''}
                            </div>
                            <p class="text-sm text-gray-600">
                                📍 \${lead.city || 'לא צוין'} | 💰 \${lead.budget || 'לא צוין'}
                            </p>
                            <p class="text-xs text-gray-500 mt-1">
                                \${new Date(lead.created_at).toLocaleString('he-IL')}
                            </p>
                        </div>
                    </div>
                </div>
                \`;
            }).join('');
        }

        // Helper functions
        function getLeadTypeClass(type) {
            const classes = {
                'investor': 'bg-purple-100 text-purple-800',
                'seller': 'bg-red-100 text-red-800', 
                'buyer': 'bg-green-100 text-green-800',
                'owner': 'bg-orange-100 text-orange-800'
            };
            return classes[type] || 'bg-gray-100 text-gray-800';
        }

        function getLeadTypeText(type) {
            const texts = {
                'investor': 'משקיע',
                'seller': 'מוכר',
                'buyer': 'קונה', 
                'owner': 'בעלים',
                'contact': 'צור קשר'
            };
            return texts[type] || 'לא ידוע';
        }

        // Bot actions
        async function testBot() {
            try {
                showSuccess('שולח בדיקה...');
                const response = await fetch('/api/whatsapp/trigger', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: '972522377712',
                        message: 'בדיקה מה-Dashboard - ' + new Date().toLocaleTimeString('he-IL')
                    })
                });
                
                if (response.ok) {
                    showSuccess('✅ בדיקת בוט הצליחה! בדוק WhatsApp');
                } else {
                    showError('❌ בדיקת בוט נכשלה');
                }
            } catch (error) {
                showError('❌ שגיאה בבדיקת בוט');
            }
        }

        function viewBotHealth() {
            window.open('/health', '_blank');
        }

        function exportLeads() {
            if (dashboardData.leads.length === 0) {
                showError('אין ליידים לייצוא');
                return;
            }
            
            const csv = convertToCSV(dashboardData.leads);
            downloadCSV(csv, 'quantum-leads-' + new Date().toISOString().split('T')[0] + '.csv');
            showSuccess('קובץ ייצוא ירד בהצלחה!');
        }

        function convertToCSV(leads) {
            const headers = ['ID', 'שם', 'טלפון', 'עיר', 'סוג', 'מקור', 'תאריך יצירה'];
            const rows = leads.map(lead => [
                lead.id,
                lead.name || '',
                lead.phone || '',
                lead.city || '',
                getLeadTypeText(lead.user_type),
                lead.source === 'whatsapp_bot' ? 'WhatsApp Bot' : lead.source,
                new Date(lead.created_at).toLocaleDateString('he-IL')
            ]);
            
            return [headers, ...rows].map(row => 
                row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
            ).join('\\n');
        }

        function downloadCSV(csv, filename) {
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        // Utility functions
        function refreshData() {
            loadDashboardData();
        }

        function showSuccess(message) {
            alert('✅ ' + message);
        }

        function showError(message) {
            alert('❌ ' + message);
        }

        // Initialize when page loads
        document.addEventListener('DOMContentLoaded', initDashboard);
    </script>

</body>
</html>
    `;
    
    res.send(dashboardHTML);
    logger.info('WhatsApp Dashboard served');
    
  } catch (error) {
    logger.error('Dashboard error:', error.message);
    res.status(500).json({ error: 'Dashboard failed to load' });
  }
});

module.exports = router;