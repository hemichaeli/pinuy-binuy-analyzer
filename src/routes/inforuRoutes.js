const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let inforuService;
try {
  inforuService = require('../services/inforuService');
} catch (err) {
  logger.warn('INFORU service not available', { error: err.message });
}

// ==================== STATUS ====================

router.get('/status', async (req, res) => {
  try {
    const accountStatus = inforuService ? await inforuService.checkAccountStatus() : { configured: false };
    const stats = inforuService ? await inforuService.getStats() : null;
    res.json({
      inforu: accountStatus,
      stats,
      smsTemplates: inforuService ? Object.keys(inforuService.SMS_TEMPLATES).map(k => ({
        key: k, name: inforuService.SMS_TEMPLATES[k].name
      })) : [],
      whatsappTemplates: inforuService ? Object.keys(inforuService.WA_TEMPLATES).map(k => ({
        key: k, name: inforuService.WA_TEMPLATES[k].name, templateId: inforuService.WA_TEMPLATES[k].templateId
      })) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SMS ====================

router.get('/templates', (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  const templates = Object.entries(inforuService.SMS_TEMPLATES).map(([key, tmpl]) => ({
    key, name: tmpl.name, template: tmpl.template, maxLength: tmpl.maxLength,
    variables: (tmpl.template.match(/\{[a-z_]+\}/g) || []).map(v => v.replace(/[{}]/g, ''))
  }));
  res.json({ templates });
});

router.post('/send', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { phone, message, template, variables, senderName } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    let finalMessage;
    if (template) {
      finalMessage = inforuService.fillTemplate(template, variables || {});
    } else if (message) {
      finalMessage = message;
    } else {
      return res.status(400).json({ error: 'Either message or template required' });
    }

    const result = await inforuService.sendSms(phone, finalMessage, {
      senderName, templateKey: template,
      listingId: req.body.listingId, complexId: req.body.complexId
    });
    res.json(result);
  } catch (err) {
    logger.error('SMS send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== WHATSAPP ====================

router.get('/whatsapp/templates', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    // Return both QUANTUM templates and all INFORU templates
    const inforuTemplates = await inforuService.getWhatsAppTemplates();
    res.json({
      quantumTemplates: Object.entries(inforuService.WA_TEMPLATES).map(([key, tmpl]) => ({
        key, ...tmpl
      })),
      allTemplates: inforuTemplates.Data?.List || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp/template/:id', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const result = await inforuService.getWhatsAppTemplate(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/send', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { phone, template, variables } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!template) return res.status(400).json({ error: 'Template key required' });

    const result = await inforuService.sendWhatsApp(phone, template, variables || {}, {
      listingId: req.body.listingId, complexId: req.body.complexId
    });
    res.json(result);
  } catch (err) {
    logger.error('WhatsApp send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/chat', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { phone, message, mediaUrl } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!message) return res.status(400).json({ error: 'Message required' });

    const result = await inforuService.sendWhatsAppChat(phone, message, { mediaUrl });
    res.json(result);
  } catch (err) {
    logger.error('WhatsApp chat send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp/incoming', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const result = await inforuService.pullIncomingWhatsApp(parseInt(req.query.limit) || 100);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp/dlr', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const result = await inforuService.pullWhatsAppDLR(parseInt(req.query.limit) || 100);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DUAL CHANNEL ====================

router.post('/send-dual', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { phone, template, variables } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!template) return res.status(400).json({ error: 'Template key required' });

    const result = await inforuService.sendDualChannel(phone, template, variables || {}, {
      listingId: req.body.listingId, complexId: req.body.complexId
    });
    res.json(result);
  } catch (err) {
    logger.error('Dual channel send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== BULK ====================

router.post('/bulk', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { template, recipients, batchSize, delayMs, channel } = req.body;
    if (!template) return res.status(400).json({ error: 'Template key required' });
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients array required' });
    }
    if (recipients.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 recipients per batch' });
    }
    const result = await inforuService.bulkSend(template, recipients, {
      batchSize: batchSize || 10, delayMs: delayMs || 2000, channel: channel || 'sms'
    });
    res.json(result);
  } catch (err) {
    logger.error('Bulk send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== UTILS ====================

router.post('/preview', (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { template, variables } = req.body;
    if (!template) return res.status(400).json({ error: 'Template key required' });
    const message = inforuService.fillTemplate(template, variables || {});
    const isHebrew = /[\u0590-\u05FF]/.test(message);
    const maxSingle = isHebrew ? 70 : 160;
    res.json({
      template, message, length: message.length,
      segments: Math.ceil(message.length / maxSingle), isHebrew
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  if (!inforuService) return res.json({ channels: [], note: 'INFORU not configured' });
  try {
    const stats = await inforuService.getStats();
    res.json({ channels: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
