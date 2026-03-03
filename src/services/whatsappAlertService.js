/**
 * WhatsApp Auto-Alert Service
 * Sends automated WhatsApp alerts for new listings matching user preferences
 */

const pool = require('../db/pool');
const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

// Build WhatsApp message for listing
function buildListingMessage(listing, lead) {
  const name = lead.name || '';
  const price = listing.price ? `${(listing.price / 1000000).toFixed(2)}M ₪` : 'לא צוין';
  const rooms = listing.rooms || 'לא צוין';
  const size = listing.size_sqm ? `${listing.size_sqm}m²` : 'לא צוין';
  const floor = listing.floor ? `קומה ${listing.floor}` : '';
  const complex = listing.complex_name || listing.complex_id || '';
  
  let message = `${name ? name + ', ' : ''}🏠 *מודעה חדשה שתתאים לך!*\n\n`;
  
  if (listing.address) {
    message += `📍 ${listing.address}\n`;
  }
  if (listing.city) {
    message += `🏙 ${listing.city}\n`;
  }
  if (complex) {
    message += `🏢 ${complex}\n`;
  }
  
  message += `\n💰 מחיר: *${price}*\n`;
  message += `🛏 חדרים: ${rooms}\n`;
  message += `📐 שטח: ${size}\n`;
  if (floor) message += `🏗 ${floor}\n`;
  
  if (listing.description) {
    const shortDesc = listing.description.substring(0, 100);
    message += `\n📝 ${shortDesc}${listing.description.length > 100 ? '...' : ''}\n`;
  }
  
  if (listing.source_url) {
    message += `\n🔗 לפרטים: ${listing.source_url}`;
  }
  
  message += `\n\n_התראה אוטומטית מ-QUANTUM_`;
  
  return message;
}

// Send WhatsApp alert
async function sendListingAlert(phone, message, listingId) {
  try {
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: message, 
        Phone: phone,
        Settings: {
          CustomerMessageId: `alert_${listingId}_${Date.now()}`,
          CustomerParameter: 'QUANTUM_AUTO_ALERT'
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
    
    return result.data.StatusId === 1;
  } catch (error) {
    console.error('[ALERT] WhatsApp send error:', error.message);
    return false;
  }
}

// Check if listing matches subscription criteria
function matchesCriteria(listing, criteria) {
  // City filter
  if (criteria.cities && criteria.cities.length > 0) {
    if (!criteria.cities.includes(listing.city)) return false;
  }
  
  // Rooms filter
  if (criteria.rooms_min !== null && listing.rooms < criteria.rooms_min) return false;
  if (criteria.rooms_max !== null && listing.rooms > criteria.rooms_max) return false;
  
  // Size filter
  if (criteria.size_min !== null && listing.size_sqm < criteria.size_min) return false;
  if (criteria.size_max !== null && listing.size_sqm > criteria.size_max) return false;
  
  // Price filter
  if (criteria.price_min !== null && listing.price < criteria.price_min) return false;
  if (criteria.price_max !== null && listing.price > criteria.price_max) return false;
  
  // Complex filter
  if (criteria.complex_ids && criteria.complex_ids.length > 0) {
    if (!criteria.complex_ids.includes(listing.complex_id)) return false;
  }
  
  return true;
}

// Process new listing - send to all matching subscribers
async function processNewListing(listing) {
  try {
    console.log(`[ALERT] Processing new listing ${listing.id} for auto-alerts`);
    
    // Get all active subscriptions
    const subscriptions = await pool.query(`
      SELECT 
        ws.id as subscription_id,
        ws.lead_id,
        ws.criteria,
        l.phone,
        l.name,
        l.status
      FROM whatsapp_subscriptions ws
      INNER JOIN leads l ON ws.lead_id = l.id
      WHERE ws.active = true
        AND l.status IN ('active', 'converted')
        AND l.phone IS NOT NULL
    `);
    
    let sentCount = 0;
    let skippedCount = 0;
    
    for (const sub of subscriptions.rows) {
      try {
        const criteria = sub.criteria || {};
        
        // Check if listing matches this subscription's criteria
        if (!matchesCriteria(listing, criteria)) {
          skippedCount++;
          continue;
        }
        
        // Build and send message
        const message = buildListingMessage(listing, sub);
        const success = await sendListingAlert(sub.phone, message, listing.id);
        
        if (success) {
          // Log the alert
          await pool.query(`
            INSERT INTO whatsapp_alert_log (subscription_id, listing_id, sent_at)
            VALUES ($1, $2, NOW())
          `, [sub.subscription_id, listing.id]);
          
          // Update subscription stats
          await pool.query(`
            UPDATE whatsapp_subscriptions 
            SET alerts_sent = alerts_sent + 1,
                last_alert_at = NOW()
            WHERE id = $1
          `, [sub.subscription_id]);
          
          sentCount++;
          console.log(`[ALERT] ✓ Sent to lead ${sub.lead_id} (${sub.phone})`);
        }
        
        // Rate limiting - 2 seconds between messages
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`[ALERT] Error processing subscription ${sub.subscription_id}:`, error.message);
      }
    }
    
    console.log(`[ALERT] Listing ${listing.id}: sent ${sentCount}, skipped ${skippedCount}`);
    
    return { sent: sentCount, skipped: skippedCount, total: subscriptions.rows.length };
  } catch (error) {
    console.error('[ALERT] Process listing error:', error.message);
    throw error;
  }
}

