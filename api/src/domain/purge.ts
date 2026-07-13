import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface PurgeCounts {
  sessions: number;
  tokens: number;
  snsMessages: number;
}

// Message ids older than SNS's own redelivery window cannot replay, so their
// dedup rows are safe to drop.
const SNS_REPLAY_RETENTION_DAYS = 7;

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

  const snsCutoff = new Date(now.getTime() - SNS_REPLAY_RETENTION_DAYS * 24 * 3600 * 1000);
  const snsMessages = await db
    .deleteFrom('processed_sns_messages')
    .where('received_at', '<', snsCutoff)
    .executeTakeFirst();

  return {
    sessions: Number(sessions.numDeletedRows),
    tokens: Number(tokens.numDeletedRows),
    snsMessages: Number(snsMessages.numDeletedRows),
  };
}
