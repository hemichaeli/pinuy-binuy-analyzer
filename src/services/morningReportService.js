/**
 * QUANTUM Morning Intelligence Report v2.1
 * Added: Israeli Real Estate Service — investor cost (mas rechisha) per opportunity
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const axios = require('axios');
const { calcMasRechisha, classifyLandType } = require('./israeliRealEstateService');

const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const NOTIFICATION_EMAILS = [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);
const DASHBOARD_BASE = process.env.DASHBOARD_URL ||
  'https://pinuy-binuy-analyzer-production.up.railway.app/dashboard';

function tabLink(tab, filter) {
  return `${DASHBOARD_BASE}#${tab}${filter ? '/' + filter : ''}`;
}

async function sendEmail({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set' };
  const fromAddress = process.env.EMAIL_FROM || 'QUANTUM Real Estate <alerts@u-r-quantum.com>';
  try {
    const response = await axios.post('https://api.resend.com/emails', {
      from: fromAddress, to: NOTIFICATION_EMAILS, subject, html
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    if (response.data?.id) {
      logger.info(`[MorningReport] Email sent: ${response.data.id}`);
      return { sent: true, count: NOTIFICATION_EMAILS.length };
    }
    return { sent: false, error: JSON.stringify(response.data) };
  } catch (err) {
    logger.warn('[MorningReport] Email error:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Enrich opportunity with investor cost analysis (mas rechisha)
 */
function enrichOpportunityWithTax(opp) {
  try {
    if (!opp.asking_price && !opp.avg_price) return opp;
    const price = parseFloat(opp.asking_price || opp.avg_price || 0);
    if (!price || price < 100000) return opp;
    const { tax, effectiveRate } = calcMasRechisha(price, 'investor');
    const land = classifyLandType(opp.city || '');
    return {
      ...opp,
      investor_purchase_tax: tax,
      investor_tax_rate_pct: Math.round(effectiveRate * 1000) / 10,
      total_entry_cost: price + tax,
      land_type: land.landType,
      land_notes: land.notes
    };
  } catch (e) {
    return opp;
  }
}

