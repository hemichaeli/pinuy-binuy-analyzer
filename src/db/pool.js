const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://pinuy_admin:pinuy_secure_2024@faithful-comfort.railway.internal:5432/pinuy_binuy';

console.log(`[pool] DATABASE_URL defined: ${!!process.env.DATABASE_URL}`);
try {
  const parsed = new URL(DATABASE_URL);
  console.log(`[pool] Using URL host: ${parsed.hostname}`);
} catch (e) {
  console.log(`[pool] URL parse info: ${DATABASE_URL.substring(0, 30)}...`);
}
console.log(`[pool] SSL: ${process.env.DATABASE_SSL}`);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
