/**
 * QUANTUM AI Service — v1.3
 * Auto-fallback: Claude → Gemini on ANY API error
 * Sends WhatsApp alert to owner on provider switch
 */

const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const OWNER_PHONE = '972546550815'; // חמי
const GEMINI_MODELS = [
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash',
  'gemini-1.0-pro'
];

// In-memory state — resets on redeploy (forces re-check after fix)
let currentProvider = 'claude'; // 'claude' | 'gemini'
let currentGeminiModel = GEMINI_MODELS[0];
let lastProviderSwitch = null;
let switchCount = 0;
let lastClaudeError = null;
let lastGeminiError = null;

function getProvider() { return currentProvider; }

async function sendOwnerAlert(message) {
  try {
    const username = process.env.INFORU_USERNAME;
    const password = process.env.INFORU_PASSWORD;
    if (!username || !password) return;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: {
        Message: message,
        Phone: OWNER_PHONE,
        Settings: { CustomerMessageId: `alert_${Date.now()}`, CustomerParameter: 'QUANTUM_SYSTEM_ALERT' }
      }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 10000,
      validateStatus: () => true
    });
    console.log(`[AIService] ✅ Owner alert sent`);
  } catch (err) {
    console.error('[AIService] Failed to send owner alert:', err.message);
  }
}

async function callClaude(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error('No ANTHROPIC_API_KEY'), { code: 'NO_KEY' });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 12000
  });

  return response.data.content[0].text;
}

async function callGeminiModel(modelName, systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('No GEMINI_API_KEY'), { code: 'NO_KEY' });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.7 }
    },
    { timeout: 12000 }
  );

  return response.data.candidates[0].content.parts[0].text;
}

async function callGemini(systemPrompt, userMessage) {
  // Try each model in order until one works
  for (const model of GEMINI_MODELS) {
    try {
      const text = await callGeminiModel(model, systemPrompt, userMessage);
      currentGeminiModel = model;
      console.log(`[AIService] ✅ Gemini OK (${model})`);
      return text;
    } catch (err) {
      const status = err.response?.status;
      const body = JSON.stringify(err.response?.data || {});
      console.warn(`[AIService] Gemini model ${model} failed (${status}): ${body.substring(0, 150)}`);
      lastGeminiError = { model, status, body: body.substring(0, 200), time: new Date().toISOString() };
      // Continue to next model
    }
  }
  throw new Error('All Gemini models failed');
}

function describeClaudeError(status, errMsg) {
  if (status === 400 && errMsg.toLowerCase().includes('credit')) return 'נגמר קרדיט';
  if (status === 401) return 'שגיאת הרשאה (API key לא תקין)';
  if (status === 403) return 'גישה נדחתה (403)';
  if (status === 404) return 'מודל לא נמצא (404)';
  if (status === 429) return 'חריגת מכסה (rate limit)';
  if (status === 529) return 'שרת עמוס (overloaded)';
  return `שגיאה ${status}`;
}

/**
 * Main AI call — tries Claude, falls back to Gemini on ANY permanent API error
 */
async function generateResponse(systemPrompt, userMessage) {
  // Already on Gemini — use it directly
  if (currentProvider === 'gemini') {
    try {
      const text = await callGemini(systemPrompt, userMessage);
      return { text, provider: 'gemini', model: currentGeminiModel };
    } catch (err) {
      console.error('[AIService] All Gemini models failed:', err.message);
      return { text: 'שלום! במה אפשר לעזור?', provider: 'gemini_error' };
    }
  }

  // Try Claude first
  try {
    const text = await callClaude(systemPrompt, userMessage);
    console.log('[AIService] ✅ Claude response OK');
    return { text, provider: 'claude' };
  } catch (err) {
    const status = err.response?.status;
    const errMsg = err.response?.data?.error?.message || err.message || '';
    const isApiError = status && status >= 400;
    const isTransient = status === 500 || status === 503;

    console.error(`[AIService] ⚠️ Claude error (${status}): ${errMsg.substring(0, 120)}`);
    lastClaudeError = { status, message: errMsg, time: new Date().toISOString() };

    if (isApiError && !isTransient) {
      currentProvider = 'gemini';
      lastProviderSwitch = new Date().toISOString();
      switchCount++;

      const reason = describeClaudeError(status, errMsg);
      console.warn(`[AIService] ⚡ Switching to Gemini (${reason}) — switch #${switchCount}`);

      await sendOwnerAlert(
        `⚠️ *QUANTUM Bot — התראה*\n\n` +
        `Claude API נכשל: *${reason}*\n` +
        `*עבר אוטומטית ל-Gemini* ✅\n\n` +
        `הבוט ממשיך לעבוד רגיל.\n` +
        `לחזרה ל-Claude: תקן את הבעיה ואז עשה Redeploy ב-Railway.\n\n` +
        `פרטים: ${errMsg.substring(0, 100)}`
      );

      try {
        const text = await callGemini(systemPrompt, userMessage);
        return { text, provider: 'gemini', model: currentGeminiModel };
      } catch (geminiErr) {
        console.error('[AIService] All Gemini models failed after Claude switch:', geminiErr.message);
        return { text: 'שלום! במה אפשר לעזור?', provider: 'error_fallback' };
      }
    }

    return { text: 'שלום! במה אפשר לעזור?', provider: 'transient_error' };
  }
}

function getStatus() {
  return {
    currentProvider,
    currentGeminiModel,
    lastProviderSwitch,
    switchCount,
    lastClaudeError,
    lastGeminiError,
    geminiModels: GEMINI_MODELS,
    claudeKeySet: !!process.env.ANTHROPIC_API_KEY,
    geminiKeySet: !!process.env.GEMINI_API_KEY
  };
}

function resetToClaude() {
  currentProvider = 'claude';
  currentGeminiModel = GEMINI_MODELS[0];
  lastClaudeError = null;
  lastGeminiError = null;
  console.log('[AIService] Reset to Claude');
}

module.exports = { generateResponse, getProvider, getStatus, resetToClaude };
