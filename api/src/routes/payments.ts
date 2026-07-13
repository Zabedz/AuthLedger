import { Type } from '@sinclair/typebox';
import { errorReplySchema, paymentListSchema, paymentSchema } from '@authledger/shared';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { getPayment, listPaymentsForUser } from '../domain/payments.js';
import { canViewPayment } from '../domain/policy.js';
import { requireAuth } from '../plugins/session-auth.js';
import type { RouteDeps } from './deps.js';

export const paymentRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (app, { db }) => {
  app.get(
    '/',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: { response: { 200: paymentListSchema } },
    },
    async (req) => {
      return { payments: await listPaymentsForUser(db, req.auth!.user.id) };
    },
  );

  // Own payment by ownership; another user's only with payments.view_any. The
  // owner-or-capability rule lives in the policy module, not the route.
  app.get(
    '/:id',
    {
      preHandler: requireAuth,
      config: { policy: 'self' },
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: paymentSchema, 403: errorReplySchema, 404: errorReplySchema },
      },
    },
    async (req, reply) => {
      const payment = await getPayment(db, req.params.id);
      if (!payment) {
        return reply.code(404).send({ error: 'no such payment' });
      }
      const decision = canViewPayment(
        { userId: req.auth!.user.id, capabilities: req.auth!.permissions },
        { ownerId: payment.ownerId, amountMinor: payment.amountMinor },
      );
      if (!decision.allowed) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return reply.code(200).send(payment.view);
    },
  );
};
