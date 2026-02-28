/**
 * Enhanced Messaging Routes v2
 * 
 * NEW endpoints:
 *   POST /api/messaging/send-filtered   - Send by filter criteria
 *   GET  /api/messaging/templates       - List templates
 *   POST /api/messaging/preview         - Preview message for listing
 *   GET  /api/messaging/dashboard       - Full dashboard stats
 *   GET  /api/messaging/auto-send       - Get auto-send config
 *   PUT  /api/messaging/auto-send       - Update auto-send config
 *   POST /api/messaging/auto-send/test  - Test auto-send with 1 listing
 *   GET  /api/messaging/unsent          - List unsent listings with filters
 * 
 * EXISTING:
 *   POST /send, /send-bulk, /check-replies
 *   PUT  /listing/:id/deal-status, /listing/:id/message-status
 *   GET  /listing/:id/messages, /stats, /status, /deal-statuses
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getOrchestrator() {
  try { return require('../services/messagingOrchestrator'); } catch (e) { 
    logger.warn('messagingOrchestrator not available:', e.message);
    return null; 
  }
}

let yad2Messenger;
try { yad2Messenger = require('../services/yad2Messenger'); } catch (e) {
  logger.warn('yad2Messenger not available:', e.message);
  yad2Messenger = null;
}

// ============================================================
// STATUS & LOGIN
// ============================================================

router.get('/status', (req, res) => {
  const orch = getOrchestrator();
  res.json({
    yad2: yad2Messenger ? yad2Messenger.getStatus() : { available: false },
    orchestrator: orch ? 'available' : 'not loaded',
    auto_send: orch ? orch.getAutoSendConfig() : null
  });
});

router.post('/login', async (req, res) => {
  try {
    if (!yad2Messenger) return res.status(503).json({ error: 'Puppeteer not available' });
    const result = await yad2Messenger.login();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SEND MESSAGES
// ============================================================

router.post('/send', async (req, res) => {
  const { listing_id, message_text, template_id } = req.body;
  if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
  
  try {
    const orch = getOrchestrator();
    const listingResult = await pool.query(
      `SELECT l.*, c.name as complex_name, c.iai_score
       FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`,
      [listing_id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];
    
    let finalMessage = message_text;
    if (!finalMessage && template_id && orch) {
      const templates = orch.getTemplates();
      const tmpl = templates[template_id];
      if (tmpl) finalMessage = orch.fillTemplate(tmpl.template, listing);
    }
    if (!finalMessage) return res.status(400).json({ error: 'message_text or template_id required' });
    
    if (orch) {
      const result = await orch.sendToListing(listing, finalMessage);
      return res.json(result);
    }
    
    // Fallback direct yad2
    const msgRecord = await pool.query(
      `INSERT INTO listing_messages (listing_id, direction, message_text, status) VALUES ($1, 'sent', $2, 'pending') RETURNING id`,
      [listing_id, finalMessage]
    );
    let result = { success: false, status: 'manual' };
    if (yad2Messenger && yad2Messenger.getStatus().hasCredentials) {
      let itemUrl = listing.url || `https://www.yad2.co.il/item/${listing.source_listing_id}`;
      result = await yad2Messenger.sendMessage(itemUrl, finalMessage);
    }
    await pool.query(`UPDATE listing_messages SET status = $1, error_message = $2 WHERE id = $3`,
      [result.success ? 'sent' : 'failed', result.error || null, msgRecord.rows[0].id]);
    if (result.success) await pool.query(`UPDATE listings SET message_status = 'נשלחה', last_message_sent_at = NOW() WHERE id = $1`, [listing_id]);
    res.json({ listing_id, message_id: msgRecord.rows[0].id, ...result });
  } catch (err) {
    logger.error('Send message failed', { listing_id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-bulk', async (req, res) => {
  const { listing_ids, message_template, template_id } = req.body;
  if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'listing_ids array required' });
  if (!message_template && !template_id) return res.status(400).json({ error: 'message_template or template_id required' });
  
  const orch = getOrchestrator();
  const results = [];
  for (const lid of listing_ids) {
    try {
      const listing = await pool.query(
        `SELECT l.*, c.name as complex_name, c.iai_score
         FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`, [lid]);
      if (listing.rows.length === 0) { results.push({ listing_id: lid, success: false, error: 'Not found' }); continue; }
      const l = listing.rows[0];
      let msg;
      if (template_id && orch) {
        const tmpl = orch.getTemplates()[template_id];
        msg = tmpl ? orch.fillTemplate(tmpl.template, l) : message_template;
      } else {
        msg = message_template.replace(/{address}/g, l.address || '').replace(/{city}/g, l.city || '')
          .replace(/{price}/g, l.asking_price ? `${Number(l.asking_price).toLocaleString()} ש"ח` : '')
          .replace(/{rooms}/g, l.rooms || '').replace(/{area}/g, l.area_sqm || '').replace(/{platform}/g, 'יד2');
      }
      if (orch) { results.push(await orch.sendToListing(l, msg)); }
      else { results.push({ listing_id: lid, success: false, error: 'Orchestrator not available' }); }
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    } catch (err) { results.push({ listing_id: lid, success: false, error: err.message }); }
  }
  res.json({ total: listing_ids.length, sent: results.filter(r => r.success || r.whatsapp_link).length, failed: results.filter(r => !r.success && !r.whatsapp_link).length, results });
});

// ============================================================
// NEW: FILTER-BASED MESSAGING
// ============================================================

router.post('/send-filtered', async (req, res) => {
  const { filters = {}, template_id = 'yad2_seller', extra_vars = {} } = req.body;
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Messaging orchestrator not available' });
  try {
    const result = await orch.sendByFilter(filters, template_id, extra_vars);
    res.json(result);
  } catch (err) {
    logger.error('send-filtered failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/unsent', async (req, res) => {
  try {
    let conditions = [`l.is_active = TRUE`, `(l.message_status IS NULL OR l.message_status = 'לא נשלחה')`];
    let params = []; let idx = 1;
    if (req.query.city) { conditions.push(`l.city = $${idx++}`); params.push(req.query.city); }
    if (req.query.platform || req.query.source) { conditions.push(`l.source = $${idx++}`); params.push(req.query.platform || req.query.source); }
    if (req.query.min_ssi) { conditions.push(`l.ssi_score >= $${idx++}`); params.push(parseFloat(req.query.min_ssi)); }
    if (req.query.min_iai) { conditions.push(`c.iai_score >= $${idx++}`); params.push(parseFloat(req.query.min_iai)); }
    if (req.query.max_price) { conditions.push(`l.asking_price <= $${idx++}`); params.push(parseFloat(req.query.max_price)); }
    if (req.query.complex_id) { conditions.push(`l.complex_id = $${idx++}`); params.push(parseInt(req.query.complex_id)); }
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await pool.query(`
      SELECT l.id, l.address, l.city, l.asking_price, l.rooms, l.area_sqm, l.floor,
             l.source, l.url, l.source_listing_id,
             l.message_status, l.deal_status, l.created_at, l.ssi_score,
             c.name as complex_name, c.iai_score
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `, params);
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE ${conditions.join(' AND ')}
    `, params);
    res.json({ total: parseInt(countResult.rows[0].total), returned: result.rows.length, offset, listings: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TEMPLATES
// ============================================================

router.get('/templates', (req, res) => {
  const orch = getOrchestrator();
  res.json({ templates: orch ? orch.getTemplates() : {} });
});

router.post('/preview', async (req, res) => {
  const { listing_id, template_id = 'yad2_seller', extra_vars = {} } = req.body;
  if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  try {
    const preview = await orch.previewMessage(listing_id, template_id, extra_vars);
    res.json(preview);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AUTO-SEND CONFIG
// ============================================================

router.get('/auto-send', (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  res.json(orch.getAutoSendConfig());
});

router.put('/auto-send', (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  const config = orch.updateAutoSendConfig(req.body);
  res.json({ success: true, config });
});

router.post('/auto-send/test', async (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  try {
    const listing = await pool.query(`
      SELECT l.id FROM listings l
      WHERE l.is_active = TRUE AND (l.message_status IS NULL OR l.message_status = 'לא נשלחה')
      ORDER BY l.created_at DESC LIMIT 1`);
    if (listing.rows.length === 0) return res.json({ success: false, message: 'No unsent listings found' });
    const prevEnabled = orch.getAutoSendConfig().enabled;
    orch.updateAutoSendConfig({ enabled: true });
    const result = await orch.autoSendToNewListings([listing.rows[0].id]);
    orch.updateAutoSendConfig({ enabled: prevEnabled });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// DASHBOARD
// ============================================================

router.get('/dashboard', async (req, res) => {
  const orch = getOrchestrator();
  if (orch) {
    try { res.json(await orch.getDashboardStats()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  } else {
    try {
      const stats = await pool.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as unsent,
          COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent
        FROM listings WHERE is_active = TRUE`);
      res.json({ overview: stats.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
});

// ============================================================
// EXISTING ROUTES
// ============================================================

router.post('/check-replies', async (req, res) => {
  try {
    if (!yad2Messenger) return res.status(503).json({ error: 'Puppeteer not available' });
    const result = await yad2Messenger.checkReplies();
    if (result.new_replies && result.new_replies.length > 0) {
      for (const reply of result.new_replies) {
        await pool.query(`INSERT INTO listing_messages (listing_id, direction, message_text, status) VALUES (NULL, 'received', $1, 'received')`, [reply.reply_text]);
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/listing/:id/deal-status', async (req, res) => {
  const { id } = req.params;
  const { deal_status, notes } = req.body;
  const validStatuses = ['חדש', 'נשלחה הודעה', 'התקבלה תשובה', 'תיווך', 'ללא תיווך', 'נמכרה', 'לא רלוונטי', 'נא ליצור קשר', 'בטיפול', 'סגור'];
  if (deal_status && !validStatuses.includes(deal_status)) return res.status(400).json({ error: 'Invalid deal_status', valid: validStatuses });
  try {
    const updates = []; const values = []; let idx = 1;
    if (deal_status) { updates.push(`deal_status = $${idx++}`); values.push(deal_status); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`, values);
    res.json({ success: true, listing_id: parseInt(id), deal_status, notes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/listing/:id/message-status', async (req, res) => {
  const { id } = req.params;
  const { message_status, last_reply_text } = req.body;
  try {
    const updates = ['message_status = $1']; const values = [message_status];
    if (last_reply_text) { updates.push('last_reply_text = $2', 'last_reply_at = NOW()'); values.push(last_reply_text); }
    values.push(id);
    await pool.query(`UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);
    res.json({ success: true, listing_id: parseInt(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/listing/:id/messages', async (req, res) => {
  try {
    const messages = await pool.query(`SELECT * FROM listing_messages WHERE listing_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ listing_id: parseInt(req.params.id), messages: messages.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as not_sent,
        COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent,
        COUNT(*) FILTER (WHERE message_status = 'קישור וואטסאפ') as whatsapp_links,
        COUNT(*) FILTER (WHERE message_status = 'התקבלה תשובה') as replied,
        COUNT(*) FILTER (WHERE deal_status = 'חדש' OR deal_status IS NULL) as new_leads,
        COUNT(*) FILTER (WHERE deal_status = 'תיווך') as brokered,
        COUNT(*) FILTER (WHERE deal_status = 'בטיפול') as in_progress,
        COUNT(*) as total
      FROM listings WHERE is_active = TRUE`);
    const msgCount = await pool.query(`
      SELECT COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE direction = 'sent') as total_sent,
        COUNT(*) FILTER (WHERE direction = 'received') as total_received
      FROM listing_messages`);
    res.json({ listings: stats.rows[0], messages: msgCount.rows[0], messenger: yad2Messenger ? yad2Messenger.getStatus() : { available: false } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/deal-statuses', (req, res) => {
  res.json({ statuses: [
    { value: 'חדש', label: 'חדש', color: '#94a3b8' },
    { value: 'נשלחה הודעה', label: 'נשלחה הודעה', color: '#60a5fa' },
    { value: 'התקבלה תשובה', label: 'התקבלה תשובה', color: '#34d399' },
    { value: 'תיווך', label: 'תיווך', color: '#f97316' },
    { value: 'ללא תיווך', label: 'ללא תיווך', color: '#a78bfa' },
    { value: 'נמכרה', label: 'נמכרה', color: '#ef4444' },
    { value: 'לא רלוונטי', label: 'לא רלוונטי', color: '#6b7280' },
    { value: 'נא ליצור קשר', label: 'נא ליצור קשר', color: '#facc15' },
    { value: 'בטיפול', label: 'בטיפול', color: '#22d3ee' },
    { value: 'סגור', label: 'סגור', color: '#1e293b' }
  ] });
});

module.exports = router;