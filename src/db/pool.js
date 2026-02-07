const { Pool } = require('pg');

// DATABASE_URL is set by start.sh to local Postgres (localhost)
// Falls back to individual PG* env vars or defaults
const dbUrl = process.env.DATABASE_URL;

let poolConfig;

if (dbUrl) {
  console.log(`[pool] Using DATABASE_URL: ${dbUrl.substring(0, 30)}...`);
  poolConfig = {
    connectionString: dbUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
} else {
  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5432');
  const database = process.env.PGDATABASE || 'pinuy_binuy';
  const user = process.env.PGUSER || 'pinuy_admin';
  const password = process.env.PGPASSWORD || 'pinuy_secure_2024';
  console.log(`[pool] Using individual params: ${user}@${host}:${port}/${database}`);
  poolConfig = { host, port, database, user, password, ssl: false };
}

const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

module.exports = pool;
