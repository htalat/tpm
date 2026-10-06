import { loadEnv } from './env';
import { createPool } from './pool';
import { migrate } from './migrate';

loadEnv();
const url = process.argv.includes('--test') ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}
const pool = createPool({ connectionString: url, applicationName: 'durable-migrate' });
try {
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
} finally {
  await pool.end();
}
