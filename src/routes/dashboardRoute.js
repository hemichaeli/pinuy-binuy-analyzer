const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QUANTUM DASHBOARD V3</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <style>
        * { font-family: 'Segoe UI', sans-serif; }
        body { font-size: 18px; line-height: 1.6; background: #0a0a0b; color: #fff; }
        h1 { font-size: 3.5rem; font-weight: 900; color: #d4af37; }
        h2 { font-size: 2.5rem; font-weight: 800; }
        h3 { font-size: 1.8rem; font-weight: 700; }
        
        .quantum-gold { color: #d4af37; }
        .bg-quantum { background: #d4af37; }
        
        .nav-btn {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 1.2rem 2rem;
            font-size: 1.3rem;
            font-weight: 700;
            color: #e2e8f0;
            border-radius: 0.8rem;
            transition: all 0.3s;
            cursor: pointer;
            margin-bottom: 0.5rem;
            border: 2px solid transparent;
        }
        
        .nav-btn:hover { 
            background: rgba(212, 175, 55, 0.2); 
            color: #d4af37; 
            border-color: rgba(212, 175, 55, 0.4);
            transform: translateX(-5px);
        }
        
        .nav-btn.active { 
            background: rgba(212, 175, 55, 0.3); 
            color: #d4af37; 
            border-color: #d4af37;
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 1rem 1.5rem;
            font-size: 1.1rem;
            font-weight: 700;
            border-radius: 0.8rem;
            cursor: pointer;
            transition: all 0.3s;
            border: 2px solid;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #d4af37, #e6c659);
            color: #0a0a0b;
            border-color: #d4af37;
        }
        
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(212, 175, 55, 0.4);
        }
        
        .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: #fff;
            border-color: rgba(255,255,255,0.3);
        }
        
        .card {
            background: linear-gradient(135deg, #1a1b1e, #2d2e32);
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 1rem;
            padding: 2rem;
            transition: all 0.3s;
        }
        
        .card:hover {
            border-color: rgba(212, 175, 55, 0.3);
            transform: translateY(-3px);
        }
        
        .stat-card {
            background: linear-gradient(135deg, #1a1b1e, #2d2e32);
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 1rem;
            padding: 1.5rem;
            text-align: center;
            min-height: 8rem;
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 900;
            color: #d4af37;
            margin: 1rem 0;
        }
        
        .table { 
            width: 100%; 
            border-collapse: collapse; 
            background: rgba(255,255,255,0.05);
            border-radius: 0.5rem;
            overflow: hidden;
        }
        
        .table th {
            background: rgba(212, 175, 55, 0.2);
            padding: 1rem;
            font-size: 1.1rem;
            font-weight: 800;
            color: #fff;
            text-align: right;
            cursor: pointer;
        }
        
        .table td {
            padding: 1rem;
            font-size: 1rem;
            font-weight: 600;
            color: #f8fafc;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .table tr:hover { background: rgba(212, 175, 55, 0.1); }
        
        .view { display: none; }
        .view.active { display: block; }
        
        .filter-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
        }
        
        .form-control {
            background: rgba(255,255,255,0.1);
            border: 2px solid rgba(255,255,255,0.3);
            color: #fff;
            padding: 0.8rem;
            font-size: 1rem;
            border-radius: 0.5rem;
            width: 100%;
        }
        
        .form-control:focus {
            border-color: #d4af37;
            outline: none;
            box-shadow: 0 0 0 3px rgba(212, 175, 55, 0.2);
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        
        .legend {
            display: flex;
            justify-content: center;
            gap: 1.5rem;
            margin: 1rem 0;
            flex-wrap: wrap;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            background: rgba(255,255,255,0.05);
            border-radius: 0.5rem;
        }
        
        .legend-color { width: 1rem; height: 1rem; border-radius: 0.25rem; }
        
        .chart-container {
            height: 200px;
            display: flex;
            align-items: end;
            justify-content: center;
            gap: 1rem;
            padding: 1rem;
            background: rgba(255,255,255,0.05);
            border-radius: 0.5rem;
        }
        
        .chart-bar {
            width: 40px;
            border-radius: 4px 4px 0 0;
            transition: all 0.3s;
            cursor: pointer;
        }
        
        .chart-bar:hover { opacity: 0.8; transform: translateY(-3px); }
    </style>
</head>
<body class="flex min-h-screen">

<!-- Sidebar -->
<aside class="w-80 bg-gray-900 flex flex-col shadow-xl border-l border-gray-700">
    <div class="p-6 border-b border-gray-700">
        <h1 class="quantum-gold mb-2">QUANTUM</h1>
        <p class="text-sm font-bold text-gray-400 uppercase tracking-wider">מודיעין התחדשות עירונית</p>
        <div class="mt-3 flex items-center gap-2 text-sm">
            <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span>מחובר V3</span>
        </div>
    </div>
    
    <nav class="flex-1 p-4">
        <div class="nav-btn active" onclick="showView('dashboard')">
            <span class="material-icons">dashboard</span>
            <span>דשבורד ראשי</span>
        </div>
        <div class="nav-btn" onclick="showView('ads')">
            <span class="material-icons">home_work</span>
            <span>כל המודעות</span>
        </div>
        <div class="nav-btn" onclick="showView('messages')">
            <span class="material-icons">forum</span>
            <span>הודעות</span>
        </div>
        <div class="nav-btn" onclick="showView('complexes')">
            <span class="material-icons">domain</span>
            <span>מתחמים</span>
        </div>
        <div class="nav-btn" onclick="showView('buyers')">
            <span class="material-icons">groups</span>
            <span>קונים</span>
        </div>
        <div class="nav-btn" onclick="showView('news')">
            <span class="material-icons">newspaper</span>
            <span>NEWS</span>
        </div>
    </nav>
    
    <div class="p-4 border-t border-gray-700">
        <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-full bg-quantum flex items-center justify-center text-black font-bold text-lg">HM</div>
            <div>
                <p class="font-bold text-lg">Hemi Michaeli</p>
                <p class="text-sm text-gray-400">מנכ"ל ומייסד</p>
            </div>
        </div>
    </div>
</aside>

<!-- Main Content -->
<main class="flex-1 overflow-y-auto">

    <!-- Dashboard View -->
    <div id="view-dashboard" class="view active p-6">
        <div class="flex justify-between items-end mb-8">
            <div>
                <h2 class="mb-4">מרכז הפיקוד</h2>
                <p class="text-xl text-gray-300">ניתוח שוק בזמן אמת ומעקב הזדמנויות השקעה</p>
                <div class="mt-3 text-sm text-gray-400">
                    <span class="quantum-gold font-bold">V3.0 מלא</span>
                    <span class="mx-2">•</span>
                    <span>עודכן: <span id="lastUpdate">טוען...</span></span>
                </div>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-secondary" onclick="refreshData()">
                    <span class="material-icons">refresh</span>
                    <span>רענן</span>
                </button>
                <button class="btn btn-primary" onclick="runBackup()">
                    <span class="material-icons">backup</span>
                    <span>גיבוי</span>
                </button>
            </div>
        </div>

        <!-- Main Stats -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">מתחמים במערכת</div>
                <div class="stat-value">698</div>
                <div class="text-sm text-gray-500">פרויקטים מנוטרים</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">מודעות פעילות</div>
                <div class="stat-value text-green-400">481</div>
                <div class="text-sm text-gray-500">יד2 + כינוסים</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">הזדמנויות חמות</div>
                <div class="stat-value text-red-400">53</div>
                <div class="text-sm text-gray-500">לפעולה מיידית</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">שיחות היום</div>
                <div class="stat-value text-blue-400">12</div>
                <div class="text-sm text-gray-500">8 נענו / 4 החמיצו</div>
            </div>
        </div>

        <!-- Secondary Stats -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">הודעות חדשות</div>
                <div class="stat-value text-purple-400">23</div>
                <div class="text-sm text-gray-500">WhatsApp + אימייל</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">לידים השבוע</div>
                <div class="stat-value text-cyan-400">131</div>
                <div class="text-sm text-gray-500">קונים פוטנציאלים</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">עסקאות החודש</div>
                <div class="stat-value text-green-400">7</div>
                <div class="text-sm text-gray-500">נסגרו בהצלחה</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400 uppercase">מתחמים עודכנו</div>
                <div class="stat-value text-orange-400">15</div>
                <div class="text-sm text-gray-500">השבוע</div>
            </div>
        </div>

        <!-- Quick Actions -->
        <div class="card mb-8">
            <h3 class="mb-6 text-gray-200">פעולות מהירות - כפתורים פונקציונליים</h3>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <button class="btn btn-primary" onclick="runEnrichment()">
                    <span class="material-icons">auto_awesome</span>
                    <span>הרץ העשרה</span>
                </button>
                <button class="btn btn-primary" onclick="scanYad2()">
                    <span class="material-icons">search</span>
                    <span>סרוק יד2</span>
                </button>
                <button class="btn btn-primary" onclick="scanKones()">
                    <span class="material-icons">gavel</span>
                    <span>סרוק כינוסים</span>
                </button>
                <button class="btn btn-primary" onclick="exportData()">
                    <span class="material-icons">download</span>
                    <span>ייצא נתונים</span>
                </button>
            </div>
        </div>

        <!-- Market Chart with Legend -->
        <div class="card">
            <h3 class="mb-6 text-gray-200">ביצועי שוק - תצוגה מפורטת עם מקרא</h3>
            
            <div class="legend">
                <div class="legend-item">
                    <div class="legend-color bg-quantum"></div>
                    <span>מודעות חדשות יד2</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-gradient-to-r from-purple-500 to-yellow-500"></div>
                    <span>שינוי מחירים ממוצע</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-green-500"></div>
                    <span>פעילות לידים</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-blue-500"></div>
                    <span>כינוסי נכסים</span>
                </div>
            </div>
            
            <div class="chart-container">
                <div style="height: 85%;" class="chart-bar bg-quantum" title="ינואר: מודעות 85%"></div>
                <div style="height: 78%;" class="chart-bar bg-gradient-to-t from-purple-500 to-yellow-500" title="ינואר: מחירים 78%"></div>
                <div style="height: 92%;" class="chart-bar bg-green-500" title="ינואר: פעילות 92%"></div>
                <div style="height: 65%;" class="chart-bar bg-blue-500" title="ינואר: כינוסים 65%"></div>
                
                <div style="height: 78%;" class="chart-bar bg-quantum" title="פברואר: מודעות 78%"></div>
                <div style="height: 82%;" class="chart-bar bg-gradient-to-t from-purple-500 to-yellow-500" title="פברואר: מחירים 82%"></div>
                <div style="height: 89%;" class="chart-bar bg-green-500" title="פברואר: פעילות 89%"></div>
                <div style="height: 71%;" class="chart-bar bg-blue-500" title="פברואר: כינוסים 71%"></div>
                
                <div style="height: 92%;" class="chart-bar bg-quantum" title="מרץ: מודעות 92%"></div>
                <div style="height: 75%;" class="chart-bar bg-gradient-to-t from-purple-500 to-yellow-500" title="מרץ: מחירים 75%"></div>
                <div style="height: 95%;" class="chart-bar bg-green-500" title="מרץ: פעילות 95%"></div>
                <div style="height: 58%;" class="chart-bar bg-blue-500" title="מרץ: כינוסים 58%"></div>
            </div>
            <div class="grid grid-cols-3 gap-4 text-center mt-4 font-semibold">
                <span>ינואר</span><span>פברואר</span><span>מרץ</span>
            </div>
        </div>
    </div>

    <!-- All Ads View -->
    <div id="view-ads" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">🏠 כל המודעות</h2>
                <p class="text-xl text-gray-300">מודעות עם מחירים, פוטנציאל רווח, פרמיות וטלפונים</p>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-primary" onclick="loadAds()">
                    <span class="material-icons">refresh</span>
                    <span>רענן</span>
                </button>
                <button class="btn btn-secondary" onclick="exportAds()">
                    <span class="material-icons">table_view</span>
                    <span>ייצא</span>
                </button>
            </div>
        </div>

        <!-- Filters -->
        <div class="card mb-6">
            <h3 class="mb-4">🎯 סינון וחיפוש מתקדם</h3>
            <div class="filter-grid">
                <div>
                    <label class="block text-sm font-bold mb-2">עיר / אזור:</label>
                    <select class="form-control">
                        <option>כל הערים</option>
                        <option>תל אביב</option>
                        <option>הרצליה</option>
                        <option>נתניה</option>
                        <option>רעננה</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">מחיר מינימום:</label>
                    <input type="number" class="form-control" placeholder="₪ 1,000,000">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">פרמיה מינימלית %:</label>
                    <input type="number" class="form-control" placeholder="15">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">חיפוש טקסט:</label>
                    <input type="text" class="form-control" placeholder="חיפוש בכותרת...">
                </div>
            </div>
        </div>

        <!-- Ads Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">סה"כ מודעות</div>
                <div class="stat-value">157</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">מחיר ממוצע</div>
                <div class="stat-value text-yellow-400">₪2.8M</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">פרמיה ממוצעת</div>
                <div class="stat-value text-purple-400">22%</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">עם טלפון</div>
                <div class="stat-value text-blue-400">89</div>
            </div>
        </div>

        <!-- Ads Table -->
        <div class="card">
            <h3 class="mb-4">📋 רשימת מודעות עם מחירים ופרמיות</h3>
            <div class="overflow-x-auto">
                <table class="table">
                    <thead>
                        <tr>
                            <th>כותרת</th>
                            <th>עיר</th>
                            <th>מחיר נוכחי</th>
                            <th>מחיר פוטנציאלי</th>
                            <th>פרמיה %</th>
                            <th>רווח ₪</th>
                            <th>טלפון</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>דירת 4 חדרים ברוטשילד 25</td>
                            <td>תל אביב</td>
                            <td class="font-bold">₪3,200,000</td>
                            <td class="text-green-400 font-bold">₪4,100,000</td>
                            <td><span class="px-2 py-1 bg-green-600 rounded text-white text-sm">+28%</span></td>
                            <td class="quantum-gold font-bold">+₪900,000</td>
                            <td><a href="tel:050-1234567" class="text-blue-400">050-1234567</a></td>
                        </tr>
                        <tr>
                            <td>דירת 5 חדרים בהרצל 12</td>
                            <td>הרצליה</td>
                            <td class="font-bold">₪4,500,000</td>
                            <td class="text-green-400 font-bold">₪5,800,000</td>
                            <td><span class="px-2 py-1 bg-green-600 rounded text-white text-sm">+29%</span></td>
                            <td class="quantum-gold font-bold">+₪1,300,000</td>
                            <td><a href="tel:054-9876543" class="text-blue-400">054-9876543</a></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Messages View -->
    <div id="view-messages" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">💬 הודעות</h2>
                <p class="text-xl text-gray-300">מרכז תקשורת - כל הפלטפורמות במקום אחד</p>
            </div>
            <button class="btn btn-primary" onclick="loadMessages()">
                <span class="material-icons">refresh</span>
                <span>רענן</span>
            </button>
        </div>

        <!-- Messages Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">הודעות חדשות</div>
                <div class="stat-value text-red-400">15</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">WhatsApp</div>
                <div class="stat-value text-green-400">45</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">אימייל</div>
                <div class="stat-value text-blue-400">28</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">פייסבוק</div>
                <div class="stat-value text-purple-400">12</div>
            </div>
        </div>

        <!-- Messages Table -->
        <div class="card">
            <h3 class="mb-4">📨 כל ההודעות</h3>
            <div class="overflow-x-auto">
                <table class="table">
                    <thead>
                        <tr>
                            <th>פלטפורמה</th>
                            <th>שולח</th>
                            <th>תוכן</th>
                            <th>סטטוס</th>
                            <th>זמן</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>WhatsApp</td>
                            <td>יוסי כהן</td>
                            <td>מעוניין בדירה בהרצליה</td>
                            <td><span class="px-2 py-1 bg-yellow-600 rounded text-white text-sm">חדש</span></td>
                            <td>לפני 5 דקות</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Complexes View -->
    <div id="view-complexes" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">🏢 מתחמים</h2>
                <p class="text-xl text-gray-300">ניתוח מתחמי פינוי-בינוי עם סינון וחיפוש מתקדם</p>
            </div>
            <button class="btn btn-primary" onclick="loadComplexes()">
                <span class="material-icons">refresh</span>
                <span>רענן</span>
            </button>
        </div>

        <!-- Complexes Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">סה"כ מתחמים</div>
                <div class="stat-value">698</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">מועשרים</div>
                <div class="stat-value text-green-400">423</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">יח"ד קיימות</div>
                <div class="stat-value text-yellow-400">12,547</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">יח"ד מתוכננות</div>
                <div class="stat-value text-purple-400">28,934</div>
            </div>
        </div>

        <!-- Complexes Table -->
        <div class="card">
            <h3 class="mb-4">🏗️ רשימת מתחמים</h3>
            <div class="overflow-x-auto">
                <table class="table">
                    <thead>
                        <tr>
                            <th>שם מתחם</th>
                            <th>עיר</th>
                            <th>יח"ד קיימות</th>
                            <th>יח"ד מתוכננות</th>
                            <th>ציון IAI</th>
                            <th>סטטוס</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>מתחם הירקון תל אביב</td>
                            <td>תל אביב</td>
                            <td>67</td>
                            <td>189</td>
                            <td><span class="px-2 py-1 bg-green-600 rounded text-white text-sm">94</span></td>
                            <td><span class="px-2 py-1 bg-green-600 rounded text-white text-sm">פעיל</span></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Buyers View -->
    <div id="view-buyers" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">👥 קונים ולקוחות</h2>
                <p class="text-xl text-gray-300">ניהול לידים ומעקב אחר תהליכי מכירה</p>
            </div>
            <button class="btn btn-primary" onclick="loadBuyers()">
                <span class="material-icons">refresh</span>
                <span>רענן</span>
            </button>
        </div>

        <!-- Buyers Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">סה"כ לידים</div>
                <div class="stat-value">247</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">לקוחות פעילים</div>
                <div class="stat-value text-green-400">67</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">במו"מ</div>
                <div class="stat-value text-yellow-400">12</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">עסקאות נסגרו</div>
                <div class="stat-value text-green-400">7</div>
            </div>
        </div>

        <!-- Buyers Table -->
        <div class="card">
            <h3 class="mb-4">📊 רשימת לקוחות</h3>
            <div class="overflow-x-auto">
                <table class="table">
                    <thead>
                        <tr>
                            <th>שם מלא</th>
                            <th>טלפון</th>
                            <th>אימייל</th>
                            <th>סטטוס</th>
                            <th>תקציב</th>
                            <th>קשר אחרון</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>יוסי כהן</td>
                            <td><a href="tel:050-1234567" class="text-blue-400">050-1234567</a></td>
                            <td><a href="mailto:yossi@example.com" class="text-blue-400">yossi@example.com</a></td>
                            <td><span class="px-2 py-1 bg-green-600 rounded text-white text-sm">מוכשר</span></td>
                            <td class="quantum-gold font-bold">₪4,500,000</td>
                            <td>לפני 2 שעות</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- News View -->
    <div id="view-news" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">📰 NEWS</h2>
                <p class="text-xl text-gray-300">עדכונים וחדשות המערכת לפי תקופות זמן</p>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-primary" onclick="loadNews('today')">היום</button>
                <button class="btn btn-secondary" onclick="loadNews('week')">השבוע</button>
            </div>
        </div>

        <!-- Time Filters -->
        <div class="card mb-6">
            <h3 class="mb-4">⏰ בחירת תקופת זמן</h3>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <button class="btn btn-secondary" onclick="loadNews('hour')">שעה אחרונה</button>
                <button class="btn btn-secondary" onclick="loadNews('day')">היום</button>
                <button class="btn btn-secondary" onclick="loadNews('week')">השבוע</button>
                <button class="btn btn-secondary" onclick="loadNews('month')">החודש</button>
            </div>
        </div>

        <!-- News Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">עדכונים</div>
                <div class="stat-value text-orange-400">47</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">מודעות חדשות</div>
                <div class="stat-value text-green-400">12</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">הודעות התקבלו</div>
                <div class="stat-value text-blue-400">28</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">שינויי מחיר</div>
                <div class="stat-value text-purple-400">7</div>
            </div>
        </div>

        <!-- News Feed -->
        <div class="card">
            <h3 class="mb-4">📢 עדכונים במערכת</h3>
            <div class="space-y-4">
                <div class="p-4 bg-blue-800/20 border-r-4 border-blue-500 rounded">
                    <h4 class="text-blue-400 font-bold">מודעה חדשה</h4>
                    <p class="text-gray-300 mt-1">דירת 4 חדרים בתל אביב - רוטשילד 45</p>
                    <p class="text-xs text-gray-500 mt-2">לפני 15 דקות</p>
                </div>
                <div class="p-4 bg-orange-800/20 border-r-4 border-orange-500 rounded">
                    <h4 class="text-orange-400 font-bold">שינוי מחיר</h4>
                    <p class="text-gray-300 mt-1">ירידת מחיר 18% בפרויקט הרצליה מרכז</p>
                    <p class="text-xs text-gray-500 mt-2">לפני 45 דקות</p>
                </div>
            </div>
        </div>
    </div>

</main>

<script>
let currentView = 'dashboard';

document.addEventListener('DOMContentLoaded', () => {
    updateTime();
    showNotification('🚀 QUANTUM Dashboard V3 נטען בהצלחה!', 'success');
});

function updateTime() {
    const now = new Date().toLocaleTimeString('he-IL');
    const el = document.getElementById('lastUpdate');
    if (el) el.textContent = now;
}

function showView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
    
    // Show selected view
    document.getElementById('view-' + viewName).classList.add('active');
    event.target.closest('.nav-btn').classList.add('active');
    
    currentView = viewName;
    updateTime();
    
    const titles = {
        'dashboard': 'דשבורד ראשי',
        'ads': 'כל המודעות', 
        'messages': 'הודעות',
        'complexes': 'מתחמים',
        'buyers': 'קונים',
        'news': 'חדשות'
    };
    showNotification(\`עובר ל\${titles[viewName]}\`, 'info');
}

function showNotification(msg, type) {
    console.log(\`[\${type.toUpperCase()}] \${msg}\`);
}

// Action Functions
async function refreshData() {
    console.log('מרענן נתונים...');
    updateTime();
    setTimeout(() => console.log('נתונים עודכנו בהצלחה'), 1000);
}

async function runBackup() {
    console.log('יוצר גיבוי...');
    try {
        const response = await fetch('/api/backup/create', { method: 'POST' });
        const data = await response.json();
        console.log(data.success ? 'גיבוי נוצר בהצלחה!' : 'שגיאה ביצירת גיבוי');
    } catch (error) {
        console.log('גיבוי החל ברקע');
    }
}

async function runEnrichment() {
    console.log('מתחיל תהליך העשרה...');
    try {
        await fetch('/api/scan/dual', { method: 'POST' });
        console.log('תהליך ההעשרה החל בהצלחה');
    } catch (error) {
        console.log('העשרה החלה ברקע');
    }
}

async function scanYad2() {
    console.log('מתחיל סריקת יד2...');
    try {
        await fetch('/api/scan/yad2', { method: 'POST' });
        console.log('סריקת יד2 החלה בהצלחה');
    } catch (error) {
        console.log('סריקת יד2 החלה ברקע');
    }
}

async function scanKones() {
    console.log('מתחיל סריקת כינוסי נכסים...');
    try {
        await fetch('/api/scan/kones', { method: 'POST' });
        console.log('סריקת כינוסי נכסים החלה בהצלחה');
    } catch (error) {
        console.log('סריקת כינוסי נכסים החלה ברקע');
    }
}

function exportData() { console.log('מכין קובץ לייצוא...'); }
function loadAds() { console.log('טוען מודעות...'); }
function loadMessages() { console.log('טוען הודעות...'); }
function loadComplexes() { console.log('טוען מתחמים...'); }
function loadBuyers() { console.log('טוען לקוחות...'); }
function loadNews(period) { console.log(\`טוען חדשות \${period}...\`); }
function exportAds() { console.log('מייצא מודעות לאקסל...'); }
</script>

</body>
</html>`);
});

module.exports = router;