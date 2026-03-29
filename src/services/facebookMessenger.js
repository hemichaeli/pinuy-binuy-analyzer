/**
 * Facebook Messenger Service - Cookie-based messaging for Marketplace listings
 *
 * Uses FB cookies from env to send messages to FB Marketplace sellers
 * via the Facebook Graph API (unofficial user endpoint).
 *
 * Priority: platform messaging first (Messenger), WhatsApp fallback.
 */

const axios = require('axios');
const { logger } = require('./logger');

const FB_GRAPH_URL = 'https://graph.facebook.com/v19.0';

// ─── Cookie / Token Management ───

let cachedToken = null;
let cachedCookies = null;

function loadFbCredentials() {
  if (cachedToken && cachedCookies) return { token: cachedToken, cookies: cachedCookies };

  const b64 = process.env.FB_COOKIES_BASE64;
  if (!b64) {
    logger.debug('[FBMessenger] FB_COOKIES_BASE64 not set');
    return null;
  }

  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    cachedCookies = JSON.parse(json);

    // Extract c_user from cookies for user ID
    const cUser = cachedCookies.find(c => c.name === 'c_user');
    if (!cUser) {
      logger.warn('[FBMessenger] No c_user cookie found');
      return null;
    }

    // Build cookie string for HTTP requests
    const cookieStr = cachedCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Access token from env (may be expired — cookie-based approach is primary)
    cachedToken = process.env.FB_ACCESS_TOKEN || null;

    logger.info(`[FBMessenger] Credentials loaded, user: ${cUser.value}, cookies: ${cachedCookies.length}`);
    return { token: cachedToken, cookies: cachedCookies, cookieStr, userId: cUser.value };
  } catch (err) {
    logger.warn(`[FBMessenger] Failed to load credentials: ${err.message}`);
    return null;
  }
}

// ─── Send Message via Graph API ───

/**
 * Send a message to a Facebook user/listing seller via Messenger
 * Uses the Graph API with user access token
 */
async function sendMessage(recipientId, messageText) {
  const creds = loadFbCredentials();
  if (!creds || !creds.token) {
    return { success: false, error: 'FB credentials not configured', channel: 'fb_messenger' };
  }

  try {
    // Use the conversations endpoint to send a message
    const response = await axios.post(
      `${FB_GRAPH_URL}/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: messageText }
      },
      {
        params: { access_token: creds.token },
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    logger.info(`[FBMessenger] Message sent to ${recipientId}`, {
      messageId: response.data?.message_id
    });

    return {
      success: true,
      channel: 'fb_messenger',
      messageId: response.data?.message_id,
      recipientId
    };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    logger.warn(`[FBMessenger] Graph API send failed: ${errMsg}`);

    // If Graph API fails, fall back to cookie-based approach
    return await sendMessageViaCookies(recipientId, messageText, creds);
  }
}

/**
 * Fallback: send message via Facebook's internal API using cookies
 * This uses the same mechanism as the web browser
 */
async function sendMessageViaCookies(recipientId, messageText, creds) {
  if (!creds?.cookieStr) {
    return { success: false, error: 'No cookies available for fallback', channel: 'fb_messenger' };
  }

  try {
    // Facebook's internal messaging API (used by the web client)
    const response = await axios.post(
      'https://www.facebook.com/messaging/send/',
      new URLSearchParams({
        'body': messageText,
        'other_user_fbid': recipientId,
        'action_type': 'ma-type:user-generated-message',
        '__a': '1'
      }).toString(),
      {
        headers: {
          'Cookie': creds.cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://www.facebook.com',
          'Referer': 'https://www.facebook.com/messages/'
        },
        timeout: 15000
      }
    );

    const success = response.status === 200;
    logger.info(`[FBMessenger] Cookie-based send ${success ? 'succeeded' : 'failed'}`, { recipientId });

    return {
      success,
      channel: 'fb_messenger',
      method: 'cookies',
      recipientId
    };
  } catch (err) {
    logger.warn(`[FBMessenger] Cookie-based send failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      channel: 'fb_messenger',
      method: 'cookies'
    };
  }
}

// ─── Send to Marketplace Listing ───

/**
 * Send a message to a Facebook Marketplace listing seller
 * Extracts seller ID from listing URL and sends via Messenger
 */
