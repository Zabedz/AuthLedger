import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createDb } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import { DAILY_EMAIL_CAP, deliverEmail, type DeliveryJob } from '../src/domain/dispatch.js';
import type { EmailMessage, Mailer } from '../src/domain/mailer.js';
import { testDatabaseUrl } from './test-db.js';
import { truncateAll } from './helpers.js';
import type { Kysely } from 'kysely';

const pool = createPool(testDatabaseUrl());
const db: Kysely<DB> = createDb(pool);

function countingMailer(): { mailer: Mailer; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { mailer: { send: async (m) => void sent.push(m) }, sent };
}

async function makeUser(email: string): Promise<string> {
  const user = await db
    .insertInto('users')
    .values({ email, password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

function job(userId: string | null, key: string): DeliveryJob {
  return {
    dedupeKey: key,
    kind: 'verify_email',
    recipient: 'to@example.com',
    userId,
    message: { to: 'to@example.com', subject: 'x', text: 'y' },
  };
}

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.destroy();
});

describe('deliverEmail idempotency', () => {
  it('sends once and treats a retry of the same job as a duplicate', async () => {
    const userId = await makeUser('a@example.com');
    const { mailer, sent } = countingMailer();

    expect(await deliverEmail(db, mailer, job(userId, 'key-1'))).toBe('sent');
    expect(await deliverEmail(db, mailer, job(userId, 'key-1'))).toBe('skipped_duplicate');
    expect(sent).toHaveLength(1);
  });

  it('re-sends when a prior attempt claimed the row but never marked it sent', async () => {
    const userId = await makeUser('b@example.com');
    const { mailer, sent } = countingMailer();

    // Simulate a crash after claim, before send: an unsent claim row exists.
    await db
      .insertInto('email_dispatches')
      .values({
        user_id: userId,
        recipient: 'to@example.com',
        kind: 'verify_email',
        dedupe_key: 'key-2',
      })
      .execute();

    expect(await deliverEmail(db, mailer, job(userId, 'key-2'))).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('daily email cap', () => {
  it('sends up to the cap and drops beyond it without consuming quota', async () => {
    const userId = await makeUser('c@example.com');
    const { mailer, sent } = countingMailer();

    for (let i = 0; i < DAILY_EMAIL_CAP; i++) {
      expect(await deliverEmail(db, mailer, job(userId, `k-${i}`))).toBe('sent');
    }
    expect(await deliverEmail(db, mailer, job(userId, 'over'))).toBe('skipped_capped');
    expect(sent).toHaveLength(DAILY_EMAIL_CAP);

    // The dropped attempt left no row, so it did not consume the quota.
    const { count } = await db
      .selectFrom('email_dispatches')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(count)).toBe(DAILY_EMAIL_CAP);
  });
});
