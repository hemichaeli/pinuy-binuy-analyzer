/**
 * QUANTUM Chat - AI answering questions about our DB
 * POST /api/chat/ask - Ask a question, get AI answer
 * GET /api/chat/ - Chat UI
 * GET /api/chat/status - AI status
 * GET /api/chat/models - Available models
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const { dualChat, isClaudeConfigured, isPerplexityConfigured, getAvailableModels } = require('../services/dualAiService');

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

  const topOpp = (await pool.query(`
    SELECT name, city, developer, iai_score, enhanced_ssi_score, status, planned_units
    FROM complexes WHERE iai_score >= 30 ORDER BY iai_score DESC LIMIT 20
  `)).rows;
  
  context += `=== טופ 20 הזדמנויות ===\n`;
  topOpp.forEach((c, i) => {
    context += `${i+1}. ${c.name} | ${c.city} | IAI:${c.iai_score} | SSI:${c.enhanced_ssi_score || '-'} | יזם:${c.developer || '-'} | שלב:${c.status || '-'}\n`;
  });
  context += '\n';

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
    const { question, history, model } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    if (!isPerplexityConfigured() && !isClaudeConfigured()) {
      return res.status(500).json({ error: 'No AI configured.' });
    }

    logger.info(`[CHAT] Q: ${question.substring(0, 100)} | model: ${model || 'default'}`);

    const dbContext = await getDbContext(question);
    const aiHistory = (history || []).slice(-6).map(m => ({ role: m.role, content: m.content }));

    const result = await dualChat(question, dbContext, aiHistory, { model: model || undefined });
    
    logger.info(`[CHAT] Sources: ${result.sources.join('+')} | Model: ${result.model} | ${result.answer.length} chars`);

    res.json({
      answer: result.answer,
      sources: result.sources,
      model: result.model,
      council_details: result.council_details || null,
      context_size: dbContext.length,
      engines: {
        claude: isClaudeConfigured() ? 'active' : 'off',
        perplexity: isPerplexityConfigured() ? 'active' : 'off'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('[CHAT] Error:', error.message);
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
 * GET /api/chat/models
 */
router.get('/models', (req, res) => {
  res.json(getAvailableModels());
});

/**
 * GET /api/chat/ - Chat UI
 */
