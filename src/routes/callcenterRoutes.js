/**
 * External Call Center Routes
 *
 * Allows QUANTUM admin to create "call lists" from filtered listings,
 * share a link with an external call center, and let agents update
 * call outcomes: interested, sent agreement, not interested, etc.
 *
 * Admin routes (require dashboard access):
 *   POST /api/callcenter/lists           — Create new call list
 *   GET  /api/callcenter/lists           — All lists
 *   GET  /api/callcenter/lists/:id       — Single list with items
 *   DELETE /api/callcenter/lists/:id     — Delete list
 *   GET  /api/callcenter/lists/:id/stats — Summary stats
 *
 * External routes (token-based, no auth):
 *   GET  /callcenter/:token              — Serve call center page
 *   GET  /api/callcenter/ext/:token      — Get list data (JSON)
 *   PUT  /api/callcenter/ext/:token/item/:itemId — Update item status
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration ──────────────────────────────────────────────────────────

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS callcenter_lists (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token VARCHAR(64) NOT NULL UNIQUE,
        created_by VARCHAR(100) DEFAULT 'admin',
        filters JSONB DEFAULT '{}',
        notes TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS callcenter_items (
        id SERIAL PRIMARY KEY,
        list_id INTEGER NOT NULL REFERENCES callcenter_lists(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id),
        contact_name VARCHAR(255),
        phone VARCHAR(50) NOT NULL,
        email VARCHAR(255),
        address VARCHAR(500),
        city VARCHAR(100),
        rooms VARCHAR(20),
        price VARCHAR(50),
        source VARCHAR(50),
        notes TEXT,
        call_status VARCHAR(50) DEFAULT 'pending',
        na_count INTEGER DEFAULT 0,
        call_outcome VARCHAR(100),
        agent_name VARCHAR(100),
        called_at TIMESTAMPTZ,
        agreement_sent BOOLEAN DEFAULT FALSE,
        agreement_sent_at TIMESTAMPTZ,
        agreement_token VARCHAR(64),
        agreement_signed BOOLEAN DEFAULT FALSE,
        agreement_signed_at TIMESTAMPTZ,
        agreement_channel VARCHAR(50),
        interested BOOLEAN,
        follow_up_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_callcenter_items_list ON callcenter_items(list_id);
      CREATE INDEX IF NOT EXISTS idx_callcenter_items_status ON callcenter_items(call_status);
      CREATE INDEX IF NOT EXISTS idx_callcenter_lists_token ON callcenter_lists(token);

      -- Add columns for existing tables
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS na_count INTEGER DEFAULT 0;
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS agreement_token VARCHAR(64);
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS agreement_signed BOOLEAN DEFAULT FALSE;
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS agreement_signed_at TIMESTAMPTZ;
      ALTER TABLE callcenter_items ADD COLUMN IF NOT EXISTS agreement_channel VARCHAR(50);
      CREATE INDEX IF NOT EXISTS idx_callcenter_items_agreement_token ON callcenter_items(agreement_token) WHERE agreement_token IS NOT NULL;
    `);
    logger.info('[CallCenter] Tables ready');
  } catch (e) {
    logger.warn('[CallCenter] Migration:', e.message);
  }
})();

// ============================================================
// ADMIN: Create call list from filtered listings
// ============================================================

router.post('/lists', async (req, res) => {
  try {
    const { name, listing_ids, filters, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const token = crypto.randomBytes(24).toString('hex');

    // Create list
    const { rows: [list] } = await pool.query(`
      INSERT INTO callcenter_lists (name, token, filters, notes)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, token, JSON.stringify(filters || {}), notes || null]);

    let items = [];

    if (listing_ids && listing_ids.length > 0) {
      // Use specific listing IDs
      const { rows: listings } = await pool.query(`
        SELECT id, contact_name, phone, contact_phone, address, city,
               rooms, asking_price, source
        FROM listings
        WHERE id = ANY($1) AND phone IS NOT NULL AND phone != ''
      `, [listing_ids]);
      items = listings;
    } else if (filters) {
      // Build from filters
      let conditions = ["l.is_active = TRUE", "(l.phone IS NOT NULL AND l.phone != '')"];
      let params = [];
      let idx = 1;

      if (filters.city) { conditions.push(`l.city = $${idx++}`); params.push(filters.city); }
      if (filters.cities && filters.cities.length) { conditions.push(`l.city = ANY($${idx++})`); params.push(filters.cities); }
      if (filters.source) { conditions.push(`l.source = $${idx++}`); params.push(filters.source); }
      if (filters.min_price) { conditions.push(`l.asking_price >= $${idx++}`); params.push(filters.min_price); }
      if (filters.max_price) { conditions.push(`l.asking_price <= $${idx++}`); params.push(filters.max_price); }
      if (filters.min_rooms) { conditions.push(`l.rooms >= $${idx++}`); params.push(filters.min_rooms); }
      if (filters.max_rooms) { conditions.push(`l.rooms <= $${idx++}`); params.push(filters.max_rooms); }
      if (filters.message_status) { conditions.push(`l.message_status = $${idx++}`); params.push(filters.message_status); }
      if (filters.no_message) { conditions.push(`(l.message_status IS NULL OR l.message_status = 'לא נשלחה')`); }

      const limit = filters.limit || 500;
      const { rows: listings } = await pool.query(`
        SELECT id, contact_name, phone, contact_phone, address, city,
               rooms, asking_price, source
        FROM listings l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC LIMIT ${parseInt(limit)}
      `, params);
      items = listings;
    }

    if (items.length === 0) {
      // Clean up empty list
      await pool.query(`DELETE FROM callcenter_lists WHERE id = $1`, [list.id]);
      return res.status(400).json({ error: 'No listings match filters / no phone numbers' });
    }

    // Insert items
    const insertValues = items.map((l, i) => {
      const base = i * 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    }).join(', ');

    const insertParams = items.flatMap(l => [
      list.id,
      l.id,
      l.contact_name || '',
      l.phone || l.contact_phone || '',
      l.address || '',
      l.city || '',
      l.rooms ? String(l.rooms) : '',
      l.asking_price ? `${Number(l.asking_price).toLocaleString()} ₪` : '',
    ]);

    await pool.query(`
      INSERT INTO callcenter_items (list_id, listing_id, contact_name, phone, address, city, rooms, price)
      VALUES ${insertValues}
    `, insertParams);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      list: { ...list, item_count: items.length },
      share_url: `${baseUrl}/callcenter/${token}`,
      token,
    });
  } catch (err) {
    logger.error('[CallCenter] Create list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List all call lists ─────────────────────────────────────────────────────

router.get('/lists', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cl.*,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id) as total_items,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.call_status = 'called') as called,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.interested = TRUE) as interested,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.agreement_sent = TRUE) as agreements_sent
      FROM callcenter_lists cl
      WHERE cl.is_active = TRUE
      ORDER BY cl.created_at DESC
    `);
    res.json({ lists: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single list with items ──────────────────────────────────────────────────

router.get('/lists/:id', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(`SELECT * FROM callcenter_lists WHERE id = $1`, [req.params.id]);
    if (!list) return res.status(404).json({ error: 'List not found' });

    const { rows: items } = await pool.query(`
      SELECT * FROM callcenter_items WHERE list_id = $1 ORDER BY id ASC
    `, [list.id]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ list, items, share_url: `${baseUrl}/callcenter/${list.token}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete list ─────────────────────────────────────────────────────────────

router.delete('/lists/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE callcenter_lists SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── List stats ──────────────────────────────────────────────────────────────

router.get('/lists/:id/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE call_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE call_status = 'called') as called,
        COUNT(*) FILTER (WHERE call_status = 'no_answer') as no_answer,
        COUNT(*) FILTER (WHERE call_status = 'callback') as callback,
        COUNT(*) FILTER (WHERE interested = TRUE) as interested,
        COUNT(*) FILTER (WHERE interested = FALSE) as not_interested,
        COUNT(*) FILTER (WHERE agreement_sent = TRUE) as agreements_sent,
        COUNT(*) FILTER (WHERE agreement_signed = TRUE) as agreements_signed,
        COUNT(*) FILTER (WHERE follow_up_date IS NOT NULL) as has_followup,
        SUM(na_count) as total_na_attempts
      FROM callcenter_items WHERE list_id = $1
    `, [req.params.id]);
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// EXTERNAL: Token-based access for call center agents
// ============================================================

// ── Serve the call center page ──────────────────────────────────────────────

router.get('/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`, [req.params.token]
    );
    if (rows.length === 0) return res.status(404).send('רשימה לא נמצאה או לא פעילה');
    res.sendFile(path.join(__dirname, '../public/callcenter.html'));
  } catch (err) { res.status(500).send('שגיאת שרת'); }
});

// ── Get list data via token ─────────────────────────────────────────────────

router.get('/ext/:token', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(
      `SELECT id, name, notes, created_at FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'List not found' });

    const { status, agent } = req.query;
    let conditions = ['list_id = $1'];
    let params = [list.id];
    let idx = 2;

    if (status) { conditions.push(`call_status = $${idx++}`); params.push(status); }
    if (agent) { conditions.push(`agent_name = $${idx++}`); params.push(agent); }

    const { rows: items } = await pool.query(`
      SELECT * FROM callcenter_items
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE call_status
          WHEN 'pending' THEN 0
          WHEN 'callback' THEN 1
          WHEN 'no_answer' THEN 2
          WHEN 'called' THEN 3
        END,
        id ASC
    `, params);

    // Stats
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE call_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE call_status = 'called') as called,
        COUNT(*) FILTER (WHERE call_status = 'no_answer') as no_answer,
        COUNT(*) FILTER (WHERE call_status = 'callback') as callback,
        COUNT(*) FILTER (WHERE interested = TRUE) as interested,
        COUNT(*) FILTER (WHERE agreement_sent = TRUE) as agreements_sent,
        COUNT(*) FILTER (WHERE agreement_signed = TRUE) as agreements_signed
      FROM callcenter_items WHERE list_id = $1
    `, [list.id]);

    res.json({ list, items, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update item status ──────────────────────────────────────────────────────

router.put('/ext/:token/item/:itemId', async (req, res) => {
  try {
    // Verify token
    const { rows: [list] } = await pool.query(
      `SELECT id FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'Invalid token' });

    const itemId = parseInt(req.params.itemId);
    const {
      call_status, call_outcome, agent_name, note_text,
      interested, agreement_sent, agreement_signed, follow_up_date, email
    } = req.body;

    let updates = ['updated_at = NOW()'];
    let params = [];
    let idx = 1;

    if (call_status !== undefined) {
      updates.push(`call_status = $${idx++}`); params.push(call_status);
      updates.push(`called_at = COALESCE(called_at, NOW())`);
      // Increment NA counter for no_answer
      if (call_status === 'no_answer') {
        updates.push(`na_count = COALESCE(na_count, 0) + 1`);
      }
    }
    if (call_outcome !== undefined) { updates.push(`call_outcome = $${idx++}`); params.push(call_outcome); }
    if (agent_name !== undefined) { updates.push(`agent_name = $${idx++}`); params.push(agent_name); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); params.push(email); }
    if (interested !== undefined) { updates.push(`interested = $${idx++}`); params.push(interested); }
    if (agreement_sent !== undefined) {
      updates.push(`agreement_sent = $${idx++}`); params.push(agreement_sent);
      if (agreement_sent) {
        const agToken = crypto.randomBytes(16).toString('hex');
        updates.push(`agreement_sent_at = COALESCE(agreement_sent_at, NOW())`);
        updates.push(`agreement_token = $${idx++}`); params.push(agToken);
      }
    }
    if (agreement_signed !== undefined) {
      updates.push(`agreement_signed = $${idx++}`); params.push(agreement_signed);
      if (agreement_signed) updates.push(`agreement_signed_at = NOW()`);
    }
    if (follow_up_date !== undefined) { updates.push(`follow_up_date = $${idx++}`); params.push(follow_up_date || null); }

    // Append note with timestamp (immutable notes log)
    if (note_text && note_text.trim()) {
      const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const noteEntry = `[${timestamp}] ${agent_name || 'נציג'}: ${note_text.trim()}`;
      updates.push(`notes = CASE WHEN notes IS NULL OR notes = '' THEN $${idx++} ELSE notes || E'\\n' || $${idx - 1} END`);
      params.push(noteEntry);
    }

    params.push(itemId, list.id);
    const { rows } = await pool.query(`
      UPDATE callcenter_items SET ${updates.join(', ')}
      WHERE id = $${idx++} AND list_id = $${idx++}
      RETURNING *
    `, params);

    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    // Sync back to listings table
    const item = rows[0];
    if (item.listing_id) {
      if (interested === true) {
        await pool.query(`UPDATE listings SET deal_status = 'בטיפול', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
      if (agreement_sent === true) {
        await pool.query(`UPDATE listings SET deal_status = 'נשלח הסכם', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
      if (agreement_signed === true) {
        await pool.query(`UPDATE listings SET deal_status = 'התקבל חתום', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
      if (interested === false) {
        await pool.query(`UPDATE listings SET deal_status = 'לא רלוונטי', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
    }

    res.json({ success: true, item: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AGREEMENT SENDING — via SMS/WhatsApp with signing link
// ============================================================

/**
 * POST /api/callcenter/ext/:token/item/:itemId/send-agreement
 * Send brokerage agreement to client via WhatsApp/SMS/Email
 * Body: { channel: 'whatsapp'|'sms'|'email', email?, message? }
 */
