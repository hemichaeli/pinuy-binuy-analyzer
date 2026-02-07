const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://pinuy_admin:pinuy_secure_2024@pinuy-binuy-postgres.railway.internal:5432/pinuy_binuy';

console.log(`[pool] DATABASE_URL defined: ${!!process.env.DATABASE_URL}`);
console.log(`[pool] Using URL host: ${new URL(DATABASE_URL).hostname}`);
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
