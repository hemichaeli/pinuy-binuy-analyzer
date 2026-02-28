const { logger } = require('./logger');

let inforuService;
try {
  inforuService = require('./inforuService');
} catch (err) {
  logger.warn('INFORU service not available for polling', { error: err.message });
}

/**
 * QUANTUM WhatsApp Polling Service
 * Since INFORU doesn't have webhooks, we poll for incoming messages every 10 seconds
 */

class WhatsAppPollingService {
  constructor() {
    this.isPolling = false;
    this.pollInterval = 10000; // 10 seconds
    this.intervalId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
  }

  async start() {
    if (this.isPolling || !inforuService) {
      logger.warn('WhatsApp polling already running or INFORU not available');
      return;
    }

    logger.info('Starting WhatsApp incoming message polling', { interval: this.pollInterval });
    this.isPolling = true;
    this.consecutiveErrors = 0;

    // Start polling immediately, then every interval
    await this.pollOnce();
    this.intervalId = setInterval(() => this.pollOnce(), this.pollInterval);
  }

  async stop() {
    if (!this.isPolling) return;

    logger.info('Stopping WhatsApp polling');
    this.isPolling = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce() {
    if (!this.isPolling || !inforuService) return;

    try {
      // Pull incoming WhatsApp messages
      const incoming = await inforuService.pullIncomingWhatsApp(50);
      if (incoming.StatusId === 1 && incoming.Data?.List?.length > 0) {
        logger.info(`Received ${incoming.Data.List.length} incoming WhatsApp messages`);
        
        // Process each message
        for (const message of incoming.Data.List) {
          await this.processIncomingMessage(message);
        }
      }

      // Pull delivery reports
      const dlr = await inforuService.pullWhatsAppDLR(50);
      if (dlr.StatusId === 1 && dlr.Data?.List?.length > 0) {
        logger.info(`Received ${dlr.Data.List.length} WhatsApp delivery reports`);
        
        // Process delivery reports
        for (const report of dlr.Data.List) {
          await this.processDeliveryReport(report);
        }
      }

      // Reset error counter on successful poll
      this.consecutiveErrors = 0;

    } catch (err) {
      this.consecutiveErrors++;
      logger.error('WhatsApp polling error', { 
        error: err.message, 
        consecutiveErrors: this.consecutiveErrors 
      });

      // Stop polling if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error('Too many consecutive polling errors, stopping service');
        await this.stop();
      }
    }
  }

  async processIncomingMessage(message) {
    try {
      logger.info('Processing incoming WhatsApp message', {
        from: message.Phone,
        text: message.Message?.substring(0, 50),
        timestamp: message.Timestamp
      });

      // Extract phone number and message text
      const phone = message.Phone;
      const text = message.Message || '';
      const timestamp = message.Timestamp;

      // Forward to QUANTUM Bot for processing
      await this.forwardToBot(phone, text, {
        source: 'whatsapp_incoming',
        messageId: message.MessageId,
        timestamp: timestamp,
        rawData: message
      });

    } catch (err) {
      logger.error('Error processing incoming WhatsApp message', { 
        error: err.message, 
        message: message 
      });
    }
  }

  async processDeliveryReport(report) {
    try {
      logger.info('Processing WhatsApp delivery report', {
        phone: report.Phone,
        status: report.Status,
        messageId: report.MessageId
      });

      // Log delivery status for monitoring
      // Could update database records, trigger notifications, etc.

    } catch (err) {
      logger.error('Error processing WhatsApp delivery report', { 
        error: err.message, 
        report: report 
      });
    }
  }

  async forwardToBot(phone, text, metadata) {
    try {
      // Simulate bot webservice call structure
      const botRequest = {
        chat: {
          sender: phone,
          id: phone
        },
        parameters: [],
        value: {
          string: text
        }
      };

      // Call the bot's Claude decision function directly
      const axios = require('axios');
      const response = await axios.post(
        'http://localhost:3000/api/bot/webservice',  // Internal call
        botRequest,
        { 
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000 
        }
      );

      if (response.data?.actions) {
        // Process bot actions - send replies via WhatsApp
        for (const action of response.data.actions) {
          if (action.type === 'SendMessage' && action.text) {
            await this.sendWhatsAppReply(phone, action.text);
          }
        }
      }

    } catch (err) {
      logger.error('Error forwarding to bot', { error: err.message, phone });
      
      // Send error message to user
      try {
        await this.sendWhatsAppReply(phone, 'מתנצל על התקלה. נציג יחזור אליך בהקדם.');
      } catch (replyErr) {
        logger.error('Failed to send error reply', { error: replyErr.message, phone });
      }
    }
  }

  async sendWhatsAppReply(phone, text) {
    try {
      // Use WhatsApp Chat API (24-hour window for replies)
      const result = await inforuService.sendWhatsAppChat(phone, text);
      
      if (result.success) {
        logger.info('WhatsApp reply sent', { phone, length: text.length });
      } else {
        logger.warn('WhatsApp reply failed', { phone, error: result.description });
      }

      return result;
    } catch (err) {
      logger.error('Error sending WhatsApp reply', { error: err.message, phone });
      throw err;
    }
  }

  getStatus() {
    return {
      isPolling: this.isPolling,
      intervalMs: this.pollInterval,
      consecutiveErrors: this.consecutiveErrors,
      inforuAvailable: !!inforuService
    };
  }
}

// Singleton instance
const pollingService = new WhatsAppPollingService();

// Auto-start polling when service loads (if INFORU available)
if (inforuService && process.env.NODE_ENV === 'production') {
  // Start after 5 seconds to let server fully initialize
  setTimeout(() => pollingService.start(), 5000);
}

module.exports = {
  WhatsAppPollingService,
  pollingService
};