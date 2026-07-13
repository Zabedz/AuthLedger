import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { adminDatabaseUrl, testDatabaseName, testDatabaseUrl } from './test-db.js';

const DUPLICATE_DATABASE = '42P04';
const SAFE_DB_NAME = /^[a-z_][a-z0-9_]*$/;

export default async function setup(): Promise<void> {
  const dbName = testDatabaseName();
  if (!SAFE_DB_NAME.test(dbName)) {
    throw new Error(`unsafe test database name derived from TEST_DATABASE_URL: "${dbName}"`);
  }

  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) {
      throw err;
    }
  } finally {
    await admin.end();
  }

  execFileSync('npx', ['node-pg-migrate', 'up'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}
