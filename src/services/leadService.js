/**
 * Lead Management Service for QUANTUM
 * Handles: DB storage, email notifications, Trello cards, lead scoring
 * v1.1.0 - Added contact form support
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const notificationService = require('./notificationService');
const trelloService = require('./trelloService');

async function ensureLeadsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS website_leads (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
        phone TEXT NOT NULL, phone_verified BOOLEAN DEFAULT FALSE,
        user_type TEXT NOT NULL, form_data JSONB DEFAULT '{}',
        mailing_list_consent BOOLEAN DEFAULT FALSE, source TEXT DEFAULT 'website',
        is_urgent BOOLEAN DEFAULT FALSE, trello_card_id TEXT, trello_card_url TEXT,
        email_sent BOOLEAN DEFAULT FALSE, notes TEXT, status TEXT DEFAULT 'new',
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_type ON website_leads(user_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_status ON website_leads(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_created ON website_leads(created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_urgent ON website_leads(is_urgent) WHERE is_urgent = TRUE`);
    // Campaign tracking columns (idempotent)
    await pool.query(`ALTER TABLE website_leads ADD COLUMN IF NOT EXISTS campaign_tag TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE website_leads ADD COLUMN IF NOT EXISTS utm_source TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE website_leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_campaign ON website_leads(campaign_tag)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_website_leads_utm ON website_leads(utm_source)`).catch(() => {});
  } catch (err) {
    logger.warn('Lead table migration note:', err.message);
  }
}

function isLeadUrgent(lead) {
  const { user_type, form_data } = lead;
  if (user_type === 'contact') return false;
  const data = typeof form_data === 'string' ? JSON.parse(form_data) : (form_data || {});

  if (user_type === 'investor') {
    if (data.budget === '5m+') return true;
    if (data.hasMultipleInvestments === true) return true;
    if ((data.areas || []).length >= 3) return true;
  }

  if (user_type === 'owner') {
    if (data.propertyType === 'building' || data.propertyType === 'commercial') return true;
    if (data.hasMultipleProperties === true) return true;
    if (data.status === 'project') return true;
    if (data.purpose === 'offer') return true;
  }

  return false;
}

function getLeadAddressString(lead) {
  const data = typeof lead.form_data === 'string' ? JSON.parse(lead.form_data) : (lead.form_data || {});
  if (lead.user_type === 'owner' && data.addresses) {
    return data.addresses.map(a => `${a.street} ${a.buildingNumber}, ${a.city}`).join(' | ');
  }
  if (lead.user_type === 'investor' && data.areas) {
    const areaMap = { 'center': 'מרכז', 'sharon': 'השרון', 'north': 'צפון', 'south': 'דרום', 'jerusalem': 'ירושלים', 'haifa': 'חיפה והקריות' };
    return data.areas.map(a => areaMap[a] || a).join(', ');
  }
  return '';
}

const TYPE_LABELS = {
  investor: { emoji: '🏢', label: 'משקיע חדש' },
  owner: { emoji: '🏠', label: 'מוכר חדש' },
  contact: { emoji: '📩', label: 'פנייה - צור קשר' }
};

function formatLeadEmailHTML(lead) {
  const typeInfo = TYPE_LABELS[lead.user_type] || TYPE_LABELS.contact;
  const urgentBadge = lead.is_urgent ? '<span style="background:#dc2626;color:white;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold;">URGENT</span>' : '';
  const data = typeof lead.form_data === 'string' ? JSON.parse(lead.form_data) : (lead.form_data || {});

  let detailsHTML = '';
  if (lead.user_type === 'investor') {
    const budgetMap = { '1-2m': '1-2 מיליון ₪', '2-5m': '2-5 מיליון ₪', '5m+': '5 מיליון ₪+' };
    const horizonMap = { 'short': 'טווח קצר', 'long': 'טווח ארוך' };
    const areaMap = { 'center': 'מרכז', 'sharon': 'השרון', 'north': 'צפון', 'south': 'דרום', 'jerusalem': 'ירושלים', 'haifa': 'חיפה והקריות' };
    detailsHTML = `
      <tr><td style="padding:4px 8px;font-weight:bold;">תקציב:</td><td>${budgetMap[data.budget] || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">אזורים:</td><td>${(data.areas || []).map(a => areaMap[a] || a).join(', ') || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">אופק:</td><td>${horizonMap[data.horizon] || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">מספר נכסים:</td><td>${data.hasMultipleInvestments ? 'כן' : 'נכס אחד'}</td></tr>`;
  } else if (lead.user_type === 'owner') {
    const propertyTypeMap = { 'residential': 'דירת מגורים', 'building': 'בניין שלם', 'commercial': 'נכס מסחרי' };
    const purposeMap = { 'rights': 'בדיקת זכויות', 'offer': 'רכישה מהירה', 'management': 'ניהול' };
    const statusMap = { 'project': 'יש פרויקט', 'no-info': 'אין מידע' };
    const addresses = (data.addresses || []).map(a => `${a.street} ${a.buildingNumber}, ${a.city}`).join('<br>');
    detailsHTML = `
      <tr><td style="padding:4px 8px;font-weight:bold;">כתובות:</td><td>${addresses || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">סוג נכס:</td><td>${propertyTypeMap[data.propertyType] || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">מטרה:</td><td>${purposeMap[data.purpose] || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">סטטוס:</td><td>${statusMap[data.status] || '-'}</td></tr>
      <tr><td style="padding:4px 8px;font-weight:bold;">מספר נכסים:</td><td>${data.hasMultipleProperties ? 'כן' : 'נכס אחד'}</td></tr>`;
  } else if (lead.user_type === 'contact') {
    const message = data.message || data.notes || '';
    const subject = data.subject || '';
    detailsHTML = `
      ${subject ? `<tr><td style="padding:4px 8px;font-weight:bold;">נושא:</td><td>${subject}</td></tr>` : ''}
      <tr><td style="padding:4px 8px;font-weight:bold;vertical-align:top;">הודעה:</td><td style="white-space:pre-wrap;">${message || 'ללא הודעה'}</td></tr>`;
  }

  return `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#1e3a5f,#0f2b46);color:white;padding:20px;border-radius:8px 8px 0 0;">
      <h1 style="margin:0;font-size:22px;">${typeInfo.emoji} QUANTUM - ${typeInfo.label} ${urgentBadge}</h1>
      <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</p>
    </div>
    <div style="background:#fff;padding:20px;border:1px solid #e5e7eb;">
      <h2 style="color:#1e3a5f;margin:0 0 16px;font-size:18px;">פרטי קשר</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 8px;font-weight:bold;">שם:</td><td>${lead.name}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold;">טלפון:</td><td><a href="tel:${lead.phone}">${lead.phone}</a></td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold;">אימייל:</td><td><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
      </table>
      ${detailsHTML ? `<h2 style="color:#1e3a5f;margin:20px 0 16px;font-size:18px;">פרטים</h2><table style="width:100%;border-collapse:collapse;">${detailsHTML}</table>` : ''}
      ${lead.mailing_list_consent ? '<p style="color:#16a34a;font-size:12px;margin-top:16px;">✅ אישר/ה רשימת תפוצה</p>' : ''}
    </div>
    <div style="background:#f9fafb;padding:12px 20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">QUANTUM Lead Management v1.1</p>
    </div></div>`;
}

async function processNewLead(leadData) {
  const results = { saved: false, emailSent: false, trelloCreated: false, leadId: null, errors: [] };

  try {
    await ensureLeadsTable();
    const isUrgent = isLeadUrgent(leadData);

    // 1. Save to database
    try {
      const insertResult = await pool.query(`
        INSERT INTO website_leads (name, email, phone, phone_verified, user_type, form_data, mailing_list_consent, is_urgent, source, campaign_tag, utm_source, utm_campaign)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
      `, [leadData.name, leadData.email, leadData.phone, leadData.phone_verified || false,
        leadData.user_type, JSON.stringify(leadData.form_data || {}),
        leadData.mailing_list_consent || false, isUrgent, leadData.source || 'website',
        leadData.campaign_tag || null, leadData.utm_source || null, leadData.utm_campaign || null]);
      results.leadId = insertResult.rows[0].id;
      results.saved = true;
      logger.info(`Lead saved: #${results.leadId} (${leadData.user_type}) ${isUrgent ? '[URGENT]' : ''}`);
    } catch (err) {
      logger.error('Failed to save lead to DB:', err.message);
      results.errors.push({ step: 'db', error: err.message });
    }

    const lead = { ...leadData, id: results.leadId, is_urgent: isUrgent };

    // 2. Send email notification
    try {
      const typeInfo = TYPE_LABELS[leadData.user_type] || TYPE_LABELS.contact;
      const urgentPrefix = isUrgent ? '🚨 URGENT ' : '';
      const subject = `${urgentPrefix}${typeInfo.emoji} [QUANTUM] ${typeInfo.label}: ${leadData.name}`;
      const htmlBody = formatLeadEmailHTML(lead);

      const emailTargets = [notificationService.PERSONAL_EMAIL, notificationService.OFFICE_EMAIL].filter(Boolean);
      let sentCount = 0;
      for (const email of emailTargets) {
        try {
          const result = await notificationService.sendEmail(email, subject, htmlBody);
          if (result.sent) sentCount++;
        } catch (err) { logger.warn(`Lead email to ${email} failed:`, err.message); }
      }
      results.emailSent = sentCount > 0;
      if (results.emailSent && results.leadId) {
        await pool.query('UPDATE website_leads SET email_sent = TRUE WHERE id = $1', [results.leadId]).catch(() => {});
      }
      logger.info(`Lead email: ${sentCount}/${emailTargets.length} sent`);
    } catch (err) {
      logger.error('Failed to send lead email:', err.message);
      results.errors.push({ step: 'email', error: err.message });
    }

    // 3. Create Trello card
    try {
      if (trelloService.isConfigured()) {
        let trelloResult;
        if (leadData.user_type === 'investor') {
          trelloResult = await trelloService.createInvestorCard(lead);
        } else if (leadData.user_type === 'owner') {
          trelloResult = await trelloService.createSellerCard(lead);
        } else if (leadData.user_type === 'contact') {
          trelloResult = await trelloService.createContactCard(lead);
        } else {
          // Unknown type fallback to contact
          trelloResult = await trelloService.createContactCard(lead);
        }
        results.trelloCreated = trelloResult.success;
        if (trelloResult.success && results.leadId) {
          await pool.query('UPDATE website_leads SET trello_card_id = $1, trello_card_url = $2 WHERE id = $3',
            [trelloResult.cardId, trelloResult.url, results.leadId]).catch(() => {});
        }
        // System notification card (skip for contact - the card itself is the notification)
        if (leadData.user_type !== 'contact') {
          const typeInfo = TYPE_LABELS[leadData.user_type] || TYPE_LABELS.contact;
          await trelloService.createNotificationCard(
            `ליד חדש: ${typeInfo.label} - ${leadData.name}`,
            `${isUrgent ? '🚨 URGENT\n\n' : ''}טלפון: ${leadData.phone}\nאימייל: ${leadData.email}\nכתובת/אזור: ${getLeadAddressString(lead)}`
          ).catch(err => logger.warn('Notification card failed:', err.message));
        }
      } else {
        // Fallback: Trello email-to-board
        try {
          const trelloEmail = notificationService.TRELLO_EMAIL;
          if (trelloEmail) {
            const typeInfo = TYPE_LABELS[leadData.user_type] || TYPE_LABELS.contact;
            const subject = `${isUrgent ? '🚨 ' : ''}${typeInfo.label}: ${leadData.name}`;
            const body = `שם: ${leadData.name}\nטלפון: ${leadData.phone}\nאימייל: ${leadData.email}\nסוג: ${typeInfo.label}\nכתובת/אזור: ${getLeadAddressString(lead)}${isUrgent ? '\n\n🚨 URGENT' : ''}\n\nתאריך: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;
            const result = await notificationService.sendEmail(trelloEmail, subject, body, body);
            results.trelloCreated = result.sent;
          }
        } catch (err) { logger.warn('Trello email fallback failed:', err.message); }
      }
    } catch (err) {
      logger.error('Failed to create Trello card:', err.message);
      results.errors.push({ step: 'trello', error: err.message });
    }

    logger.info(`Lead processed: #${results.leadId}`, { type: leadData.user_type, urgent: isUrgent, db: results.saved, email: results.emailSent, trello: results.trelloCreated });
    return results;
  } catch (err) {
    logger.error('Lead processing failed:', err.message);
    results.errors.push({ step: 'general', error: err.message });
    return results;
  }
}

async function getLeads({ type, status, urgent, limit = 50, offset = 0 } = {}) {
  await ensureLeadsTable();
  let query = 'SELECT * FROM website_leads WHERE 1=1';
  const params = [];
  let pc = 0;
  if (type) { pc++; query += ` AND user_type = $${pc}`; params.push(type); }
  if (status) { pc++; query += ` AND status = $${pc}`; params.push(status); }
  if (urgent !== undefined) { pc++; query += ` AND is_urgent = $${pc}`; params.push(urgent); }
  query += ' ORDER BY created_at DESC';
  pc++; query += ` LIMIT $${pc}`; params.push(limit);
  pc++; query += ` OFFSET $${pc}`; params.push(offset);
  const result = await pool.query(query, params);
  const counts = await pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN user_type='investor' THEN 1 END) as investors, COUNT(CASE WHEN user_type='owner' THEN 1 END) as sellers, COUNT(CASE WHEN user_type='contact' THEN 1 END) as contacts, COUNT(CASE WHEN is_urgent=TRUE THEN 1 END) as urgent, COUNT(CASE WHEN status='new' THEN 1 END) as new_leads FROM website_leads`);
  return { leads: result.rows, counts: counts.rows[0], pagination: { limit, offset, returned: result.rows.length } };
}

async function updateLeadStatus(leadId, status, notes = null) {
  const fields = ['status = $1', 'updated_at = NOW()'];
  const params = [status];
  let pc = 1;
  if (notes !== null) { pc++; fields.push(`notes = $${pc}`); params.push(notes); }
  pc++; params.push(leadId);
  await pool.query(`UPDATE website_leads SET ${fields.join(', ')} WHERE id = $${pc}`, params);
  return { updated: true };
}

async function getLeadStats() {
  await ensureLeadsTable();
  const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN user_type='investor' THEN 1 END) as investors, COUNT(CASE WHEN user_type='owner' THEN 1 END) as sellers, COUNT(CASE WHEN user_type='contact' THEN 1 END) as contacts, COUNT(CASE WHEN is_urgent=TRUE THEN 1 END) as urgent, COUNT(CASE WHEN status='new' THEN 1 END) as new_leads, COUNT(CASE WHEN status='contacted' THEN 1 END) as contacted, COUNT(CASE WHEN status='qualified' THEN 1 END) as qualified, COUNT(CASE WHEN status='closed' THEN 1 END) as closed, COUNT(CASE WHEN email_sent=TRUE THEN 1 END) as emails_sent, COUNT(CASE WHEN trello_card_id IS NOT NULL THEN 1 END) as trello_cards, COUNT(CASE WHEN created_at > NOW()-INTERVAL '24 hours' THEN 1 END) as last_24h, COUNT(CASE WHEN created_at > NOW()-INTERVAL '7 days' THEN 1 END) as last_7d, MIN(created_at) as first_lead, MAX(created_at) as last_lead FROM website_leads`);
  return stats.rows[0];
}

module.exports = { processNewLead, getLeads, updateLeadStatus, getLeadStats, ensureLeadsTable, isLeadUrgent, getLeadAddressString };
