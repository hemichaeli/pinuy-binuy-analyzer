/**
 * QUANTUM Morning Intelligence Report v1.0
 * 
 * Sent daily at 07:30 Israel time (after listings scan at 07:00)
 * 
 * Report contents:
 * 1. Top 3 hottest opportunities (by IAI)
 * 2. Top 3 stressed sellers (by SSI)
 * 3. Price drops in last 24h (new listings with price_changes > 0)
 * 4. Committee approvals in last 7 days
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const { sendEmail, NOTIFICATION_EMAILS } = require('./notificationService');
const axios = require('axios');

const DASHBOARD_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard';
const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

// ─── WHATSAPP HELPERS ──────────────────────────────────────────────

function getInforuAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) return null;
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function buildWhatsAppMorningBrief(data) {
  const { opportunities, sellers, priceDrops, committees, stats } = data;
  const today = new Date().toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Asia/Jerusalem'
  });

  let msg = `🌅 *QUANTUM Morning Intel*\n${today}\n`;
  msg += `${'─'.repeat(28)}\n\n`;

  // KPI strip
  msg += `📊 *סיכום יומי:*\n`;
  msg += `• ${stats.opportunities || 0} הזדמנויות השקעה\n`;
  msg += `• ${stats.stressed || 0} מוכרים לחוצים\n`;
  msg += `• ${priceDrops.length} ירידות מחיר ב-24ש\n`;
  if (committees.length > 0) msg += `• ${committees.length} אישורי ועדה השבוע\n`;
  msg += `\n`;

  // Top 3 opportunities
  if (opportunities.length > 0) {
    msg += `🏆 *Top הזדמנויות:*\n`;
    opportunities.slice(0, 3).forEach((o, i) => {
      const stage = { declared: 'הכרזה', approved: 'אישור', deposit: 'פיקדון', construction: 'בנייה', planning: 'תכנון', initial: 'ראשוני' }[o.plan_stage] || o.plan_stage || '-';
      msg += `${i + 1}. *${o.name}* - ${o.city} | IAI: ${o.iai_score} | ${stage}\n`;
    });
    msg += `\n`;
  }

  // Top stressed sellers
  if (sellers.length > 0) {
    msg += `⚡ *מוכרים לחוצים:*\n`;
    sellers.slice(0, 3).forEach((s, i) => {
      const drop = s.total_price_drop_percent ? ` | ▼${parseFloat(s.total_price_drop_percent).toFixed(0)}%` : '';
      msg += `${i + 1}. ${s.address || s.city} (SSI: ${s.ssi_score}${drop})\n`;
    });
    msg += `\n`;
  }

  // Price drops highlight
  if (priceDrops.length > 0) {
    const top = priceDrops[0];
    const pct = parseFloat(top.total_price_drop_percent || 0).toFixed(1);
    msg += `📉 *ירידת מחיר בולטת:* ${top.address || top.city} ▼${pct}%\n\n`;
  }

  msg += `🔗 *לדשבורד המלא:*\n${DASHBOARD_URL}`;
  return msg;
}

async function sendMorningWhatsApp(message) {
  const auth = getInforuAuth();
  if (!auth) {
    logger.warn('[MorningReport] INFORU credentials not configured - skipping WhatsApp');
    return { sent: 0, skipped: 1, reason: 'no_credentials' };
  }

  // Get phone numbers from env (PERSONAL_PHONE and OFFICE_PHONE)
  const phones = [
    process.env.PERSONAL_PHONE,
    process.env.OFFICE_PHONE
  ].filter(Boolean).map(p => p.replace(/\D/g, '')); // normalize to digits only

  if (phones.length === 0) {
    logger.warn('[MorningReport] No PERSONAL_PHONE or OFFICE_PHONE configured');
    return { sent: 0, skipped: 1, reason: 'no_phones' };
  }

  let sent = 0;
  const results = [];

  for (const phone of phones) {
    try {
      const resp = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
        Data: {
          Message: message,
          Phone: phone,
          Settings: {
            CustomerMessageId: `morning_${Date.now()}_${phone}`,
            CustomerParameter: 'QUANTUM_MORNING_INTEL'
          }
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        timeout: 15000,
        validateStatus: () => true
      });

      // FIX: INFORU API returns StatusId (int), not Status (string)
      const ok = resp.status === 200 && (resp.data?.StatusId === 1 || resp.data?.Status === 'Success');
      results.push({ phone, sent: ok, statusId: resp.data?.StatusId, status: resp.data?.Status, code: resp.status });
      if (ok) sent++;
      logger.info(`[MorningReport] WhatsApp to ${phone}: ${ok ? 'OK' : 'FAILED'}`, resp.data);
    } catch (err) {
      logger.warn(`[MorningReport] WhatsApp send error to ${phone}:`, err.message);
      results.push({ phone, sent: false, error: err.message });
    }

    // Short delay between messages
    if (phones.indexOf(phone) < phones.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return { sent, total: phones.length, results };
}
