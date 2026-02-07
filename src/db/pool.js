const { Pool } = require('pg');

// Build connection config from individual vars (most reliable on Railway)
const host = process.env.PGHOST || 'localhost';
const port = parseInt(process.env.PGPORT || '5432');
const database = process.env.PGDATABASE || 'pinuy_binuy';
const user = process.env.PGUSER || 'pinuy_admin';
const password = process.env.PGPASSWORD || 'pinuy_secure_2024';
const useSSL = process.env.DATABASE_SSL === 'true';

console.log(`[pool] Connecting to ${host}:${port}/${database} as ${user}`);
console.log(`[pool] SSL: ${useSSL ? 'enabled' : 'disabled'}`);
console.log(`[pool] DATABASE_URL present: ${!!process.env.DATABASE_URL}`);

const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
