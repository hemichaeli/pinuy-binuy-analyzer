/**
 * Messaging Routes - Send/track messages to yad2 sellers
 * v4.15.0
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

let yad2Messenger;
try {
  yad2Messenger = require('../services/yad2Messenger');
} catch (e) {
  logger.warn('yad2Messenger not available (puppeteer may not be installed)', { error: e.message });
}

// GET /api/messaging/status - Messenger status
router.get('/status', (req, res) => {
  const status = yad2Messenger ? yad2Messenger.getStatus() : { available: false, reason: 'puppeteer not installed' };
  res.json(status);
});

// POST /api/messaging/login - Login to yad2
router.post('/login', async (req, res) => {
  try {
    if (!yad2Messenger) {
      return res.status(503).json({ error: 'Puppeteer not available' });
    }
    const result = await yad2Messenger.login();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messaging/send - Send message to one listing
router.post('/send', async (req, res) => {
  const { listing_id, message_text } = req.body;
  if (!listing_id || !message_text) {
    return res.status(400).json({ error: 'listing_id and message_text required' });
  }

  try {
    // Get listing details
    const listing = await pool.query(
      'SELECT id, url, source_listing_id, address, city, asking_price FROM listings WHERE id = $1',
      [listing_id]
    );
    if (listing.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const l = listing.rows[0];
    let itemUrl = l.url;
    
    // Ensure we have an item URL (not search URL)
    if (l.source_listing_id && !itemUrl.includes('/item/')) {
      itemUrl = `https://www.yad2.co.il/item/${l.source_listing_id}`;
    }

    // Save message record
    const msgRecord = await pool.query(
      `INSERT INTO listing_messages (listing_id, direction, message_text, status)
       VALUES ($1, 'sent', $2, 'pending') RETURNING id`,
      [listing_id, message_text]
    );
    const msgId = msgRecord.rows[0].id;

    // Try to send via Puppeteer
    let result;
    if (yad2Messenger && yad2Messenger.getStatus().hasCredentials) {
      result = await yad2Messenger.sendMessage(itemUrl, message_text);
    } else {
      result = { success: false, status: 'manual', error: 'Puppeteer not configured - use manual send' };
    }

    // Update message record
    await pool.query(
      `UPDATE listing_messages SET status = $1, error_message = $2 WHERE id = $3`,
      [result.success ? 'sent' : (result.status || 'failed'), result.error || null, msgId]
    );

    // Update listing status
    if (result.success) {
      await pool.query(
        `UPDATE listings SET message_status = 'נשלחה', last_message_sent_at = NOW() WHERE id = $1`,
        [listing_id]
      );
    }

    res.json({
      message_id: msgId,
      listing_id,
      url: itemUrl,
      result
    });
  } catch (err) {
    logger.error('Send message failed', { listing_id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messaging/send-bulk - Send to multiple listings
router.post('/send-bulk', async (req, res) => {
  const { listing_ids, message_template } = req.body;
  if (!listing_ids || !listing_ids.length || !message_template) {
    return res.status(400).json({ error: 'listing_ids array and message_template required' });
  }

  const results = [];
  for (const lid of listing_ids) {
    try {
      // Get listing for template replacement
      const listing = await pool.query(
        'SELECT id, url, source_listing_id, address, city, asking_price, rooms, area_sqm FROM listings WHERE id = $1',
        [lid]
      );
      if (listing.rows.length === 0) {
        results.push({ listing_id: lid, success: false, error: 'Not found' });
        continue;
      }

      const l = listing.rows[0];
      // Replace template vars
      let msg = message_template
        .replace(/{address}/g, l.address || '')
        .replace(/{city}/g, l.city || '')
        .replace(/{price}/g, l.asking_price ? `${Number(l.asking_price).toLocaleString()} ש"ח` : '')
        .replace(/{rooms}/g, l.rooms || '')
        .replace(/{area}/g, l.area_sqm || '')
        .replace(/{platform}/g, 'יד2');

      let itemUrl = l.url;
      if (l.source_listing_id && !itemUrl.includes('/item/')) {
        itemUrl = `https://www.yad2.co.il/item/${l.source_listing_id}`;
      }

      // Save message
      const msgRecord = await pool.query(
        `INSERT INTO listing_messages (listing_id, direction, message_text, status)
         VALUES ($1, 'sent', $2, 'pending') RETURNING id`,
        [lid, msg]
      );

      // Try Puppeteer send
      let result;
      if (yad2Messenger && yad2Messenger.getStatus().hasCredentials) {
        result = await yad2Messenger.sendMessage(itemUrl, msg);
        // Throttle between sends
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      } else {
        result = { success: false, status: 'manual' };
      }

      await pool.query(
        `UPDATE listing_messages SET status = $1, error_message = $2 WHERE id = $3`,
        [result.success ? 'sent' : (result.status || 'failed'), result.error || null, msgRecord.rows[0].id]
      );

      if (result.success) {
        await pool.query(
          `UPDATE listings SET message_status = 'נשלחה', last_message_sent_at = NOW() WHERE id = $1`,
          [lid]
        );
      }

      results.push({ listing_id: lid, message_id: msgRecord.rows[0].id, success: result.success, url: itemUrl });
    } catch (err) {
      results.push({ listing_id: lid, success: false, error: err.message });
    }
  }

  res.json({
    total: listing_ids.length,
    sent: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  });
});

// POST /api/messaging/check-replies - Scan yad2 inbox for replies
router.post('/check-replies', async (req, res) => {
  try {
    if (!yad2Messenger) {
      return res.status(503).json({ error: 'Puppeteer not available' });
    }
    const result = await yad2Messenger.checkReplies();
    
    // Save any new replies to DB
    if (result.new_replies && result.new_replies.length > 0) {
      for (const reply of result.new_replies) {
        // Try to match reply to a listing by conversation URL or content
        // For now, save as unmatched and let user associate
        await pool.query(
          `INSERT INTO listing_messages (listing_id, direction, message_text, status)
           VALUES (NULL, 'received', $1, 'received')`,
          [reply.reply_text]
        );
      }
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/messaging/listing/:id/deal-status - Update deal status
router.put('/listing/:id/deal-status', async (req, res) => {
  const { id } = req.params;
  const { deal_status, notes } = req.body;
  
  const validStatuses = ['חדש', 'נשלחה הודעה', 'התקבלה תשובה', 'תיווך', 'ללא תיווך', 'נמכרה', 'לא רלוונטי', 'נא ליצור קשר', 'בטיפול', 'סגור'];
  
  if (deal_status && !validStatuses.includes(deal_status)) {
    return res.status(400).json({ error: 'Invalid deal_status', valid: validStatuses });
  }

  try {
    const updates = [];
    const values = [];
    let idx = 1;

    if (deal_status) {
      updates.push(`deal_status = $${idx++}`);
      values.push(deal_status);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${idx++}`);
      values.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(id);
    await pool.query(
      `UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      values
    );

    res.json({ success: true, listing_id: parseInt(id), deal_status, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/messaging/listing/:id/message-status - Update message status
router.put('/listing/:id/message-status', async (req, res) => {
  const { id } = req.params;
  const { message_status, last_reply_text } = req.body;
  
  try {
    const updates = ['message_status = $1'];
    const values = [message_status];
    
    if (last_reply_text) {
      updates.push('last_reply_text = $2', 'last_reply_at = NOW()');
      values.push(last_reply_text);
    }
    
    values.push(id);
    await pool.query(
      `UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    res.json({ success: true, listing_id: parseInt(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messaging/listing/:id/messages - Message history for a listing
router.get('/listing/:id/messages', async (req, res) => {
  try {
    const messages = await pool.query(
      `SELECT * FROM listing_messages WHERE listing_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ listing_id: parseInt(req.params.id), messages: messages.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messaging/stats - Messaging statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE message_status = 'לא נשלחה') as not_sent,
        COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent,
        COUNT(*) FILTER (WHERE message_status = 'התקבלה תשובה') as replied,
        COUNT(*) FILTER (WHERE deal_status = 'חדש' OR deal_status IS NULL) as new_leads,
        COUNT(*) FILTER (WHERE deal_status = 'תיווך') as brokered,
        COUNT(*) FILTER (WHERE deal_status = 'ללא תיווך') as no_broker,
        COUNT(*) FILTER (WHERE deal_status = 'נמכרה') as sold,
        COUNT(*) FILTER (WHERE deal_status = 'לא רלוונטי') as irrelevant,
        COUNT(*) FILTER (WHERE deal_status = 'בטיפול') as in_progress,
        COUNT(*) FILTER (WHERE deal_status = 'נא ליצור קשר') as call_requested,
        COUNT(*) as total
      FROM listings WHERE is_active = TRUE
    `);
    
    const msgCount = await pool.query(`
      SELECT COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE direction = 'sent') as total_sent,
        COUNT(*) FILTER (WHERE direction = 'received') as total_received
      FROM listing_messages
    `);

    res.json({
      listings: stats.rows[0],
      messages: msgCount.rows[0],
      messenger: yad2Messenger ? yad2Messenger.getStatus() : { available: false }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messaging/deal-statuses - List valid deal statuses
router.get('/deal-statuses', (req, res) => {
  res.json({
    statuses: [
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
    ]
  });
});

module.exports = router;
