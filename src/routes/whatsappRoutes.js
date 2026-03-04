const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

/**
 * INFORU WhatsApp Webhook Handler
 * 
 * INFORU sends incoming WhatsApp messages in this format:
 * {
 *   "CustomerId": 29838,
 *   "ProjectId": 1056646,
 *   "Data": [{
 *     "Channel": "SMS_MO",
 *     "Type": "PhoneNumber",
 *     "Value": "0522377712",
 *     "Keyword": "keyword",
 *     "Message": "full message text",
 *     "Network": "WhatsApp",
 *     "ShortCode": "97237572229",
 *     "ApplicationID": "14158",
 *     "CustomerParam": "wamid...",
 *     "MoSessionId": "wamid...",
 *     "AdditionalInfo": "{\"AccountId\":\"...\",\"SenderId\":\"...\"}"
 *   }]
 * }
 */

// POST /api/whatsapp/webhook - Receive incoming messages from INFORU
router.post('/webhook', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Log raw payload for debugging
    logger.info('[WHATSAPP WEBHOOK] Received payload:', {
      customerId: req.body.CustomerId,
      projectId: req.body.ProjectId,
      dataCount: req.body.Data?.length || 0
    });

    // Validate INFORU payload structure
    if (!req.body.Data || !Array.isArray(req.body.Data)) {
      logger.warn('[WHATSAPP WEBHOOK] Invalid payload - missing Data array');
      return res.status(400).json({ 
        error: 'Invalid payload', 
        message: 'Data array is required' 
      });
    }

    // Process each message in the Data array
    const results = [];
    for (const message of req.body.Data) {
      try {
        const result = await processIncomingMessage(message);
        results.push(result);
      } catch (error) {
        logger.error('[WHATSAPP WEBHOOK] Failed to process message:', error);
        results.push({ 
          status: 'error', 
          phone: message.Value, 
          error: error.message 
        });
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`[WHATSAPP WEBHOOK] Processed ${results.length} messages in ${duration}ms`);

    // CRITICAL: Return 200 OK quickly to prevent INFORU timeout
    res.status(200).json({ 
      status: 'ok', 
      processed: results.length,
      duration: `${duration}ms`,
      results 
    });

  } catch (error) {
    logger.error('[WHATSAPP WEBHOOK] Unexpected error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

/**
 * Process a single incoming WhatsApp message
 */
async function processIncomingMessage(message) {
  const {
    Value: phoneNumber,
    Message: text,
    Keyword: keyword,
    Network: network,
    ShortCode: businessNumber,
    CustomerParam: messageId,
    MoSessionId: sessionId,
    AdditionalInfo: additionalInfo
  } = message;

  logger.info('[WHATSAPP MESSAGE]', {
    from: phoneNumber,
    to: businessNumber,
    text,
    keyword,
    messageId: messageId?.substring(0, 20) + '...'
  });

  // Parse AdditionalInfo JSON if present
  let accountInfo = {};
  try {
    if (additionalInfo && typeof additionalInfo === 'string') {
      accountInfo = JSON.parse(additionalInfo);
    }
  } catch (e) {
    logger.warn('[WHATSAPP MESSAGE] Failed to parse AdditionalInfo:', e.message);
  }

  // TODO: Process the message (store in DB, trigger bot response, etc.)
  // For now, just log and acknowledge
  
  // Example: Detect intent based on message
  const intent = detectIntent(text, keyword);
  
  logger.info('[WHATSAPP MESSAGE] Detected intent:', {
    phone: phoneNumber,
    intent,
    text
  });

  return {
    status: 'processed',
    phone: phoneNumber,
    intent,
    messageId: messageId?.substring(0, 20) + '...'
  };
}

/**
 * Simple intent detection
 */
function detectIntent(text, keyword) {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword?.toLowerCase() || '';

  // Greetings
  if (/^(שלום|היי|הי|בוקר טוב|ערב טוב|hello|hi|hey)/i.test(lowerText)) {
    return 'greeting';
  }

  // Help/Info
  if (/^(עזרה|מידע|help|info|\?)/i.test(lowerText)) {
    return 'help';
  }

  // Numbers (menu selection)
  if (/^\d+$/.test(lowerText.trim())) {
    return 'menu_selection';
  }

  // Default
  return 'unknown';
}

// GET /api/whatsapp/status - Health check for webhook
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    webhook: '/api/whatsapp/webhook',
    method: 'POST',
    format: 'INFORU',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
