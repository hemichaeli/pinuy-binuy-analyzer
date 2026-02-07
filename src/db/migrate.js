require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  console.log('Running database migration...');
  
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    await pool.query(schema);
    
    console.log('Migration completed successfully!');
    console.log('Tables created: complexes, buildings, transactions, listings, benchmarks, scan_logs, alerts');
  } catch (error) {
    console.error('Migration failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch(() => process.exit(1));
}

module.exports = migrate;
