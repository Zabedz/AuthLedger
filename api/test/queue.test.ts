import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createPool, createDb } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import type { EmailMessage, Mailer } from '../src/domain/mailer.js';
import { createJobRunner, type JobRunner } from '../src/jobs/queue.js';
import { testDatabaseUrl } from './test-db.js';
import { truncateAll } from './helpers.js';

const pool = createPool(testDatabaseUrl());
const db: Kysely<DB> = createDb(pool);

const silentLog = { info: () => {}, error: () => {} };

let runner: JobRunner;
const sent: EmailMessage[] = [];
const mailer: Mailer = { send: async (m) => void sent.push(m) };

beforeAll(async () => {
  await truncateAll(db);
  runner = createJobRunner(testDatabaseUrl(), db, mailer, silentLog);
  await runner.start();
});

afterAll(async () => {
  await runner.stop();
  await db.destroy();
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the job to process');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('pg-boss job runner', () => {
  it('processes an enqueued email through the real queue', async () => {
    const userId = (
      await db
        .insertInto('users')
        .values({ email: 'queue@example.com', password_hash: 'x' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    await runner.enqueue({
      kind: 'verify_email',
      recipient: 'queue@example.com',
      userId,
      ctx: { appOrigin: 'http://localhost:5173', token: 'queued-token' },
    });

    await waitFor(() => sent.some((m) => m.text.includes('queued-token')));
    expect(sent.some((m) => m.text.includes('queued-token'))).toBe(true);
  });
});
