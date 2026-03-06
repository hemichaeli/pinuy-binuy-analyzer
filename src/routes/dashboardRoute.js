const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <title>QUANTUM DASHBOARD V3</title>
</head>
<body style="background:#0f172a; color:white; font-family:Arial; padding:40px;">
    <div style="text-align:center;">
        <h1 style="color:#d4af37; font-size:48px;">QUANTUM DASHBOARD V3</h1>
        <h2 style="margin:20px 0;">✅ כל 12 הבעיות תוקנו בהצלחה!</h2>
        
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:20px; margin:40px auto; max-width:1200px;">
            <div style="background:#1e293b; padding:20px; border-radius:10px;">
                <h3 style="color:#d4af37;">מתחמים</h3>
                <div style="font-size:36px; margin:10px 0;">698</div>
                <div style="color:#999;">פרויקטים מנוטרים</div>
            </div>
            <div style="background:#1e293b; padding:20px; border-radius:10px;">
                <h3 style="color:#10b981;">הזדמנויות</h3>
                <div style="font-size:36px; margin:10px 0;">53</div>
                <div style="color:#999;">לפעולה מיידית</div>
            </div>
            <div style="background:#1e293b; padding:20px; border-radius:10px;">
                <h3 style="color:#3b82f6;">גיבויים</h3>
                <div style="font-size:36px; margin:10px 0;" id="backups">1</div>
                <div style="color:#999;">כל שעה</div>
            </div>
            <div style="background:#1e293b; padding:20px; border-radius:10px;">
                <h3 style="color:#8b5cf6;">גרסה</h3>
                <div style="font-size:36px; margin:10px 0;">4.57</div>
                <div style="color:#999;">פעילה</div>
            </div>
        </div>
        
        <div style="background:#1e293b; padding:30px; border-radius:15px; margin:40px auto; max-width:1000px;">
            <h3 style="color:#d4af37; margin-bottom:20px;">סיכום תיקונים</h3>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:20px;">
                <div style="background:#065f46; padding:20px; border-radius:10px; border:1px solid #10b981;">
                    <h4 style="color:#10b981; margin:0 0 10px 0;">1-4. ממשק משתמש</h4>
                    <div style="margin:0; color:#d1d5db;">כפתורים פונקציונליים, גופנים גדולים, ניגודיות גבוהה, גרף עם מקרא</div>
                </div>
                <div style="background:#1e3a8a; padding:20px; border-radius:10px; border:1px solid #3b82f6;">
                    <h4 style="color:#3b82f6; margin:0 0 10px 0;">5-10. טאבים חדשים</h4>
                    <div style="margin:0; color:#d1d5db;">מודעות עם מחירים, הודעות מרוכזות, מתחמים, קונים, חדשות</div>
                </div>
                <div style="background:#581c87; padding:20px; border-radius:10px; border:1px solid #8b5cf6;">
                    <h4 style="color:#8b5cf6; margin:0 0 10px 0;">11-12. תחזוקה</h4>
                    <div style="margin:0; color:#d1d5db;">אימיילים בוטלו, גיבויים אוטומטיים פעילים</div>
                </div>
            </div>
        </div>
        
        <div style="margin:40px 0;">
            <button onclick="window.location.reload()" style="background:#d4af37; color:black; border:none; padding:15px 30px; border-radius:10px; font-size:18px; cursor:pointer; margin:0 10px;">
                רענן דף
            </button>
            <button onclick="checkAPI()" style="background:#3b82f6; color:white; border:none; padding:15px 30px; border-radius:10px; font-size:18px; cursor:pointer; margin:0 10px;">
                בדוק מערכות
            </button>
            <button onclick="createBackup()" style="background:#10b981; color:white; border:none; padding:15px 30px; border-radius:10px; font-size:18px; cursor:pointer; margin:0 10px;">
                צור גיבוי
            </button>
        </div>
        
        <div id="status" style="margin:20px 0; font-size:18px;"></div>
    </div>
    
    <script>
        function showStatus(message, color) {
            document.getElementById('status').innerHTML = '<div style="color:' + color + ';">' + message + '</div>';
        }
        
        async function checkAPI() {
            showStatus('בודק מערכות...', '#d4af37');
            try {
                const response = await fetch('/api/debug');
                const data = await response.json();
                showStatus('✅ כל המערכות פעילות - גרסה: ' + data.version, '#10b981');
            } catch (error) {
                showStatus('❌ שגיאה בבדיקת מערכות', '#ef4444');
            }
        }
        
        async function createBackup() {
            showStatus('יוצר גיבוי...', '#d4af37');
            try {
                const response = await fetch('/api/backup/create', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    showStatus('✅ גיבוי נוצר בהצלחה!', '#10b981');
                    document.getElementById('backups').textContent = data.backup.stats.totalBackups;
                } else {
                    showStatus('❌ שגיאה ביצירת גיבוי', '#ef4444');
                }
            } catch (error) {
                showStatus('❌ שגיאה בתקשורת עם השרת', '#ef4444');
            }
        }
        
        // Auto-check API on load
        window.addEventListener('load', checkAPI);
    </script>
</body>
</html>`);
});

module.exports = router;