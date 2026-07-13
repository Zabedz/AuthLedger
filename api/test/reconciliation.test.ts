import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';
import { reconcile } from '../src/domain/reconciliation.js';
import { accountBalance, postCharge } from '../src/domain/ledger.js';
import { assignRole } from '../src/domain/authz.js';

const PASSWORD = 'correct-horse-battery';

// A stub for the provider's balance transactions; each is a settled charge with
// its fee and the intent it came from.
type BalanceTxn = {
  id: string;
  type: string;
  amount: number;
  fee: number;
  currency: string;
  source: { payment_intent: string };
};
function stubStripe(txns: BalanceTxn[]): Stripe {
  return { balanceTransactions: { list: async () => ({ data: txns }) } } as unknown as Stripe;
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

describe('reconciliation', () => {
  it('posts provider fees to the ledger, and does so once on a re-run', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_1', amountMinor: 5000, currency: 'usd' });
    const settlements = [
      {
        balanceTxnId: 'txn_1',
        intentId: 'pi_1',
        amountMinor: 5000,
        feeMinor: 175,
        currency: 'usd',
      },
    ];

    const first = await reconcile(ctx.db, settlements);
    expect(first.feesPostedMinor).toBe(175);
    expect(first.discrepancies).toEqual([]);
    expect(await accountBalance(ctx.db, 'fees')).toBe(175);
    // Receivable now reflects the net owed by the provider (gross minus fee).
    expect(await accountBalance(ctx.db, 'stripe_receivable')).toBe(4825);

    const second = await reconcile(ctx.db, settlements);
    expect(second.feesPostedMinor).toBe(0);
    expect(await accountBalance(ctx.db, 'fees')).toBe(175);
  });

  it('detects a settled charge missing from the ledger (a seeded gap)', async () => {
    const result = await reconcile(ctx.db, [
      {
        balanceTxnId: 'txn_2',
        intentId: 'pi_missing',
        amountMinor: 3000,
        feeMinor: 100,
        currency: 'usd',
      },
    ]);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.reference).toBe('pi_missing');
  });

  it('reports zero discrepancies when the ledger matches the provider', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_ok', amountMinor: 2000, currency: 'usd' });
    const clean = await reconcile(ctx.db, [
      {
        balanceTxnId: 'txn_3',
        intentId: 'pi_ok',
        amountMinor: 2000,
        feeMinor: 90,
        currency: 'usd',
      },
    ]);
    expect(clean.discrepancies).toEqual([]);
  });
});

describe('admin reconciliation and ledger endpoints', () => {
  beforeEach(async () => {
    await ctx.close();
    ctx = await makeTestServer({
      stripe: stubStripe([
        {
          id: 'txn_a',
          type: 'charge',
          amount: 5000,
          fee: 175,
          currency: 'usd',
          source: { payment_intent: 'pi_gap' },
        },
      ]),
    });
    await truncateAll(ctx.db);
  });

  async function admin(): Promise<string> {
    const a = await makeUser('admin@example.com');
    await assignRole(ctx.db, a.id, 'admin', null);
    return a.cookie;
  }

  it('runs reconciliation, reports the gap, and records the run', async () => {
    const cookie = await admin();
    const res = await ctx.app.inject(
      withOrigin({ method: 'POST', url: '/api/admin/reconcile', headers: { cookie } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().fees_posted_minor).toBe(175);
    expect(res.json().discrepancy_count).toBe(1);
    expect(res.json().discrepancies[0].reference).toBe('pi_gap');

    const history = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/reconciliations',
      headers: { cookie },
    });
    expect(history.json().reconciliations).toHaveLength(1);
    expect(history.json().reconciliations[0].discrepancy_count).toBe(1);
  });

  it('forbids reconciliation without ledger.reconcile', async () => {
    const plain = await makeUser('plain@example.com');
    const res = await ctx.app.inject(
      withOrigin({
        method: 'POST',
        url: '/api/admin/reconcile',
        headers: { cookie: plain.cookie },
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('serves ledger balances by account and currency to an admin', async () => {
    const cookie = await admin();
    await postCharge(ctx.db, { providerIntentId: 'pi_bal', amountMinor: 1000, currency: 'usd' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/ledger',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const revenue = res
      .json()
      .balances.find((b: { account: string; currency: string }) => b.account === 'revenue');
    expect(revenue.balance_minor).toBe(-1000);
    expect(revenue.currency).toBe('usd');
  });
});
