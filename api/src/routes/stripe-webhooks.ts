import Stripe from 'stripe';
import { Type } from '@sinclair/typebox';
import { errorReplySchema } from '@authledger/shared';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import { applyPaymentEvent } from '../domain/payments.js';
import { postCharge } from '../domain/ledger.js';
import { mapStripeEvent } from '../domain/stripe-mapping.js';

// constructEvent is HMAC over the webhook secret and never calls the API, so the
// client needs no live key when only verifying webhooks. Named so it reads as a
// sentinel, not a credential.
const NO_API_KEY = 'stripe-api-key-unused-for-webhook-verification';

export interface StripeWebhookDeps {
  config: Config;
  db: Kysely<DB>;
  // Tests inject a client; production builds one from config.
  stripe?: Stripe;
}

export const stripeWebhookRoutes: FastifyPluginAsyncTypebox<StripeWebhookDeps> = async (
  app,
  deps,
) => {
  const { config, db } = deps;
  const stripe = deps.stripe ?? new Stripe(config.stripeSecretKey ?? NO_API_KEY);

  // Signature verification needs the exact bytes, so this plugin keeps the raw
  // buffer instead of the parsed JSON. Scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    '/stripe',
    {
      // Authenticated by the Stripe signature, not a session cookie. Rate limited
      // like the other internet-exposed webhook, since each call runs an HMAC
      // verify and a transaction.
      config: {
        policy: 'public',
        skipOriginCheck: true,
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
      schema: {
        response: {
          200: Type.Object({ received: Type.Boolean() }),
          400: errorReplySchema,
          503: errorReplySchema,
        },
      },
    },
    async (req, reply) => {
      if (!config.stripeWebhookSecret) {
        req.log.error('stripe webhook secret is not configured');
        return reply.code(503).send({ error: 'stripe webhook not configured' });
      }
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        return reply.code(400).send({ error: 'missing signature' });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body as Buffer,
          signature,
          config.stripeWebhookSecret,
        );
      } catch (err) {
        req.log.warn({ err }, 'stripe webhook signature verification failed');
        return reply.code(400).send({ error: 'invalid signature' });
      }

      const internal = mapStripeEvent(event);

      // Claim the event id and process in one transaction: a replay conflicts and
      // is a no-op, and a processing failure rolls the claim back so the Stripe
      // retry reprocesses. The inbox status records the application outcome;
      // 'unmatched' (a handled event with no payment row, only reachable for an
      // out-of-band intent) is left for M7 reconciliation against the provider.
      await db.transaction().execute(async (trx) => {
        const claim = await trx
          .insertInto('provider_events')
          .values({
            id: event.id,
            type: event.type,
            status: internal ? 'processed' : 'unhandled',
            payload: JSON.stringify(event),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!claim) {
          return;
        }
        if (internal) {
          const outcome = await applyPaymentEvent(trx, internal);
          if (outcome === 'unknown_intent') {
            await trx
              .updateTable('provider_events')
              .set({ status: 'unmatched' })
              .where('id', '=', event.id)
              .execute();
          } else if (outcome === 'applied' && internal.kind === 'succeeded') {
            // The charge settled: post it to the ledger in the same transaction,
            // so a payment and its journal entry commit together.
            // applyPaymentEvent returned 'applied', so the row exists; fail loud
            // and roll back rather than silently commit a charge with no entry.
            const payment = await trx
              .selectFrom('payments')
              .select(['amount_minor', 'currency'])
              .where('provider_intent_id', '=', internal.providerIntentId)
              .executeTakeFirstOrThrow();
            await postCharge(trx, {
              providerIntentId: internal.providerIntentId,
              amountMinor: Number(payment.amount_minor),
              currency: payment.currency,
            });
          }
        }
      });

      return reply.code(200).send({ received: true });
    },
  );
};