router.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>QUANTUM AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Assistant', -apple-system, sans-serif; background: #080c14; color: #e0e0e0; height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
    
    .header { background: linear-gradient(135deg, #0f1623 0%, #080c14 100%); padding: 12px 20px; border-bottom: 1px solid #1a2744; display: flex; align-items: center; justify-content: space-between; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-icon { width: 32px; height: 32px; background: linear-gradient(135deg, #06d6a0, #3b82f6); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 16px; color: #000; font-family: serif; }
    .logo h1 { font-size: 18px; color: #fff; font-weight: 800; letter-spacing: 2px; }
    .logo .sub { font-size: 9px; color: #4a5e80; letter-spacing: 1px; display: block; margin-top: -2px; }
    
    .model-select { background: #0f1623; border: 1px solid #1a2744; color: #8899b4; padding: 5px 8px; border-radius: 6px; font-size: 11px; font-family: inherit; cursor: pointer; outline: none; direction: ltr; max-width: 170px; }
    .model-select:focus { border-color: #3b82f6; }
    .model-select option { background: #0f1623; }
    .model-select optgroup { color: #4a5e80; font-style: normal; }
    
    .dash-link { color: #4a5e80; text-decoration: none; font-size: 11px; padding: 5px 8px; border: 1px solid #1a2744; border-radius: 6px; white-space: nowrap; }
    .dash-link:hover { color: #06d6a0; border-color: #06d6a0; }

    .chat-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
    
    .msg { max-width: 88%; padding: 12px 16px; border-radius: 14px; line-height: 1.7; font-size: 14px; white-space: pre-wrap; word-wrap: break-word; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    
    .msg.user { background: linear-gradient(135deg, #1e3a5f, #1a2f4d); align-self: flex-start; border-bottom-right-radius: 4px; color: #e2e8f0; }
    .msg.bot { background: #0f1623; align-self: flex-end; border-bottom-left-radius: 4px; border: 1px solid #1a2744; }
    .msg.bot strong { color: #06d6a0; }
    .msg.council { border-color: #fbbf24; }
    .msg.council strong { color: #fbbf24; }
    .msg.system { background: transparent; align-self: center; text-align: center; color: #4a5e80; font-size: 12px; border: 1px dashed #1a2744; padding: 16px 24px; border-radius: 12px; max-width: 340px; }
    .msg .meta { font-size: 10px; color: #4a5e80; margin-top: 6px; padding-top: 5px; border-top: 1px solid #1a274422; }
    .msg.typing { color: #4a5e80; font-style: italic; background: transparent; border: none; font-size: 12px; }
    .msg .council-badge { display: inline-block; background: linear-gradient(135deg, #fbbf24, #f59e0b); color: #000; font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 4px; margin-left: 4px; }

    .suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 16px 8px; justify-content: center; }
    .suggestions button { background: transparent; border: 1px solid #1a2744; color: #8899b4; padding: 5px 12px; border-radius: 16px; cursor: pointer; font-size: 12px; font-family: inherit; transition: all 0.15s; }
    .suggestions button:hover { border-color: #06d6a0; color: #06d6a0; }

    .input-area { background: #0a0e17; padding: 12px 16px; border-top: 1px solid #1a2744; display: flex; gap: 8px; }
    .input-area input { flex: 1; background: #0f1623; border: 1px solid #1a2744; color: #fff; padding: 12px 16px; border-radius: 10px; font-size: 15px; font-family: inherit; outline: none; }
    .input-area input:focus { border-color: #06d6a0; }
    .input-area input::placeholder { color: #4a5e80; }
    .send-btn { background: linear-gradient(135deg, #06d6a0, #059669); color: #000; border: none; width: 44px; height: 44px; border-radius: 10px; cursor: pointer; font-size: 18px; font-weight: 900; display: flex; align-items: center; justify-content: center; }
    .send-btn:hover { filter: brightness(1.1); }
    .send-btn:disabled { background: #1a2744; color: #4a5e80; cursor: wait; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <div class="logo-icon">Q</div>
      <div>
        <h1>QUANTUM</h1>
        <span class="sub">INTELLIGENCE</span>
      </div>
    </div>
    <div class="header-right">
      <select class="model-select" id="modelSelect">
        <optgroup label="Standard">
          <option value="sonar-pro">Pro (מומלץ)</option>
          <option value="sonar">Fast (מהיר)</option>
        </optgroup>
        <optgroup label="Research">
          <option value="sonar-reasoning-pro">Reasoning (חשיבה)</option>
          <option value="sonar-deep-research">Deep Research (מחקר עמוק)</option>
        </optgroup>
        <optgroup label="Premium">
          <option value="council">Council (מועצה) - 3 מודלים</option>
        </optgroup>
      </select>
      <a href="/api/dashboard/" class="dash-link">דשבורד</a>
    </div>
  </div>
  
  <div class="chat-area" id="chat">
    <div class="msg system">מח חד. הבנה עמוקה. גישה לסודות השוק.<br><br>שאל אותי כל שאלה על פינוי-בינוי.</div>
  </div>

  <div class="suggestions" id="suggestions">
    <button onclick="askQ('מה ההזדמנויות הכי טובות עכשיו?')">הזדמנויות</button>
    <button onclick="askQ('איפה יש מוכרים במצוקה?')">מוכרים לחוצים</button>
    <button onclick="askQ('השווה בין בת ים לחולון לפתח תקווה')">השוואת ערים</button>
    <button onclick="askQ('איזה מתחמים בכינוס נכסים?')">כינוס נכסים</button>
    <button onclick="askQ('תן לי 5 הזדמנויות זהב')">הזדמנויות זהב</button>
  </div>

  <div class="input-area">
    <input type="text" id="input" placeholder="שאל על פינוי-בינוי..." onkeydown="if(event.key==='Enter'&&!event.shiftKey)send()">
    <button class="send-btn" id="btn" onclick="send()">&#10148;</button>
  </div>

  <script>
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const btn = document.getElementById('btn');
    const suggestions = document.getElementById('suggestions');
    const modelSelect = document.getElementById('modelSelect');
    let history = [];

    const modelNames = { 
      'sonar': 'Fast', 
      'sonar-pro': 'Pro', 
      'sonar-reasoning-pro': 'Reasoning',
      'sonar-deep-research': 'Deep Research',
      'council': 'Council'
    };

    const modelEmojis = {
      'sonar': '', 
      'sonar-pro': '', 
      'sonar-reasoning-pro': '',
      'sonar-deep-research': '',
      'council': ''
    };

    function addMsg(text, role, meta, isCouncil) {
      const div = document.createElement('div');
      div.className = 'msg ' + role + (isCouncil ? ' council' : '');
      let html = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      if (isCouncil && role === 'bot') {
        html = '<span class="council-badge">COUNCIL</span> ' + html;
      }
      if (meta) {
        html += '<div class="meta">' + meta + '</div>';
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
      const model = modelSelect.value;
      const mName = modelNames[model] || model;
      const typingText = model === 'council' 
        ? 'Council: שולח ל-3 מודלים במקביל...' 
        : model === 'sonar-deep-research'
          ? 'Deep Research: מחקר מעמיק (עד 5 דקות)...'
          : mName + ' מנתח...';
      const typing = addMsg(typingText, 'typing');
      
      try {
        const res = await fetch('/api/chat/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, history, model })
        });
        const data = await res.json();
        typing.remove();
        
        if (data.error) { addMsg(data.error, 'system'); }
        else {
          const metaParts = [];
          if (data.model) metaParts.push(modelNames[data.model] || data.model);
          if (data.sources && data.sources.length > 0) metaParts.push(data.sources.join('+'));
          if (data.council_details) metaParts.push(data.council_details.models_responded + '/' + data.council_details.models_queried + ' models');
          if (data.context_size) metaParts.push(Math.round(data.context_size / 1024) + 'K');
          
          const isCouncil = data.model === 'council' || (data.council_details != null);
          addMsg(data.answer, 'bot', metaParts.join(' | '), isCouncil);
          history.push({ role: 'user', content: q });
          history.push({ role: 'assistant', content: data.answer });
        }
      } catch (e) { typing.remove(); addMsg('שגיאת חיבור: ' + e.message, 'system'); }
      
      btn.disabled = false;
      input.focus();
    }

    modelSelect.value = 'sonar-pro';
  </script>
</body>
</html>`);
});

module.exports = router;
