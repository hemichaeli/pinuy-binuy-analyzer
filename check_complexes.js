const pool = require('./src/db/pool');
async function main() {
  const r1 = await pool.query("SELECT COUNT(*) as total FROM complexes");
  const r2 = await pool.query("SELECT COUNT(*) as with_address FROM complexes WHERE address IS NOT NULL AND address != ''");
  const r3 = await pool.query("SELECT COUNT(*) as with_addresses FROM complexes WHERE addresses IS NOT NULL AND addresses != ''");
  const r4 = await pool.query("SELECT id, name, city, address, addresses FROM complexes WHERE address IS NOT NULL AND address != '' LIMIT 5");
  console.log('Total complexes:', r1.rows[0].total);
  console.log('With address:', r2.rows[0].with_address);
  console.log('With addresses:', r3.rows[0].with_addresses);
  console.log('\nSample complexes with address:');
  r4.rows.forEach(r => console.log(JSON.stringify(r)));
  await pool.end();
}
main().catch(console.error);
