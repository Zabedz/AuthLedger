import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { Config } from '../src/config.js';
import { createDb, createPool } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import type { HealthDeps } from '../src/routes/health.js';
import { buildServer, type ServerDeps } from '../src/server.js';
import { testDatabaseUrl } from './test-db.js';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  logLevel: 'fatal',
  databaseUrl: testDatabaseUrl(),
  appOrigin: 'http://localhost:5173',
  stripeSecretKey: undefined,
};

export const healthyDeps: HealthDeps = {
  checkDatabase: async () => {},
  pendingMigrations: async () => [],
};

export interface TestContext {
  app: FastifyInstance;
  db: Kysely<DB>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export async function makeTestServer(
  overrides: Partial<Omit<ServerDeps, 'db'>> & { config?: Partial<Config> } = {},
  loggerStream?: NodeJS.WritableStream,
): Promise<TestContext> {
  const pool = createPool(testDatabaseUrl());
  const db = createDb(pool);
  const config = { ...testConfig, ...overrides.config };
  const app = await buildServer(
    config,
    { db, health: overrides.health ?? healthyDeps },
    { loggerStream },
  );

  return {
    app,
    db,
    pool,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function truncateAll(db: Kysely<DB>): Promise<void> {
  await db.deleteFrom('audit_events').execute();
  await db.deleteFrom('sessions').execute();
  await db.deleteFrom('users').execute();
}

// State-changing requests must pass the origin check; this wraps inject with
// the app's own origin so tests opt OUT of it explicitly instead of in.
export function withOrigin(opts: InjectOptions): InjectOptions {
  return { ...opts, headers: { origin: testConfig.appOrigin, ...opts.headers } };
}

export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const line = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof line !== 'string') {
    throw new Error(`expected a set-cookie header, got ${String(setCookie)}`);
  }
  return line.split(';')[0]!;
}
