# QUANTUM — Claude Project Instructions

> **This file is loaded automatically at the start of every Claude chat in this project.**
> Read it fully before doing anything else.

---

## 🗂️ Issues Tracker — Source of Truth

All tasks and their status live here:
**https://github.com/hemichaeli/claude-issues-tracker/tree/main/pinuy-binuy-analyzer/issues/**

Local path (already cloned): `/home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/`

### Rules — mandatory for every response:

1. **Start of chat:** Pull the tracker and read all open issue files to know current state
   ```bash
   cd /home/ubuntu/claude-issues-tracker && git pull
   ls pinuy-binuy-analyzer/issues/
   ```

2. **During work:** After completing any subtask, append a progress row:
   ```bash
   echo "| $(date '+%Y-%m-%d %H:%M') | [what you did] |" >> /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
   cd /home/ubuntu/claude-issues-tracker && git add -A && git commit -m "progress: #[NUMBER] [summary]" && git push
   ```

3. **When closing an issue:**
   ```bash
   # Update tracker status
   sed -i 's/\*\*Status:\*\* open/**Status:** closed/' /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
   echo "| $(date '+%Y-%m-%d %H:%M') | ✅ CLOSED |" >> /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
   cd /home/ubuntu/claude-issues-tracker && git add -A && git commit -m "closed: #[NUMBER]" && git push
   # Close on GitHub
   gh issue close [NUMBER] -R hemichaeli/pinuy-binuy-analyzer
   ```

4. **New issues added by user:** Check GitHub for issues not yet in the tracker:
   ```bash
   gh issue list -R hemichaeli/pinuy-binuy-analyzer --state open
   ```
   If a new issue exists without a tracker file → create the file and add it to the priority queue.

5. **Priority order:** Work issues from lowest number to highest, unless a label says `P0` (do first) or `P2`/`P3` (do later).

---

## 🏗️ Project Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Node.js 18 |
| **Database** | PostgreSQL on Railway |
| **Deployment** | Railway (auto-deploy on push to `main`) |
| **Backend URL** | https://pinuy-binuy-analyzer-production.up.railway.app |
| **Dashboard** | https://quantum-dashboard-production.up.railway.app |
| **WhatsApp** | INFORU API (credentials in Railway env vars) |
| **Auto-dialer** | Vapi API (assistantId: `quantum_cold_prospecting`) |
| **Repo** | https://github.com/hemichaeli/pinuy-binuy-analyzer |

---

## 🔄 Git Workflow

After every completed feature:
```bash
git add -A
git commit -m "feat: [description]"
git push
```

Wait ~90 seconds, then verify Railway deployment:
```bash
curl -s https://pinuy-binuy-analyzer-production.up.railway.app/health
```

---

## 📋 Scraper Template

Every new scraper must include:
- `src/scrapers/[name]Scraper.js` — scraper logic
- `src/routes/[name]Routes.js` — API routes
- DB migration in `migrations/` — table with: `id, url, title, price, rooms, city, phone, source, created_at, whatsapp_sent, called`
- Daily cron in `src/cron/[name]Cron.js`
- Auto-WhatsApp via INFORU after finding new listing with phone
- Auto-dialer: check `phone_calls` table → if not called → insert + call Vapi
- Dashboard tab in frontend

---

## 📞 Auto-Dialer Integration

When a new listing with a phone number is found:
```javascript
// Check if already called
const existing = await db.query('SELECT id FROM phone_calls WHERE phone=$1 AND lead_source=$2', [phone, source]);
if (existing.rows.length === 0) {
  // Insert call record
  await db.query('INSERT INTO phone_calls (phone, lead_source, status) VALUES ($1, $2, $3)', [phone, source, 'pending']);
  // Trigger Vapi call
  await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assistantId: 'quantum_cold_prospecting',
      customer: { number: phone },
      metadata: { lead_source: source }
    })
  });
}
```
