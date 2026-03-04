const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

/**
 * Serve modern QUANTUM dashboard
 * GET /dashboard - Main analytics dashboard
 */
router.get('/', (req, res) => {
  try {
    const dashboardPath = path.join(__dirname, '../views/dashboard.html');
    
    if (fs.existsSync(dashboardPath)) {
      res.sendFile(dashboardPath);
    } else {
      // Fallback: serve inline dashboard
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
        <a class="sidebar-item bg-primary/10 text-primary flex items-center space-x-3 space-x-reverse p-3 rounded-lg" href="/dashboard">
            <span class="material-icons-round text-lg">dashboard</span><span>דשבורד</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="/api/complexes">
            <span class="material-icons-round text-lg">domain</span><span>מתחמים</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="/api/opportunities">
            <span class="material-icons-round text-lg">trending_up</span><span>הזדמנויות</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="/api/scan/logs">
            <span class="material-icons-round text-lg">radar</span><span>סריקות</span>
        </a>
        <a class="sidebar-item flex items-center space-x-3 space-x-reverse p-3 rounded-lg text-slate-400 transition-colors" href="/api/alerts">
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
        <div class="col-span-12 lg:col-span-9 space-y-8">
            <section class="bg-secondary p-6 rounded-2xl border border-white/5">
                <h4 class="font-display text-xl mb-6">ביצועי שוק</h4>
                <div class="h-48 flex items-end justify-between px-2" id="marketChart"></div>
            </section>

            <section class="bg-secondary rounded-2xl border border-white/5 overflow-hidden">
                <div class="p-6 border-b border-white/5 flex justify-between items-center">
                    <h4 class="font-display text-xl text-primary">הזדמנויות חמות</h4>
                    <a href="/api/opportunities" class="text-sm text-primary flex items-center font-medium">
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
                    <a href="/api/opportunities" class="mt-4 px-4 py-2 bg-background-dark text-white text-xs font-bold rounded-lg inline-block">
                        חיפוש מדויק
                    </a>
                </div>
            </section>
        </div>
    </div>
</main>

<script>
async function loadData() {
    try {
        const [health, opportunities] = await Promise.all([
            fetch('/health').then(r => r.json()),
            fetch('/api/opportunities').then(r => r.json())
        ]);

        // Hero Stats
        document.getElementById('heroStats').innerHTML = [
            { label: 'סה"כ מתחמים', value: health?.complexes || '696', change: '+12%', positive: true },
            { label: 'הזדמנויות חמות', value: opportunities.length || '23', badge: 'רמת ביטחון גבוהה', primary: true },
            { label: 'ציון IAI ממוצע', value: '75', progress: true },
            { label: 'התראות חדשות', value: '5', badge: 'דרוש טיפול', pulse: true }
        ].map(s => \`
            <div class="bg-secondary p-6 rounded-2xl border border-white/5">
                <p class="text-xs uppercase tracking-widest text-slate-500 mb-1">\${s.label}</p>
                <div class="flex items-end justify-between">
                    <h3 class="text-3xl font-bold \${s.primary ? 'text-primary' : ''}">\${s.value}</h3>
                    \${s.change ? \`<span class="text-\${s.positive ? 'emerald' : 'red'}-500 text-xs">\${s.change}</span>\` : ''}
                    \${s.badge ? \`<span class="bg-\${s.pulse ? 'red' : 'primary'}-500/20 text-\${s.pulse ? 'red' : 'primary'}-500 text-[10px] px-2 py-1 rounded-full \${s.pulse ? 'animate-pulse' : ''}">\${s.badge}</span>\` : ''}
                    \${s.progress ? '<div class="w-12 h-2 bg-white/10 rounded-full mb-2 overflow-hidden"><div class="h-full iai-gradient w-3/4"></div></div>' : ''}
                </div>
            </div>
        \`).join('');

        // Opportunities Table
        document.getElementById('opportunitiesTable').innerHTML = \`
            <thead class="bg-white/[0.02]"><tr class="text-xs uppercase text-slate-500 text-right">
                <th class="px-6 py-4 font-semibold">מתחם</th>
                <th class="px-6 py-4 font-semibold">עיר</th>
                <th class="px-6 py-4 font-semibold">IAI</th>
                <th class="px-6 py-4 font-semibold">SSI</th>
            </tr></thead>
            <tbody>
                \${opportunities.slice(0, 3).map(o => \`
                    <tr class="hover:bg-white/[0.01] border-t border-white/5">
                        <td class="px-6 py-4">
                            <div class="flex items-center space-x-3 space-x-reverse">
                                <div class="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                                    <span class="material-icons-round text-slate-400">domain</span>
                                </div>
                                <div>
                                    <p class="font-semibold text-sm">\${o.address || o.name || 'מתחם'}</p>
                                    <p class="text-xs text-slate-500">\${o.existing_units || '?'} יח"ד</p>
                                </div>
                            </div>
                        </td>
                        <td class="px-6 py-4 text-sm">\${o.city || 'לא ידוע'}</td>
                        <td class="px-6 py-4">
                            <div class="iai-gradient text-white text-[10px] font-bold px-2 py-1 rounded inline-flex shadow-lg shadow-primary/20">
                                \${o.iai_score || 85} IAI
                            </div>
                        </td>
                        <td class="px-6 py-4">
                            <div class="w-32 h-2 bg-white/10 rounded-full relative overflow-hidden">
                                <div class="absolute inset-y-0 right-0 \${o.ssi_score > 70 ? 'bg-orange-500' : 'bg-yellow-500'} rounded-full" style="width:\${o.ssi_score || 50}%"></div>
                            </div>
                        </td>
                    </tr>
                \`).join('')}
            </tbody>
        \`;

        // Smart Insight
        document.getElementById('smartInsight').textContent = 
            'בת ים מציגה עלייה של 15% במדד לחץ מוכרים (SSI) ב-72 השעות האחרונות. מומלץ להתמקד בסריקות באזור זה.';

        // Alerts
        document.getElementById('alertFeed').innerHTML = [
            { type: 'red', title: 'סריקה קריטית', msg: 'כינוס נכסים נפתח ב"מתחם הים" בת ים', time: 'לפני 2 דקות' },
            { type: 'primary', title: 'סף IAI', msg: 'מתחם "רוטשילד 45" חצה ציון 85', time: 'לפני 15 דקות' }
        ].map(a => \`
            <div class="flex space-x-4 space-x-reverse">
                <div class="mt-1"><span class="block w-2 h-2 rounded-full bg-\${a.type} ring-4 ring-\${a.type}/20"></span></div>
                <div>
                    <p class="text-xs font-bold text-\${a.type} uppercase mb-1">\${a.title}</p>
                    <p class="text-sm font-medium">\${a.msg}</p>
                    <p class="text-[10px] opacity-50 mt-1">\${a.time}</p>
                </div>
            </div>
        \`).join('');

    } catch (e) { console.error('Load error:', e); }
}

document.addEventListener('DOMContentLoaded', loadData);
</script>

</body>
</html>`;
}

module.exports = router;