router.post('/ext/:token/item/:itemId/send-agreement', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(
      `SELECT id FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'Invalid token' });

    const itemId = parseInt(req.params.itemId);
    const { rows: [item] } = await pool.query(
      `SELECT * FROM callcenter_items WHERE id = $1 AND list_id = $2`, [itemId, list.id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const { channel = 'whatsapp', email: recipientEmail, message: customMessage } = req.body;

    // Generate unique agreement token
    const agToken = crypto.randomBytes(16).toString('hex');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const signingUrl = `${baseUrl}/callcenter/sign/${agToken}`;

    // Update item with agreement token
    await pool.query(`
      UPDATE callcenter_items SET
        agreement_sent = TRUE, agreement_sent_at = NOW(),
        agreement_token = $1, agreement_channel = $2,
        email = COALESCE($3, email),
        updated_at = NOW()
      WHERE id = $4
    `, [agToken, channel, recipientEmail || null, itemId]);

    // Sync to listings
    if (item.listing_id) {
      await pool.query(`UPDATE listings SET deal_status = 'נשלח הסכם', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
    }

    const agreementText = customMessage || `שלום ${item.contact_name || ''},\nתודה על השיחה! מצורף הסכם תיווך לחתימה דיגיטלית:\n${signingUrl}\nQUANTUM Real Estate`;

    let sendResult = { success: false };

    if (channel === 'whatsapp' || channel === 'sms') {
      try {
        const inforu = require('../services/inforuService');
        if (channel === 'whatsapp') {
          sendResult = await inforu.sendMessage(item.phone, agreementText, { preferWhatsApp: true });
        } else {
          sendResult = await inforu.sendSms(item.phone, agreementText);
        }
      } catch (e) {
        sendResult = { success: false, error: e.message };
      }
    } else if (channel === 'email' && (recipientEmail || item.email)) {
      // TODO: integrate email service when available
      sendResult = { success: true, note: 'Email integration pending — signing link generated' };
    }

    res.json({
      success: true,
      signing_url: signingUrl,
      agreement_token: agToken,
      channel,
      send_result: sendResult,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/callcenter/ext/:token/item/:itemId/send-message
 * Send a custom message via WhatsApp/SMS (available after NA3+)
 * Body: { message, channel?: 'whatsapp'|'sms' }
 */
router.post('/ext/:token/item/:itemId/send-message', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(
      `SELECT id FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'Invalid token' });

    const itemId = parseInt(req.params.itemId);
    const { rows: [item] } = await pool.query(
      `SELECT * FROM callcenter_items WHERE id = $1 AND list_id = $2`, [itemId, list.id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if ((item.na_count || 0) < 3) {
      return res.status(400).json({ error: 'Message sending available after NA3 (3 unanswered calls)' });
    }

    const { message, channel = 'whatsapp' } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    let sendResult = { success: false };
    try {
      const inforu = require('../services/inforuService');
      if (channel === 'whatsapp') {
        sendResult = await inforu.sendMessage(item.phone, message, { preferWhatsApp: true });
      } else {
        sendResult = await inforu.sendSms(item.phone, message);
      }
    } catch (e) {
      sendResult = { success: false, error: e.message };
    }

    // Log as note
    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const noteEntry = `[${timestamp}] הודעה נשלחה (${channel}): ${message.substring(0, 80)}...`;
    await pool.query(`
      UPDATE callcenter_items SET
        notes = CASE WHEN notes IS NULL OR notes = '' THEN $1 ELSE notes || E'\\n' || $1 END,
        updated_at = NOW()
      WHERE id = $2
    `, [noteEntry, itemId]).catch(() => {});

    res.json({ success: sendResult.success, channel, send_result: sendResult });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AGREEMENT SIGNING PAGE — public, token-based
// ============================================================

router.get('/sign/:agToken', async (req, res) => {
  try {
    const { rows: [item] } = await pool.query(
      `SELECT ci.*, cl.name as list_name FROM callcenter_items ci
       JOIN callcenter_lists cl ON cl.id = ci.list_id
       WHERE ci.agreement_token = $1`,
      [req.params.agToken]
    );
    if (!item) return res.status(404).send('קישור לא תקין או שפג תוקפו');
    if (item.agreement_signed) return res.send(`
      <html dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>QUANTUM — הסכם חתום</title>
      <style>body{font-family:sans-serif;background:#0f1117;color:#e2e4e9;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
      .card{background:#1a1d27;border:1px solid #2dd4bf;border-radius:12px;padding:40px;text-align:center;max-width:400px;}
      h1{color:#22c55e;font-size:24px;}p{color:#8b8fa3;}</style></head>
      <body><div class="card"><h1>✅ ההסכם כבר נחתם</h1><p>חתום בתאריך ${new Date(item.agreement_signed_at).toLocaleDateString('he-IL')}</p><p>תודה רבה!</p></div></body></html>
    `);

    // Show signing page
    res.send(`
      <html dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>QUANTUM — חתימה על הסכם תיווך</title>
      <style>
        body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e4e9;margin:0;padding:20px;}
        .card{background:#1a1d27;border:1px solid #2d3148;border-radius:12px;padding:30px;max-width:500px;margin:0 auto;}
        h1{color:#2dd4bf;font-size:20px;margin-bottom:5px;}
        .info{color:#8b8fa3;font-size:13px;margin-bottom:20px;}
        .field{margin-bottom:16px;}
        .field label{display:block;font-size:12px;color:#8b8fa3;margin-bottom:4px;}
        .field input{width:100%;padding:10px;background:#242836;border:1px solid #2d3148;border-radius:8px;color:#e2e4e9;font-size:14px;box-sizing:border-box;}
        canvas{border:1px solid #2d3148;border-radius:8px;background:#242836;display:block;width:100%;height:120px;touch-action:none;cursor:crosshair;}
        .btn{padding:12px 24px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-top:12px;}
        .btn-sign{background:#2dd4bf;color:#000;}.btn-clear{background:#2d3148;color:#8b8fa3;font-size:13px;}
        .legal{font-size:11px;color:#8b8fa3;margin-top:16px;line-height:1.6;}
        .check{display:flex;align-items:flex-start;gap:8px;margin:12px 0;}
        .check input{margin-top:3px;accent-color:#2dd4bf;}
        .success{display:none;text-align:center;padding:30px;} .success h2{color:#22c55e;}
      </style></head>
      <body>
      <div class="card" id="sign-form">
        <h1>📜 הסכם תיווך — QUANTUM Real Estate</h1>
        <div class="info">${item.contact_name || ''} | ${item.address || ''}, ${item.city || ''}</div>
        <div class="field"><label>שם מלא</label><input type="text" id="signerName" value="${item.contact_name || ''}"></div>
        <div class="field"><label>תעודת זהות</label><input type="text" id="signerId" placeholder="מספר ת.ז."></div>
        <div class="field"><label>טלפון</label><input type="text" id="signerPhone" value="${item.phone || ''}"></div>
        <div class="field"><label>אימייל</label><input type="email" id="signerEmail" value="${item.email || ''}" placeholder="אופציונלי"></div>
        <div class="legal">
          <strong>תנאי ההסכם:</strong><br>
          בחתימתי על הסכם זה, אני מאשר/ת כי QUANTUM Real Estate ישמש כמתווך/ת בעסקת הנדל"ן הקשורה לנכס המתואר לעיל.
          העמלה תהיה בהתאם לתעריפים המקובלים ובכפוף לחוק המתווכים במקרקעין, תשנ"ו-1996.
          ההסכם תקף ל-12 חודשים מיום החתימה.
        </div>
        <div class="check"><input type="checkbox" id="agreeTerms"><label for="agreeTerms" style="font-size:12px;color:#e2e4e9;cursor:pointer;">קראתי ואני מסכים/ה לתנאי ההסכם</label></div>
        <div class="field"><label>חתימה (צייר/י בעזרת האצבע או העכבר)</label>
          <canvas id="sigCanvas" width="460" height="120"></canvas>
          <button class="btn btn-clear" onclick="clearSig()">נקה חתימה</button>
        </div>
        <button class="btn btn-sign" onclick="submitSignature()">✍️ חתום על ההסכם</button>
      </div>
      <div class="card success" id="sign-success">
        <h2>✅ ההסכם נחתם בהצלחה!</h2>
        <p style="color:#8b8fa3;">תודה רבה. צוות QUANTUM ייצור עמך קשר בהקדם.</p>
      </div>
      <script>
        const canvas = document.getElementById('sigCanvas');
        const ctx = canvas.getContext('2d');
        let drawing = false, hasSig = false;
        canvas.width = canvas.offsetWidth; canvas.height = 120;
        ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2; ctx.lineCap = 'round';

        function getPos(e) {
          const r = canvas.getBoundingClientRect();
          const t = e.touches ? e.touches[0] : e;
          return { x: t.clientX - r.left, y: t.clientY - r.top };
        }
        canvas.addEventListener('mousedown', e => { drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
        canvas.addEventListener('mousemove', e => { if (!drawing) return; hasSig = true; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
        canvas.addEventListener('mouseup', () => drawing = false);
        canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
        canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; hasSig = true; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
        canvas.addEventListener('touchend', () => drawing = false);

        function clearSig() { ctx.clearRect(0, 0, canvas.width, canvas.height); hasSig = false; }

        async function submitSignature() {
          if (!document.getElementById('agreeTerms').checked) { alert('נא לאשר את תנאי ההסכם'); return; }
          if (!hasSig) { alert('נא לחתום'); return; }
          const name = document.getElementById('signerName').value;
          const idNum = document.getElementById('signerId').value;
          if (!name || !idNum) { alert('נא למלא שם מלא ותעודת זהות'); return; }

          try {
            const resp = await fetch('/api/callcenter/sign/${req.params.agToken}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                signer_name: name,
                signer_id: idNum,
                signer_phone: document.getElementById('signerPhone').value,
                signer_email: document.getElementById('signerEmail').value,
                signature_data: canvas.toDataURL('image/png'),
              })
            });
            const result = await resp.json();
            if (result.success) {
              document.getElementById('sign-form').style.display = 'none';
              document.getElementById('sign-success').style.display = 'block';
            } else { alert(result.error || 'שגיאה'); }
          } catch(e) { alert('שגיאת תקשורת'); }
        }
      </script>
      </body></html>
    `);
  } catch (err) { res.status(500).send('שגיאת שרת'); }
});

/**
 * POST /api/callcenter/sign/:agToken — Submit signed agreement
 */
router.post('/sign/:agToken', async (req, res) => {
  try {
    const { signer_name, signer_id, signer_phone, signer_email, signature_data } = req.body;
    if (!signer_name || !signer_id) return res.status(400).json({ error: 'Name and ID required' });

    const { rows: [item] } = await pool.query(
      `SELECT * FROM callcenter_items WHERE agreement_token = $1`, [req.params.agToken]
    );
    if (!item) return res.status(404).json({ error: 'Invalid token' });
    if (item.agreement_signed) return res.json({ success: true, already_signed: true });

    // Mark as signed
    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const noteEntry = `[${timestamp}] הסכם נחתם דיגיטלית — ${signer_name}, ת.ז. ${signer_id}`;

    await pool.query(`
      UPDATE callcenter_items SET
        agreement_signed = TRUE, agreement_signed_at = NOW(),
        contact_name = COALESCE(NULLIF($1, ''), contact_name),
        email = COALESCE(NULLIF($2, ''), email),
        notes = CASE WHEN notes IS NULL OR notes = '' THEN $3 ELSE notes || E'\\n' || $3 END,
        updated_at = NOW()
      WHERE id = $4
    `, [signer_name, signer_email || null, noteEntry, item.id]);

    // Sync to listings
    if (item.listing_id) {
      await pool.query(`UPDATE listings SET deal_status = 'התקבל חתום', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
    }

    // Store signature data in unified_messages for audit
    try {
      await pool.query(`
        INSERT INTO unified_messages (listing_id, contact_phone, direction, channel, platform, message_text, status, metadata)
        VALUES ($1, $2, 'incoming', 'agreement_signed', 'callcenter', $3, 'received', $4::jsonb)
      `, [
        item.listing_id, item.phone,
        `הסכם תיווך נחתם — ${signer_name}`,
        JSON.stringify({ signer_name, signer_id, signer_phone, signer_email, signed_at: new Date().toISOString(), item_id: item.id })
      ]);
    } catch (e) { logger.warn('[CallCenter] Failed to log signature:', e.message); }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
