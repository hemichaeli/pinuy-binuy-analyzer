const { logger } = require('./logger');

/**
 * Nadlan.gov.il Transaction Scraper - STUB
 * TODO: Implement in Task 2
 */

async function scanAll(options = {}) {
  logger.info('Nadlan scraper: not yet implemented (stub)');
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    totalNew: 0,
    details: []
  };
}

async function scanComplex(complexId) {
  logger.info(`Nadlan scraper for complex ${complexId}: not yet implemented (stub)`);
  return { complexId, transactions: 0, status: 'stub' };
}

module.exports = { scanAll, scanComplex };
