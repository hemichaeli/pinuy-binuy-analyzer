const { Pool } = require('pg');

let poolConfig;

const dbUrl = process.env.DATABASE_URL;

if (dbUrl && dbUrl.length > 10) {
  console.log(`[pool] Using DATABASE_URL (${dbUrl.substring(0, 20)}...)`);
  poolConfig = {
    connectionString: dbUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
} else {
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || 5432;
  const database = process.env.PGDATABASE || 'pinuy_binuy';
  const user = process.env.PGUSER || 'pinuy_admin';
  const password = process.env.PGPASSWORD || 'pinuy_secure_2024';
  console.log(`[pool] Using individual params - host: ${host}, port: ${port}, db: ${database}, user: ${user}`);
  poolConfig = {
    host,
    port: parseInt(port),
    database,
    user,
    password,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

console.log('[pool] SSL:', process.env.DATABASE_SSL === 'true' ? 'enabled' : 'disabled');

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
