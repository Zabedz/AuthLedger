import type { FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import { recordAudit } from '../domain/audit.js';
import { isNewDevice } from '../domain/devices.js';
import type { EmailEnqueuer } from '../domain/dispatch.js';
import { issueMfaChallenge } from '../domain/mfa.js';
import { createSession, revokeSession, type Session, type User } from '../domain/sessions.js';
import { setMfaChallengeCookie, setSessionCookie } from '../plugins/session-auth.js';

export interface RouteDeps {
  config: Config;
  db: Kysely<DB>;
  enqueue: EmailEnqueuer;
}

export function userReply(user: User) {
  return {
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at !== null,
      mfa_enabled: user.totp_enabled_at !== null,
      created_at: user.created_at.toISOString(),
    },
  };
}

export function requestContextOf(req: { ip: string; headers: Record<string, unknown> }) {
  return {
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

// The half-authenticated MFA step, shared by the password path and the OAuth
// callback: mint a single-use challenge, audit it, and stash it in the cookie.
// The caller decides how to answer (JSON signal or redirect to /mfa).
export async function beginMfaChallenge(
  deps: RouteDeps,
  reply: FastifyReply,
  userId: string,
  ctx: { ip: string; userAgent: string | null },
): Promise<void> {
  const challenge = await issueMfaChallenge(deps.db, userId);
  await recordAudit(deps.db, { event: 'mfa_challenge_issued', userId, ...ctx });
  setMfaChallengeCookie(reply, deps.config, challenge);
}

// The tail of a successful login, shared by the password path and the MFA
// path: rotate any presented session, mint a new one, audit, notify a new
// device, and set the cookie. Returns the reply body.
export async function completeLogin(
  deps: RouteDeps,
  reply: FastifyReply,
  user: User,
  ctx: { ip: string; userAgent: string | null },
  presented: Session | null,
) {
  const { db, config, enqueue } = deps;
  const newDevice = await isNewDevice(db, user.id, ctx.userAgent);

  if (presented) {
    await revokeSession(db, presented.id, user.id);
  }

  const { token, session } = await createSession(db, user.id, ctx);
  await recordAudit(db, {
    event: 'login_succeeded',
    userId: user.id,
    sessionId: session.id,
    ...ctx,
  });

  if (newDevice) {
    await enqueue.enqueue({
      kind: 'new_device_login',
      recipient: user.email,
      userId: user.id,
      ctx: { appOrigin: config.appOrigin },
    });
  }

  setSessionCookie(reply, config, token);
  return userReply(user);
}
