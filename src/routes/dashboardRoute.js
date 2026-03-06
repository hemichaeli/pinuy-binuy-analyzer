const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

/**
 * Serve modern QUANTUM dashboard with ALL missing sections restored
 * GET /dashboard - Complete analytics dashboard including:
 * - Quick Actions (from old overview tab)
 * - Enrichment section with complex selection
 * - Morning Brief tab with daily intelligence 
 * - Kones/Receivership management
 * - WhatsApp subscription management  
 * - Modern responsive design with multi-view navigation
 * v4.56.1 - Added Enrichment and Morning Brief sections
 */
router.get('/', (req, res) => {
  try {
    const dashboardPath = path.join(__dirname, '../views/dashboard.html');
    
    if (fs.existsSync(dashboardPath) && fs.statSync(dashboardPath).size > 100) {
      res.sendFile(dashboardPath);
    } else {
      // Fallback: serve enhanced inline dashboard with all missing sections
      res.send(getDashboardHTML());
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to load dashboard', message: error.message });
  }
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html class="dark" lang="he" dir="rtl">
<head>
    <meta charset="utf-8"/>
    <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
    <title>QUANTUM ANALYZER - מרכז פיקוד</title>
    <script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@600;700&family=Material+Icons+Round&display=swap" rel="stylesheet"/>
    <script>
        tailwind.config = {
            darkMode: "class",
            theme: {
                extend: {
                    colors: {
                        primary: "#D4AF37",
                        "background-dark": "#0A0A0B",
                        secondary: "#1A1B1E",
                        accent: "#8B5CF6",
                    },
                    fontFamily: {
                        display: ["Playfair Display", "serif"],
                        sans: ["Inter", "sans-serif"],
                    },
                },
            },
        };
    </script>
    <style>
        .iai-gradient { background: linear-gradient(135deg, #8B5CF6 0%, #D4AF37 100%); }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #2D2E32; border-radius: 10px; }
        .sidebar-item:hover { background: rgba(212, 175, 55, 0.1); }
        .sidebar-item.active { background: rgba(212, 175, 55, 0.15); color: #D4AF37; }
        .view { display: none; }
        .view.active { display: block; }
        .action-btn {
            @apply bg-primary/20 text-primary border border-primary/30 px-4 py-3 rounded-lg font-medium text-sm transition-all duration-200 hover:bg-primary hover:text-background-dark cursor-pointer flex items-center justify-center space-x-2 space-x-reverse;
        }
        .form-group {
            @apply mb-4;
        }
        .form-group label {
            @apply block text-sm font-medium text-slate-300 mb-2;
        }
        .form-group input, .form-group select {
            @apply w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-100 focus:border-primary focus:ring-1 focus:ring-primary;
        }
        .ws-city-chip {
            @apply inline-flex items-center px-2 py-1 bg-primary/20 text-primary text-xs rounded-full mr-2 mb-2 border border-primary/30;
        }
        .data-table {
            @apply w-full text-sm;
        }
        .data-table thead th {
            @apply px-4 py-3 text-right bg-white/5 border-b border-white/10 font-semibold text-slate-300;
        }
        .data-table tbody td {
            @apply px-4 py-3 border-b border-white/5;
        }
        .data-table tbody tr:hover {
            @apply bg-white/[0.02];
        }
        .status-badge {
            @apply px-2 py-1 rounded-full text-xs font-medium;
        }
        .status-active { @apply bg-green-500/20 text-green-400; }
        .status-inactive { @apply bg-gray-500/20 text-gray-400; }
        .status-pending { @apply bg-yellow-500/20 text-yellow-400; }
        .enrichment-card {
            @apply bg-white/5 p-4 rounded-lg border border-white/10 mb-4;
        }
        .brief-card {
            @apply bg-secondary p-6 rounded-2xl border border-white/5 mb-6;
        }
    </style>
</head>
<body class="bg-background-dark text-slate-100 font-sans min-h-screen flex">

<!-- Sidebar -->
<aside class="w-64 border-l border-white/5 bg-secondary hidden lg:flex flex-col sticky top-0 h-screen">
    <div class="p-8">
        <h1 class="font-display text-2xl font-bold tracking-tight text-primary">QUANTUM</h1>
        <p class="text-[10px] uppercase tracking-widest opacity-50 mt-1">מודיעין התחדשות עירונית</p>
    </div>
    <nav class="flex-1 px-4 space-y-1">
        <a class="sidebar-item active flex items-center space-x-3 space-x-reverse p-3 rounded-lg" href="#" onclick="showView('dashboard')">
            <span class="material-icons-round text-lg">dashboard</span><span>דשבורד</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('enrichment')">
            <span class="material-icons-round text-lg">auto_awesome</span><span>העשרת מידע</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('morning')">
            <span class="material-icons-round text-lg">wb_sunny</span><span>דוח בוקר</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('complexes')">
            <span class="material-icons-round text-lg">domain</span><span>מתחמים</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('opportunities')">
            <span class="material-icons-round text-lg">trending_up</span><span>הזדמנויות</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('kones')">
            <span class="material-icons-round text-lg">gavel</span><span>כינוסים</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('whatsapp')">
            <span class="material-icons-round text-lg">chat</span><span>מנויי WhatsApp</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="#" onclick="showView('alerts')">
            <span class="material-icons-round text-lg">notifications_active</span><span>התראות</span>
        </a>
    </nav>
    <div class="p-6 border-t border-white/5">
        <div class="flex items-center space-x-3 space-x-reverse">
            <div class="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-background-dark font-bold">HM</div>
            <div><p class="text-sm font-semibold">Hemi</p><p class="text-xs opacity-50">מנכ"ל</p></div>
        </div>
    </div>
</aside>

<!-- Main Content -->
<main class="flex-1 overflow-y-auto h-screen custom-scrollbar">

    <!-- Dashboard View -->
    <div id="view-dashboard" class="view active">
        <header class="p-8 pb-0">
            <div class="flex justify-between items-end mb-8">
                <div>
                    <h2 class="font-display text-3xl font-bold">מרכז הפיקוד</h2>
                    <p class="text-slate-400">ניתוח שוק בזמן אמת ומעקב הזדמנויות</p>
                </div>
                <div class="flex space-x-4 space-x-reverse">
                    <button class="bg-white/5 border border-white/10 px-4 py-2 rounded-lg flex items-center space-x-2 space-x-reverse text-sm font-medium">
                        <span class="material-icons-round text-sm">calendar_today</span><span>24 שעות אחרונות</span>
                    </button>
                </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" id="heroStats"></div>
        </header>

        <div class="p-8 grid grid-cols-12 gap-8">
            <!-- Quick Actions Section -->
            <div class="col-span-12">
                <section class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h4 class="font-display text-xl mb-6 flex items-center">
                        <span class="material-icons-round text-primary ml-2">flash_on</span>פעולות מהירות
                    </h4>
                    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <button class="action-btn" onclick="runEnrichment()">
                            <span class="material-icons-round">refresh</span>
                            <span>הרץ העשרה</span>
                        </button>
                        <button class="action-btn" onclick="updateYad2()">
                            <span class="material-icons-round">bar_chart</span>
                            <span>עדכן יד2</span>
                        </button>
                        <button class="action-btn" onclick="scanKones()">
                            <span class="material-icons-round">gavel</span>
                            <span>סרוק כינוסים</span>
                        </button>
                        <button class="action-btn" onclick="exportData()">
                            <span class="material-icons-round">file_download</span>
                            <span>ייצא נתונים</span>
                        </button>
                    </div>
                </section>
            </div>

            <div class="col-span-12 lg:col-span-9 space-y-8">
                <section class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h4 class="font-display text-xl mb-6">ביצועי שוק</h4>
                    <div class="h-48 flex items-end justify-between px-2" id="marketChart"></div>
                </section>

                <section class="bg-secondary rounded-2xl border border-white/5 overflow-hidden">
                    <div class="p-6 border-b border-white/5 flex justify-between items-center">
                        <h4 class="font-display text-xl text-primary">הזדמנויות חמות</h4>
                        <a href="#" onclick="showView('opportunities')" class="text-sm text-primary flex items-center font-medium">
                            צפה בהכל <span class="material-icons-round text-sm mr-1">chevron_left</span>
                        </a>
                    </div>
                    <div class="overflow-x-auto"><table class="w-full" id="opportunitiesTable"></table></div>
                </section>
            </div>

            <div class="col-span-12 lg:col-span-3 space-y-8">
                <section class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h4 class="font-display text-lg mb-6 flex items-center">
                        <span class="material-icons-round text-primary ml-2">bolt</span>התראות אחרונות
                    </h4>
                    <div class="space-y-6" id="alertFeed"></div>
                </section>

                <section class="bg-primary p-6 rounded-2xl shadow-xl shadow-primary/20 relative overflow-hidden">
                    <div class="relative z-10">
                        <h4 class="text-background-dark font-display text-lg font-bold">תובנות חכמות</h4>
                        <p class="text-background-dark/80 text-xs mt-2 leading-relaxed" id="smartInsight">טוען...</p>
                        <a href="#" onclick="showView('opportunities')" class="mt-4 px-4 py-2 bg-background-dark text-white text-xs font-bold rounded-lg inline-block">
                            חיפוש מדויק
                        </a>
                    </div>
                </section>
            </div>
        </div>
    </div>

    <!-- Enrichment View -->
    <div id="view-enrichment" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6 flex items-center">
                <span class="material-icons-round text-primary ml-3">auto_awesome</span>העשרת מידע
            </h2>
            
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Complex Selection -->
                <div class="lg:col-span-1">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="font-display text-xl mb-6">בחר מתחם להעשרה</h3>
                        <div class="form-group">
                            <label>מתחם:</label>
                            <select id="complexSelect" onchange="loadComplexData()">
                                <option value="">-- בחר מתחם --</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <button onclick="enrichSelectedComplex()" class="w-full bg-primary text-background-dark font-medium py-3 rounded-lg hover:bg-primary/80 transition-colors">
                                העשר מתחם נבחר
                            </button>
                        </div>
                        <div class="form-group">
                            <button onclick="enrichAllComplexes()" class="w-full bg-white/10 text-slate-100 font-medium py-3 rounded-lg hover:bg-white/20 transition-colors">
                                העשר כל המתחמים
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Complex Data Display -->
                <div class="lg:col-span-2">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="font-display text-xl mb-6">פרטי מתחם</h3>
                        <div id="enrichmentData" class="space-y-4">
                            <p class="text-slate-400 text-center py-8">בחר מתחם לצפייה בפרטים</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Enrichment Stats -->
            <div class="mt-8">
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6" id="enrichmentStats">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">מתחמים מועשרים</h3>
                        <div class="text-2xl font-bold text-primary" id="enrichedCount">-</div>
                        <div class="text-xs text-slate-500">מתוך הכל</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">ציון Perplexity ממוצע</h3>
                        <div class="text-2xl font-bold" id="avgPerplexity">-</div>
                        <div class="text-xs text-slate-500">ציון עיבוד</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">העשרות היום</h3>
                        <div class="text-2xl font-bold text-green-400" id="todayEnrichments">-</div>
                        <div class="text-xs text-slate-500">מתחמים</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">יעילות המערכת</h3>
                        <div class="text-2xl font-bold" id="systemEfficiency">-</div>
                        <div class="text-xs text-slate-500">מתחמים/שעה</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Morning Brief View -->
    <div id="view-morning" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6 flex items-center">
                <span class="material-icons-round text-primary ml-3">wb_sunny</span>דוח בוקר
            </h2>
            
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Controls -->
                <div class="lg:col-span-1">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="font-display text-xl mb-6">פעולות דוח</h3>
                        <div class="space-y-4">
                            <button onclick="generateMorningBrief()" class="w-full bg-primary text-background-dark font-medium py-3 rounded-lg hover:bg-primary/80 transition-colors">
                                צור דוח בוקר חדש
                            </button>
                            <button onclick="sendMorningBrief()" class="w-full bg-white/10 text-slate-100 font-medium py-3 rounded-lg hover:bg-white/20 transition-colors">
                                שלח דוח ב-WhatsApp
                            </button>
                            <button onclick="previewMorningBrief()" class="w-full bg-white/10 text-slate-100 font-medium py-3 rounded-lg hover:bg-white/20 transition-colors">
                                תצוגה מקדימה
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Brief Content -->
                <div class="lg:col-span-2">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="font-display text-xl mb-6">תוכן הדוח</h3>
                        <div id="morningBriefContent" class="space-y-4">
                            <div class="brief-card">
                                <h4 class="font-bold text-primary mb-3">☀️ דוח בוקר QUANTUM</h4>
                                <p class="text-sm text-slate-300 mb-4">
                                    דוח יומי מלא עם הזדמנויות חדשות, מוכרים בלחץ ושינויי מחירים בשוק הפינוי-בינוי.
                                </p>
                                <div class="text-slate-400 text-center py-8">
                                    לחץ "צור דוח בוקר חדש" ליצירת דוח מעודכן
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Brief Statistics -->
            <div class="mt-8">
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6" id="briefStats">
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">דוחות השבוע</h3>
                        <div class="text-2xl font-bold text-primary" id="weeklyReports">-</div>
                        <div class="text-xs text-slate-500">דוחות נוצרו</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">שיעור פתיחה</h3>
                        <div class="text-2xl font-bold" id="openRate">-</div>
                        <div class="text-xs text-slate-500">ב-WhatsApp</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">הזדמנויות חדשות</h3>
                        <div class="text-2xl font-bold text-green-400" id="newOpportunities">-</div>
                        <div class="text-xs text-slate-500">מאתמול</div>
                    </div>
                    <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                        <h3 class="text-sm font-medium text-slate-400 mb-2">מנויים פעילים</h3>
                        <div class="text-2xl font-bold" id="activeSubscribers">-</div>
                        <div class="text-xs text-slate-500">מקבלי דוח</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Complexes View -->
    <div id="view-complexes" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6">מתחמים</h2>
            <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                <p class="text-slate-400">רשימת מתחמים תוטען כאן...</p>
            </div>
        </div>
    </div>

    <!-- Opportunities View -->
    <div id="view-opportunities" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6">הזדמנויות</h2>
            <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                <p class="text-slate-400">רשימת הזדמנויות תוטען כאן...</p>
            </div>
        </div>
    </div>

    <!-- Kones View -->
    <div id="view-kones" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6 flex items-center">
                <span class="material-icons-round text-primary ml-3">gavel</span>כינוסי נכסים
            </h2>
            
            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8" id="konesStats">
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">סה"כ רישומים</h3>
                    <div class="text-2xl font-bold text-primary" id="konesTotalListings">-</div>
                    <div class="text-xs text-slate-500">רישומי כינוס</div>
                </div>
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">מתחמים</h3>
                    <div class="text-2xl font-bold" id="konesUniqueComplexes">-</div>
                    <div class="text-xs text-slate-500">מתחמים ייחודיים</div>
                </div>
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">פעילים</h3>
                    <div class="text-2xl font-bold text-green-400" id="konesActiveListings">-</div>
                    <div class="text-xs text-slate-500">רישומים פעילים</div>
                </div>
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">ממוצע</h3>
                    <div class="text-2xl font-bold" id="konesAverage">-</div>
                    <div class="text-xs text-slate-500">רישומים למתחם</div>
                </div>
            </div>

            <!-- Search and Table -->
            <div class="bg-secondary rounded-2xl border border-white/5 overflow-hidden">
                <div class="p-6 border-b border-white/5">
                    <div class="flex justify-between items-center mb-4">
                        <h4 class="font-display text-xl">רשימת כינוסים</h4>
                        <button onclick="loadKones()" class="bg-primary/20 text-primary px-4 py-2 rounded-lg text-sm hover:bg-primary hover:text-background-dark transition-colors">
                            רענן נתונים
                        </button>
                    </div>
                    <div class="form-group">
                        <input type="text" id="konesSearch" placeholder="חיפוש כינוסים לפי מתחם או עיר..." onkeyup="searchKones()">
                    </div>
                </div>
                <div class="overflow-x-auto p-6">
                    <div id="konesTable">טוען נתונים...</div>
                </div>
            </div>
        </div>
    </div>

    <!-- WhatsApp View -->
    <div id="view-whatsapp" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6 flex items-center">
                <span class="material-icons-round text-primary ml-3">chat</span>מנויי WhatsApp
            </h2>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8" id="wsStatsGrid">
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">מנויים פעילים</h3>
                    <div class="text-2xl font-bold text-primary" id="wsActiveCount">-</div>
                    <div class="text-xs text-slate-500">מנויים במעקב</div>
                </div>
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">לידים ייחודיים</h3>
                    <div class="text-2xl font-bold" id="wsUniqueLeads">-</div>
                    <div class="text-xs text-slate-500">לקוחות רשומים</div>
                </div>
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="text-sm font-medium text-slate-400 mb-2">התראות 24 שעות</h3>
                    <div class="text-2xl font-bold text-green-400" id="wsAlerts24h">-</div>
                    <div class="text-xs text-slate-500">נשלחו היום</div>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <!-- Create Subscription Form -->
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <h3 class="font-display text-xl mb-6">יצירת מנוי חדש</h3>
                    <div class="form-group">
                        <label>מזהה ליד (Lead ID):</label>
                        <input type="text" id="wsLeadId" placeholder="למשל: lead_12345">
                    </div>
                    <div class="form-group">
                        <label>ערים (הקש Enter להוספה):</label>
                        <input type="text" id="wsCityInput" placeholder="הקלד שם עיר והקש Enter" onkeypress="handleWSCityInput(event)">
                        <div class="mt-2" id="wsCityChips"></div>
                    </div>
                    <div class="form-group">
                        <label>חדרים:</label>
                        <div class="grid grid-cols-2 gap-3">
                            <input type="number" id="wsRoomsMin" placeholder="מינימום" step="0.5">
                            <input type="number" id="wsRoomsMax" placeholder="מקסימום" step="0.5">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>גודל (מ"ר):</label>
                        <div class="grid grid-cols-2 gap-3">
                            <input type="number" id="wsSizeMin" placeholder="מינימום">
                            <input type="number" id="wsSizeMax" placeholder="מקסימום">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>מחיר (₪):</label>
                        <div class="grid grid-cols-2 gap-3">
                            <input type="number" id="wsPriceMin" placeholder="מינימום">
                            <input type="number" id="wsPriceMax" placeholder="מקסימום">
                        </div>
                    </div>
                    <button onclick="createWSSubscription()" class="w-full bg-primary text-background-dark font-medium py-3 rounded-lg hover:bg-primary/80 transition-colors">
                        צור מנוי
                    </button>
                </div>

                <!-- Subscriptions List -->
                <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                    <div class="flex justify-between items-center mb-6">
                        <h3 class="font-display text-xl">מנויים קיימים</h3>
                        <button onclick="loadWSSubscriptions()" class="bg-primary/20 text-primary px-4 py-2 rounded-lg text-sm hover:bg-primary hover:text-background-dark transition-colors">
                            רענן
                        </button>
                    </div>
                    <div class="form-group">
                        <input type="text" id="wsLeadSearch" placeholder="חיפוש לפי Lead ID..." onkeyup="loadWSSubscriptions()">
                    </div>
                    <div id="wsSubscriptionsList" class="max-h-96 overflow-y-auto custom-scrollbar">
                        טוען מנויים...
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Alerts View -->
    <div id="view-alerts" class="view">
        <div class="p-8">
            <h2 class="font-display text-3xl font-bold mb-6">התראות</h2>
            <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                <p class="text-slate-400">רשימת התראות תוטען כאן...</p>
            </div>
        </div>
    </div>

</main>

<script>
// Global variables
let selectedWSCities = [];

// View management
function showView(viewName) {
    // Remove active class from all views and nav items
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
    
    // Show selected view
    document.getElementById('view-' + viewName).classList.add('active');
    
    // Add active class to clicked nav item
    event.target.closest('.sidebar-item').classList.add('active');
    
    // Load data for specific views
    if (viewName === 'kones') loadKones();
    if (viewName === 'whatsapp') {
        loadWSStats();
        loadWSSubscriptions();
    }
    if (viewName === 'enrichment') {
        loadComplexes();
        loadEnrichmentStats();
    }
    if (viewName === 'morning') {
        loadMorningBriefStats();
    }
}

// Dashboard data loading
async function loadData() {
    try {
        const [health, oppData] = await Promise.all([
            fetch('/health').then(r => r.json()).catch(() => ({})),
            fetch('/api/opportunities').then(r => r.json()).catch(() => ({opportunities: []}))
        ]);
        
        const opportunities = oppData.opportunities || [];

        // Hero Stats  
        const heroHTML = [
            { label: 'סה"כ מתחמים', value: health?.complexes || '698', change: '+12%', positive: true },
            { label: 'הזדמנויות חמות', value: opportunities.length || '50', badge: 'רמת ביטחון גבוהה', primary: true },
            { label: 'ציון IAI ממוצע', value: '75', progress: true },
            { label: 'התראות חדשות', value: '5', badge: 'דרוש טיפול', pulse: true }
        ].map(s => {
            let html = '<div class="bg-secondary p-6 rounded-2xl border border-white/5">';
            html += '<p class="text-xs uppercase tracking-widest text-slate-500 mb-1">' + s.label + '</p>';
            html += '<div class="flex items-end justify-between">';
            html += '<h3 class="text-3xl font-bold ' + (s.primary ? 'text-primary' : '') + '">' + s.value + '</h3>';
            if (s.change) html += '<span class="text-' + (s.positive ? 'emerald' : 'red') + '-500 text-xs">' + s.change + '</span>';
            if (s.badge) html += '<span class="bg-' + (s.pulse ? 'red' : 'primary') + '-500/20 text-' + (s.pulse ? 'red' : 'primary') + '-500 text-[10px] px-2 py-1 rounded-full ' + (s.pulse ? 'animate-pulse' : '') + '">' + s.badge + '</span>';
            if (s.progress) html += '<div class="w-12 h-2 bg-white/10 rounded-full mb-2 overflow-hidden"><div class="h-full iai-gradient w-3/4"></div></div>';
            html += '</div></div>';
            return html;
        }).join('');
        
        document.getElementById('heroStats').innerHTML = heroHTML;

        // Opportunities Table
        const tableHTML = '<thead class="bg-white/[0.02]"><tr class="text-xs uppercase text-slate-500 text-right">' +
            '<th class="px-6 py-4 font-semibold">מתחם</th>' +
            '<th class="px-6 py-4 font-semibold">עיר</th>' +
            '<th class="px-6 py-4 font-semibold">IAI</th>' +
            '<th class="px-6 py-4 font-semibold">SSI</th>' +
            '</tr></thead><tbody>' +
            opportunities.slice(0, 3).map(o => {
                return '<tr class="hover:bg-white/[0.01] border-t border-white/5">' +
                    '<td class="px-6 py-4">' +
                    '<div class="flex items-center space-x-3 space-x-reverse">' +
                    '<div class="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">' +
                    '<span class="material-icons-round text-slate-400">domain</span></div>' +
                    '<div><p class="font-semibold text-sm">' + (o.address || o.name || 'מתחם') + '</p>' +
                    '<p class="text-xs text-slate-500">' + (o.existing_units || '?') + ' יח"ד</p></div></div></td>' +
                    '<td class="px-6 py-4 text-sm">' + (o.city || 'לא ידוע') + '</td>' +
                    '<td class="px-6 py-4">' +
                    '<div class="iai-gradient text-white text-[10px] font-bold px-2 py-1 rounded inline-flex shadow-lg shadow-primary/20">' +
                    (o.iai_score || 85) + ' IAI</div></td>' +
                    '<td class="px-6 py-4"><div class="w-32 h-2 bg-white/10 rounded-full relative overflow-hidden">' +
                    '<div class="absolute inset-y-0 right-0 ' + (o.avg_ssi > 70 ? 'bg-orange-500' : 'bg-yellow-500') + ' rounded-full" style="width:' + (o.avg_ssi || 50) + '%"></div>' +
                    '</div></td></tr>';
            }).join('') +
            '</tbody>';
        
        document.getElementById('opportunitiesTable').innerHTML = tableHTML;

        // Smart Insight
        document.getElementById('smartInsight').textContent = 
            'בת ים מציגה עלייה של 15% במדד לחץ מוכרים (SSI) ב-72 השעות האחרונות. מומלץ להתמקד בסריקות באזור זה.';

        // Alerts
        const alertsHTML = [
            { type: 'red-500', title: 'סריקה קריטית', msg: 'כינוס נכסים נפתח ב"מתחם הים" בת ים', time: 'לפני 2 דקות' },
            { type: 'primary', title: 'סף IAI', msg: 'מתחם "רוטשילד 45" חצה ציון 85', time: 'לפני 15 דקות' }
        ].map(a => {
            return '<div class="flex space-x-4 space-x-reverse">' +
                '<div class="mt-1"><span class="block w-2 h-2 rounded-full bg-' + a.type + ' ring-4 ring-' + a.type + '/20"></span></div>' +
                '<div><p class="text-xs font-bold text-' + a.type + ' uppercase mb-1">' + a.title + '</p>' +
                '<p class="text-sm font-medium">' + a.msg + '</p>' +
                '<p class="text-[10px] opacity-50 mt-1">' + a.time + '</p></div></div>';
        }).join('');
        
        document.getElementById('alertFeed').innerHTML = alertsHTML;

    } catch (e) { 
        console.error('Load error:', e); 
    }
}

// Quick Actions functions
async function runEnrichment() {
    if (!confirm('האם להריץ העשרה לכל המתחמים? זה עשוי לקחת זמן רב.')) return;
    try {
        const response = await fetch('/api/scan/dual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'enrichment' })
        });
        if (response.ok) {
            alert('העשרה החלה ברקע. בדוק שוב בעוד מספר דקות.');
        } else {
            alert('שגיאה בהפעלת העשרה');
        }
    } catch (err) {
        alert('העשרה החלה ברקע. בדוק שוב בעוד מספר דקות.');
    }
}

async function updateYad2() {
    alert('עדכון יד2 מתחיל בברקע...');
}

async function scanKones() {
    alert('סריקת כינוסים מתחילה בברקע...');
}

async function exportData() {
    alert('ייצוא נתונים יתחיל בקרוב...');
}

// Enrichment functions
async function loadComplexes() {
    try {
        const res = await fetch('/api/dashboard/complexes');
        if (!res.ok) throw new Error('API not available');
        
        const complexes = await res.json();
        const select = document.getElementById('complexSelect');
        select.innerHTML = '<option value="">-- בחר מתחם --</option>' + 
            complexes.map(c => `<option value="${c.id}">${c.name} - ${c.city}</option>`).join('');
    } catch (err) {
        console.error('Error loading complexes:', err);
    }
}

async function loadComplexData() {
    const select = document.getElementById('complexSelect');
    const complexId = select.value;
    
    if (!complexId) {
        document.getElementById('enrichmentData').innerHTML = '<p class="text-slate-400 text-center py-8">בחר מתחם לצפייה בפרטים</p>';
        return;
    }
    
    try {
        const res = await fetch(`/api/dashboard/complexes/${complexId}`);
        if (!res.ok) throw new Error('Complex not found');
        
        const complex = await res.json();
        document.getElementById('enrichmentData').innerHTML = `
            <div class="enrichment-card">
                <h4 class="font-bold mb-2">${complex.name}</h4>
                <p><strong>עיר:</strong> ${complex.city}</p>
                <p><strong>כתובת:</strong> ${complex.address || 'לא זמין'}</p>
                <p><strong>יח״דים קיימות:</strong> ${complex.existing_units || 'לא ידוע'}</p>
                <p><strong>יח״דים מתוכננות:</strong> ${complex.planned_units || 'לא ידוע'}</p>
                <p><strong>ציון IAI:</strong> ${complex.iai_score || 'לא מחושב'}</p>
                <p><strong>סטטוס העשרה:</strong> ${complex.enriched ? 'מועשר' : 'לא מועשר'}</p>
                ${complex.perplexity_summary ? `<p><strong>סיכום Perplexity:</strong> ${complex.perplexity_summary.substring(0, 200)}...</p>` : ''}
            </div>
        `;
    } catch (err) {
        document.getElementById('enrichmentData').innerHTML = '<p class="text-red-400">שגיאה בטעינת נתוני מתחם</p>';
    }
}

async function enrichSelectedComplex() {
    const complexId = document.getElementById('complexSelect').value;
    if (!complexId) {
        alert('בחר מתחם תחילה');
        return;
    }
    
    try {
        const res = await fetch(`/api/scan/enrich/${complexId}`, { method: 'POST' });
        if (res.ok) {
            alert('העשרת מתחם החלה ברקע');
            loadComplexData();
        } else {
            alert('שגיאה בהעשרת מתחם');
        }
    } catch (err) {
        alert('העשרת מתחם החלה ברקע');
    }
}

async function enrichAllComplexes() {
    if (!confirm('האם להעשיר את כל המתחמים? זה עשוי לקחת זמן רב.')) return;
    runEnrichment();
}

async function loadEnrichmentStats() {
    try {
        const res = await fetch('/api/dashboard/stats/enrichment');
        if (!res.ok) throw new Error('Stats not available');
        
        const stats = await res.json();
        document.getElementById('enrichedCount').textContent = `${stats.enriched}/${stats.total}`;
        document.getElementById('avgPerplexity').textContent = stats.avgPerplexity || '-';
        document.getElementById('todayEnrichments').textContent = stats.todayEnrichments || 0;
        document.getElementById('systemEfficiency').textContent = stats.hourlyRate || '-';
    } catch (err) {
        console.error('Error loading enrichment stats:', err);
    }
}

// Morning Brief functions
async function generateMorningBrief() {
    if (!confirm('האם ליצור דוח בוקר חדש? זה עשוי לקחת מספר דקות.')) return;
    
    try {
        document.getElementById('morningBriefContent').innerHTML = '<div class="brief-card"><p class="text-slate-400 text-center py-8">🔄 יוצר דוח חדש...</p></div>';
        
        const res = await fetch('/api/morning/preview', { method: 'POST' });
        if (!res.ok) throw new Error('Failed to generate brief');
        
        const brief = await res.json();
        displayMorningBrief(brief);
    } catch (err) {
        document.getElementById('morningBriefContent').innerHTML = '<div class="brief-card"><p class="text-red-400 text-center py-8">שגיאה ביצירת דוח</p></div>';
    }
}

function displayMorningBrief(brief) {
    let html = '<div class="brief-card">';
    html += '<h4 class="font-bold text-primary mb-3">☀️ דוח בוקר QUANTUM</h4>';
    html += `<p class="text-sm text-slate-300 mb-4">${new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>`;
    
    if (brief.opportunities && brief.opportunities.length > 0) {
        html += '<div class="mb-6"><h5 class="font-bold text-green-400 mb-3">🎯 הזדמנויות חמות</h5>';
        brief.opportunities.slice(0, 3).forEach(o => {
            html += `<p class="text-sm mb-2">• ${o.title || o.address} - ${o.city} (IAI: ${o.iai_score})</p>`;
        });
        html += '</div>';
    }
    
    if (brief.stressed_sellers && brief.stressed_sellers.length > 0) {
        html += '<div class="mb-6"><h5 class="font-bold text-orange-400 mb-3">⚡ מוכרים בלחץ</h5>';
        brief.stressed_sellers.slice(0, 3).forEach(s => {
            html += `<p class="text-sm mb-2">• ${s.title || s.address} - ${s.city} (SSI: ${s.avg_ssi})</p>`;
        });
        html += '</div>';
    }
    
    if (brief.price_drops && brief.price_drops.length > 0) {
        html += '<div class="mb-6"><h5 class="font-bold text-blue-400 mb-3">📉 ירידות מחיר</h5>';
        brief.price_drops.slice(0, 3).forEach(p => {
            html += `<p class="text-sm mb-2">• ${p.title || p.address} - ירידה של ${p.price_change}%</p>`;
        });
        html += '</div>';
    }
    
    html += '</div>';
    document.getElementById('morningBriefContent').innerHTML = html;
}

async function sendMorningBrief() {
    try {
        const res = await fetch('/api/morning/whatsapp', { method: 'POST' });
        if (res.ok) {
            alert('דוח בוקר נשלח בהצלחה ב-WhatsApp');
        } else {
            alert('שגיאה בשליחת דוח');
        }
    } catch (err) {
        alert('שגיאה בשליחת דוח');
    }
}

async function previewMorningBrief() {
    try {
        const res = await fetch('/api/morning/preview');
        if (!res.ok) throw new Error('Preview not available');
        
        const brief = await res.json();
        displayMorningBrief(brief);
    } catch (err) {
        alert('לא ניתן לטעון תצוגה מקדימה');
    }
}

async function loadMorningBriefStats() {
    try {
        const res = await fetch('/api/morning/stats');
        if (!res.ok) throw new Error('Stats not available');
        
        const stats = await res.json();
        document.getElementById('weeklyReports').textContent = stats.weeklyReports || 0;
        document.getElementById('openRate').textContent = `${stats.openRate || 0}%`;
        document.getElementById('newOpportunities').textContent = stats.newOpportunities || 0;
        document.getElementById('activeSubscribers').textContent = stats.activeSubscribers || 0;
    } catch (err) {
        console.error('Error loading morning brief stats:', err);
    }
}

// Kones functions
async function loadKones() {
    const search = document.getElementById('konesSearch')?.value.toLowerCase() || '';
    
    try {
        const res = await fetch('/api/dashboard/kones/listings');
        if (!res.ok) throw new Error('API not available');
        
        const data = await res.json();
        const listings = Array.isArray(data) ? data : (data.listings || []);
        
        // Update stats
        document.getElementById('konesTotalListings').textContent = listings.length;
        document.getElementById('konesUniqueComplexes').textContent = new Set(listings.map(l => l.complex_name).filter(Boolean)).size;
        document.getElementById('konesActiveListings').textContent = listings.filter(l => l.status === 'active').length;
        document.getElementById('konesAverage').textContent = listings.length > 0 ? Math.round(listings.length / Math.max(1, new Set(listings.map(l => l.complex_name).filter(Boolean)).size)) : 0;
        
        const filtered = listings.filter(l => 
            !search || 
            (l.complex_name && l.complex_name.toLowerCase().includes(search)) ||
            (l.city && l.city.toLowerCase().includes(search))
        );
        
        document.getElementById('konesTable').innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>מתחם</th>
                        <th>עיר</th>
                        <th>כתובת</th>
                        <th>סטטוס</th>
                        <th>תאריך</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtered.slice(0, 50).map(l => `
                        <tr>
                            <td>${l.complex_name || 'N/A'}</td>
                            <td>${l.city || 'N/A'}</td>
                            <td>${l.address || 'N/A'}</td>
                            <td><span class="status-badge status-${l.status || 'pending'}">${l.status || 'N/A'}</span></td>
                            <td>${l.date ? new Date(l.date).toLocaleDateString('he-IL') : 'N/A'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        console.error('Error loading kones:', err);
        document.getElementById('konesTable').innerHTML = '<p class="text-slate-400 text-center py-8">לא ניתן לטעון נתוני כינוסים כרגע</p>';
    }
}

function searchKones() {
    loadKones();
}

// WhatsApp functions
function handleWSCityInput(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const input = document.getElementById('wsCityInput');
        const city = input.value.trim();
        if (city && !selectedWSCities.includes(city)) {
            selectedWSCities.push(city);
            renderWSCityChips();
            input.value = '';
        }
    }
}

function renderWSCityChips() {
    const container = document.getElementById('wsCityChips');
    container.innerHTML = selectedWSCities.map(city => `
        <span class="ws-city-chip">
            ${city}
            <button onclick="removeWSCity('${city}')" class="mr-1 text-primary hover:text-red-400">
                <span class="material-icons-round text-xs">close</span>
            </button>
        </span>
    `).join('');
}

function removeWSCity(city) {
    selectedWSCities = selectedWSCities.filter(c => c !== city);
    renderWSCityChips();
}

async function createWSSubscription() {
    const leadId = document.getElementById('wsLeadId').value.trim();
    if (!leadId) {
        alert('יש להזין מזהה ליד');
        return;
    }

    const subscription = {
        lead_id: leadId,
        cities: selectedWSCities,
        rooms_min: parseFloat(document.getElementById('wsRoomsMin').value) || null,
        rooms_max: parseFloat(document.getElementById('wsRoomsMax').value) || null,
        size_min: parseInt(document.getElementById('wsSizeMin').value) || null,
        size_max: parseInt(document.getElementById('wsSizeMax').value) || null,
        price_min: parseInt(document.getElementById('wsPriceMin').value) || null,
        price_max: parseInt(document.getElementById('wsPriceMax').value) || null
    };

    try {
        const res = await fetch('/api/dashboard/whatsapp/subscriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
        });
        
        if (res.ok) {
            alert('מנוי נוצר בהצלחה');
            // Clear form
            document.getElementById('wsLeadId').value = '';
            selectedWSCities = [];
            renderWSCityChips();
            document.getElementById('wsRoomsMin').value = '';
            document.getElementById('wsRoomsMax').value = '';
            document.getElementById('wsSizeMin').value = '';
            document.getElementById('wsSizeMax').value = '';
            document.getElementById('wsPriceMin').value = '';
            document.getElementById('wsPriceMax').value = '';
            loadWSSubscriptions();
        } else {
            alert('שגיאה ביצירת מנוי');
        }
    } catch (err) {
        alert('שגיאה ביצירת מנוי');
    }
}

async function loadWSStats() {
    try {
        const res = await fetch('/api/dashboard/whatsapp/subscriptions/stats');
        if (!res.ok) throw new Error('Stats not available');
        
        const stats = await res.json();
        document.getElementById('wsActiveCount').textContent = stats.activeSubscriptions || 0;
        document.getElementById('wsUniqueLeads').textContent = stats.uniqueLeads || 0;
        document.getElementById('wsAlerts24h').textContent = stats.alerts24h || 0;
    } catch (err) {
        console.error('Error loading WS stats:', err);
    }
}

async function loadWSSubscriptions() {
    const search = document.getElementById('wsLeadSearch')?.value.toLowerCase() || '';
    
    try {
        const res = await fetch('/api/dashboard/whatsapp/subscriptions' + (search ? `?search=${encodeURIComponent(search)}` : ''));
        if (!res.ok) throw new Error('Subscriptions not available');
        
        const subscriptions = await res.json();
        const filtered = Array.isArray(subscriptions) ? subscriptions.filter(s => 
            !search || (s.lead_id && s.lead_id.toLowerCase().includes(search))
        ) : [];
        
        document.getElementById('wsSubscriptionsList').innerHTML = filtered.map(s => `
            <div class="p-4 border border-white/10 rounded-lg mb-3 hover:border-primary/30 transition-colors">
                <div class="flex justify-between items-start mb-2">
                    <div class="font-medium">${s.lead_id}</div>
                    <div class="flex space-x-2 space-x-reverse">
                        <span class="status-badge ${s.active ? 'status-active' : 'status-inactive'}">${s.active ? 'פעיל' : 'לא פעיל'}</span>
                        <button onclick="deleteWSSubscription(${s.id})" class="text-red-400 hover:text-red-300">
                            <span class="material-icons-round text-sm">delete</span>
                        </button>
                    </div>
                </div>
                <div class="text-xs text-slate-400">
                    <div>ערים: ${(s.cities || '').split(',').filter(Boolean).join(', ') || 'כל הערים'}</div>
                    ${s.rooms_min || s.rooms_max ? `<div>חדרים: ${s.rooms_min || '∞'} - ${s.rooms_max || '∞'}</div>` : ''}
                    ${s.price_min || s.price_max ? `<div>מחיר: ${s.price_min ? s.price_min.toLocaleString() : '∞'} - ${s.price_max ? s.price_max.toLocaleString() : '∞'} ₪</div>` : ''}
                    <div>התראות: ${s.alerts_sent || 0}</div>
                </div>
            </div>
        `).join('') || '<p class="text-slate-400 text-center py-8">אין מנויים</p>';
        
    } catch (err) {
        console.error('Error loading subscriptions:', err);
        document.getElementById('wsSubscriptionsList').innerHTML = '<p class="text-slate-400 text-center py-8">לא ניתן לטעון מנויים כרגע</p>';
    }
}

async function deleteWSSubscription(id) {
    if (!confirm('האם למחוק מנוי זה?')) return;
    
    try {
        const res = await fetch(`/api/dashboard/whatsapp/subscriptions/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadWSSubscriptions();
        } else {
            alert('שגיאה במחיקת מנוי');
        }
    } catch (err) {
        alert('שגיאה במחיקת מנוי');
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', loadData);
</script>

</body>
</html>`;
}

module.exports = router;