const axios = require('axios');
const { logger } = require('../services/logger');

/**
 * QUANTUM WhatsApp Integration Testing Suite
 * Comprehensive testing of WhatsApp templates, campaigns, and messaging
 */

class QuantumWhatsAppTester {
  constructor(baseUrl = 'https://pinuy-binuy-analyzer-production.up.railway.app') {
    this.baseUrl = baseUrl;
    this.testPhone = '0522377712'; // Default test phone
    this.results = {
      timestamp: new Date().toISOString(),
      tests: [],
      summary: { passed: 0, failed: 0, skipped: 0 }
    };
  }

  async test(name, testFn) {
    logger.info(`[TEST] Starting: ${name}`);
    try {
      const startTime = Date.now();
      const result = await testFn();
      const duration = Date.now() - startTime;
      
      this.results.tests.push({
        name,
        status: 'PASSED',
        duration,
        result: typeof result === 'object' ? JSON.stringify(result) : result,
        timestamp: new Date().toISOString()
      });
      this.results.summary.passed++;
      logger.info(`[TEST] ✅ ${name} (${duration}ms)`);
      return result;
    } catch (error) {
      this.results.tests.push({
        name,
        status: 'FAILED',
        error: error.message,
        timestamp: new Date().toISOString()
      });
      this.results.summary.failed++;
      logger.error(`[TEST] ❌ ${name}: ${error.message}`);
      throw error;
    }
  }

  async skip(name, reason = '') {
    this.results.tests.push({
      name,
      status: 'SKIPPED',
      reason,
      timestamp: new Date().toISOString()
    });
    this.results.summary.skipped++;
    logger.warn(`[TEST] ⏭️ ${name}: ${reason}`);
  }

  // ==================== BASIC SYSTEM TESTS ====================

  async testSystemHealth() {
    const response = await axios.get(`${this.baseUrl}/health`, { timeout: 10000 });
    if (response.status !== 200) throw new Error('Health check failed');
    if (!response.data.status || response.data.status !== 'ok') {
      throw new Error('System not healthy: ' + JSON.stringify(response.data));
    }
    return response.data;
  }

  async testRouteLoading() {
    const response = await axios.get(`${this.baseUrl}/debug`, { timeout: 10000 });
    if (response.status !== 200) throw new Error('Debug endpoint failed');
    
    const quantumRoute = response.data.routes?.find(r => r.path === '/api/quantum');
    if (!quantumRoute) throw new Error('QUANTUM route not loaded');
    if (quantumRoute.status !== 'ok') {
      throw new Error(`QUANTUM route failed: ${quantumRoute.error}`);
    }
    
    return { 
      totalRoutes: response.data.routes?.length || 0,
      quantumRoute: quantumRoute,
      version: response.data.version
    };
  }

  // ==================== INFORU API TESTS ====================

  async testInforuStatus() {
    const response = await axios.get(`${this.baseUrl}/api/inforu/status`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('INFORU status failed');
    
    const data = response.data;
    if (!data.configured) throw new Error('INFORU not configured');
    if (!data.sms?.working) throw new Error('SMS API not working');
    if (!data.whatsapp?.working) throw new Error('WhatsApp API not working');
    
    return {
      sms: data.sms,
      whatsapp: data.whatsapp,
      templateCount: data.whatsapp?.templateCount || 0
    };
  }

  async testExistingWhatsAppTemplates() {
    const response = await axios.get(`${this.baseUrl}/api/inforu/whatsapp/templates`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('Template list failed');
    
    const templates = response.data.Data?.List || [];
    const approvedTemplates = templates.filter(t => t.ApprovalStatusDescription === 'APPROVED');
    
    return {
      totalTemplates: templates.length,
      approvedTemplates: approvedTemplates.length,
      templates: templates.map(t => ({
        id: t.TemplateId,
        name: t.TemplateName,
        status: t.ApprovalStatusDescription
      }))
    };
  }

  // ==================== QUANTUM TEMPLATES TESTS ====================

  async testQuantumTemplatesStatus() {
    const response = await axios.get(`${this.baseUrl}/api/quantum/templates/status`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('QUANTUM templates status failed');
    
    return response.data;
  }

  async testQuantumCampaigns() {
    const response = await axios.get(`${this.baseUrl}/api/quantum/campaigns`, { timeout: 10000 });
    if (response.status !== 200) throw new Error('QUANTUM campaigns failed');
    
    const data = response.data;
    if (!data.campaigns || !data.templates) {
      throw new Error('Missing campaigns or templates data');
    }
    
    return {
      campaignCount: Object.keys(data.campaigns).length,
      templateCount: Object.keys(data.templates).length,
      campaigns: Object.keys(data.campaigns),
      templates: Object.keys(data.templates)
    };
  }

  async testCampaignPreviews() {
    const response = await axios.get(`${this.baseUrl}/api/quantum/campaigns/test`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('Campaign previews failed');
    
    const previews = response.data.previews;
    if (!previews || Object.keys(previews).length === 0) {
      throw new Error('No campaign previews generated');
    }
    
    return {
      previewCount: Object.keys(previews).length,
      previews: Object.keys(previews).map(key => ({
        campaign: key,
        hasPreview: !!previews[key].preview,
        hasError: !!previews[key].error
      }))
    };
  }

  // ==================== MESSAGING TESTS ====================

  async testExistingWhatsAppSend() {
    // Test with existing approved template
    const payload = {
      phone: this.testPhone,
      template: 'institutional_message',
      variables: {},
      options: { source: 'integration_test' }
    };
    
    const response = await axios.post(`${this.baseUrl}/api/inforu/whatsapp/send`, payload, { timeout: 15000 });
    if (response.status !== 200) throw new Error('WhatsApp send failed');
    
    const result = response.data;
    if (!result.success) {
      throw new Error(`Send failed: ${result.description} (Status: ${result.status})`);
    }
    
    return {
      success: result.success,
      recipientsCount: result.recipientsCount,
      templateId: result.templateId,
      status: result.status
    };
  }

  async testQuantumWhatsAppSend() {
    // Test with QUANTUM-enhanced endpoint
    const payload = {
      phone: this.testPhone,
      template: 'test_message',
      variables: { name: 'Test User' },
      options: { 
        source: 'quantum_integration_test',
        campaignType: 'integration_test'
      }
    };
    
    const response = await axios.post(`${this.baseUrl}/api/quantum/send`, payload, { timeout: 15000 });
    if (response.status !== 200) throw new Error('QUANTUM WhatsApp send failed');
    
    const result = response.data;
    if (!result.success) {
      throw new Error(`QUANTUM send failed: ${result.description}`);
    }
    
    return {
      success: result.success,
      quantum: result.quantum,
      templateType: result.quantum?.templateType
    };
  }

  // ==================== ANALYTICS & DATA TESTS ====================

  async testAnalytics() {
    const response = await axios.get(`${this.baseUrl}/api/quantum/analytics`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('Analytics failed');
    
    return response.data;
  }

  async testCampaignTargets() {
    const response = await axios.get(`${this.baseUrl}/api/quantum/targets/high_ssi_seller?limit=5`, { timeout: 15000 });
    if (response.status !== 200) throw new Error('Campaign targets failed');
    
    return {
      campaignType: response.data.campaignType,
      targetsFound: response.data.targetsFound,
      hasTargets: response.data.targets && response.data.targets.length > 0
    };
  }

  // ==================== INTEGRATION WITH QUANTUM DATA ====================

  async testDatabaseIntegration() {
    // Test that we can access QUANTUM database tables
    const complexesResponse = await axios.get(`${this.baseUrl}/api/complexes?limit=5`, { timeout: 10000 });
    if (complexesResponse.status !== 200) throw new Error('Complexes API failed');
    
    const complexes = complexesResponse.data;
    if (!complexes || complexes.length === 0) {
      throw new Error('No complexes found in database');
    }
    
    return {
      complexCount: complexes.length,
      hasSSIData: complexes.some(c => c.ssi_score !== null),
      hasIAIData: complexes.some(c => c.iai_score !== null)
    };
  }

  // ==================== RUN ALL TESTS ====================

  async runAllTests() {
    logger.info('🚀 Starting QUANTUM WhatsApp Integration Test Suite');
    console.log('\n=== QUANTUM WHATSAPP INTEGRATION TEST SUITE ===\n');
    
    try {
      // Basic System Tests
      console.log('📋 BASIC SYSTEM TESTS');
      await this.test('System Health Check', () => this.testSystemHealth());
      await this.test('Route Loading', () => this.testRouteLoading());
      
      // INFORU API Tests
      console.log('\n📞 INFORU API TESTS');
      await this.test('INFORU Status', () => this.testInforuStatus());
      await this.test('Existing Templates', () => this.testExistingWhatsAppTemplates());
      
      // QUANTUM Templates Tests
      console.log('\n🎯 QUANTUM TEMPLATES TESTS');
      await this.test('QUANTUM Templates Status', () => this.testQuantumTemplatesStatus());
      await this.test('QUANTUM Campaigns', () => this.testQuantumCampaigns());
      await this.test('Campaign Previews', () => this.testCampaignPreviews());
      
      // Messaging Tests
      console.log('\n💬 MESSAGING TESTS');
      await this.test('Existing WhatsApp Send', () => this.testExistingWhatsAppSend());
      await this.test('QUANTUM WhatsApp Send', () => this.testQuantumWhatsAppSend());
      
      // Analytics & Data Tests
      console.log('\n📊 ANALYTICS & DATA TESTS');
      await this.test('Analytics Dashboard', () => this.testAnalytics());
      await this.test('Campaign Targets', () => this.testCampaignTargets());
      await this.test('Database Integration', () => this.testDatabaseIntegration());
      
    } catch (error) {
      logger.error('Test suite encountered critical error:', error.message);
    }
    
    // Print Results
    console.log('\n=== TEST RESULTS ===');
    console.log(`✅ Passed: ${this.results.summary.passed}`);
    console.log(`❌ Failed: ${this.results.summary.failed}`);
    console.log(`⏭️ Skipped: ${this.results.summary.skipped}`);
    console.log(`📊 Total: ${this.results.tests.length}`);
    
    if (this.results.summary.failed > 0) {
      console.log('\n❌ FAILED TESTS:');
      this.results.tests
        .filter(t => t.status === 'FAILED')
        .forEach(t => console.log(`  - ${t.name}: ${t.error}`));
    }
    
    if (this.results.summary.passed === this.results.tests.length) {
      console.log('\n🎉 ALL TESTS PASSED! QUANTUM WhatsApp integration is ready!');
    } else {
      console.log(`\n⚠️ ${this.results.summary.failed} tests failed. Review and fix issues.`);
    }
    
    return this.results;
  }

  // ==================== STATIC TEST RUNNER ====================
  
  static async runTests() {
    const tester = new QuantumWhatsAppTester();
    return await tester.runAllTests();
  }
}

module.exports = QuantumWhatsAppTester;

// Allow running from command line
if (require.main === module) {
  QuantumWhatsAppTester.runTests()
    .then(results => {
      console.log('\nTest completed.');
      process.exit(results.summary.failed === 0 ? 0 : 1);
    })
    .catch(error => {
      console.error('Test suite failed:', error.message);
      process.exit(1);
    });
}
