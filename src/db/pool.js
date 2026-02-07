const { Pool } = require('pg');

let poolConfig;

if (process.env.DATABASE_URL) {
  console.log('[pool] Using DATABASE_URL');
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
} else {
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || 5432;
  const database = process.env.PGDATABASE || 'pinuy_binuy';
  const user = process.env.PGUSER || 'pinuy_admin';
  console.log(`[pool] Using individual params - host: ${host}, port: ${port}, db: ${database}`);
  poolConfig = {
    host,
    port: parseInt(port),
    database,
    user,
    password: process.env.PGPASSWORD || 'pinuy_secure_2024',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
