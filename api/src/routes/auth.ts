import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  acceptedReplySchema,
  credentialsSchema,
  errorReplySchema,
  sessionListSchema,
  userEnvelopeSchema,
} from '@authledger/shared';
import { authenticate, registerUser } from '../domain/accounts.js';
import { recordAudit } from '../domain/audit.js';
import { issueToken, VERIFY_EMAIL_TTL_HOURS } from '../domain/tokens.js';
import { isNewDevice } from '../domain/devices.js';
import { createSession, listLiveSessions, revokeSession } from '../domain/sessions.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../plugins/session-auth.js';
import { requestContextOf, userReply, type RouteDeps } from './deps.js';

export const authRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (
  app,
  { config, db, enqueue },
) => {
  app.post(
    '/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
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

      const newDevice = await isNewDevice(db, result.user.id, ctx.userAgent);

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

      if (newDevice) {
        await enqueue.enqueue({
          kind: 'new_device_login',
          recipient: result.user.email,
          userId: result.user.id,
          ctx: { appOrigin: config.appOrigin },
        });
      }

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
