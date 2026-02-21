const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

// Service loading with proper error handling
let deepEnrichmentService;
let scanPriorityService; 
let smartBatchService;
let neighborhoodBenchmarkService;
let onboardingPipeline;

try {
  deepEnrichmentService = require('../services/deepEnrichmentService');
} catch (err) {
  logger.warn('Deep enrichment service not available', { error: err.message });
}

try {
  scanPriorityService = require('../services/scanPriorityService');
} catch (err) {
  logger.warn('Scan priority service not available', { error: err.message });
}

try {
  smartBatchService = require('../services/smartBatchService');
} catch (err) {
  logger.warn('Smart batch service not available', { error: err.message });
}

try {
  neighborhoodBenchmarkService = require('../services/neighborhoodBenchmarkService');
} catch (err) {
  logger.warn('Neighborhood benchmark service not available', { error: err.message });
}

try {
  onboardingPipeline = require('../services/onboardingPipeline');
} catch (err) {
  logger.warn('Onboarding pipeline not available', { error: err.message });
}