// Batch process multiple new listings
async function processBatchListings(listings) {
  console.log(`[ALERT] Processing batch of ${listings.length} new listings`);
  
  let totalSent = 0;
  let totalSkipped = 0;
  
  for (const listing of listings) {
    try {
      const result = await processNewListing(listing);
      totalSent += result.sent;
      totalSkipped += result.skipped;
      
      // 5 second pause between listings to avoid overwhelming system
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (error) {
      console.error(`[ALERT] Batch processing error for listing ${listing.id}:`, error.message);
    }
  }
  
  return { totalSent, totalSkipped, processedListings: listings.length };
}

// Create subscription for a lead
async function createSubscription(leadId, criteria) {
  try {
    const result = await pool.query(`
      INSERT INTO whatsapp_subscriptions (
        lead_id,
        criteria,
        active,
        created_at,
        updated_at
      ) VALUES ($1, $2, true, NOW(), NOW())
      RETURNING *
    `, [leadId, JSON.stringify(criteria)]);
    
    return result.rows[0];
  } catch (error) {
    console.error('[ALERT] Create subscription error:', error.message);
    throw error;
  }
}

// Update subscription criteria
async function updateSubscription(subscriptionId, criteria) {
  try {
    const result = await pool.query(`
      UPDATE whatsapp_subscriptions
      SET 
        criteria = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [subscriptionId, JSON.stringify(criteria)]);
    
    return result.rows[0];
  } catch (error) {
    console.error('[ALERT] Update subscription error:', error.message);
    throw error;
  }
}

// Toggle subscription active status
async function toggleSubscription(subscriptionId, active) {
  try {
    const result = await pool.query(`
      UPDATE whatsapp_subscriptions
      SET 
        active = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [subscriptionId, active]);
    
    return result.rows[0];
  } catch (error) {
    console.error('[ALERT] Toggle subscription error:', error.message);
    throw error;
  }
}

// Get subscriptions for a lead
async function getSubscriptions(leadId) {
  try {
    const result = await pool.query(`
      SELECT 
        ws.*,
        COUNT(wal.id) as total_alerts_sent
      FROM whatsapp_subscriptions ws
      LEFT JOIN whatsapp_alert_log wal ON ws.id = wal.subscription_id
      WHERE ws.lead_id = $1
      GROUP BY ws.id
      ORDER BY ws.created_at DESC
    `, [leadId]);
    
    return result.rows;
  } catch (error) {
    console.error('[ALERT] Get subscriptions error:', error.message);
    throw error;
  }
}

module.exports = {
  processNewListing,
  processBatchListings,
  createSubscription,
  updateSubscription,
  toggleSubscription,
  getSubscriptions,
  buildListingMessage,
  matchesCriteria
};
