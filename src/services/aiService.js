/**
 * QUANTUM AI Service — v1.4
 * Auto-fallback: Claude → Gemini on ANY API error
 * Tries multiple models for both providers
 */

const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const OWNER_PHONE = '972546550815'; // חמי

const CLAUDE_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307',
  'claude-3-sonnet-20240229',
  'claude-3-opus-20240229'
];

const GEMINI_ENDPOINTS = [
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent', version: 'v1' },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', version: 'v1beta' },
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent', version: 'v1-pro', noSystem: true }
];

let currentProvider = 'claude';
let currentClaudeModel = null;
let currentGeminiEndpoint = null;
let lastProviderSwitch = null;
let switchCount = 0;
let lastClaudeError = null;
let lastGeminiError = null;

async function sendOwnerAlert(message) {
  try {
    const username = process.env.INFORU_USERNAME;
    const password = process.env.INFORU_PASSWORD;
    if (!username || !password) return;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: message, Phone: OWNER_PHONE, Settings: { CustomerMessageId: `alert_${Date.now()}`, CustomerParameter: 'QUANTUM_SYSTEM_ALERT' } }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` }, timeout: 10000, validateStatus: () => true });
    console.log('[AIService] ✅ Owner alert sent');
  } catch (err) { console.error('[AIService] Alert failed:', err.message); }
}

async function callClaude(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY');

  for (const model of CLAUDE_MODELS) {
    try {
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      }, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 12000
      });
      currentClaudeModel = model;
      console.log(`[AIService] ✅ Claude OK (${model})`);
      return response.data.content[0].text;
    } catch (err) {
      const status = err.response?.status;
      const msg = JSON.stringify(err.response?.data || err.message).substring(0, 200);
      console.warn(`[AIService] Claude model ${model} failed (${status}): ${msg}`);
      // Only try next model on 404 (model not found)
      // For auth errors (400/401/403) or credit errors — all models will fail, stop early
      if (status !== 404) {
        const finalErr = new Error(err.response?.data?.error?.message || err.message);
        finalErr.status = status;
        finalErr.responseData = err.response?.data;
        throw finalErr;
      }
    }
  }
  const err = new Error('All Claude models returned 404 — no valid model found');
  err.status = 404;
  throw err;
}

async function callGemini(systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('No GEMINI_API_KEY');

  for (const endpoint of GEMINI_ENDPOINTS) {
    try {
      const body = endpoint.noSystem
        ? { contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nהודעת המשתמש: ${userMessage}` }] }], generationConfig: { maxOutputTokens: 400, temperature: 0.7 } }
        : { system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: userMessage }] }], generationConfig: { maxOutputTokens: 400, temperature: 0.7 } };

      const response = await axios.post(`${endpoint.url}?key=${apiKey}`, body, { timeout: 12000 });
      currentGeminiEndpoint = endpoint.version;
      console.log(`[AIService] ✅ Gemini OK (${endpoint.version})`);
      return response.data.candidates[0].content.parts[0].text;
    } catch (err) {
      const status = err.response?.status;
      const msg = JSON.stringify(err.response?.data || err.message).substring(0, 200);
      console.warn(`[AIService] Gemini ${endpoint.version} failed (${status}): ${msg}`);
      lastGeminiError = { endpoint: endpoint.version, status, msg, time: new Date().toISOString() };
    }
  }
  throw new Error('All Gemini endpoints failed');
}

function describeError(status, errMsg) {
  if (status === 400 && String(errMsg).toLowerCase().includes('credit')) return 'נגמר קרדיט';
  if (status === 401) return 'שגיאת הרשאה';
  if (status === 403) return 'גישה נדחתה';
  if (status === 404) return 'מודל לא נמצא';
  if (status === 429) return 'חריגת מכסה';
  return `שגיאה ${status}`;
}

async function generateResponse(systemPrompt, userMessage) {
  if (currentProvider === 'gemini') {
    try {
      const text = await callGemini(systemPrompt, userMessage);
      return { text, provider: 'gemini', model: currentGeminiEndpoint };
    } catch (err) {
      console.error('[AIService] All Gemini failed:', err.message);
      return { text: 'שלום! במה אפשר לעזור?', provider: 'gemini_error' };
    }
  }

  try {
    const text = await callClaude(systemPrompt, userMessage);
    return { text, provider: 'claude', model: currentClaudeModel };
  } catch (err) {
    const status = err.status || err.response?.status;
    const errMsg = err.message || '';
    const isTransient = status === 500 || status === 503;

    console.error(`[AIService] ⚠️ Claude failed (${status}): ${errMsg.substring(0, 120)}`);
    lastClaudeError = { status, message: errMsg, time: new Date().toISOString() };

    if (!isTransient) {
      currentProvider = 'gemini';
      lastProviderSwitch = new Date().toISOString();
      switchCount++;

      const reason = describeError(status, errMsg);
      console.warn(`[AIService] ⚡ Switching to Gemini (${reason}) — switch #${switchCount}`);

      await sendOwnerAlert(
        `⚠️ *QUANTUM Bot — התראה*\n\nClaude API נכשל: *${reason}*\n*עבר אוטומטית ל-Gemini* ✅\n\nהבוט ממשיך לעבוד רגיל.\nלחזרה ל-Claude: תקן ועשה Redeploy ב-Railway.\n\nפרטים: ${errMsg.substring(0, 100)}`
      );

      try {
        const text = await callGemini(systemPrompt, userMessage);
        return { text, provider: 'gemini', model: currentGeminiEndpoint };
      } catch (geminiErr) {
        console.error('[AIService] All Gemini failed after Claude switch:', geminiErr.message);
        return { text: 'שלום! במה אפשר לעזור?', provider: 'error_fallback' };
      }
    }

    return { text: 'שלום! במה אפשר לעזור?', provider: 'transient_error' };
  }
}

function getStatus() {
  return {
    currentProvider, currentClaudeModel, currentGeminiEndpoint,
    lastProviderSwitch, switchCount, lastClaudeError, lastGeminiError,
    claudeModels: CLAUDE_MODELS,
    claudeKeySet: !!process.env.ANTHROPIC_API_KEY,
    geminiKeySet: !!process.env.GEMINI_API_KEY
  };
}

function resetToClaude() {
  currentProvider = 'claude';
  currentClaudeModel = null;
  lastClaudeError = null;
  lastGeminiError = null;
  console.log('[AIService] Reset to Claude');
}

module.exports = { generateResponse, getProvider: () => currentProvider, getStatus, resetToClaude };
