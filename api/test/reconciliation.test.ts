import pg from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';
import { createDb } from '../src/db/client.js';
import { reconcile, runAndRecordReconciliation } from '../src/domain/reconciliation.js';
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
        converted: false,
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
        converted: false,
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
        converted: false,
      },
    ]);
    expect(clean.discrepancies).toEqual([]);
  });

  it('records a failed run and rethrows, so silence never means "ran and broke"', async () => {
    const failing = {
      balanceTransactions: {
        list: async () => {
          throw new Error('stripe is down');
        },
      },
    } as unknown as Stripe;

    await expect(runAndRecordReconciliation(ctx.db, failing)).rejects.toThrow('stripe is down');
    const rows = await ctx.db.selectFrom('reconciliations').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('stripe is down');
    expect(rows[0]!.checked).toBe(0);
  });

  it('records a successful run with status ok and no error', async () => {
    const ok = stubStripe([]);
    const outcome = await runAndRecordReconciliation(ctx.db, ok);
    const row = await ctx.db
      .selectFrom('reconciliations')
      .selectAll()
      .where('id', '=', outcome.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ok');
    expect(row.error).toBeNull();
  });

  it('flags a settled charge whose ledger amount disagrees with the provider', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_short', amountMinor: 5000, currency: 'usd' });
    const result = await reconcile(ctx.db, [
      {
        balanceTxnId: 'txn_short',
        intentId: 'pi_short',
        amountMinor: 4000,
        feeMinor: 0,
        currency: 'usd',
        converted: false,
      },
    ]);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.reason).toContain('amount mismatch');
    expect(result.discrepancies[0]!.reason).toContain('5000');
    expect(result.discrepancies[0]!.reason).toContain('4000');
  });

  it('does not compare amounts across a currency conversion', async () => {
    // A usd charge on a gbp account settles converted: the provider's gross is
    // in gbp and tells nothing about the usd ledger amount.
    await postCharge(ctx.db, { providerIntentId: 'pi_fx', amountMinor: 5000, currency: 'usd' });
    const result = await reconcile(ctx.db, [
      {
        balanceTxnId: 'txn_fx',
        intentId: 'pi_fx',
        amountMinor: 3714,
        feeMinor: 0,
        currency: 'gbp',
        converted: true,
      },
    ]);
    expect(result.discrepancies).toEqual([]);
  });

  it('flags an unconverted settlement whose currency disagrees with the ledger', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_cur', amountMinor: 5000, currency: 'usd' });
    const result = await reconcile(ctx.db, [
      {
        balanceTxnId: 'txn_cur',
        intentId: 'pi_cur',
        amountMinor: 5000,
        feeMinor: 0,
        currency: 'eur',
        converted: false,
      },
    ]);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.reason).toContain('currency mismatch');
  });

  it('windows the fetch on the newest successful run, with an hour of overlap', async () => {
    const ranAt = new Date('2026-07-15T06:11:00Z');
    await ctx.db
      .insertInto('reconciliations')
      .values({
        ran_at: ranAt,
        checked: 0,
        fees_posted_minor: '0',
        discrepancy_count: 0,
        discrepancies: JSON.stringify([]),
      })
      .execute();
    // A failed run after it must not advance the watermark.
    await ctx.db
      .insertInto('reconciliations')
      .values({
        ran_at: new Date('2026-07-16T06:11:00Z'),
        checked: 0,
        fees_posted_minor: '0',
        discrepancy_count: 0,
        discrepancies: JSON.stringify([]),
        status: 'failed',
        error: 'boom',
      })
      .execute();

    const captured: Record<string, unknown>[] = [];
    const spying = {
      balanceTransactions: {
        list: async (params: Record<string, unknown>) => {
          captured.push(params);
          return { data: [], has_more: false };
        },
      },
    } as unknown as Stripe;

    await runAndRecordReconciliation(ctx.db, spying);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.created).toEqual({
      gte: Math.floor(ranAt.getTime() / 1000) - 3600,
    });
  });

  it('stops the unwindowed first run at one page, then pages and caps loudly', async () => {
    const txn = (id: string, intent: string) => ({
      id,
      type: 'charge',
      amount: 1000,
      fee: 30,
      currency: 'usd',
      source: { payment_intent: intent },
    });

    // First run ever: no watermark exists, so it must take one page and stop;
    // paging a large history into the cap would fail the run forever, since a
    // failed run never seeds the watermark.
    let firstCalls = 0;
    const busyFirst = {
      balanceTransactions: {
        list: async () => {
          firstCalls += 1;
          return { data: [txn('txn_f1', 'pi_f1')], has_more: true };
        },
      },
    } as unknown as Stripe;
    const first = await runAndRecordReconciliation(ctx.db, busyFirst);
    expect(firstCalls).toBe(1);
    expect(first.checked).toBe(1);

    // With the watermark seeded, a windowed run follows has_more to the end.
    const pages = [
      { data: [txn('txn_p1', 'pi_p1')], has_more: true },
      { data: [txn('txn_p2', 'pi_p2')], has_more: false },
    ];
    let calls = 0;
    const paged = {
      balanceTransactions: { list: async () => pages[Math.min(calls++, 1)] },
    } as unknown as Stripe;
    const run = await runAndRecordReconciliation(ctx.db, paged);
    expect(calls).toBe(2);
    expect(run.checked).toBe(2);
    expect(run.feesPostedMinor).toBe(60);

    // A windowed run that would exceed the cap fails loudly and is recorded.
    let endlessCalls = 0;
    const endless = {
      balanceTransactions: {
        list: async () => {
          endlessCalls += 1;
          return { data: [txn(`txn_e${endlessCalls}`, 'pi_e')], has_more: true };
        },
      },
    } as unknown as Stripe;
    await expect(runAndRecordReconciliation(ctx.db, endless)).rejects.toThrow(/under-scan/);
    const failed = await ctx.db
      .selectFrom('reconciliations')
      .select('status')
      .orderBy('ran_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(failed.status).toBe('failed');
  });

  it('keeps the original cause when recording the failure also fails', async () => {
    const failing = {
      balanceTransactions: {
        list: async () => {
          throw new Error('stripe is down');
        },
      },
    } as unknown as Stripe;
    // A database that cannot be reached, so the failure row cannot be written
    // either; the rejection must carry both causes, original first.
    const deadPool = new pg.Pool({
      connectionString: 'postgres://127.0.0.1:1/unreachable',
      connectionTimeoutMillis: 200,
    });
    const deadDb = createDb(deadPool);

    const rejection = await runAndRecordReconciliation(deadDb, failing).then(
      () => null,
      (err: unknown) => err,
    );
    // Both causes ride along, the original first; with the database down the
    // original is the watermark read, which fails before Stripe is reached.
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toHaveLength(2);
    expect((rejection as AggregateError).message).toContain('could not be recorded');
    await deadPool.end();
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
    expect(history.json().reconciliations[0].status).toBe('ok');
    expect(history.json().reconciliations[0].error).toBeNull();
  });

  it('surfaces a failed run in the history after the endpoint 500s', async () => {
    await ctx.close();
    ctx = await makeTestServer({
      stripe: {
        balanceTransactions: {
          list: async () => {
            throw new Error('stripe is down');
          },
        },
      } as unknown as Stripe,
    });
    await truncateAll(ctx.db);
    const cookie = await admin();

    const res = await ctx.app.inject(
      withOrigin({ method: 'POST', url: '/api/admin/reconcile', headers: { cookie } }),
    );
    expect(res.statusCode).toBe(500);

    const history = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/reconciliations',
      headers: { cookie },
    });
    expect(history.json().reconciliations).toHaveLength(1);
    expect(history.json().reconciliations[0].status).toBe('failed');
    expect(history.json().reconciliations[0].error).toContain('stripe is down');
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
