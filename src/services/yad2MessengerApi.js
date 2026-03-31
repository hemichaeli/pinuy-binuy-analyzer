/**
 * yad2 Messenger API Service v2 - REST API + Sendbird SDK
 *
 * Replaces the Puppeteer-based yad2Messenger.js with a pure REST API approach.
 * Uses yad2's gateway API for authentication and Sendbird for chat messaging.
 *
 * Architecture:
 *   1. Authenticate via POST gw.yad2.co.il/auth/login → JWT tokens
 *   2. Connect to Sendbird SDK using App ID + user ID from JWT
 *   3. Create/join group channels for listing conversations
 *   4. Send messages via Sendbird SDK
 *   5. Check inbox via Sendbird SDK
 *
 * Fallback: If Sendbird not configured, generates manual chat URLs
 *
 * Env vars:
 *   YAD2_EMAIL - yad2 account email
 *   YAD2_PASSWORD - yad2 account password
 *   YAD2_SENDBIRD_APP_ID - Sendbird application ID (extract from browser DevTools)
 */

const axios = require('axios');
const { logger } = require('./logger');

// ─── Configuration ───

const YAD2_AUTH_URL = 'https://gw.yad2.co.il/auth/login';
const YAD2_REFRESH_URL = 'https://gw.yad2.co.il/auth/token/refresh';
const YAD2_BASE = 'https://www.yad2.co.il';

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': YAD2_BASE,
  'Referer': `${YAD2_BASE}/login`,
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

// ─── State ───

let _accessToken = null;
let _refreshToken = null;
let _tokenExpiry = 0;
let _userId = null;
let _userUUID = null;
let _userName = null;
let _sendbirdSdk = null;
let _sendbirdConnected = false;

// ─── Authentication ───

/**
 * Login to yad2 via REST API
 * Returns JWT access_token + refresh_token
 */
