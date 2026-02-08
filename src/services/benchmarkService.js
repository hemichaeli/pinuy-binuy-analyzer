const { logger } = require('./logger');

/**
 * Benchmark Service - STUB
 * Compares complex prices vs. similar non-pinuy-binuy buildings
 * TODO: Implement in Task 3
 */

async function calculateAllBenchmarks(options = {}) {
  logger.info('Benchmark service: not yet implemented (stub)');
  return {
    calculated: 0,
    skipped: 0,
    errors: 0,
    summary: 'Benchmark calculation not yet implemented'
  };
}

async function calculateBenchmark(complexId) {
  logger.info(`Benchmark for complex ${complexId}: not yet implemented (stub)`);
  return { complexId, status: 'stub' };
}

module.exports = { calculateAllBenchmarks, calculateBenchmark };
