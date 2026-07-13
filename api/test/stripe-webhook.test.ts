import Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, truncateAll, type TestContext } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_dummy');

let ctx: TestContext;

beforeEach(async () => {
  if (ctx) await ctx.close();
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

// Builds a Stripe event body and its valid signature header for the test secret.
function signedEvent(opts: { id: string; type: string; intentId: string; created: number }): {
  payload: string;
  header: string;
} {
  const payload = JSON.stringify({
    id: opts.id,
    object: 'event',
    type: opts.type,
    created: opts.created,
    data: { object: { id: opts.intentId, object: 'payment_intent' } },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

function post(payload: string, headers: Record<string, string>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/webhooks/stripe',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

async function seedPayment(intentId: string): Promise<void> {
  const user = await ctx.db
    .insertInto('users')
    .values({ email: `payer-${intentId}@example.com`, password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('payments')
    .values({
      user_id: user.id,
      idempotency_key: `idem-${intentId}`,
      provider_intent_id: intentId,
      amount_minor: '1000',
      currency: 'usd',
      status: 'created',
    })
    .execute();
}

async function paymentStatus(intentId: string): Promise<string> {
  const row = await ctx.db
    .selectFrom('payments')
    .select('status')
    .where('provider_intent_id', '=', intentId)
    .executeTakeFirstOrThrow();
  return row.status;
}

describe('stripe webhook signature', () => {
  it('rejects a missing signature', async () => {
    const { payload } = signedEvent({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      intentId: 'pi_1',
      created: 100,
    });
    expect((await post(payload, {})).statusCode).toBe(400);
  });

  it('rejects a tampered body', async () => {
    const { payload, header } = signedEvent({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      intentId: 'pi_1',
      created: 100,
    });
    const res = await post(payload + ' ', { 'stripe-signature': header });
    expect(res.statusCode).toBe(400);
  });
});

describe('stripe webhook processing', () => {
  it('applies a succeeded event and records the inbox row', async () => {
    await seedPayment('pi_ok');
    const { payload, header } = signedEvent({
      id: 'evt_ok',
      type: 'payment_intent.succeeded',
      intentId: 'pi_ok',
      created: 200,
    });
    const res = await post(payload, { 'stripe-signature': header });
    expect(res.statusCode).toBe(200);
    expect(await paymentStatus('pi_ok')).toBe('succeeded');
    const inbox = await ctx.db
      .selectFrom('provider_events')
      .select('status')
      .where('id', '=', 'evt_ok')
      .executeTakeFirstOrThrow();
    expect(inbox.status).toBe('processed');
  });

  it('treats a replayed event id as a no-op', async () => {
    await seedPayment('pi_replay');
    const succeeded = signedEvent({
      id: 'evt_r',
      type: 'payment_intent.succeeded',
      intentId: 'pi_replay',
      created: 300,
    });
    await post(succeeded.payload, { 'stripe-signature': succeeded.header });

    // Same id delivered again: the inbox stays one row, the payment unchanged.
    const again = await post(succeeded.payload, { 'stripe-signature': succeeded.header });
    expect(again.statusCode).toBe(200);
    const count = await ctx.db
      .selectFrom('provider_events')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('id', '=', 'evt_r')
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });

  it('ignores an out-of-order event that would downgrade a settled payment', async () => {
    await seedPayment('pi_order');
    const succeeded = signedEvent({
      id: 'evt_s',
      type: 'payment_intent.succeeded',
      intentId: 'pi_order',
      created: 500,
    });
    await post(succeeded.payload, { 'stripe-signature': succeeded.header });
    expect(await paymentStatus('pi_order')).toBe('succeeded');

    // A late 'processing' with an earlier event time must not move it back.
    const late = signedEvent({
      id: 'evt_p',
      type: 'payment_intent.processing',
      intentId: 'pi_order',
      created: 400,
    });
    await post(late.payload, { 'stripe-signature': late.header });
    expect(await paymentStatus('pi_order')).toBe('succeeded');
  });

  it('stores an event with no handler as unhandled, without failing', async () => {
    const { payload, header } = signedEvent({
      id: 'evt_u',
      type: 'charge.dispute.created',
      intentId: 'pi_x',
      created: 600,
    });
    const res = await post(payload, { 'stripe-signature': header });
    expect(res.statusCode).toBe(200);
    const inbox = await ctx.db
      .selectFrom('provider_events')
      .select('status')
      .where('id', '=', 'evt_u')
      .executeTakeFirstOrThrow();
    expect(inbox.status).toBe('unhandled');
  });

  it('records a known event for an unknown intent as unmatched for retry', async () => {
    const { payload, header } = signedEvent({
      id: 'evt_ui',
      type: 'payment_intent.succeeded',
      intentId: 'pi_missing',
      created: 700,
    });
    const res = await post(payload, { 'stripe-signature': header });
    expect(res.statusCode).toBe(200);
    const inbox = await ctx.db
      .selectFrom('provider_events')
      .select('status')
      .where('id', '=', 'evt_ui')
      .executeTakeFirstOrThrow();
    expect(inbox.status).toBe('unmatched');
  });

  it('applies a same-second processing then succeeded, ending succeeded', async () => {
    await seedPayment('pi_same');
    const processing = signedEvent({
      id: 'evt_a',
      type: 'payment_intent.processing',
      intentId: 'pi_same',
      created: 800,
    });
    const succeeded = signedEvent({
      id: 'evt_b',
      type: 'payment_intent.succeeded',
      intentId: 'pi_same',
      created: 800,
    });
    await post(processing.payload, { 'stripe-signature': processing.header });
    await post(succeeded.payload, { 'stripe-signature': succeeded.header });
    expect(await paymentStatus('pi_same')).toBe('succeeded');
  });
});
