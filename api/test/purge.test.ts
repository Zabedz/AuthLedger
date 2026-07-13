import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createPool, createDb } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import { purgeExpired } from '../src/domain/purge.js';
import { truncateAll } from './helpers.js';
import { testDatabaseUrl } from './test-db.js';

const pool = createPool(testDatabaseUrl());
const db: Kysely<DB> = createDb(pool);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600 * 1000);

async function makeUser(): Promise<string> {
  const user = await db
    .insertInto('users')
    .values({ email: `purge-${process.hrtime.bigint()}@example.com`, password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return user.id;
}

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.destroy();
});

describe('purgeExpired', () => {
  it('deletes expired sessions and keeps live ones', async () => {
    const userId = await makeUser();
    await db
      .insertInto('sessions')
      .values([
        { user_id: userId, token_hash: Buffer.from('dead'), expires_at: hoursAgo(1) },
        { user_id: userId, token_hash: Buffer.from('live'), expires_at: hoursAhead(1) },
      ])
      .execute();

    const counts = await purgeExpired(db);
    expect(counts.sessions).toBe(1);

    const remaining = await db.selectFrom('sessions').select('token_hash').execute();
    expect(remaining).toHaveLength(1);
  });

  it('deletes consumed and expired MFA challenges, keeps pending ones', async () => {
    const userId = await makeUser();
    await db
      .insertInto('mfa_challenges')
      .values([
        {
          user_id: userId,
          token_hash: Buffer.from('consumed'),
          expires_at: hoursAhead(1),
          consumed_at: new Date(),
        },
        { user_id: userId, token_hash: Buffer.from('expired'), expires_at: hoursAgo(1) },
        { user_id: userId, token_hash: Buffer.from('pending'), expires_at: hoursAhead(1) },
      ])
      .execute();

    const counts = await purgeExpired(db);
    expect(counts.mfaChallenges).toBe(2);
    expect(await db.selectFrom('mfa_challenges').select('token_hash').execute()).toHaveLength(1);
  });

  it('deletes consumed and expired tokens, keeps pending ones', async () => {
    const userId = await makeUser();
    await db
      .insertInto('auth_tokens')
      .values([
        {
          user_id: userId,
          purpose: 'verify_email',
          token_hash: Buffer.from('consumed'),
          expires_at: hoursAhead(1),
          consumed_at: new Date(),
        },
        {
          user_id: userId,
          purpose: 'verify_email',
          token_hash: Buffer.from('expired'),
          expires_at: hoursAgo(1),
        },
        {
          user_id: userId,
          purpose: 'reset_password',
          token_hash: Buffer.from('pending'),
          expires_at: hoursAhead(1),
        },
      ])
      .execute();

    const counts = await purgeExpired(db);
    expect(counts.tokens).toBe(2);

    const remaining = await db.selectFrom('auth_tokens').select('token_hash').execute();
    expect(remaining).toHaveLength(1);
  });
});
