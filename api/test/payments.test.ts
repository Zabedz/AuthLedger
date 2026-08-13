import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';
import { assignRole } from '../src/domain/authz.js';

const PASSWORD = 'correct-horse-battery';

// A stub Stripe that records calls and never touches the network. Payment
// intents get a stable id per idempotency key so a retry maps to one row.
function stubStripe(opts: { failRefund?: boolean } = {}) {
  const calls = { create: [] as { params: unknown; opts: unknown }[], refund: [] as unknown[] };
  const stripe = {
    paymentIntents: {
      create: async (params: { amount: number }, o: { idempotencyKey: string }) => {
        calls.create.push({ params, opts: o });
        return {
          id: `pi_${o.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '')}`,
          client_secret: `pi_secret_${o.idempotencyKey}`,
          status: 'requires_payment_method',
        };
      },
    },
    refunds: {
      create: async (params: { amount: number }, o: { idempotencyKey: string }) => {
        if (opts.failRefund) {
          throw new Error('stub stripe refund failure');
        }
        calls.refund.push({ params, opts: o });
        return {
          id: `re_${o.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '')}`,
          status: 'succeeded',
          amount: params.amount,
        };
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

let ctx: TestContext;

beforeEach(async () => {
  if (ctx) await ctx.close();
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

async function makeUser(email: string): Promise<{ cookie: string; id: string }> {
  await ctx.app.inject(
    withOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    }),
  );
  const login = await ctx.app.inject(
    withOrigin({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } }),
  );
  const row = await ctx.db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  return { cookie: cookieOf(login), id: row.id };
}

async function seedPayment(userId: string, key: string): Promise<string> {
  const row = await ctx.db
    .insertInto('payments')
    .values({
      user_id: userId,
      idempotency_key: key,
      amount_minor: '2500',
      currency: 'usd',
      status: 'succeeded',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function get(url: string, cookie?: string) {
  return ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

describe('payment views', () => {
  it('lists only the caller own payments', async () => {
    const owner = await makeUser('owner@example.com');
    const other = await makeUser('other@example.com');
    await seedPayment(owner.id, 'idem-owner');
    await seedPayment(other.id, 'idem-other');

    const res = await get('/api/payments', owner.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().payments).toHaveLength(1);
    expect(res.json().payments[0].amount_minor).toBe(2500);
  });

  it('lets the owner read their payment by id', async () => {
    const owner = await makeUser('owner@example.com');
    const id = await seedPayment(owner.id, 'idem-1');
    const res = await get(`/api/payments/${id}`, owner.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('succeeded');
  });

  it("forbids reading another user's payment without payments.view_any", async () => {
    const owner = await makeUser('owner@example.com');
    const stranger = await makeUser('stranger@example.com');
    const id = await seedPayment(owner.id, 'idem-1');
    expect((await get(`/api/payments/${id}`, stranger.cookie)).statusCode).toBe(403);
  });

  it("lets an admin (payments.view_any) read another user's payment", async () => {
    const owner = await makeUser('owner@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await seedPayment(owner.id, 'idem-1');
    const res = await get(`/api/payments/${id}`, admin.cookie);
    expect(res.statusCode).toBe(200);
  });

  it('is 404 for a missing payment and 401 without a session', async () => {
    const owner = await makeUser('owner@example.com');
    expect(
      (await get('/api/payments/00000000-0000-0000-0000-000000000000', owner.cookie)).statusCode,
    ).toBe(404);
    expect((await get('/api/payments', undefined)).statusCode).toBe(401);
  });

  it('serves the publishable key from the public config endpoint', async () => {
    const res = await get('/api/payments/config');
    expect(res.statusCode).toBe(200);
    expect(res.json().publishable_key).toBe('pk_test_fixture');
  });
});

describe('payment create and refund', () => {
  let stub: ReturnType<typeof stubStripe>;

  beforeEach(async () => {
    await ctx.close();
    stub = stubStripe();
    ctx = await makeTestServer({ stripe: stub.stripe });
    await truncateAll(ctx.db);
  });

  function post(
    url: string,
    cookie: string,
    payload: object,
    headers: Record<string, string> = {},
  ) {
    return ctx.app.inject(
      withOrigin({ method: 'POST', url, headers: { cookie, ...headers }, payload }),
    );
  }

  it('creates an intent, records the payment, and returns the client secret', async () => {
    const user = await makeUser('buyer@example.com');
    const res = await post(
      '/api/payments',
      user.cookie,
      { amount_minor: 1500, currency: 'usd' },
      {
        'idempotency-key': 'order-abcdef',
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().client_secret).toContain('pi_secret_');
    expect(res.json().status).toBe('created');

    const row = await ctx.db
      .selectFrom('payments')
      .select(['amount_minor', 'provider_intent_id'])
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(Number(row.amount_minor)).toBe(1500);
    expect(row.provider_intent_id).toBeTruthy();
    // The user's id scopes Stripe's idempotency key.
    expect((stub.calls.create[0]!.opts as { idempotencyKey: string }).idempotencyKey).toBe(
      `${user.id}:order-abcdef`,
    );
  });

  it('returns the same payment for a repeated idempotency key', async () => {
    const user = await makeUser('buyer@example.com');
    const first = await post(
      '/api/payments',
      user.cookie,
      { amount_minor: 1500, currency: 'usd' },
      {
        'idempotency-key': 'order-abcdef',
      },
    );
    const second = await post(
      '/api/payments',
      user.cookie,
      { amount_minor: 1500, currency: 'usd' },
      {
        'idempotency-key': 'order-abcdef',
      },
    );
    expect(first.json().id).toBe(second.json().id);
    const count = await ctx.db
      .selectFrom('payments')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });

  it('requires an idempotency key', async () => {
    const user = await makeUser('buyer@example.com');
    const res = await post('/api/payments', user.cookie, { amount_minor: 1500, currency: 'usd' });
    expect(res.statusCode).toBe(400);
  });

  async function succeededPayment(userId: string, amount = 4000): Promise<string> {
    const row = await ctx.db
      .insertInto('payments')
      .values({
        user_id: userId,
        idempotency_key: `k-${userId}-${amount}`,
        provider_intent_id: `pi-${userId}-${amount}`,
        amount_minor: String(amount),
        currency: 'usd',
        status: 'succeeded',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  // The route requires an 8+ char key; pad short test labels while keeping
  // distinct labels distinct and repeated labels identical.
  const IK = (k: string) => ({ 'idempotency-key': k.padEnd(8, '0') });

  it('lets a holder of payments.refund refund a settled payment', async () => {
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await succeededPayment(buyer.id);

    const res = await post(`/api/payments/${id}/refund`, admin.cookie, {}, IK('refund-1'));
    expect(res.statusCode).toBe(200);
    expect(res.json().refunded_minor).toBe(4000);
    expect((stub.calls.refund[0] as { params: { amount: number } }).params.amount).toBe(4000);
    const count = await ctx.db
      .selectFrom('refunds')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });

  it('requires an idempotency key for a refund', async () => {
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await succeededPayment(buyer.id);
    expect((await post(`/api/payments/${id}/refund`, admin.cookie, {})).statusCode).toBe(400);
  });

  it('is idempotent on a repeated refund key: one refund, not two', async () => {
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await succeededPayment(buyer.id);

    await post(`/api/payments/${id}/refund`, admin.cookie, { amount_minor: 1000 }, IK('r-same'));
    await post(`/api/payments/${id}/refund`, admin.cookie, { amount_minor: 1000 }, IK('r-same'));
    const count = await ctx.db
      .selectFrom('refunds')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
    // Only one refund reached the provider.
    expect(stub.calls.refund).toHaveLength(1);
  });

  it('rejects a refund beyond the remaining balance', async () => {
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await succeededPayment(buyer.id);

    await post(`/api/payments/${id}/refund`, admin.cookie, {}, IK('r-full')); // full 4000
    const over = await post(
      `/api/payments/${id}/refund`,
      admin.cookie,
      { amount_minor: 1 },
      IK('r-more'),
    );
    expect(over.statusCode).toBe(400);
  });

  it('enforces the ceiling against the cumulative refund total, not per call', async () => {
    const buyer = await makeUser('buyer@example.com');
    const limited = await makeUser('limited@example.com');
    // A role with only payments.refund (no over-ceiling), created idempotently.
    await ctx.db
      .insertInto('roles')
      .values({ name: 'refunder', description: 'limited refunds' })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute();
    const role = await ctx.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', 'refunder')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('role_permissions')
      .values({ role_id: role.id, action: 'payments.refund' })
      .onConflict((oc) => oc.columns(['role_id', 'action']).doNothing())
      .execute();
    await ctx.db
      .insertInto('user_roles')
      .values({ user_id: limited.id, role_id: role.id })
      .execute();

    const id = await succeededPayment(buyer.id, 100_000);
    // First refund at the ceiling is allowed.
    const first = await post(
      `/api/payments/${id}/refund`,
      limited.cookie,
      { amount_minor: 50_000 },
      IK('c-1'),
    );
    expect(first.statusCode).toBe(200);
    // A second partial pushes the cumulative past the ceiling: denied
    // without payments.refund_over_ceiling.
    const second = await post(
      `/api/payments/${id}/refund`,
      limited.cookie,
      { amount_minor: 40_000 },
      IK('c-2'),
    );
    expect(second.statusCode).toBe(403);

    // Reference data survives truncateAll, so remove the test-only role or the
    // roles-match-the-code assertion in authz.test would see it.
    await ctx.db.deleteFrom('roles').where('name', '=', 'refunder').execute();
  });

  it('rejects refunding a non-settled payment', async () => {
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const created = await ctx.db
      .insertInto('payments')
      .values({
        user_id: buyer.id,
        idempotency_key: 'k-created',
        provider_intent_id: 'pi-created',
        amount_minor: '4000',
        currency: 'usd',
        status: 'created',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(
      (await post(`/api/payments/${created.id}/refund`, admin.cookie, {}, IK('r-x'))).statusCode,
    ).toBe(400);
  });

  it('returns 502 when the provider refund fails', async () => {
    await ctx.close();
    const failing = stubStripe({ failRefund: true });
    ctx = await makeTestServer({ stripe: failing.stripe });
    await truncateAll(ctx.db);
    const buyer = await makeUser('buyer@example.com');
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const id = await succeededPayment(buyer.id);
    const res = await post(`/api/payments/${id}/refund`, admin.cookie, {}, IK('r-fail'));
    expect(res.statusCode).toBe(502);
    // Nothing recorded when the provider call failed.
    const count = await ctx.db
      .selectFrom('refunds')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(0);
  });
});
