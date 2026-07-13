import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { hashPassword, timingDummyHash, verifyPassword } from './passwords.js';
import type { User } from './sessions.js';

export const MAX_FAILED_LOGINS = 10;
export const LOCK_MINUTES = 15;

export type RegisterResult = { status: 'created'; user: User } | { status: 'exists' };

export type AuthenticateResult =
  | { status: 'ok'; user: User }
  // userId is present when the email matched, so failure audits can name the
  // actor; it stays undefined for an unknown email.
  | { status: 'invalid'; userId?: string }
  | { status: 'locked'; userId: string }
  | { status: 'locked_now'; userId: string };

export async function registerUser(
  db: Kysely<DB>,
  email: string,
  password: string,
): Promise<RegisterResult> {
  const passwordHash = await hashPassword(password);

  const user = await db
    .insertInto('users')
    .values({ email, password_hash: passwordHash })
    .onConflict((oc) => oc.column('email').doNothing())
    .returningAll()
    .executeTakeFirst();

  return user ? { status: 'created', user } : { status: 'exists' };
}

export async function authenticate(
  db: Kysely<DB>,
  email: string,
  password: string,
): Promise<AuthenticateResult> {
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();

  if (!user) {
    await verifyPassword(timingDummyHash, password);
    return { status: 'invalid' };
  }

  if (user.locked_until && user.locked_until > new Date()) {
    // Equalize timing with the verify paths so a locked account is not
    // detectable by a faster response.
    await verifyPassword(timingDummyHash, password);
    return { status: 'locked', userId: user.id };
  }

  // An OAuth-only account has no password; it cannot be entered this way.
  if (user.password_hash === null) {
    await verifyPassword(timingDummyHash, password);
    return { status: 'invalid', userId: user.id };
  }

  const valid = await verifyPassword(user.password_hash, password);

  if (valid) {
    await db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, updated_at: new Date() })
      .where('id', '=', user.id)
      .execute();
    return { status: 'ok', user };
  }

  // Increment atomically: a read-modify-write loses failures when an attacker
  // pipelines requests, letting them exceed MAX_FAILED_LOGINS guesses.
  const failure = await db
    .updateTable('users')
    .set((eb) => ({
      failed_login_count: eb('failed_login_count', '+', 1),
      updated_at: new Date(),
    }))
    .where('id', '=', user.id)
    .returning('failed_login_count')
    .executeTakeFirstOrThrow();

  if (failure.failed_login_count >= MAX_FAILED_LOGINS) {
    // Two racing lockers both writing the lock is idempotent.
    await db
      .updateTable('users')
      .set({
        failed_login_count: 0,
        locked_until: new Date(Date.now() + LOCK_MINUTES * 60 * 1000),
      })
      .where('id', '=', user.id)
      .execute();
    return { status: 'locked_now', userId: user.id };
  }

  return { status: 'invalid', userId: user.id };
}