async function login() {
  const email = process.env.YAD2_EMAIL;
  const password = process.env.YAD2_PASSWORD;

  if (!email || !password) {
    throw new Error('YAD2_EMAIL and YAD2_PASSWORD env vars required');
  }

  logger.info('[yad2Api] Logging in via REST API...');

  try {
    const response = await axios.post(YAD2_AUTH_URL, {
      email,
      password,
    }, {
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const { data } = response.data;

    if (!data?.access_token) {
      throw new Error(`Login failed: ${response.data?.message || 'No token returned'}`);
    }

    _accessToken = data.access_token;
    _refreshToken = data.refresh_token;

    // Decode JWT to extract user info (no verification needed - just decoding)
    const payload = _decodeJwt(_accessToken);
    _userId = payload.UserID;
    _userUUID = payload.UUID;
    _userName = `${payload.FirstName} ${payload.LastName}`;
    _tokenExpiry = payload.exp * 1000; // Convert to ms

    logger.info('[yad2Api] Login successful', {
      userId: _userId,
      userName: _userName,
      expiresIn: Math.round((_tokenExpiry - Date.now()) / 1000) + 's',
    });

    return {
      success: true,
      userId: _userId,
      userName: _userName,
      accessToken: _accessToken,
    };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('[yad2Api] Login failed', { error: msg });
    throw new Error(`yad2 login failed: ${msg}`);
  }
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken() {
  if (!_refreshToken) {
    return login(); // No refresh token, do full login
  }

  try {
    const response = await axios.post(YAD2_REFRESH_URL, {}, {
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/json',
        'Cookie': `refresh_token=${_refreshToken}`,
      },
      timeout: 10000,
    });

    if (response.data?.data?.access_token) {
      _accessToken = response.data.data.access_token;
      const payload = _decodeJwt(_accessToken);
      _tokenExpiry = payload.exp * 1000;
      logger.info('[yad2Api] Token refreshed');
      return { success: true };
    }
  } catch (err) {
    logger.warn('[yad2Api] Token refresh failed, doing full login', { error: err.message });
  }

  return login();
}

/**
 * Ensure we have a valid access token
 */
async function ensureAuth() {
  if (_accessToken && Date.now() < _tokenExpiry - 60000) {
    return; // Token still valid (with 1min buffer)
  }

  if (_refreshToken) {
    await refreshAccessToken();
  } else {
    await login();
  }
}

// ─── Sendbird Integration ───

/**
 * Initialize Sendbird SDK connection
 * Requires YAD2_SENDBIRD_APP_ID env var
 */
async function connectSendbird() {
  const appId = process.env.YAD2_SENDBIRD_APP_ID;

  if (!appId) {
    logger.warn('[yad2Api] YAD2_SENDBIRD_APP_ID not set - Sendbird messaging disabled');
    logger.warn('[yad2Api] To extract: open yad2.co.il in browser → DevTools → Console → search for "SendbirdChat.init" or "appId"');
    return false;
  }

  await ensureAuth();

  try {
    // Dynamic import of Sendbird SDK
    let SendbirdChat;
    try {
      const sb = require('@sendbird/chat');
      SendbirdChat = sb.default || sb.SendbirdChat || sb;
    } catch (e) {
      logger.warn('[yad2Api] @sendbird/chat not installed. Run: npm install @sendbird/chat');
      return false;
    }

    const { GroupChannelModule } = require('@sendbird/chat/groupChannel');

    _sendbirdSdk = SendbirdChat.init({
      appId,
      modules: [new GroupChannelModule()],
    });

    // Connect with user ID from yad2 JWT
    const sbUserId = `yad2_${_userId}`;
    await _sendbirdSdk.connect(sbUserId);

    _sendbirdConnected = true;
    logger.info('[yad2Api] Sendbird connected', { userId: sbUserId, appId: appId.substring(0, 8) + '...' });
    return true;
  } catch (err) {
    logger.error('[yad2Api] Sendbird connection failed', { error: err.message });
    _sendbirdConnected = false;
    return false;
  }
}

// ─── Messaging ───

/**
 * Send a message to a yad2 listing seller
 * @param {string} listingUrl - yad2 item URL (e.g., https://www.yad2.co.il/item/xxxxx)
 * @param {string} messageText - Message to send
 * @returns {Object} Result with success, status, channel
 */
async function sendMessage(listingUrl, messageText) {
  const itemId = _extractItemId(listingUrl);

  if (!itemId) {
    return {
      success: false,
      status: 'failed',
      error: 'Cannot extract item ID from URL',
      manual_url: listingUrl,
    };
  }

  logger.info('[yad2Api] Sending message', { itemId, messageLength: messageText.length });

  // Strategy 1: Try Sendbird SDK
  if (_sendbirdConnected && _sendbirdSdk) {
    try {
      const result = await _sendViaSendbird(itemId, messageText);
      if (result.success) return result;
    } catch (err) {
      logger.warn('[yad2Api] Sendbird send failed, trying fallback', { error: err.message });
    }
  }

  // Strategy 2: Try direct API (yad2 internal chat endpoints)
  try {
    await ensureAuth();
    const result = await _sendViaApi(itemId, messageText);
    if (result.success) return result;
  } catch (err) {
    logger.warn('[yad2Api] API send failed', { error: err.message });
  }

  // Strategy 3: Return manual URL for human action
  const manualUrl = `${YAD2_BASE}/item/${itemId}`;
  logger.info('[yad2Api] Returning manual URL', { itemId, url: manualUrl });

  return {
    success: false,
    status: 'manual',
    channel: 'yad2_chat',
    manual_url: manualUrl,
    message: 'Auto-send not available. Use the URL to send manually.',
    itemId,
  };
}

/**
 * Send message via Sendbird SDK
 */
async function _sendViaSendbird(itemId, messageText) {
  if (!_sendbirdSdk || !_sendbirdConnected) {
    return { success: false, error: 'Sendbird not connected' };
  }

  try {
    const { GroupChannelModule } = require('@sendbird/chat/groupChannel');

    // The channel URL pattern for yad2 is typically: yad2_item_{itemId}_{sellerId}_{buyerId}
    // We need to find or create the channel
    const channelUrl = `yad2_realestate_${itemId}`;

    // Try to get existing channel or create new one
    let channel;
    try {
      channel = await _sendbirdSdk.groupChannel.getChannel(channelUrl);
    } catch (e) {
      // Channel doesn't exist - need to create via yad2's API first
      // This would require knowing the seller's Sendbird user ID
      logger.warn('[yad2Api] Channel not found, need yad2 API to initiate conversation', { channelUrl });
      return { success: false, error: 'Channel not found - need API to create conversation' };
    }

    // Send message
    const params = {};
    params.message = messageText;
    const message = await channel.sendUserMessage(params);

    logger.info('[yad2Api] Message sent via Sendbird', { itemId, messageId: message.messageId });

    return {
      success: true,
      status: 'sent',
      channel: 'yad2_chat_sendbird',
      messageId: message.messageId,
      itemId,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: `Sendbird error: ${err.message}` };
  }
}

/**
 * Send message via yad2's internal chat API
 * Uses the gw.yad2.co.il/chat/ endpoints
 */
async function _sendViaApi(itemId, messageText) {
  const chatEndpoints = [
    { method: 'POST', url: `https://gw.yad2.co.il/chat/conversations/${itemId}/messages` },
    { method: 'POST', url: `https://gw.yad2.co.il/chat/item/${itemId}/message` },
    { method: 'POST', url: `https://gw.yad2.co.il/chat/send` },
  ];

  for (const ep of chatEndpoints) {
    try {
      const response = await axios({
        method: ep.method,
        url: ep.url,
        headers: {
          ...COMMON_HEADERS,
          'Content-Type': 'application/json',
          'Cookie': `access_token=${_accessToken}`,
          'Authorization': `Bearer ${_accessToken}`,
        },
        data: {
          itemId,
          message: messageText,
          text: messageText,
        },
        timeout: 10000,
        validateStatus: (s) => s < 500, // Don't throw on 4xx
      });

      if (response.status === 200 || response.status === 201) {
        logger.info('[yad2Api] Message sent via API', { endpoint: ep.url, itemId });
        return {
          success: true,
          status: 'sent',
          channel: 'yad2_chat_api',
          itemId,
          timestamp: new Date().toISOString(),
        };
      }

      // If we get a proper JSON error (not HTML), log it
      if (typeof response.data === 'object' && response.data?.message) {
        logger.debug('[yad2Api] API endpoint response', {
          url: ep.url,
          status: response.status,
          message: response.data.message,
        });
      }
    } catch (err) {
      // Continue to next endpoint
    }
  }

  return { success: false, error: 'No chat API endpoint worked' };
}

// ─── Inbox / Replies ───

/**
 * Check inbox for replies to our messages
 * @returns {Object} Conversations with unread messages
 */
async function checkReplies() {
  await ensureAuth();

  logger.info('[yad2Api] Checking inbox for replies...');

  // Try Sendbird SDK first
  if (_sendbirdConnected && _sendbirdSdk) {
    try {
      const result = await _checkRepliesViaSendbird();
      if (result.success) return result;
    } catch (err) {
      logger.warn('[yad2Api] Sendbird inbox check failed', { error: err.message });
    }
  }

  // Try API
  try {
    const result = await _checkRepliesViaApi();
    if (result.success) return result;
  } catch (err) {
    logger.warn('[yad2Api] API inbox check failed', { error: err.message });
  }

  return {
    success: false,
    total_conversations: 0,
    new_replies: [],
    manual_url: `${YAD2_BASE}/my-messages`,
    error: 'Could not fetch inbox. Check manually.',
  };
}

/**
 * Check replies via Sendbird SDK
 */
async function _checkRepliesViaSendbird() {
  if (!_sendbirdSdk) return { success: false };

  const { GroupChannelListQueryParams } = require('@sendbird/chat/groupChannel');

  const query = _sendbirdSdk.groupChannel.createMyGroupChannelListQuery({
    includeEmpty: false,
    limit: 20,
    order: 'latest_last_message',
  });

  const channels = await query.next();
  const conversations = [];

  for (const ch of channels) {
    if (ch.unreadMessageCount > 0) {
      conversations.push({
        channelUrl: ch.url,
        name: ch.name,
        unreadCount: ch.unreadMessageCount,
        lastMessage: ch.lastMessage?.message || '',
        lastMessageAt: ch.lastMessage?.createdAt ? new Date(ch.lastMessage.createdAt).toISOString() : null,
      });
    }
  }

  return {
    success: true,
    total_conversations: channels.length,
    unread_conversations: conversations.length,
    new_replies: conversations,
  };
}

/**
 * Check replies via yad2 API
 */
async function _checkRepliesViaApi() {
  const endpoints = [
    'https://gw.yad2.co.il/chat/conversations',
    'https://gw.yad2.co.il/chat/inbox',
    'https://gw.yad2.co.il/chat/unread',
  ];

  for (const url of endpoints) {
    try {
      const response = await axios.get(url, {
        headers: {
          ...COMMON_HEADERS,
          'Cookie': `access_token=${_accessToken}`,
          'Authorization': `Bearer ${_accessToken}`,
        },
        timeout: 10000,
        validateStatus: (s) => s < 500,
      });

      if (response.status === 200 && typeof response.data === 'object' && !response.data?.toString().includes('<!DOCTYPE')) {
        return {
          success: true,
          ...response.data,
        };
      }
    } catch (err) {
      // Try next
    }
  }

  return { success: false };
}

// ─── Status & Cleanup ───

/**
 * Get service status
 */
function getStatus() {
  return {
    service: 'yad2MessengerApi',
    version: 2,
    hasCredentials: !!(process.env.YAD2_EMAIL && process.env.YAD2_PASSWORD),
    isLoggedIn: !!_accessToken && Date.now() < _tokenExpiry,
    userId: _userId,
    userName: _userName,
    tokenExpiresIn: _tokenExpiry > 0 ? Math.max(0, Math.round((_tokenExpiry - Date.now()) / 1000)) + 's' : 'N/A',
    sendbird: {
      appIdConfigured: !!process.env.YAD2_SENDBIRD_APP_ID,
      connected: _sendbirdConnected,
    },
    capabilities: {
      restLogin: true,
      sendbirdMessaging: _sendbirdConnected,
      apiMessaging: !!_accessToken,
      manualUrlGeneration: true,
    },
  };
}

/**
 * Cleanup connections
 */
async function cleanup() {
  if (_sendbirdSdk && _sendbirdConnected) {
    try {
      await _sendbirdSdk.disconnect();
    } catch (e) { /* ignore */ }
    _sendbirdConnected = false;
  }
  _accessToken = null;
  _refreshToken = null;
  _tokenExpiry = 0;
}

// ─── Utilities ───

/**
 * Decode JWT payload (no verification)
 */
function _decodeJwt(token) {
  try {
    const parts = token.split('.');
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return {};
  }
}

/**
 * Extract yad2 item ID from URL
 */
function _extractItemId(url) {
  if (!url) return null;
  // Match /item/xxxxx patterns
  const match = url.match(/\/item\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  // Maybe it's just the ID
  if (/^[a-zA-Z0-9]{6,15}$/.test(url)) return url;
  return null;
}

/**
 * Get authenticated cookies for browser-based operations
 * Can be used by Apify actors or Chrome extensions
 */
async function getAuthCookies() {
  await ensureAuth();
  return {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    userId: _userId,
    domain: '.yad2.co.il',
  };
}

/**
 * Generate a pre-authenticated message URL
 * User can click this to go directly to the listing's chat
 */
function getMessageUrl(itemId) {
  return `${YAD2_BASE}/item/${itemId}`;
}

// ─── Backward Compatibility (matches yad2Messenger.js exports) ───

module.exports = {
  login,
  sendMessage,
  checkReplies,
  cleanup,
  getStatus,
  getAuthCookies,
  getMessageUrl,
  connectSendbird,
  ensureAuth,
  // Aliased for backward compat with yad2Messenger
  _getPage: () => null, // No puppeteer page
  _getCookies: async () => {
    if (!_accessToken) return [];
    return [
      { name: 'access_token', value: _accessToken, domain: '.yad2.co.il' },
      { name: 'refresh_token', value: _refreshToken, domain: '.yad2.co.il' },
    ];
  },
};
