import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

// A login is from a "new device" when the user has signed in before but never
// from this user agent. The first-ever login is excluded (there is nothing
// unfamiliar about it). Coarse by design (user agents are neither unique nor
// stable), enough to notify on an unfamiliar sign-in without fingerprinting.
export async function isNewDevice(
  db: Kysely<DB>,
  userId: string,
  userAgent: string | null,
): Promise<boolean> {
  if (!userAgent) {
    return false;
  }
  const priorSessions = await db
    .selectFrom('sessions')
    .select('user_agent')
    .where('user_id', '=', userId)
    .execute();

  if (priorSessions.length === 0) {
    return false;
  }
  return !priorSessions.some((s) => s.user_agent === userAgent);
}
