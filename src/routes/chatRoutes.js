/**
 * QUANTUM Chat - Dual AI (Claude + Perplexity) answering questions about our DB
 * POST /api/chat/ask - Ask a question, get merged AI answer
 * GET /api/chat/ - Chat UI
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { dualChat, isClaudeConfigured, isPerplexityConfigured } = require('../services/dualAiService');

/**
 * Pull compact DB context based on the question
 */
async function getDbContext(question) {
  const lowerQ = question.toLowerCase();
  
  const stats = (await pool.query(`
    SELECT COUNT(*) as total, 
      COUNT(*) FILTER (WHERE iai_score >= 30) as opportunities,
      COUNT(*) FILTER (WHERE iai_score >= 70) as excellent,
      COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed,
      COUNT(DISTINCT city) as cities,
      ROUND(AVG(iai_score)) as avg_iai
    FROM complexes
  `)).rows[0];

  let context = `מסד נתונים QUANTUM - פינוי-בינוי ישראל:
${stats.total} מתחמים, ${stats.opportunities} הזדמנויות (IAI 30+), ${stats.excellent} מצוינות (IAI 70+), ${stats.stressed} מוכרים במצוקה (SSI 40+), ${stats.cities} ערים. IAI ממוצע: ${stats.avg_iai}.

`;

  // Detect city
  const allCities = (await pool.query(`SELECT DISTINCT city FROM complexes WHERE city IS NOT NULL`)).rows;
  let targetCity = null;
  for (const c of allCities) {
    if (c.city && lowerQ.includes(c.city.toLowerCase())) { targetCity = c.city; break; }
  }

  if (targetCity) {
    const cityData = (await pool.query(`
      SELECT name, city, developer, iai_score, enhanced_ssi_score, status, planned_units, 
        is_receivership, is_inheritance_property, addresses
      FROM complexes WHERE city = $1 ORDER BY iai_score DESC NULLS LAST
    `, [targetCity])).rows;
    
    context += `=== ${targetCity} (${cityData.length} מתחמים) ===\n`;
    cityData.forEach((c, i) => {
      context += `${i+1}. ${c.name || c.addresses || '-'} | IAI:${c.iai_score || '-'} | SSI:${c.enhanced_ssi_score || '-'} | יזם:${c.developer || '-'} | שלב:${c.status || '-'} | יחד:${c.planned_units || '-'}${c.is_receivership ? ' | כינוס' : ''}${c.is_inheritance_property ? ' | ירושה' : ''}\n`;
    });
    context += '\n';
  }

  // Top opportunities
  const topOpp = (await pool.query(`
    SELECT name, city, developer, iai_score, enhanced_ssi_score, status, planned_units
    FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 20
  `)).rows;
  
  context += `=== טופ 20 הזדמנויות ===\n`;
  topOpp.forEach((c, i) => {
    context += `${i+1}. ${c.name} | ${c.city} | IAI:${c.iai_score} | SSI:${c.enhanced_ssi_score || '-'} | יזם:${c.developer || '-'} | שלב:${c.status || '-'}\n`;
  });
  context += '\n';

  // Stressed sellers
  if (lowerQ.includes('מצוק') || lowerQ.includes('לח') || lowerQ.includes('stress') || lowerQ.includes('ssi') || lowerQ.includes('כינוס') || lowerQ.includes('ירוש') || lowerQ.includes('מוכר') || lowerQ.includes('הזדמנו') || lowerQ.includes('זול') || lowerQ.includes('מתחת')) {
    const stressed = (await pool.query(`
      SELECT name, city, enhanced_ssi_score, iai_score, is_receivership, is_inheritance_property, has_enforcement_cases
      FROM complexes WHERE enhanced_ssi_score >= 10 ORDER BY enhanced_ssi_score DESC LIMIT 15
    `)).rows;
    
    context += `=== מוכרים במצוקה ===\n`;
    stressed.forEach((c, i) => {
      let flags = [];
      if (c.is_receivership) flags.push('כינוס');
      if (c.is_inheritance_property) flags.push('ירושה');
      if (c.has_enforcement_cases) flags.push('הוצלפ');
      context += `${i+1}. ${c.name} | ${c.city} | SSI:${c.enhanced_ssi_score} | IAI:${c.iai_score || '-'} | ${flags.join(', ') || '-'}\n`;
    });
    context += '\n';
  }

  // Kones
  if (lowerQ.includes('כינוס') || lowerQ.includes('kones') || lowerQ.includes('receivership') || lowerQ.includes('מכר')) {
    const kones = (await pool.query(`
      SELECT address, city, property_type, price, region, submission_deadline
      FROM kones_listings WHERE is_active = true ORDER BY created_at DESC LIMIT 15
    `)).rows;
    
    if (kones.length > 0) {
      context += `=== כינוס נכסים ===\n`;
      kones.forEach((k, i) => {
        context += `${i+1}. ${k.address || '-'} | ${k.city || '-'} | ${k.property_type || '-'} | ${k.price ? '₪'+Number(k.price).toLocaleString() : '-'}\n`;
      });
      context += '\n';
    }
  }

  // Transactions
  if (lowerQ.includes('עסק') || lowerQ.includes('מכיר') || lowerQ.includes('מחיר') || lowerQ.includes('נמכר')) {
    const tx = (await pool.query(`
      SELECT t.address, c.city, t.price, t.size_sqm, t.price_per_sqm, t.transaction_date
      FROM transactions t LEFT JOIN complexes c ON t.complex_id = c.id
      ORDER BY t.transaction_date DESC NULLS LAST LIMIT 20
    `)).rows;
    
    if (tx.length > 0) {
      context += `=== עסקאות אחרונות ===\n`;
      tx.forEach((t, i) => {
        context += `${i+1}. ${t.address || '-'} | ${t.city || '-'} | ₪${t.price ? Number(t.price).toLocaleString() : '-'} | ${t.size_sqm || '-'}מר\n`;
      });
      context += '\n';
    }
  }

  // City breakdown
  if (lowerQ.includes('עיר') || lowerQ.includes('ערים') || lowerQ.includes('השוו') || lowerQ.includes('איפה') || lowerQ.includes('איזה עיר') || lowerQ.includes('הכי טוב')) {
    const cities = (await pool.query(`
      SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE iai_score >= 30) as opp,
        COUNT(*) FILTER (WHERE enhanced_ssi_score >= 40) as stressed, ROUND(AVG(iai_score)) as avg_iai
      FROM complexes WHERE city IS NOT NULL GROUP BY city HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) FILTER (WHERE iai_score >= 30) DESC LIMIT 25
    `)).rows;
    
    context += `=== פילוח ערים ===\n`;
    cities.forEach(c => { context += `${c.city}: ${c.total} מתחמים, ${c.opp} הזדמנויות, IAI ממוצע ${c.avg_iai}\n`; });
    context += '\n';
  }

  // Golden opportunities
  const golden = (await pool.query(`
    SELECT name, city, iai_score, enhanced_ssi_score, developer, status
    FROM complexes WHERE iai_score >= 40 AND enhanced_ssi_score >= 20
    ORDER BY (iai_score + enhanced_ssi_score) DESC LIMIT 10
  `)).rows;
  
  if (golden.length > 0) {
    context += `=== הזדמנויות זהב ===\n`;
    golden.forEach((g, i) => { context += `${i+1}. ${g.name} | ${g.city} | IAI:${g.iai_score} | SSI:${g.enhanced_ssi_score}\n`; });
  }

  return context;
}

