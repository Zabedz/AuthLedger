import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface PurgeCounts {
  sessions: number;
  tokens: number;
}

// Housekeeping: drop sessions past their absolute expiry and auth tokens that
// are consumed or expired. Idle-but-unexpired sessions stay (they are dead to
// findLiveSession but a user may still list and revoke them until absolute
// expiry).
export async function purgeExpired(db: Kysely<DB>, now: Date = new Date()): Promise<PurgeCounts> {
  const sessions = await db.deleteFrom('sessions').where('expires_at', '<', now).executeTakeFirst();

  const tokens = await db
    .deleteFrom('auth_tokens')
    .where((eb) => eb.or([eb('expires_at', '<', now), eb('consumed_at', 'is not', null)]))
    .executeTakeFirst();

  return {
    sessions: Number(sessions.numDeletedRows),
    tokens: Number(tokens.numDeletedRows),
  };
}
