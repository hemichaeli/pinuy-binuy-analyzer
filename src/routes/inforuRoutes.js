const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let inforuService;
try {
  inforuService = require('../services/inforuService');
} catch (err) {
  logger.warn('INFORU service not available', { error: err.message });
}

router.get('/status', async (req, res) => {
  try {
    const accountStatus = inforuService ? await inforuService.checkAccountStatus() : { configured: false };
    const stats = inforuService ? await inforuService.getStats() : null;
    res.json({
      inforu: accountStatus,
      stats: stats,
      templates: inforuService ? Object.keys(inforuService.TEMPLATES).map(k => ({
        key: k, name: inforuService.TEMPLATES[k].name, maxLength: inforuService.TEMPLATES[k].maxLength
      })) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates', (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  const templates = Object.entries(inforuService.TEMPLATES).map(([key, tmpl]) => ({
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

router.post('/bulk', async (req, res) => {
  if (!inforuService) return res.status(503).json({ error: 'INFORU not available' });
  try {
    const { template, recipients, batchSize, delayMs, senderName } = req.body;
    if (!template) return res.status(400).json({ error: 'Template key required' });
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients array required' });
    }
    if (recipients.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 recipients per batch' });
    }
    const result = await inforuService.bulkSend(template, recipients, {
      batchSize: batchSize || 10, delayMs: delayMs || 2000, senderName
    });
    res.json(result);
  } catch (err) {
    logger.error('Bulk SMS failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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
      segments: Math.ceil(message.length / maxSingle), isHebrew,
      costEstimate: `~${(Math.ceil(message.length / maxSingle) * 0.07).toFixed(2)} ILS per recipient`
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  if (!inforuService) return res.json({ total_sent: 0, successful: 0, failed: 0, note: 'INFORU not configured' });
  try {
    const stats = await inforuService.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
