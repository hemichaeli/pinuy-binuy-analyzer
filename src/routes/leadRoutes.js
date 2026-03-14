/**
 * Lead Management Routes for QUANTUM
 * POST /submit - Receive lead from website
 * GET / - List leads (filters: type, status, urgent)
 * GET /stats - Lead statistics
 * PUT /:id/status - Update lead status
 * GET /trello/status - Trello integration status
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let leadService;
let trelloService;

try {
  leadService = require('../services/leadService');
} catch (e) {
  logger.error('leadService not available:', e.message);
}

try {
  trelloService = require('../services/trelloService');
} catch (e) {
  logger.warn('trelloService not available:', e.message);
}

/**
 * POST /submit - Process new lead from website
 */
router.post('/submit', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ success: false, error: 'Lead service not available' });
    }

    const { name, email, phone, userType, user_type, phoneVerified, phone_verified,
            mailingListConsent, mailing_list_consent, formData, form_data, source,
            campaign_tag, utm_source, utm_campaign } = req.body;

    // Also check query params for UTM (for QR/link-based flows)
    const utmSourceFinal = utm_source || req.query.utm_source || req.query.src || null;
    const utmCampaignFinal = utm_campaign || req.query.utm_campaign || req.query.campaign || null;
    const campaignTagFinal = campaign_tag || req.query.campaign_tag || utmCampaignFinal || null;

    const leadData = {
      name: name || 'Unknown',
      email: email || '',
      phone: phone || '',
      phone_verified: phoneVerified || phone_verified || false,
      user_type: userType || user_type || 'investor',
      form_data: formData || form_data || {},
      mailing_list_consent: mailingListConsent || mailing_list_consent || false,
      source: utmSourceFinal === 'flyer' ? 'flyer' : (source || 'website'),
      campaign_tag: campaignTagFinal,
      utm_source: utmSourceFinal,
      utm_campaign: utmCampaignFinal
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, phone'
      });
    }

    logger.info(`New lead received: ${leadData.name} (${leadData.user_type})`);

    const result = await leadService.processNewLead(leadData);

    res.status(result.saved ? 201 : 207).json({
      success: true,
      leadId: result.leadId,
      notifications: {
        email: result.emailSent,
        trello: result.trelloCreated
      },
      errors: result.errors.length > 0 ? result.errors : undefined
    });

  } catch (error) {
    logger.error('Lead submit error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET / - List leads with optional filters
 */
router.get('/', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const { type, status, urgent, limit, offset } = req.query;
    const result = await leadService.getLeads({
      type,
      status,
      urgent: urgent !== undefined ? urgent === 'true' : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0
    });

    res.json(result);
  } catch (error) {
    logger.error('Lead list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /stats - Lead statistics
 */
router.get('/stats', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const stats = await leadService.getLeadStats();
    res.json(stats);
  } catch (error) {
    logger.error('Lead stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /trello/status - Trello integration status
 */
router.get('/trello/status', async (req, res) => {
  try {
    if (!trelloService) {
      return res.json({ configured: false, error: 'Trello service not available' });
    }

    const status = await trelloService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /:id/status - Update lead status
 */
router.put('/:id/status', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Valid: ${validStatuses.join(', ')}`
      });
    }

    const result = await leadService.updateLeadStatus(parseInt(id), status, notes);
    res.json(result);
  } catch (error) {
    logger.error('Lead status update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