function buildEmailHtml({ opportunities, sellers, priceDrops, committees, stats, today, scanNum }) {
  const linkStyle = 'color:#4ecdc4; text-decoration:none; font-weight:600;';
  const rowStyle = (bg) => `background:${bg}; border-bottom:1px solid #3a3f4a;`;

  const oppRows = opportunities.slice(0, 5).map((o, i) => {
    const stage = { declared: 'הכרזה', approved: 'אישור', deposit: 'פיקדון', construction: 'בנייה', planning: 'תכנון', initial: 'ראשוני' }[o.plan_stage] || o.plan_stage || '-';
    const iaiColor = o.iai_score >= 85 ? '#4ade80' : o.iai_score >= 70 ? '#e8b84b' : '#9aa0b0';
    // Show investor tax if available
    const taxCell = o.investor_purchase_tax
      ? `<td style="padding:10px 14px; color:#f87171; font-size:12px;">מס: ₪${o.investor_purchase_tax.toLocaleString('he-IL')}</td>`
      : `<td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${o.developer || '-'}</td>`;
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px; color:#e8eaf0;">
          <a href="${tabLink('complexes')}" style="${linkStyle}">${o.name || o.city}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${o.city || ''}</span>
        </td>
        <td style="padding:10px 14px; text-align:center;">
          <span style="background:rgba(78,205,196,0.15); color:${iaiColor}; padding:3px 10px; border-radius:6px; font-weight:700; font-size:13px;">${o.iai_score}</span>
        </td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${stage}</td>
        ${taxCell}
      </tr>`;
  }).join('');

  const sellerRows = sellers.slice(0, 5).map((s, i) => {
    const drop = s.total_price_drop_percent ? `▼${parseFloat(s.total_price_drop_percent).toFixed(0)}%` : '-';
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px;">
          <a href="${tabLink('ads')}" style="${linkStyle}">${s.address || s.city || '-'}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${s.complex_name || ''}</span>
        </td>
        <td style="padding:10px 14px; text-align:center;">
          <span style="background:rgba(248,113,113,0.15); color:#f87171; padding:3px 10px; border-radius:6px; font-weight:700; font-size:13px;">${s.ssi_score}</span>
        </td>
        <td style="padding:10px 14px; color:#f87171; font-weight:600;">${drop}</td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${s.days_on_market || 0} ימים</td>
      </tr>`;
  }).join('');

  const dropRows = priceDrops.slice(0, 5).map((p, i) => {
    const pct = parseFloat(p.total_price_drop_percent || 0).toFixed(1);
    const price = p.asking_price ? `₪${Number(p.asking_price).toLocaleString('he-IL')}` : '-';
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px;">
          <a href="${tabLink('ads')}" style="${linkStyle}">${p.address || p.city || '-'}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${p.complex_name || ''}</span>
        </td>
        <td style="padding:10px 14px; color:#f87171; font-weight:700;">▼${pct}%</td>
        <td style="padding:10px 14px; color:#9aa0b0;">${price}</td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${p.price_changes || 1} שינויים</td>
      </tr>`;
  }).join('');

  const oppHeader = opportunities.some(o => o.investor_purchase_tax)
    ? '<th style="padding:10px 14px; text-align:right; color:#f87171; font-size:12px; font-weight:500;">מס רכישה (8%)</th>'
    : '<th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">יזם</th>';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>QUANTUM Morning Intel</title></head>
<body style="margin:0; padding:0; background:#1e2128; font-family:Arial,sans-serif; color:#e8eaf0;">
<div style="max-width:700px; margin:0 auto; padding:24px 16px;">

  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:24px 28px; margin-bottom:20px; text-align:center;">
    <div style="font-size:11px; color:#4ecdc4; letter-spacing:3px; text-transform:uppercase; margin-bottom:8px;">QUANTUM ANALYZER</div>
    <div style="font-size:22px; font-weight:800; letter-spacing:2px; color:#e8eaf0;">דוח בוקר יומי</div>
    <div style="color:#9aa0b0; font-size:13px; margin-top:6px;">${today} | סריקה #${scanNum}</div>
  </div>

  <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:20px;">
    <a href="${tabLink('complexes')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(78,205,196,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#4ecdc4;">${stats.opportunities}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">הזדמנויות</div>
    </a>
    <a href="${tabLink('ads')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(248,113,113,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#f87171;">${stats.stressed}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">מוכרים לחוצים</div>
    </a>
    <a href="${tabLink('ads')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(232,184,75,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#e8b84b;">${stats.price_drops}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">ירידות מחיר</div>
    </a>
    <a href="${tabLink('complexes')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(139,92,246,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#a78bfa;">${stats.committees}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">אישורי ועדה</div>
    </a>
  </div>

  ${opportunities.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">🏆 הזדמנויות השקעה מובילות</span>
      <a href="${tabLink('complexes')}" style="${linkStyle} font-size:12px;">לכל המתחמים &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">מתחם</th>
          <th style="padding:10px 14px; text-align:center; color:#9aa0b0; font-size:12px; font-weight:500;">IAI</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">שלב</th>
          ${oppHeader}
        </tr>
      </thead>
      <tbody>${oppRows}</tbody>
    </table>
  </div>` : ''}

  ${sellers.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">⚡ מוכרים לחוצים</span>
      <a href="${tabLink('ads')}" style="${linkStyle} font-size:12px;">לכל המודעות &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">כתובת</th>
          <th style="padding:10px 14px; text-align:center; color:#9aa0b0; font-size:12px; font-weight:500;">SSI</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ירידת מחיר</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ימים בשוק</th>
        </tr>
      </thead>
      <tbody>${sellerRows}</tbody>
    </table>
  </div>` : ''}

  ${priceDrops.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">📉 ירידות מחיר ב-24 שעות</span>
      <a href="${tabLink('ads')}" style="${linkStyle} font-size:12px;">לכל המודעות &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">כתובת</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ירידה</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">מחיר נוכחי</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">שינויים</th>
        </tr>
      </thead>
      <tbody>${dropRows}</tbody>
    </table>
  </div>` : ''}

  <div style="text-align:center; padding:20px 0 10px;">
    <a href="${tabLink('dashboard')}" style="background:#4ecdc4; color:#1a1d24; padding:12px 32px; border-radius:8px; font-weight:700; font-size:14px; text-decoration:none; display:inline-block;">פתח דשבורד מלא &larr;</a>
    <div style="color:#6b7280; font-size:11px; margin-top:14px;">QUANTUM Analyzer | דוח אוטומטי יומי 07:30</div>
  </div>

</div>
</body>
</html>`;
}

async function sendMorningReport() {
  try {
    const { shouldSkipToday } = require('../config/israeliHolidays');
    const skipCheck = shouldSkipToday();
    if (skipCheck.shouldSkip) {
      logger.info(`[MorningReport] SKIPPED: ${skipCheck.reason}`);
      return { success: true, skipped: true, reason: skipCheck.reasonHe };
    }

    const todayIL = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS morning_report_log (id SERIAL PRIMARY KEY, sent_date DATE UNIQUE NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW())`);
      const { rows } = await pool.query(`SELECT id FROM morning_report_log WHERE sent_date = $1 LIMIT 1`, [todayIL]);
      if (rows.length > 0) {
        logger.info(`[MorningReport] Already sent today (${todayIL})`);
        return { success: true, skipped: true, reason: `כבר נשלח היום (${todayIL})` };
      }
      await pool.query(`INSERT INTO morning_report_log (sent_date, sent_at) VALUES ($1, NOW()) ON CONFLICT (sent_date) DO NOTHING`, [todayIL]);
    } catch (dbErr) {
      logger.warn('[MorningReport] Dedup check failed (continuing):', dbErr.message);
    }

    logger.info('[MorningReport] Generating...');

    const [oppResult, sellersResult, dropsResult, committeesResult] = await Promise.all([
      pool.query(`
        SELECT id, name, city, iai_score, status, developer, actual_premium,
               address, plan_stage, signature_percent, asking_price, avg_price
        FROM complexes WHERE iai_score >= 60 ORDER BY iai_score DESC LIMIT 8
      `),
      pool.query(`
        SELECT l.id, l.address, l.city, l.asking_price, l.ssi_score, l.days_on_market,
               l.price_changes, l.total_price_drop_percent, c.name as complex_name
        FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
        WHERE l.ssi_score >= 30 ORDER BY l.ssi_score DESC LIMIT 5
      `),
      pool.query(`
        SELECT l.id, l.address, l.city, l.asking_price, l.price_changes,
               l.total_price_drop_percent, c.name as complex_name
        FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
        WHERE l.price_changes > 0 AND l.last_seen >= NOW() - INTERVAL '24 hours'
          AND l.total_price_drop_percent >= 5
        ORDER BY l.total_price_drop_percent DESC LIMIT 5
      `),
      pool.query(`
        SELECT COUNT(*) as count FROM committee_approvals
        WHERE meeting_date >= NOW() - INTERVAL '7 days'
          AND decision_type IN ('approval','advancement','declaration')
      `).catch(() => ({ rows: [{ count: 0 }] }))
    ]);

    // Enrich opportunities with investor tax (internal only — not shown to clients)
    const opportunities = oppResult.rows.map(enrichOpportunityWithTax);
    const sellers = sellersResult.rows;
    const priceDrops = dropsResult.rows;
    const committees = committeesResult.rows;

    const stats = {
      opportunities: opportunities.length,
      stressed: sellers.length,
      stressed_sellers: sellers.length,
      price_drops: priceDrops.length,
      committees: parseInt(committees[0]?.count || 0)
    };

    const today = new Date().toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Asia/Jerusalem'
    });
    const scanNum = Math.floor(Date.now() / 86400000) % 1000 + 100;

    let emailResult = { sent: false };
    try {
      emailResult = await sendEmail({
        subject: `🌅 [QUANTUM] דוח בוקר ${today}`,
        html: buildEmailHtml({ opportunities, sellers, priceDrops, committees, stats, today, scanNum })
      });
    } catch (emailErr) {
      logger.warn('[MorningReport] Email failed:', emailErr.message);
      emailResult = { sent: false, error: emailErr.message };
    }

    logger.info('[MorningReport] Complete', { stats });
    return { success: true, stats, email: emailResult, generated_at: new Date().toISOString() };

  } catch (err) {
    logger.error('[MorningReport] Fatal:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendMorningReport };
