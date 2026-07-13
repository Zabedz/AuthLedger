import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { Config } from '../src/config.js';
import { createDb, createPool } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import { deliverEmail, toDeliveryJob, type EmailEnqueuer } from '../src/domain/dispatch.js';
import type { EmailMessage, Mailer } from '../src/domain/mailer.js';
import type { HealthDeps } from '../src/routes/health.js';
import { buildServer, type ServerDeps } from '../src/server.js';
import { testDatabaseUrl } from './test-db.js';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  logLevel: 'fatal',
  databaseUrl: testDatabaseUrl(),
  appOrigin: 'http://localhost:5173',
  smtp: {
    host: 'localhost',
    port: 1025,
    user: undefined,
    pass: undefined,
    from: 'test@authledger.test',
  },
  encryptionKey: Buffer.alloc(32, 9),
  sesSnsTopicArn: undefined,
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
  // Emails "sent" during the request, captured in order. Enqueue runs the real
  // dispatch (cap and dedupe included) inline against a capturing transport.
  sent: EmailMessage[];
  close: () => Promise<void>;
}

export async function makeTestServer(
  overrides: Partial<Omit<ServerDeps, 'db' | 'enqueue'>> & { config?: Partial<Config> } = {},
  loggerStream?: NodeJS.WritableStream,
): Promise<TestContext> {
  const pool = createPool(testDatabaseUrl());
  const db = createDb(pool);
  const config = { ...testConfig, ...overrides.config };

  const sent: EmailMessage[] = [];
  const captureMailer: Mailer = {
    send: async (message) => {
      sent.push(message);
    },
  };
  const enqueue: EmailEnqueuer = {
    enqueue: async (request) => {
      await deliverEmail(db, captureMailer, toDeliveryJob(request));
    },
  };

  const app = await buildServer(
    config,
    { db, enqueue, health: overrides.health ?? healthyDeps },
    { loggerStream },
  );

  return {
    app,
    db,
    pool,
    sent,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function truncateAll(db: Kysely<DB>): Promise<void> {
  await db.deleteFrom('audit_events').execute();
  await db.deleteFrom('email_dispatches').execute();
  await db.deleteFrom('auth_tokens').execute();
  await db.deleteFrom('mfa_challenges').execute();
  await db.deleteFrom('mfa_recovery_codes').execute();
  await db.deleteFrom('processed_sns_messages').execute();
  await db.deleteFrom('email_suppressions').execute();
  await db.deleteFrom('sessions').execute();
  await db.deleteFrom('users').execute();
}

// Verification and reset emails carry the token in a URL; pull it out.
export function tokenFromEmail(message: EmailMessage): string {
  const match = message.text.match(/[?&]token=([^\s&]+)/);
  if (!match) {
    throw new Error(`no token in email: ${message.text}`);
  }
  return decodeURIComponent(match[1]!);
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
