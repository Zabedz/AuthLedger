import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Kysely } from 'kysely';
import {
  credentialsSchema,
  errorReplySchema,
  sessionListSchema,
  userEnvelopeSchema,
} from '@authledger/shared';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import { authenticate, registerUser } from '../domain/accounts.js';
import { recordAudit } from '../domain/audit.js';
import { createSession, listLiveSessions, revokeSession, type User } from '../domain/sessions.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../plugins/session-auth.js';

function userReply(user: User) {
  return {
    user: {
      id: user.id,
      email: user.email,
      created_at: user.created_at.toISOString(),
    },
  };
}

function requestContextOf(req: { ip: string; headers: Record<string, unknown> }) {
  return {
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

export const authRoutes: FastifyPluginAsyncTypebox<{ config: Config; db: Kysely<DB> }> = async (
  app,
  { config, db },
) => {
  app.post(
    '/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: credentialsSchema,
        response: { 201: userEnvelopeSchema, 409: errorReplySchema },
      },
    },
    async (req, reply) => {
      const ctx = requestContextOf(req);
      const result = await registerUser(db, req.body.email, req.body.password);

      if (result.status === 'exists') {
        // A 409 leaks address existence; acceptable until M3, where
        // verification email flows make the response uniform (see PLAN M3).
        return reply.code(409).send({ error: 'email already registered' });
      }

      await recordAudit(db, { event: 'user_registered', userId: result.user.id, ...ctx });
      return reply.code(201).send(userReply(result.user));
    },
  );

  app.post(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: credentialsSchema,
        response: { 200: userEnvelopeSchema, 401: errorReplySchema },
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
        // One generic answer for wrong password, unknown email, and locked
        // account: anything richer is an oracle.
        return reply.code(401).send({ error: 'invalid credentials' });
      }

      // Rotation: a session presented at login never survives it.
      if (req.auth) {
        await revokeSession(db, req.auth.session.id, req.auth.user.id);
      }

      const { token, session } = await createSession(db, result.user.id, ctx);
      await recordAudit(db, {
        event: 'login_succeeded',
        userId: result.user.id,
        sessionId: session.id,
        ...ctx,
      });

      setSessionCookie(reply, config, token);
      return reply.code(200).send(userReply(result.user));
    },
  );

  app.post(
    '/logout',
    { preHandler: requireAuth, schema: { response: { 204: Type.Null() } } },
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
      schema: { response: { 200: userEnvelopeSchema, 401: errorReplySchema } },
    },
    async (req, reply) => {
      return reply.code(200).send(userReply(req.auth!.user));
    },
  );

  app.get(
    '/sessions',
    { preHandler: requireAuth, schema: { response: { 200: sessionListSchema } } },
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