async function sendToMarketplaceListing(listingUrl, messageText) {
  const creds = loadFbCredentials();
  if (!creds) {
    return {
      success: false,
      error: 'FB credentials not configured',
      channel: 'fb_messenger',
      fallback: 'manual',
      manualUrl: listingUrl
    };
  }

  // Extract listing ID from URL
  const listingMatch = listingUrl?.match(/marketplace\/item\/(\d+)/);
  const listingId = listingMatch ? listingMatch[1] : null;

  if (!listingId) {
    return {
      success: false,
      error: 'Cannot extract listing ID from URL',
      channel: 'fb_messenger',
      fallback: 'manual',
      manualUrl: listingUrl
    };
  }

  try {
    // Try Graph API approach: send message about a marketplace listing
    const response = await axios.post(
      `${FB_GRAPH_URL}/${listingId}/messages`,
      { message: messageText },
      {
        params: { access_token: creds.token },
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    return {
      success: true,
      channel: 'fb_messenger',
      listingId,
      messageId: response.data?.message_id
    };
  } catch (err) {
    logger.debug(`[FBMessenger] Marketplace Graph API failed, trying cookie method`);

    // Fallback: use cookie-based approach to message about the listing
    try {
      const result = await sendMarketplaceMessageViaCookies(listingId, messageText, creds);
      return result;
    } catch (cookieErr) {
      return {
        success: false,
        error: `Graph: ${err.message}, Cookies: ${cookieErr.message}`,
        channel: 'fb_messenger',
        fallback: 'manual',
        manualUrl: listingUrl
      };
    }
  }
}

/**
 * Send a marketplace listing message using cookies
 */
async function sendMarketplaceMessageViaCookies(listingId, messageText, creds) {
  try {
    // Facebook's marketplace messaging endpoint
    const response = await axios.post(
      'https://www.facebook.com/api/graphql/',
      new URLSearchParams({
        'fb_api_req_friendly_name': 'MarketplaceSendMessage',
        'variables': JSON.stringify({
          input: {
            listing_id: listingId,
            message: { text: messageText }
          }
        }),
        'doc_id': '5889623031114251', // Marketplace send message mutation
        '__a': '1'
      }).toString(),
      {
        headers: {
          'Cookie': creds.cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://www.facebook.com',
          'Referer': `https://www.facebook.com/marketplace/item/${listingId}/`
        },
        timeout: 15000
      }
    );

    const success = response.status === 200 && !response.data?.errors;
    return {
      success,
      channel: 'fb_messenger',
      method: 'marketplace_cookies',
      listingId,
      error: response.data?.errors ? JSON.stringify(response.data.errors).substring(0, 200) : null
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      channel: 'fb_messenger',
      method: 'marketplace_cookies',
      listingId
    };
  }
}

// ─── Check Inbox for Replies ───

/**
 * Check for incoming messages (replies from sellers)
 */
async function checkInbox(sinceTimestamp = null) {
  const creds = loadFbCredentials();
  if (!creds || !creds.token) {
    return { success: false, error: 'FB credentials not configured', messages: [] };
  }

  try {
    const params = { access_token: creds.token, fields: 'messages{message,from,created_time}', limit: 20 };
    if (sinceTimestamp) params.since = sinceTimestamp;

    const response = await axios.get(`${FB_GRAPH_URL}/me/conversations`, {
      params,
      timeout: 15000
    });

    const conversations = response.data?.data || [];
    const messages = [];

    for (const conv of conversations) {
      const msgs = conv.messages?.data || [];
      for (const msg of msgs) {
        if (msg.from?.id !== creds.userId) {
          messages.push({
            conversationId: conv.id,
            messageId: msg.id,
            from: msg.from,
            text: msg.message,
            createdAt: msg.created_time,
            channel: 'fb_messenger'
          });
        }
      }
    }

    return { success: true, messages, count: messages.length };
  } catch (err) {
    logger.warn(`[FBMessenger] Inbox check failed: ${err.message}`);
    return { success: false, error: err.message, messages: [] };
  }
}

// ─── Status ───

function getStatus() {
  const creds = loadFbCredentials();
  return {
    configured: !!creds,
    hasToken: !!creds?.token,
    hasCookies: !!creds?.cookieStr,
    userId: creds?.userId || null,
    channel: 'fb_messenger'
  };
}

module.exports = {
  sendMessage,
  sendToMarketplaceListing,
  checkInbox,
  getStatus,
  loadFbCredentials
};
