const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let signatureService;
try {
  signatureService = require('../services/signatureService');
} catch (err) {
  logger.warn('Signature service not available', { error: err.message });
}

/**
 * POST /api/signatures/enrich/:id
 * Enrich signature_percent for a single complex
 */
router.post('/enrich/:id', async (req, res) => {
  if (!signatureService) return res.status(503).json({ error: 'Signature service not available' });
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid complex ID' });
    const result = await signatureService.enrichSignature(id);
    res.json(result);
  } catch (err) {
    logger.error('Signature enrichment failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/signatures/batch
 * Batch enrich signatures
 * Body: { limit, minIai, staleOnly }
 */
router.post('/batch', async (req, res) => {
  if (!signatureService) return res.status(503).json({ error: 'Signature service not available' });
  try {
    const { limit = 20, minIai = 0, staleOnly = true } = req.body;
    logger.info(`Starting signature batch: limit=${limit}, minIai=${minIai}`);
    const results = await signatureService.enrichSignaturesBatch({ limit, minIai, staleOnly });
    res.json(results);
  } catch (err) {
    logger.error('Signature batch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/signatures/stats
 * Signature coverage statistics
 */
router.get('/stats', async (req, res) => {
  if (!signatureService) return res.status(503).json({ error: 'Signature service not available' });
  try {
    const stats = await signatureService.getSignatureStats();
    const pool = require('../db/pool');
    
    // Get top signed complexes
    const topSigned = await pool.query(`
      SELECT id, name, city, signature_percent, signature_source, signature_confidence,
             signature_source_detail, signature_date
      FROM complexes 
      WHERE signature_percent IS NOT NULL 
      ORDER BY signature_percent DESC 
      LIMIT 20
    `);

    res.json({
      coverage: {
        total: parseInt(stats.total),
        has_signature: parseInt(stats.has_signature),
        percent: Math.round((parseInt(stats.has_signature) / parseInt(stats.total)) * 100),
        from_protocol: parseInt(stats.from_protocol),
        from_press: parseInt(stats.from_press),
        avg_signature: stats.avg_signature ? Math.round(parseFloat(stats.avg_signature)) : null,
        avg_confidence: stats.avg_confidence ? Math.round(parseFloat(stats.avg_confidence)) : null
      },
      distribution: {
        above_80: parseInt(stats.above_80),
        between_60_80: parseInt(stats.between_60_80),
        below_60: parseInt(stats.below_60)
      },
      top_signed: topSigned.rows.map(r => ({
        id: r.id,
        name: r.name,
        city: r.city,
        signature_percent: parseFloat(r.signature_percent),
        source: r.signature_source,
        confidence: r.signature_confidence,
        source_detail: r.signature_source_detail,
        date: r.signature_date,
        color: r.signature_source === 'protocol' ? 'green' : 'yellow'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
