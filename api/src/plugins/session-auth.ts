import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import cookie from '@fastify/cookie';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import {
  findLiveSession,
  SESSION_ABSOLUTE_DAYS,
  type Session,
  type User,
} from '../domain/sessions.js';
import { MFA_CHALLENGE_TTL_MINUTES } from '../domain/mfa.js';
import { loadPermissions, type PermissionAction } from '../domain/authz.js';

export const SESSION_COOKIE = 'al_session';
export const MFA_CHALLENGE_COOKIE = 'al_mfa';
// Scoped to the one endpoint that reads it, so the challenge cookie is not sent
// on any other request.
const MFA_COOKIE_PATH = '/api/auth/login/mfa';

declare module 'fastify' {
  interface FastifyRequest {
    auth: { user: User; session: Session; permissions: Set<PermissionAction> } | null;
  }
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: SESSION_ABSOLUTE_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
  });
}

// The MFA challenge token rides in an HttpOnly cookie between the password (or
// OAuth) step and the second-factor step, so it never reaches JavaScript.
export function setMfaChallengeCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: MFA_COOKIE_PATH,
    maxAge: MFA_CHALLENGE_TTL_MINUTES * 60,
  });
}

export function clearMfaChallengeCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(MFA_CHALLENGE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: MFA_COOKIE_PATH,
  });
}

// Resolves the session cookie into request.auth on every request; routes
// opt into enforcement with requireAuth.
export async function registerSessionAuth(
  app: FastifyInstance,
  config: Config,
  db: Kysely<DB>,
): Promise<void> {
  await app.register(cookie);

  app.decorateRequest('auth', null);

  app.addHook('preHandler', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) {
      return;
    }
    const resolved = await findLiveSession(db, token);
    if (!resolved) {
      return;
    }
    // Permissions resolve per request from the user's roles, so a grant or
    // revoke lands on the next request without touching the session.
    const permissions = await loadPermissions(db, resolved.user.id);
    req.auth = { ...resolved, permissions };
  });
}

export const requireAuth: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!req.auth) {
    return reply.code(401).send({ error: 'authentication required' });
  }
};

// Gate a route on a single permission. Unauthenticated is 401; authenticated
// without the permission is 403. The route also declares this action in its
// policy config (see authz-guard), which is what the deny-by-default boot check
// verifies; this hook is the request-time enforcement of the same action.
export function requirePermission(action: PermissionAction): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    if (!req.auth.permissions.has(action)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
