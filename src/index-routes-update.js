function loadAllRoutes() {
  const routes = [
    ['./routes/projects', '/api/projects'],
    ['./routes/opportunities', '/api'],
    ['./routes/scan', '/api/scan'],
    ['./routes/alerts', '/api/alerts'],
    ['./routes/ssiRoutes', '/api/ssi'],
    ['./routes/enhancedData', '/api/enhanced'],
    ['./routes/konesRoutes', '/api/kones'],
    ['./routes/perplexityRoutes', '/api/perplexity'],
    ['./routes/intelligenceRoutes', '/api/intelligence'],
    ['./routes/chatRoutes', '/api/chat'],
    ['./routes/dashboardRoutes', '/api/dashboard'],
    ['./routes/governmentDataRoutes', '/api/government'],
    ['./routes/newsRoutes', '/api/news'],
    ['./routes/pricingRoutes', '/api/pricing'],
    ['./routes/messagingRoutes', '/api/messaging'],
    ['./routes/facebookRoutes', '/api/facebook'],
    ['./routes/admin', '/api/admin'],
    ['./routes/enrichmentRoutes', '/api/enrichment'],
    ['./routes/inforuRoutes', '/api/inforu'],
    ['./routes/quantumWhatsAppRoutes', '/api/quantum'],           // QUANTUM WhatsApp templates & campaigns
    ['./routes/quantumConversationRoutes', '/api/conversations'], // QUANTUM conversation management  
    ['./routes/premiumRoutes', '/api/premium'],
    ['./routes/signatureRoutes', '/api/signatures'],
    ['./routes/schedulerRoutes', '/api/scheduler/v2'],
    ['./routes/leadRoutes', '/api/leads'],
    ['./routes/botRoutes', '/api/bot'],
    ['./routes/firefliesWebhookRoutes', '/api/fireflies'],
    ['./routes/mavatBuildingRoutes', '/api/mavat'],
  ];
  
  let loaded = 0, failed = 0;
  for (const [routePath, mountPath] of routes) {
    if (loadRoute(routePath, mountPath)) loaded++;
    else failed++;
  }
  logger.info(`Routes: ${loaded} loaded, ${failed} skipped`);
}