/**
 * POST /api/chat/ask
 */
router.post('/ask', async (req, res) => {
  try {
    const { question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    if (!isPerplexityConfigured() && !isClaudeConfigured()) {
      return res.status(500).json({ error: 'No AI configured. Need PERPLEXITY_API_KEY or ANTHROPIC_API_KEY.' });
    }

    logger.info(`[DUAL-CHAT] Q: ${question.substring(0, 100)}`);

    const dbContext = await getDbContext(question);
    
    // Convert history format
    const aiHistory = (history || []).slice(-6).map(m => ({ role: m.role, content: m.content }));

    const result = await dualChat(question, dbContext, aiHistory);
    
    logger.info(`[DUAL-CHAT] Sources: ${result.sources.join('+')} | ${result.answer.length} chars`);

    res.json({
      answer: result.answer,
      sources: result.sources,
      context_size: dbContext.length,
      engines: {
        claude: isClaudeConfigured() ? 'active' : 'not configured',
        perplexity: isPerplexityConfigured() ? 'active' : 'not configured'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('[DUAL-CHAT] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/status
 */
router.get('/status', (req, res) => {
  res.json({
    claude: isClaudeConfigured() ? 'active' : 'not configured',
    perplexity: isPerplexityConfigured() ? 'active' : 'not configured',
    mode: (isClaudeConfigured() && isPerplexityConfigured()) ? 'dual-ai' : 
          isClaudeConfigured() ? 'claude-only' : 
          isPerplexityConfigured() ? 'perplexity-only' : 'none'
  });
});

/**
 * GET /api/chat/ - Chat UI
 */
router.get('/', (req, res) => {
  const claudeStatus = isClaudeConfigured();
  const perplexityStatus = isPerplexityConfigured();
  const mode = (claudeStatus && perplexityStatus) ? 'Dual AI' : claudeStatus ? 'Claude' : perplexityStatus ? 'Perplexity' : 'None';
  const badge = (claudeStatus && perplexityStatus) ? '#10b981' : '#f59e0b';

  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM Chat - ${mode}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0e17; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    .header { background: linear-gradient(135deg, #1a1f35 0%, #0d1117 100%); padding: 16px 24px; border-bottom: 1px solid #2a3040; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; color: #fff; }
    .badge { background: ${badge}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; }
    .chat-area { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .msg { max-width: 85%; padding: 12px 16px; border-radius: 12px; line-height: 1.7; font-size: 14px; white-space: pre-wrap; word-wrap: break-word; }
    .msg.user { background: #1e3a5f; align-self: flex-start; border-bottom-right-radius: 4px; }
    .msg.bot { background: #1a2332; align-self: flex-end; border-bottom-left-radius: 4px; border: 1px solid #2a3545; }
    .msg strong { color: #60a5fa; }
    .msg.system { background: #1a1f2e; align-self: center; text-align: center; color: #888; font-size: 13px; border: 1px dashed #333; }
    .msg .sources { font-size: 11px; color: #666; margin-top: 8px; padding-top: 6px; border-top: 1px solid #2a3545; }
    .input-area { background: #0d1117; padding: 16px 20px; border-top: 1px solid #2a3040; display: flex; gap: 10px; }
    .input-area input { flex: 1; background: #1a2332; border: 1px solid #2a3545; color: #fff; padding: 12px 16px; border-radius: 8px; font-size: 15px; outline: none; }
    .input-area input:focus { border-color: #3b82f6; }
    .input-area button { background: #3b82f6; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; }
    .input-area button:hover { background: #2563eb; }
    .input-area button:disabled { background: #334155; cursor: wait; }
    .typing { color: #888; font-style: italic; }
    .suggestions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 20px 10px; }
    .suggestions button { background: #1a2332; border: 1px solid #2a3545; color: #94a3b8; padding: 6px 14px; border-radius: 16px; cursor: pointer; font-size: 13px; }
    .suggestions button:hover { border-color: #3b82f6; color: #fff; }
  </style>
</head>
<body>
  <div class="header">
    <h1>QUANTUM Chat</h1>
    <span class="badge">${mode}</span>
  </div>
  
  <div class="chat-area" id="chat">
    <div class="msg system">שלום! אני יודע הכל על מתחמי פינוי-בינוי בישראל. שאל אותי כל שאלה.<br>מנועים: ${mode}</div>
  </div>

  <div class="suggestions" id="suggestions">
    <button onclick="askQ('מה ההזדמנויות הכי טובות עכשיו?')">הזדמנויות טובות</button>
    <button onclick="askQ('איפה יש מוכרים במצוקה?')">מוכרים במצוקה</button>
    <button onclick="askQ('השווה בין בת ים לחולון לפינוי בינוי')">השוואת ערים</button>
    <button onclick="askQ('איזה מתחמים בכינוס נכסים?')">כינוס נכסים</button>
    <button onclick="askQ('מה ההזדמנות הכי טובה בפתח תקווה?')">פתח תקווה</button>
    <button onclick="askQ('תן לי 5 הזדמנויות זהב עם IAI וSSI גבוהים')">הזדמנויות זהב</button>
  </div>

  <div class="input-area">
    <input type="text" id="input" placeholder="שאל שאלה על פינוי-בינוי..." onkeydown="if(event.key==='Enter')send()">
    <button id="btn" onclick="send()">שלח</button>
  </div>

  <script>
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const btn = document.getElementById('btn');
    const suggestions = document.getElementById('suggestions');
    let history = [];

    function addMsg(text, role, sources) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      let html = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      if (sources && sources.length) {
        html += '<div class="sources">מקורות: ' + sources.join(' + ') + '</div>';
      }
      div.innerHTML = html;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    function askQ(q) { input.value = q; send(); }

    async function send() {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      btn.disabled = true;
      suggestions.style.display = 'none';
      addMsg(q, 'user');
      const typing = addMsg('חושב... (Claude + Perplexity)', 'typing');
      
      try {
        const res = await fetch('/api/chat/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, history })
        });
        const data = await res.json();
        typing.remove();
        
        if (data.error) { addMsg('שגיאה: ' + data.error, 'system'); }
        else {
          addMsg(data.answer, 'bot', data.sources);
          history.push({ role: 'user', content: q });
          history.push({ role: 'assistant', content: data.answer });
        }
      } catch (e) { typing.remove(); addMsg('שגיאת חיבור: ' + e.message, 'system'); }
      
      btn.disabled = false;
      input.focus();
    }
  </script>
</body>
</html>`);
});

module.exports = router;
