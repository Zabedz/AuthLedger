import { Type } from '@sinclair/typebox';
import {
  createPaymentSchema,
  errorReplySchema,
  paymentConfigSchema,
  paymentIntentReplySchema,
  paymentListSchema,
  paymentSchema,
  refundBodySchema,
  refundReplySchema,
} from '@authledger/shared';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type Stripe from 'stripe';
import { recordAudit } from '../domain/audit.js';
import {
  findRefundByKey,
  getPayment,
  listPaymentsForUser,
  recordCreatedPayment,
  recordRefund,
  refundedTotal,
  type PaymentStatus,
} from '../domain/payments.js';
import { canRefundPayment, canViewPayment } from '../domain/policy.js';
import { authorize } from '../plugins/authz-guard.js';
import { requireAuth } from '../plugins/session-auth.js';
import { reportServerError } from '../sentry.js';
import { requestContextOf, type RouteDeps } from './deps.js';

export interface PaymentDeps extends RouteDeps {
  stripe: Stripe;
}

const REFUNDABLE: ReadonlySet<PaymentStatus> = new Set(['succeeded']);

export const paymentRoutes: FastifyPluginAsyncTypebox<PaymentDeps> = async (app, deps) => {
  const { config, db, stripe } = deps;

  // Public: the SPA needs the publishable key to mount the Payment Element.
  app.get(
    '/config',
    { config: { policy: 'public' }, schema: { response: { 200: paymentConfigSchema } } },
    async () => ({ publishable_key: config.stripePublishableKey ?? null }),
  );

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

  // Creates a PaymentIntent for the caller. The Idempotency-Key header makes a
  // retry return the same intent and row rather than a second charge.
  app.post(
    '/',
    {
      preHandler: requireAuth,
      config: { policy: 'self', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: createPaymentSchema,
        response: {
          200: paymentIntentReplySchema,
          400: errorReplySchema,
          502: errorReplySchema,
          503: errorReplySchema,
        },
      },
    },
    async (req, reply) => {
      if (!config.stripeSecretKey) {
        return reply.code(503).send({ error: 'payments are not configured' });
      }
      const header = req.headers['idempotency-key'];
      if (typeof header !== 'string' || header.length < 8 || header.length > 200) {
        return reply.code(400).send({ error: 'an Idempotency-Key header is required' });
      }
      const userId = req.auth!.user.id;
      // Scope the key to the user so two users cannot collide on one client key.
      const idempotencyKey = `${userId}:${header}`;

      let intent: Stripe.PaymentIntent;
      let payment: { id: string; status: PaymentStatus; created: boolean };
      try {
        intent = await stripe.paymentIntents.create(
          {
            amount: req.body.amount_minor,
            currency: req.body.currency,
            // Card only: this app takes card payments, and it renders a
            // deterministic card form in the Payment Element.
            payment_method_types: ['card'],
          },
          { idempotencyKey },
        );
        payment = await recordCreatedPayment(db, {
          userId,
          idempotencyKey,
          providerIntentId: intent.id,
          amountMinor: req.body.amount_minor,
          currency: req.body.currency,
        });
      } catch (err) {
        req.log.error({ err }, 'payment intent creation failed');
        reportServerError(err, req);
        return reply.code(502).send({ error: 'could not create the payment' });
      }
      if (!intent.client_secret) {
        req.log.error({ intentId: intent.id }, 'payment intent has no client secret');
        reportServerError(new Error('payment intent has no client secret'), req);
        return reply.code(502).send({ error: 'could not create the payment' });
      }

      // Audit only a genuine create, so a retried key does not overcount.
      if (payment.created) {
        await recordAudit(db, {
          event: 'payment_created',
          userId,
          ...requestContextOf(req),
          detail: { paymentId: payment.id, amountMinor: req.body.amount_minor },
        });
      }

      return reply.code(200).send({
        id: payment.id,
        client_secret: intent.client_secret,
        status: payment.status,
        amount_minor: req.body.amount_minor,
        currency: req.body.currency,
      });
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

  // Refund a settled payment. The permission gates entry; the policy module
  // decides the ceiling and records the reason.
  app.post(
    '/:id/refund',
    {
      ...authorize('payments.refund'),
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: refundBodySchema,
        response: {
          200: refundReplySchema,
          400: errorReplySchema,
          403: errorReplySchema,
          404: errorReplySchema,
          502: errorReplySchema,
          503: errorReplySchema,
        },
      },
    },
    async (req, reply) => {
      if (!config.stripeSecretKey) {
        return reply.code(503).send({ error: 'payments are not configured' });
      }
      const header = req.headers['idempotency-key'];
      if (typeof header !== 'string' || header.length < 8 || header.length > 200) {
        return reply.code(400).send({ error: 'an Idempotency-Key header is required' });
      }
      const payment = await getPayment(db, req.params.id);
      if (!payment) {
        return reply.code(404).send({ error: 'no such payment' });
      }
      if (!REFUNDABLE.has(payment.view.status) || !payment.providerIntentId) {
        return reply.code(400).send({ error: `cannot refund a ${payment.view.status} payment` });
      }

      // Idempotent: a retried refund request returns the one already recorded.
      const refundKey = `${payment.view.id}:${header}`;
      const existing = await findRefundByKey(db, refundKey);
      if (existing) {
        return reply.code(200).send({ refunded_minor: existing.amountMinor, reason: 'idempotent' });
      }

      const already = await refundedTotal(db, payment.view.id);
      const remaining = payment.amountMinor - already;
      const amount = req.body.amount_minor ?? remaining;
      if (amount <= 0 || amount > remaining) {
        return reply.code(400).send({ error: 'refund amount is out of range' });
      }

      // The ceiling is checked against the running total, so several partial
      // refunds cannot add up past it on a routine grant.
      const decision = canRefundPayment(
        { userId: req.auth!.user.id, capabilities: req.auth!.permissions },
        { ownerId: payment.ownerId, amountMinor: already + amount },
      );
      if (!decision.allowed) {
        return reply.code(403).send({ error: decision.reason });
      }

      let refund: Stripe.Refund;
      try {
        refund = await stripe.refunds.create(
          { payment_intent: payment.providerIntentId, amount },
          { idempotencyKey: `refund:${refundKey}` },
        );
      } catch (err) {
        req.log.error({ err, paymentId: payment.view.id }, 'refund failed');
        reportServerError(err, req);
        return reply.code(502).send({ error: 'could not refund the payment' });
      }

      await recordRefund(db, {
        paymentId: payment.view.id,
        idempotencyKey: refundKey,
        amountMinor: amount,
        providerRefundId: refund.id,
        createdBy: req.auth!.user.id,
      });
      await recordAudit(db, {
        event: 'payment_refunded',
        userId: req.auth!.user.id,
        ...requestContextOf(req),
        detail: { paymentId: payment.view.id, amountMinor: amount, reason: decision.reason },
      });

      return reply.code(200).send({ refunded_minor: amount, reason: decision.reason });
    },
  );
};
