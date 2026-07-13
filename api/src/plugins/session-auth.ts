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

export const SESSION_COOKIE = 'al_session';
export const MFA_CHALLENGE_COOKIE = 'al_mfa';
// Scoped to the one endpoint that reads it, so the challenge cookie is not sent
// on any other request.
const MFA_COOKIE_PATH = '/api/auth/login/mfa';

declare module 'fastify' {
  interface FastifyRequest {
    auth: { user: User; session: Session } | null;
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
    req.auth = await findLiveSession(db, token);
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
