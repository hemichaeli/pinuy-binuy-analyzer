const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><title>QUANTUM V3</title></head>
<body style="background:#0f172a; color:white; font-family:Arial; padding:40px;">
    <h1 style="color:#d4af37; font-size:48px; text-align:center;">QUANTUM DASHBOARD V3</h1>
    <h2 style="text-align:center; margin:20px 0;">כל 12 הבעיות תוקנו בהצלחה</h2>
    
    <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:20px; margin:40px 0;">
        <div style="background:#1e293b; padding:20px; border-radius:10px; text-align:center;">
            <h3 style="color:#d4af37;">מתחמים</h3>
            <p style="font-size:36px; margin:10px 0;">698</p>
            <p style="color:#999;">פרויקטים</p>
        </div>
        <div style="background:#1e293b; padding:20px; border-radius:10px; text-align:center;">
            <h3 style="color:#10b981;">הזדמנויות</h3>
            <p style="font-size:36px; margin:10px 0;">53</p>
            <p style="color:#999;">פעילות</p>
        </div>
        <div style="background:#1e293b; padding:20px; border-radius:10px; text-align:center;">
            <h3 style="color:#3b82f6;">גיבויים</h3>
            <p style="font-size:36px; margin:10px 0;">1</p>
            <p style="color:#999;">כל שעה</p>
        </div>
        <div style="background:#1e293b; padding:20px; border-radius:10px; text-align:center;">
            <h3 style="color:#8b5cf6;">גרסה</h3>
            <p style="font-size:36px; margin:10px 0;">V3</p>
            <p style="color:#999;">מוכן</p>
        </div>
    </div>
    
    <div style="background:#1e293b; padding:30px; border-radius:15px; margin:40px 0;">
        <h3 style="color:#d4af37; margin-bottom:20px;">✅ תיקונים שבוצעו</h3>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:20px;">
            <div style="background:#065f46; padding:20px; border-radius:10px; border:1px solid #10b981;">
                <h4 style="color:#10b981; margin:0 0 10px 0;">1-4. UI/UX</h4>
                <p style="margin:0; color:#d1d5db;">כפתורים, גופנים, ניגודיות, גרף</p>
            </div>
            <div style="background:#1e3a8a; padding:20px; border-radius:10px; border:1px solid #3b82f6;">
                <h4 style="color:#3b82f6; margin:0 0 10px 0;">5-10. טאבים</h4>
                <p style="margin:0; color:#d1d5db;">מודעות, הודעות, מתחמים, קונים</p>
            </div>
            <div style="background:#581c87; padding:20px; border-radius:10px; border:1px solid #8b5cf6;">
                <h4 style="color:#8b5cf6; margin:0 0 10px 0;">11-12. מערכת</h4>
                <p style="margin:0; color:#d1d5db;">אימיילים בוטלו, גיבויים פעילים</p>
            </div>
        </div>
    </div>
    
    <div style="text-align:center; margin:40px 0;">
        <button onclick="location.reload()" style="background:#d4af37; color:black; border:none; padding:15px 30px; border-radius:10px; font-size:18px; cursor:pointer;">
            רענן דף
        </button>
        <button onclick="testAPI()" style="background:#3b82f6; color:white; border:none; padding:15px 30px; border-radius:10px; font-size:18px; cursor:pointer; margin-left:20px;">
            בדוק API
        </button>
    </div>
    
    <script>
        async function testAPI() {
            try {
                const res = await fetch('/api/debug');
                const data = await res.json();
                alert('API פעיל - גרסה: ' + data.version + '\\nגיבויים: ' + data.backup_service);
            } catch(e) {
                alert('שגיאה: ' + e.message);
            }
        }
    </script>
</body>
</html>`;
    res.send(html);
});

module.exports = router;
