import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  acceptedReplySchema,
  emailRequestSchema,
  errorReplySchema,
  resetPasswordSchema,
  tokenSchema,
} from '@authledger/shared';
import { recordAudit } from '../domain/audit.js';
import { hashPassword } from '../domain/passwords.js';
import { revokeAllSessions } from '../domain/sessions.js';
import {
  consumeToken,
  issueToken,
  RESET_PASSWORD_TTL_HOURS,
  VERIFY_EMAIL_TTL_HOURS,
} from '../domain/tokens.js';
import { clearSessionCookie, requireAuth } from '../plugins/session-auth.js';
import { requestContextOf, type RouteDeps } from './deps.js';

const accepted = { status: 'accepted' as const };

export const accountRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (
  app,
  { config, db, enqueue },
) => {
  app.post(
    '/verify-email',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: tokenSchema, response: { 200: acceptedReplySchema, 400: errorReplySchema } },
    },
    async (req, reply) => {
      const consumed = await consumeToken(db, req.body.token, 'verify_email');
      if (!consumed) {
        return reply.code(400).send({ error: 'invalid or expired token' });
      }
      await db
        .updateTable('users')
        .set({ email_verified_at: new Date(), updated_at: new Date() })
        .where('id', '=', consumed.userId)
        .where('email_verified_at', 'is', null)
        .execute();
      await recordAudit(db, {
        event: 'email_verified',
        userId: consumed.userId,
        ...requestContextOf(req),
      });
      return reply.code(200).send(accepted);
    },
  );

  app.post(
    '/verify-email/resend',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: emailRequestSchema, response: { 202: acceptedReplySchema } },
    },
    async (req, reply) => {
      const user = await db
        .selectFrom('users')
        .select(['id', 'email', 'email_verified_at'])
        .where('email', '=', req.body.email)
        .executeTakeFirst();

      if (user && user.email_verified_at === null) {
        const token = await issueToken(db, user.id, 'verify_email', VERIFY_EMAIL_TTL_HOURS);
        await enqueue.enqueue({
          kind: 'verify_email',
          recipient: user.email,
          userId: user.id,
          ctx: { appOrigin: config.appOrigin, token },
        });
      }
      return reply.code(202).send(accepted);
    },
  );

  app.post(
    '/password-reset/request',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: emailRequestSchema, response: { 202: acceptedReplySchema } },
    },
    async (req, reply) => {
      const user = await db
        .selectFrom('users')
        .select(['id', 'email'])
        .where('email', '=', req.body.email)
        .executeTakeFirst();

      if (user) {
        const token = await issueToken(db, user.id, 'reset_password', RESET_PASSWORD_TTL_HOURS);
        await enqueue.enqueue({
          kind: 'reset_password',
          recipient: user.email,
          userId: user.id,
          ctx: { appOrigin: config.appOrigin, token },
        });
      }
      return reply.code(202).send(accepted);
    },
  );

  app.post(
    '/password-reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: resetPasswordSchema,
        response: { 200: acceptedReplySchema, 400: errorReplySchema },
      },
    },
    async (req, reply) => {
      const ctx = requestContextOf(req);
      const passwordHash = await hashPassword(req.body.password);

      // Consume the token, change the password, and drop every session in one
      // transaction: if any step fails the token is not spent.
      const outcome = await db.transaction().execute(async (trx) => {
        const consumed = await consumeToken(trx, req.body.token, 'reset_password');
        if (!consumed) {
          return null;
        }
        await trx
          .updateTable('users')
          .set({
            password_hash: passwordHash,
            // A completed reset proves control of the inbox, so verify too.
            email_verified_at: new Date(),
            failed_login_count: 0,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', consumed.userId)
          .execute();
        // A reset is the response to a possible compromise: kill all sessions.
        await revokeAllSessions(trx, consumed.userId);
        const user = await trx
          .selectFrom('users')
          .select('email')
          .where('id', '=', consumed.userId)
          .executeTakeFirstOrThrow();
        return { userId: consumed.userId, email: user.email };
      });

      if (!outcome) {
        return reply.code(400).send({ error: 'invalid or expired token' });
      }

      await recordAudit(db, { event: 'password_reset', userId: outcome.userId, ...ctx });
      await enqueue.enqueue({
        kind: 'password_changed',
        recipient: outcome.email,
        userId: outcome.userId,
        ctx: { appOrigin: config.appOrigin },
      });
      return reply.code(200).send(accepted);
    },
  );

  app.delete(
    '/account',
    { preHandler: requireAuth, schema: { response: { 204: Type.Null() } } },
    async (req, reply) => {
      const { user } = req.auth!;
      // Audit and delete in one transaction so a crash cannot leave a
      // "deleted" audit row for a still-live account. audit_events has no FK
      // to users, so the record survives the cascade.
      await db.transaction().execute(async (trx) => {
        await recordAudit(trx, {
          event: 'account_deleted',
          userId: user.id,
          ...requestContextOf(req),
        });
        // Cascade removes sessions and tokens; email_dispatches.user_id is nulled.
        await trx.deleteFrom('users').where('id', '=', user.id).execute();
      });
      // Notify only once the deletion is durable.
      await enqueue.enqueue({
        kind: 'account_deleted',
        recipient: user.email,
        userId: null,
        ctx: { appOrigin: config.appOrigin },
      });
      clearSessionCookie(reply, config);
      return reply.code(204).send(null);
    },
  );
};
