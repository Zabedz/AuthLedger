import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export type TokenPurpose = 'verify_email' | 'reset_password';

export const VERIFY_EMAIL_TTL_HOURS = 24;
export const RESET_PASSWORD_TTL_HOURS = 1;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// Issuing a fresh token invalidates any earlier unconsumed token of the same
// purpose, so a resent link supersedes the previous one.
export async function issueToken(
  db: Kysely<DB>,
  userId: string,
  purpose: TokenPurpose,
  ttlHours: number,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('auth_tokens')
      .set({ consumed_at: new Date() })
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .execute();

    await trx
      .insertInto('auth_tokens')
      .values({
        user_id: userId,
        purpose,
        token_hash: hashToken(token),
        expires_at: expiresAt,
      })
      .execute();
  });

  return token;
}

// Consumes a token atomically: the UPDATE ... WHERE consumed_at IS NULL means
// a replayed token matches zero rows, so reuse cannot succeed even under a
// race.
export async function consumeToken(
  db: Kysely<DB>,
  token: string,
  purpose: TokenPurpose,
): Promise<{ userId: string } | null> {
  const consumed = await db
    .updateTable('auth_tokens')
    .set({ consumed_at: new Date() })
    .where('token_hash', '=', hashToken(token))
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date())
    .returning('user_id')
    .executeTakeFirst();

  return consumed ? { userId: consumed.user_id } : null;
}
