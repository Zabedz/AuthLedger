import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';
import { assignRole } from '../src/domain/authz.js';

const PASSWORD = 'correct-horse-battery';

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
});
