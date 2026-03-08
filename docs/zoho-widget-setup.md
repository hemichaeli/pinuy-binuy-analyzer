# QUANTUM Scheduling Bot — Zoho CRM Widget Registration

## מה זה?

ה-widget מאפשר להפעיל בוט WhatsApp לתיאום פגישות ישירות מתוך דף הקמפיין ב-Zoho CRM.

URL של ה-widget:
```
https://pinuy-binuy-analyzer-production.up.railway.app/api/scheduling/widget
```

---

## הוספה ל-Zoho CRM

### שיטה 1: כפתור Custom Action בקמפיין (המהירה ביותר)

1. ב-Zoho CRM → **Setup** → **Customization** → **Modules and Fields**
2. בחר **Campaigns**
3. לחץ **Links and Buttons** → **New Button**
4. הגדרות:
   - **Name**: `🤖 הפעל בוט תיאום`
   - **Button Type**: `Open URL`
   - **URL**: `https://pinuy-binuy-analyzer-production.up.railway.app/api/scheduling/widget?campaignId=${Campaigns.id}`
   - **Open in**: `Overlay` (גורם לפתיחה בתוך Zoho)
5. שמור

---

### שיטה 2: Zoho CRM Extension (Widget מוטמע)

זו השיטה שמציגה את ה-widget בתוך דף הקמפיין בפאנל צד, בדיוק כמו בצילום המסך.

#### שלב 1: Zoho Developer Console

1. פתח: https://marketplace.zoho.com/developer/home
2. לחץ **Create Extension** → **CRM**
3. שם: `QUANTUM Bot`
4. Component type: **Widget**

#### שלב 2: הגדר את ה-Widget

בקובץ `plugin-manifest.json` של ה-extension:
```json
{
  "pluginName": "QUANTUM Scheduling Bot",
  "namespace": "quantum_bot",
  "components": [
    {
      "type": "widget",
      "module": "Campaigns",
      "locations": ["DetailView"],
      "dimensions": { "width": "380px", "height": "600px" }
    }
  ]
}
```

#### שלב 3: קוד ה-Widget

```html
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <script src="https://js.zohostatic.com/zohocrm/sdk/2.0/ZohoEmbededAppSDK.js"></script>
</head>
<body style="margin:0;padding:0;">
  <iframe
    id="quantum-frame"
    src="about:blank"
    style="width:100%;height:600px;border:none;"
  ></iframe>

  <script>
    const BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';

    ZOHO.embeddedApp.on('PageLoad', function(data) {
      const campaignId = data?.EntityId?.[0] || data?.EntityId || '';
      const frame = document.getElementById('quantum-frame');
      frame.src = `${BASE}/api/scheduling/widget?campaignId=${campaignId}`;
    });

    ZOHO.embeddedApp.init();
  </script>
</body>
</html>
```

#### שלב 4: פרסום

1. Upload ל-Zoho Developer Console
2. **Test** → **Install to My CRM**
3. ב-Zoho CRM → **Setup** → **Extensions** → QUANTUM Bot → **Configure**
4. הגדר: מופיע ב-Campaign Detail View

---

## איך זה עובד אחרי ההתקנה

1. נכנס לדף קמפיין ב-Zoho CRM
2. ה-widget נטען אוטומטית בפאנל הצד עם ה-Campaign ID
3. לחץ **"טען מ-Zoho CRM"** - אנשי הקשר נטענים אוטומטית
4. לחץ **"🚀 הפעל בוט תיאום"** - WhatsApp נשלח לכולם
5. סטטוס מתעדכן בזמן אמת

---

## ENV Variables נדרשים ב-Railway

```
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

לקבל GOOGLE_SERVICE_ACCOUNT_JSON:
1. Google Cloud Console → IAM → Service Accounts
2. צור service account חדש
3. הוסף role: **Google Calendar API** editor
4. Download JSON key
5. העתק את תוכן ה-JSON כ-string לתוך ה-env var

לכל פרויקט - הגדר `google_calendar_id` בטבלת `projects`:
```sql
UPDATE projects SET google_calendar_id = 'your_calendar@group.calendar.google.com' WHERE id = 1;
```
