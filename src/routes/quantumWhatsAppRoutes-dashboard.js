// Add the following to the existing quantumWhatsAppRoutes.js file

// ==================== DASHBOARD ROUTE ====================

const path = require('path');
const fs = require('fs');

// Serve QUANTUM WhatsApp Dashboard
router.get('/dashboard', (req, res) => {
  try {
    const dashboardPath = path.join(__dirname, '../public/quantum-whatsapp-dashboard.html');
    
    if (fs.existsSync(dashboardPath)) {
      res.sendFile(path.resolve(dashboardPath));
    } else {
      // Fallback - serve basic dashboard info as JSON
      res.json({
        message: 'QUANTUM WhatsApp Dashboard',
        endpoints: {
          'Templates Status': '/api/quantum/templates/status',
          'Campaigns': '/api/quantum/campaigns',
          'Analytics': '/api/quantum/analytics',
          'Send Message': 'POST /api/quantum/send',
          'Create Templates': 'POST /api/quantum/templates/create-all',
          'Test Suite': '/api/quantum/test'
        },
        note: 'Dashboard HTML file not found. Use API endpoints directly.'
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test runner endpoint
router.get('/test', async (req, res) => {
  try {
    const QuantumTester = require('../tests/quantumWhatsAppIntegrationTest');
    
    // Run tests in background if requested
    if (req.query.async === 'true') {
      res.json({ message: 'Tests started in background', note: 'Check logs for results' });
      QuantumTester.runTests().catch(err => logger.error('Background test failed:', err));
      return;
    }
    
    // Run tests synchronously
    const results = await QuantumTester.runTests();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message, note: 'Test runner failed' });
  }
});

// Quick status endpoint
router.get('/status', async (req, res) => {
  try {
    const health = await axios.get(`${req.protocol}://${req.get('host')}/health`);
    const inforuStatus = await axios.get(`${req.protocol}://${req.get('host')}/api/inforu/status`);
    
    res.json({
      system: health.data.status,
      version: health.data.version,
      inforu: {
        configured: inforuStatus.data.configured,
        sms_working: inforuStatus.data.sms?.working,
        whatsapp_working: inforuStatus.data.whatsapp?.working,
        templates: inforuStatus.data.whatsapp?.templateCount || 0
      },
      quantum: {
        routes_loaded: true,
        dashboard: '/api/quantum/dashboard',
        test_suite: '/api/quantum/test'
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
