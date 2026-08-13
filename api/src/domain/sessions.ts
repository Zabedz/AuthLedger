import { createHash, randomBytes } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import type { DB, Sessions, Users } from '../db/types.js';

export const SESSION_ABSOLUTE_DAYS = 30;
export const SESSION_IDLE_DAYS = 14;
// last_seen_at writes are throttled to one per session per interval so busy
// sessions do not turn every request into an update.
const TOUCH_INTERVAL_MINUTES = 5;

export type Session = Selectable<Sessions>;
export type User = Selectable<Users>;

export interface SessionContext {
  ip: string | null;
  userAgent: string | null;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function idleCutoff(): Date {
  return new Date(Date.now() - SESSION_IDLE_DAYS * 24 * 3600 * 1000);
}

export async function createSession(
  db: Kysely<DB>,
  userId: string,
  ctx: SessionContext,
): Promise<{ token: string; session: Session }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 24 * 3600 * 1000);

  const session = await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: hashToken(token),
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      expires_at: expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { token, session };
}

export async function findLiveSession(
  db: Kysely<DB>,
  token: string,
): Promise<{ session: Session; user: User } | null> {
  const session = await db
    .selectFrom('sessions')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .where('last_seen_at', '>', idleCutoff())
    .executeTakeFirst();

  if (!session) {
    return null;
  }

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .executeTakeFirst();

  if (!user) {
    return null;
  }

  const touchCutoff = new Date(Date.now() - TOUCH_INTERVAL_MINUTES * 60 * 1000);
  if (session.last_seen_at < touchCutoff) {
    await db
      .updateTable('sessions')
      .set({ last_seen_at: new Date() })
      .where('id', '=', session.id)
      .execute();
  }

  return { session, user };
}

export async function revokeSession(
  db: Kysely<DB>,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const revoked = await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return revoked.numUpdatedRows > 0n;
}

// Revokes every live session for a user, optionally sparing one (the session
// that initiated a password change keeps the user signed in on that device).
export async function revokeAllSessions(
  db: Kysely<DB>,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  let query = db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);

  if (exceptSessionId) {
    query = query.where('id', '!=', exceptSessionId);
  }

  const revoked = await query.executeTakeFirst();
  return Number(revoked.numUpdatedRows);
}

export async function listLiveSessions(db: Kysely<DB>, userId: string): Promise<Session[]> {
  return db
    .selectFrom('sessions')
    .selectAll()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .where('last_seen_at', '>', idleCutoff())
    .orderBy('created_at', 'desc')
    .execute();
}
