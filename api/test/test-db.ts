const BASE = 'postgres://authledger:authledger@localhost:5432';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? `${BASE}/authledger_test`;
}

export function testDatabaseName(): string {
  return new URL(testDatabaseUrl()).pathname.replace(/^\//, '');
}

// The compose/CI postgres user owns the instance, so it can create the test
// database from any existing one.
export function adminDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = '/postgres';
  return url.toString();
}
