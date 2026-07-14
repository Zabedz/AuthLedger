import Stripe from 'stripe';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, truncateAll, type TestContext } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_dummy');

// Capture spans in memory instead of exporting them, so the assertions read the
// same span tree an exporter would ship.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

let ctx: TestContext;

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  if (ctx) await ctx.close();
  await provider.shutdown();
  // Reset the global provider and context manager so later test files run
  // untraced with a clean teardown.
  trace.disable();
  context.disable();
});

beforeEach(async () => {
  if (ctx) await ctx.close();
  exporter.reset();
  // A truthy tracing config makes the server register its span hooks; the spans
  // land in the in-memory exporter above, not the console.
  ctx = await makeTestServer({
    config: { tracing: { consoleExporter: true, otlpEndpoint: undefined } },
  });
  await truncateAll(ctx.db);
});

function signedEvent(intentId: string): { payload: string; header: string } {
  const payload = JSON.stringify({
    id: `evt_${intentId}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    created: 1000,
    data: { object: { id: intentId, object: 'payment_intent' } },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
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

describe('tracing', () => {
  it('opens a server span per request, named by the matched route', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);

    const server = exporter.getFinishedSpans().find((s) => s.name === 'GET /api/healthz');
    expect(server).toBeDefined();
    expect(server!.attributes['http.route']).toBe('/api/healthz');
    expect(server!.attributes['http.response.status_code']).toBe(200);
  });

  it('nests the ledger posting under the webhook request in one trace', async () => {
    await seedPayment('pi_trace');
    const { payload, header } = signedEvent('pi_trace');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.name === 'POST /api/webhooks/stripe');
    const ledger = spans.find((s) => s.name === 'ledger.post_entry');
    expect(server).toBeDefined();
    expect(ledger).toBeDefined();

    // Same trace, and the ledger span is a direct child of the HTTP span: the
    // trace runs from the webhook request down to the ledger write.
    expect(ledger!.spanContext().traceId).toBe(server!.spanContext().traceId);
    expect(ledger!.parentSpanContext?.spanId).toBe(server!.spanContext().spanId);
    expect(ledger!.attributes['ledger.kind']).toBe('charge');
    expect(ledger!.attributes['ledger.reference']).toBe('pi_trace');
  });
});
