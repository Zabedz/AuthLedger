import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer, truncateAll, type TestContext } from './helpers.js';
import { accountBalance, postCharge, postEntry } from '../src/domain/ledger.js';

let ctx: TestContext;

beforeEach(async () => {
  if (ctx) await ctx.close();
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

describe('double-entry ledger', () => {
  it('posts a balanced entry and reflects it in the account balances', async () => {
    const posted = await postEntry(ctx.db, {
      kind: 'charge',
      reference: 'pi_1',
      currency: 'usd',
      postings: [
        { account: 'stripe_receivable', amountMinor: 1500 },
        { account: 'revenue', amountMinor: -1500 },
      ],
    });
    expect(posted).toBe(true);
    expect(await accountBalance(ctx.db, 'stripe_receivable')).toBe(1500);
    expect(await accountBalance(ctx.db, 'revenue')).toBe(-1500);
  });

  it('refuses an unbalanced entry at the domain boundary', async () => {
    await expect(
      postEntry(ctx.db, {
        kind: 'charge',
        reference: 'pi_bad',
        currency: 'usd',
        postings: [
          { account: 'stripe_receivable', amountMinor: 1500 },
          { account: 'revenue', amountMinor: -1400 },
        ],
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('the database itself rejects an unbalanced insert, not just the app', async () => {
    // Bypass postEntry's guard and write directly, so the DB constraint is what
    // catches the imbalance (the plan's acceptance).
    const entry = await ctx.db
      .insertInto('ledger_entries')
      .values({ kind: 'charge', reference: 'pi_db', currency: 'usd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      ctx.db
        .insertInto('ledger_postings')
        .values([
          { entry_id: entry.id, account: 'stripe_receivable', amount_minor: '1500' },
          { entry_id: entry.id, account: 'revenue', amount_minor: '-1400' },
        ])
        .execute(),
    ).rejects.toThrow(/unbalanced/);
  });

  it('is idempotent on (kind, reference): a redelivered charge posts once', async () => {
    const first = await postCharge(ctx.db, {
      providerIntentId: 'pi_2',
      amountMinor: 1000,
      currency: 'usd',
    });
    const second = await postCharge(ctx.db, {
      providerIntentId: 'pi_2',
      amountMinor: 1000,
      currency: 'usd',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await accountBalance(ctx.db, 'revenue')).toBe(-1000);
  });

  it('corrects a mistake with a reversing entry, not an edit', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_rev', amountMinor: 800, currency: 'usd' });
    const reversed = await postEntry(ctx.db, {
      kind: 'reversal',
      reference: 'pi_rev',
      currency: 'usd',
      postings: [
        { account: 'stripe_receivable', amountMinor: -800 },
        { account: 'revenue', amountMinor: 800 },
      ],
    });
    expect(reversed).toBe(true);
    // The charge and its reversal net to zero, and both rows remain.
    expect(await accountBalance(ctx.db, 'stripe_receivable')).toBe(0);
    expect(await accountBalance(ctx.db, 'revenue')).toBe(0);
  });

  it('is append-only: UPDATE and DELETE on the ledger are refused', async () => {
    await postCharge(ctx.db, { providerIntentId: 'pi_3', amountMinor: 500, currency: 'usd' });
    await expect(
      ctx.db
        .updateTable('ledger_postings')
        .set({ amount_minor: '9' })
        .where('account', '=', 'revenue')
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.db.deleteFrom('ledger_entries').where('reference', '=', 'pi_3').execute(),
    ).rejects.toThrow(/append-only/);
  });
});
