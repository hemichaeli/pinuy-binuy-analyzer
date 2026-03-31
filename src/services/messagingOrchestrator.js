/**
 * Messaging Orchestrator - Multi-platform auto-messaging for listings
 *
 * ESCALATION PRIORITY (per listing):
 *   1. Platform messaging first (yad2_chat, fb_messenger, komo_chat)
 *   2. WhatsApp (if phone available)
 *   3. SMS (for kones/receivership)
 *   4. Manual fallback
 *
 * Supports:
 *   - Auto-send on new listing discovery
 *   - Filter-based batch send (city, SSI, price, rooms, area, source, complex)
 *   - Configurable templates per platform
 *   - Rate limiting and throttling
 *   - Message tracking via unified_messages table
 *   - Available channels detection per listing
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Lazy-load services to prevent startup failures
// Prefer API-based messenger v2, fallback to Puppeteer v1
function getYad2Messenger() {
  try { return require('./yad2MessengerApi'); } catch (e) {
    try { return require('./yad2Messenger'); } catch (e2) { return null; }
  }
}
function getInforuService() {
  try { return require('./inforuService'); } catch (e) { return null; }
}
function getFbMessenger() {
  try { return require('./facebookMessenger'); } catch (e) { return null; }
}
function getPhoneOrch() {
  try { return require('./phoneRevealOrchestrator'); } catch (e) { return null; }
}

// ============================================================
// CHANNEL DETECTION
// ============================================================

/**
 * Compute available channels for a listing based on source and data
 * Priority order: platform first, then WhatsApp, then manual
 */
function detectAvailableChannels(listing) {
  const channels = [];
  const source = (listing.source || '').toLowerCase();
  const hasPhone = listing.phone && listing.phone.length > 5;
  const hasUrl = !!listing.url;

  // For yad2: WhatsApp is primary (most private listings use WhatsApp, not internal chat)
  // yad2_chat (leave details + Sendbird) is secondary
  if (source === 'yad2') {
    if (hasPhone) {
      channels.push('whatsapp'); // WhatsApp first - most yad2 private listings use this
    }
    if (hasUrl || listing.source_listing_id) {
      channels.push('yad2_chat'); // Leave details form + Sendbird as backup
    }
  }

  // Other platforms: native chat first
  if (source === 'facebook' && hasUrl) {
    channels.push('fb_messenger');
  }
  if (source === 'komo' && (hasUrl || listing.source_listing_id)) {
    channels.push('komo_chat');
  }

  // WhatsApp for non-yad2 (priority 2 — only if phone exists)
  if (source !== 'yad2' && hasPhone) {
    channels.push('whatsapp');
  }

  // SMS for kones/receivership
  if ((source === 'kones' || source === 'receivership') && hasPhone) {
    channels.push('sms');
  }

  // Manual fallback
  if (channels.length === 0) {
    channels.push('manual');
  }

  return channels;
}

// ============================================================
// MESSAGE TEMPLATES
// ============================================================

const DEFAULT_TEMPLATES = {
  yad2_seller: {
    id: 'yad2_seller',
    name: 'פנייה למוכר ביד2',
    platform: 'yad2',
    template: `שלום,
ראיתי את הנכס שלך ב{address}, {city}.
אני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים רציניים לאזור שלך.
אשמח לשוחח - {agent_phone}
QUANTUM Real Estate`,
    variables: ['address', 'city', 'agent_phone', 'price', 'rooms']
  },
  
  kones_inquiry: {
    id: 'kones_inquiry',
    name: 'פנייה לכונס נכסים',
    platform: 'kones',
    template: `לכבוד עו"ד {contact_name},
בנוגע לנכס בכינוס ב{address}, {city}.
אנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים פוטנציאליים מיידיים.
נשמח לשיתוף פעולה - {agent_phone}`,
    variables: ['contact_name', 'address', 'city', 'agent_phone']
  },
  
  whatsapp_seller: {
    id: 'whatsapp_seller',
    name: 'הודעת וואטסאפ למוכר',
    platform: 'whatsapp',
    template: `שלום, ראיתי את הנכס שלך ב{address}, {city} (מחיר: {price}).
אני מ-QUANTUM - משרד תיווך המתמחה בפינוי-בינוי.
יש לנו קונים רציניים לאזור. אשמח לשוחח.
{agent_phone}`,
    variables: ['address', 'city', 'price', 'agent_phone']
  },
  
  facebook_seller: {
    id: 'facebook_seller',
    name: 'פנייה בפייסבוק',
    platform: 'facebook',
    template: `שלום, ראיתי את הנכס שלך ב{address}.
אני מ-QUANTUM, מתמחים בפינוי-בינוי.
יש לנו קונים רציניים לאזור.
מוזמן/ת ליצור קשר: {agent_phone}`,
    variables: ['address', 'city', 'agent_phone']
  },
  
  sms_seller: {
    id: 'sms_seller',
    name: 'SMS למוכר',
    platform: 'sms',
    template: `שלום, ראיתי שיש לך נכס ב{address}, {city}. אני מ-QUANTUM, משרד תיווך פינוי-בינוי. יש לנו קונים. {agent_phone}`,
    variables: ['address', 'city', 'agent_phone']
  }
};

