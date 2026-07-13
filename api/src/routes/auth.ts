import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  acceptedReplySchema,
  credentialsSchema,
  errorReplySchema,
  loginReplySchema,
  mfaCodeSchema,
  sessionListSchema,
  userEnvelopeSchema,
} from '@authledger/shared';
import { authenticate, registerUser } from '../domain/accounts.js';
import { recordAudit } from '../domain/audit.js';
import { issueToken, VERIFY_EMAIL_TTL_HOURS } from '../domain/tokens.js';
import { consumeMfaChallenge, consumeRecoveryCode, verifyTotpForUser } from '../domain/mfa.js';
import { listLiveSessions, revokeSession } from '../domain/sessions.js';
import {
  clearMfaChallengeCookie,
  clearSessionCookie,
  MFA_CHALLENGE_COOKIE,
  requireAuth,
} from '../plugins/session-auth.js';
import {
  beginMfaChallenge,
  completeLogin,
  requestContextOf,
  userReply,
  type RouteDeps,
} from './deps.js';

export const authRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (
  app,
  { config, db, enqueue },
) => {
  app.post(
    '/register',
    {
      config: { policy: 'public', rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: credentialsSchema,
        response: { 202: acceptedReplySchema },
      },
    },
    async (req, reply) => {
      const ctx = requestContextOf(req);
      const result = await registerUser(db, req.body.email, req.body.password);

      // Uniform response whether or not the address is new: only a real,
      // freshly created account triggers a verification email.
      if (result.status === 'created') {
        await recordAudit(db, { event: 'user_registered', userId: result.user.id, ...ctx });
        const token = await issueToken(db, result.user.id, 'verify_email', VERIFY_EMAIL_TTL_HOURS);
        await enqueue.enqueue({
          kind: 'verify_email',
          recipient: result.user.email,
          userId: result.user.id,
          ctx: { appOrigin: config.appOrigin, token },
        });
      }

      return reply.code(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/login',
    {
      config: { policy: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: credentialsSchema,
        response: { 200: loginReplySchema, 401: errorReplySchema },
      },
    },
    async (req, reply) => {
      const ctx = requestContextOf(req);
      const result = await authenticate(db, req.body.email, req.body.password);

      if (result.status !== 'ok') {
        const event =
          result.status === 'locked_now'
            ? 'account_locked'
            : result.status === 'locked'
              ? 'login_rejected_locked'
              : 'login_failed';
        await recordAudit(db, {
          event,
          userId: result.userId,
          ...ctx,
          detail: { email: req.body.email },
        });
        if (result.status === 'locked_now') {
          await enqueue.enqueue({
            kind: 'account_locked',
            recipient: req.body.email,
            userId: result.userId,
            ctx: { appOrigin: config.appOrigin },
          });
        }
        // One generic answer for wrong password, unknown email, and locked
        // account: anything richer is an oracle.
        return reply.code(401).send({ error: 'invalid credentials' });
      }

      // Password verified. If MFA is on, stop here and set a challenge cookie
      // instead of a session (ADR-010: the password-ok state is never a
      // session row).
      if (result.user.totp_enabled_at !== null) {
        await beginMfaChallenge({ config, db, enqueue }, reply, result.user.id, ctx);
        return reply.code(200).send({ mfa_required: true as const });
      }

      const body = await completeLogin(
        { config, db, enqueue },
        reply,
        result.user,
        ctx,
        req.auth?.session ?? null,
      );
      return reply.code(200).send(body);
    },
  );

  app.post(
    '/login/mfa',
    {
      config: { policy: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: mfaCodeSchema,
        response: { 200: userEnvelopeSchema, 401: errorReplySchema },
      },
    },
    async (req, reply) => {
      const ctx = requestContextOf(req);
      const challengeToken = req.cookies[MFA_CHALLENGE_COOKIE];
      const challenge = challengeToken ? await consumeMfaChallenge(db, challengeToken) : null;
      if (!challenge) {
        return reply.code(401).send({ error: 'invalid or expired challenge' });
      }
      clearMfaChallengeCookie(reply, config);

      // A 6-digit code is a TOTP; anything else is treated as a recovery code.
      const code = req.body.code;
      const isTotp = /^[0-9]{6}$/.test(code);
      const ok = isTotp
        ? await verifyTotpForUser(db, challenge.userId, code, config.encryptionKey)
        : await consumeRecoveryCode(db, challenge.userId, code);

      if (!ok) {
        await recordAudit(db, { event: 'mfa_failed', userId: challenge.userId, ...ctx });
        return reply.code(401).send({ error: 'invalid code' });
      }

      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', challenge.userId)
        .executeTakeFirstOrThrow();

      await recordAudit(db, {
        event: isTotp ? 'mfa_succeeded' : 'recovery_code_used',
        userId: user.id,
        ...ctx,
      });

      const body = await completeLogin(
        { config, db, enqueue },
        reply,
        user,
        ctx,
        req.auth?.session ?? null,
      );
      return reply.code(200).send(body);
    },
  );

  app.post(
    '/logout',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: { response: { 204: Type.Null() } },
    },
    async (req, reply) => {
      const { user, session } = req.auth!;
      await revokeSession(db, session.id, user.id);
      await recordAudit(db, {
        event: 'logout',
        userId: user.id,
        sessionId: session.id,
        ...requestContextOf(req),
      });
      clearSessionCookie(reply, config);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: { response: { 200: userEnvelopeSchema, 401: errorReplySchema } },
    },
    async (req, reply) => {
      return reply.code(200).send(userReply(req.auth!.user));
    },
  );

  app.get(
    '/sessions',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: { response: { 200: sessionListSchema } },
    },
    async (req) => {
      const { user, session: current } = req.auth!;
      const sessions = await listLiveSessions(db, user.id);
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          created_at: s.created_at.toISOString(),
          last_seen_at: s.last_seen_at.toISOString(),
          ip: s.ip,
          user_agent: s.user_agent,
          current: s.id === current.id,
        })),
      };
    },
  );

  app.delete(
    '/sessions/:id',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 404: errorReplySchema },
      },
    },
    async (req, reply) => {
      const { user, session: current } = req.auth!;
      const revoked = await revokeSession(db, req.params.id, user.id);

      if (!revoked) {
        return reply.code(404).send({ error: 'no such session' });
      }

      await recordAudit(db, {
        event: 'session_revoked',
        userId: user.id,
        sessionId: req.params.id,
        ...requestContextOf(req),
      });

      if (req.params.id === current.id) {
        clearSessionCookie(reply, config);
      }
      return reply.code(204).send(null);
    },
  );
};