// ============================================================
// AUTO-SEND CONFIGURATION
// ============================================================

let autoSendConfig = {
  enabled: false,
  template_id: 'yad2_seller',
  filters: {},
  platforms: ['yad2'],
  daily_limit: 50,
  delay_between_ms: 5000,
  agent_phone: process.env.AGENT_PHONE || '050-0000000',
  sent_today: 0,
  last_reset: new Date().toISOString().split('T')[0]
};

// ============================================================
// CORE FUNCTIONS
// ============================================================

function fillTemplate(templateStr, listing, extraVars = {}) {
  const vars = {
    address: listing.address || listing.street || '',
    city: listing.city || '',
    price: listing.asking_price ? `${Number(listing.asking_price).toLocaleString()} ש"ח` : '',
    rooms: listing.rooms || '',
    area: listing.area_sqm || '',
    floor: listing.floor || '',
    platform: listing.source || 'yad2',
    complex_name: listing.complex_name || '',
    contact_name: listing.contact_name || '',
    agent_phone: autoSendConfig.agent_phone,
    ...extraVars
  };
  let message = templateStr;
  for (const [key, value] of Object.entries(vars)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return message.trim();
}

async function sendToListing(listing, messageText, options = {}) {
  const platform = (listing.source || 'yad2').toLowerCase();
  const channels = detectAvailableChannels(listing);
  const result = {
    listing_id: listing.id, platform, channel: 'unknown',
    available_channels: channels, success: false,
    message_text: messageText, error: null
  };

  try {
    // Log to unified_messages
    const convId = `conv_${listing.id}_${channels[0]}`;
    const msgRecord = await pool.query(
      `INSERT INTO unified_messages (listing_id, complex_id, contact_phone, direction, channel, platform, message_text, status, conversation_id)
       VALUES ($1, $2, $3, 'outgoing', $4, $5, $6, 'pending', $7) RETURNING id`,
      [listing.id, listing.complex_id || null, listing.phone || listing.contact_phone || null,
       channels[0], platform, messageText, convId]
    ).catch(() => {
      // Fallback to old table if unified_messages doesn't exist yet
      return pool.query(
        `INSERT INTO listing_messages (listing_id, direction, message_text, status, channel)
         VALUES ($1, 'sent', $2, 'pending', $3) RETURNING id`,
        [listing.id, messageText, channels[0]]
      );
    });
    result.message_id = msgRecord.rows[0]?.id;

    // Escalation: try each available channel in priority order
    for (const channel of channels) {
      if (result.success) break;

      if (channel === 'yad2_chat') {
        result.channel = 'yad2_chat';
        const yad2 = getYad2Messenger();

        // Resolve proper yad2 item URL (Perplexity listings may have search page URLs)
        let itemUrl = listing.url;
        const phoneOrch = getPhoneOrch();
        if (phoneOrch) {
          // Check if URL is a proper item URL
          const hasItemUrl = itemUrl && itemUrl.includes('/item/');
          const hasValidId = phoneOrch.isValidYad2Id(listing.source_listing_id);

          if (!hasItemUrl && hasValidId) {
            itemUrl = `https://www.yad2.co.il/item/${listing.source_listing_id}`;
          } else if (!hasItemUrl && !hasValidId) {
            // Try to extract from URL
            const urlId = phoneOrch.extractYad2ItemId(itemUrl);
            if (urlId) {
              itemUrl = `https://www.yad2.co.il/item/${urlId}`;
            } else {
              // Resolve via API search
              const resolved = await phoneOrch.resolveYad2ItemId(listing);
              if (resolved) {
                itemUrl = resolved.url;
                // Update DB for future use
                await pool.query(
                  `UPDATE listings SET source_listing_id = $1, url = $2, updated_at = NOW() WHERE id = $3`,
                  [resolved.itemId, resolved.url, listing.id]
                ).catch(() => {});
              }
            }
          }
        } else if (listing.source_listing_id && (!itemUrl || !itemUrl.includes('/item/'))) {
          itemUrl = `https://www.yad2.co.il/item/${listing.source_listing_id}`;
        }

        if (yad2 && yad2.getStatus().hasCredentials && itemUrl && itemUrl.includes('/item/')) {
          const sendResult = await yad2.sendMessage(itemUrl, messageText);
          result.success = sendResult.success;
          if (!sendResult.success) result.error = sendResult.error;
        }
        if (!result.success) {
          result.manual_url = itemUrl || listing.url || `https://www.yad2.co.il/item/${listing.source_listing_id}`;
        }
      }

      else if (channel === 'fb_messenger') {
        result.channel = 'fb_messenger';
        const fbm = getFbMessenger();
        if (fbm && fbm.getStatus().configured) {
          const fbResult = listing.url
            ? await fbm.sendToMarketplaceListing(listing.url, messageText)
            : { success: false, error: 'No FB listing URL' };
          result.success = fbResult.success;
          if (!fbResult.success) {
            result.error = fbResult.error;
            result.manual_url = listing.url;
          }
        } else {
          result.manual_url = listing.url;
        }
      }

      else if (channel === 'komo_chat') {
        result.channel = 'komo_chat';
        const sid = listing.source_listing_id;
        result.manual_url = sid
          ? `https://www.komo.co.il/code/nadlan/apartments-for-sale.asp?modaaNum=${sid}`
          : listing.url;

        // Try to get phone from Komo API and send via WhatsApp instead
        if (!listing.phone && sid && /^\d+$/.test(sid)) {
          const phoneOrch = getPhoneOrch();
          if (phoneOrch) {
            const komoResult = await phoneOrch.fetchKomoPhone(sid);
            if (komoResult && komoResult.phone) {
              listing.phone = komoResult.phone;
              // Update DB with newly found phone
              await pool.query(
                `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
                [komoResult.phone, komoResult.contact_name, listing.id]
              ).catch(() => {});
              // Will try WhatsApp on next channel iteration
            }
          }
        }
        // Continue to next channel (WhatsApp if phone now available)
      }

      else if (channel === 'whatsapp') {
        result.channel = 'whatsapp';
        const phone = listing.phone || listing.contact_phone;
        if (phone) {
          const inforu = getInforuService();
          if (inforu) {
            try {
              const waResult = await inforu.sendWhatsApp(phone, messageText, {
                listingId: listing.id, complexId: listing.complex_id
              });
              result.success = waResult.success !== false;
              if (!result.success) result.error = waResult.error;
            } catch (e) {
              // InForu WA failed, generate link as fallback
              result.whatsapp_link = generateWhatsAppLink(listing, messageText);
              result.success = true;
            }
          } else {
            result.whatsapp_link = generateWhatsAppLink(listing, messageText);
            result.success = true;
          }
        }
      }

      else if (channel === 'sms') {
        result.channel = 'sms';
        const inforu = getInforuService();
        const phone = listing.phone || listing.contact_phone;
        if (inforu && phone) {
          const smsResult = await inforu.sendSms(phone, messageText, {
            listingId: listing.id, complexId: listing.complex_id
          });
          result.success = smsResult.success;
          if (!smsResult.success) result.error = smsResult.error;
        }
      }

      else if (channel === 'manual') {
        result.channel = 'manual';
        result.manual_url = listing.url;
      }
    }

    // Update message status
    const finalStatus = result.success ? 'sent' : (result.whatsapp_link ? 'whatsapp_link' : (result.manual_url ? 'manual' : 'failed'));
    await pool.query(
      `UPDATE unified_messages SET status = $1, error_message = $2, channel = $3, updated_at = NOW() WHERE id = $4`,
      [finalStatus, result.error, result.channel, result.message_id]
    ).catch(() => {
      pool.query(
        `UPDATE listing_messages SET status = $1, error_message = $2, channel = $3 WHERE id = $4`,
        [finalStatus, result.error, result.channel, result.message_id]
      ).catch(() => {});
    });

    if (result.success || result.whatsapp_link) {
      await pool.query(
        `UPDATE listings SET message_status = $1, last_message_sent_at = NOW(),
         available_channels = $3 WHERE id = $2`,
        [result.success ? 'נשלחה' : 'קישור וואטסאפ', listing.id, channels]
      ).catch(() => {
        pool.query(`UPDATE listings SET message_status = $1, last_message_sent_at = NOW() WHERE id = $2`,
          [result.success ? 'נשלחה' : 'קישור וואטסאפ', listing.id]).catch(() => {});
      });
    } else {
      // Still update available_channels even if send failed
      await pool.query(`UPDATE listings SET available_channels = $1 WHERE id = $2`, [channels, listing.id]).catch(() => {});
    }
  } catch (err) {
    result.error = err.message;
    logger.error(`[MessagingOrchestrator] sendToListing failed`, { listing_id: listing.id, error: err.message });
  }

  return result;
}

function generateWhatsAppLink(listing, messageText) {
  const phone = (listing.contact_phone || '').replace(/[^0-9]/g, '');
  if (!phone) return null;
  let intlPhone = phone;
  if (phone.startsWith('0')) intlPhone = '972' + phone.slice(1);
  return `https://wa.me/${intlPhone}?text=${encodeURIComponent(messageText)}`;
}

async function sendByFilter(filters = {}, templateId = 'yad2_seller', extraVars = {}) {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template) throw new Error(`Template "${templateId}" not found`);
  
  let conditions = [`l.is_active = TRUE`, `(l.message_status IS NULL OR l.message_status = 'לא נשלחה')`];
  let params = [];
  let paramIdx = 1;
  
  if (filters.city) { conditions.push(`l.city = $${paramIdx++}`); params.push(filters.city); }
  if (filters.cities && filters.cities.length) { conditions.push(`l.city = ANY($${paramIdx++})`); params.push(filters.cities); }
  if (filters.source) { conditions.push(`l.source = $${paramIdx++}`); params.push(filters.source); }
  if (filters.platform) { conditions.push(`l.source = $${paramIdx++}`); params.push(filters.platform); }
  if (filters.min_price) { conditions.push(`l.asking_price >= $${paramIdx++}`); params.push(filters.min_price); }
  if (filters.max_price) { conditions.push(`l.asking_price <= $${paramIdx++}`); params.push(filters.max_price); }
  if (filters.min_rooms) { conditions.push(`l.rooms >= $${paramIdx++}`); params.push(filters.min_rooms); }
  if (filters.max_rooms) { conditions.push(`l.rooms <= $${paramIdx++}`); params.push(filters.max_rooms); }
  if (filters.min_area) { conditions.push(`l.area_sqm >= $${paramIdx++}`); params.push(filters.min_area); }
  if (filters.complex_id) { conditions.push(`l.complex_id = $${paramIdx++}`); params.push(filters.complex_id); }
  if (filters.min_ssi) { conditions.push(`l.ssi_score >= $${paramIdx++}`); params.push(filters.min_ssi); }
  if (filters.min_iai) { conditions.push(`c.iai_score >= $${paramIdx++}`); params.push(filters.min_iai); }
  
  const limit = filters.limit || 50;
  
  const result = await pool.query(`
    SELECT l.*, c.name as complex_name, c.iai_score
    FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY l.created_at DESC LIMIT ${limit}
  `, params);
  
  const listings = result.rows;
  if (listings.length === 0) return { total: 0, sent: 0, failed: 0, results: [], message: 'No matching unsent listings found' };
  
  logger.info(`[MessagingOrchestrator] sendByFilter: ${listings.length} listings match`, { filters });
  
  const results = [];
  let sent = 0, failed = 0;
  
  for (const listing of listings) {
    const messageText = fillTemplate(template.template, listing, extraVars);
    const sendResult = await sendToListing(listing, messageText);
    results.push(sendResult);
    if (sendResult.success || sendResult.whatsapp_link) sent++; else failed++;
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
  }
  
  return { total: listings.length, sent, failed, template_used: templateId, filters_applied: filters, results };
}

async function autoSendToNewListings(newListingIds = []) {
  if (!autoSendConfig.enabled) {
    logger.info('[MessagingOrchestrator] Auto-send disabled, skipping');
    return { skipped: true, reason: 'auto-send disabled' };
  }
  
  const today = new Date().toISOString().split('T')[0];
  if (autoSendConfig.last_reset !== today) { autoSendConfig.sent_today = 0; autoSendConfig.last_reset = today; }
  
  const remaining = autoSendConfig.daily_limit - autoSendConfig.sent_today;
  if (remaining <= 0) return { skipped: true, reason: 'daily limit reached' };
  
  const idsToProcess = newListingIds.slice(0, remaining);
  if (idsToProcess.length === 0) return { skipped: true, reason: 'no new listings' };
  
  const template = DEFAULT_TEMPLATES[autoSendConfig.template_id] || DEFAULT_TEMPLATES.yad2_seller;
  const results = [];
  let sent = 0;
  
  for (const listingId of idsToProcess) {
    try {
      const listingResult = await pool.query(
        `SELECT l.*, c.name as complex_name, c.iai_score
         FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`,
        [listingId]
      );
      if (listingResult.rows.length === 0) continue;
      const listing = listingResult.rows[0];
      
      if (autoSendConfig.platforms.length > 0 && !autoSendConfig.platforms.includes(listing.source)) continue;
      
      const f = autoSendConfig.filters;
      if (f.city && listing.city !== f.city) continue;
      if (f.min_ssi && listing.ssi_score < f.min_ssi) continue;
      if (f.min_iai && listing.iai_score < f.min_iai) continue;
      if (f.max_price && listing.asking_price > f.max_price) continue;
      
      const messageText = fillTemplate(template.template, listing);
      const sendResult = await sendToListing(listing, messageText);
      results.push(sendResult);
      
      if (sendResult.success || sendResult.whatsapp_link) { sent++; autoSendConfig.sent_today++; }
      await new Promise(r => setTimeout(r, autoSendConfig.delay_between_ms));
    } catch (err) {
      logger.error(`[MessagingOrchestrator] Auto-send failed for listing ${listingId}`, { error: err.message });
      results.push({ listing_id: listingId, success: false, error: err.message });
    }
  }
  
  logger.info(`[MessagingOrchestrator] Auto-send complete: ${sent}/${idsToProcess.length} sent`);
  return { total: idsToProcess.length, sent, daily_count: autoSendConfig.sent_today, daily_limit: autoSendConfig.daily_limit, results };
}

function getAutoSendConfig() { return { ...autoSendConfig }; }

function updateAutoSendConfig(updates) {
  const allowed = ['enabled', 'template_id', 'filters', 'platforms', 'daily_limit', 'delay_between_ms', 'agent_phone'];
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) autoSendConfig[key] = value;
  }
  logger.info('[MessagingOrchestrator] Config updated', { autoSendConfig });
  return getAutoSendConfig();
}

function getTemplates() { return DEFAULT_TEMPLATES; }

async function previewMessage(listingId, templateId, extraVars = {}) {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template) throw new Error(`Template "${templateId}" not found`);
  
  const result = await pool.query(
    `SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`,
    [listingId]
  );
  if (result.rows.length === 0) throw new Error('Listing not found');
  const listing = result.rows[0];
  
  return {
    listing_id: listingId,
    template_id: templateId,
    message: fillTemplate(template.template, listing, extraVars),
    source: listing.source,
    channel: { yad2: 'yad2_chat', kones: 'sms', receivership: 'sms', facebook: 'manual_facebook' }[(listing.source || '').toLowerCase()] || 'manual',
    listing_summary: { address: listing.address, city: listing.city, price: listing.asking_price, rooms: listing.rooms, source: listing.source }
  };
}

async function getDashboardStats() {
  const stats = await pool.query(`
    SELECT COUNT(*) as total_listings,
      COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as unsent,
      COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent,
      COUNT(*) FILTER (WHERE message_status = 'קישור וואטסאפ') as whatsapp_links,
      COUNT(*) FILTER (WHERE message_status = 'התקבלה תשובה') as replied,
      COUNT(*) FILTER (WHERE deal_status = 'תיווך') as brokered,
      COUNT(*) FILTER (WHERE deal_status = 'בטיפול') as in_progress
    FROM listings WHERE is_active = TRUE
  `);
  const bySource = await pool.query(`
    SELECT source, COUNT(*) as count,
      COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent
    FROM listings WHERE is_active = TRUE GROUP BY source ORDER BY count DESC
  `);
  const byCity = await pool.query(`
    SELECT city, COUNT(*) as count,
      COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as unsent
    FROM listings WHERE is_active = TRUE GROUP BY city ORDER BY count DESC LIMIT 20
  `);
  const recent = await pool.query(`
    SELECT lm.*, l.address, l.city, l.source
    FROM listing_messages lm JOIN listings l ON lm.listing_id = l.id
    ORDER BY lm.created_at DESC LIMIT 20
  `);
  return { overview: stats.rows[0], by_source: bySource.rows, by_city: byCity.rows, recent_messages: recent.rows, auto_send: getAutoSendConfig() };
}

async function ensureMessagingTables() {
  try {
    await pool.query(`ALTER TABLE listing_messages ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT 'unknown'`);
    logger.info('[MessagingOrchestrator] DB migrations complete');
  } catch (err) { logger.warn('[MessagingOrchestrator] DB migration warning:', err.message); }
}
ensureMessagingTables().catch(() => {});

module.exports = {
  sendToListing, sendByFilter, autoSendToNewListings,
  getAutoSendConfig, updateAutoSendConfig,
  getTemplates, previewMessage, getDashboardStats,
  fillTemplate, generateWhatsAppLink, detectAvailableChannels,
  DEFAULT_TEMPLATES
};