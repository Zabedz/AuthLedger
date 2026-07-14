import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

const tracer = trace.getTracer('authledger-ledger');

export type LedgerAccount = 'stripe_receivable' | 'revenue' | 'fees' | 'refunds' | 'disputes';
export type LedgerEntryKind = 'charge' | 'refund' | 'fee' | 'dispute' | 'reversal';

export interface Posting {
  account: LedgerAccount;
  // Signed integer minor units: a debit is positive, a credit negative. An
  // entry's postings must sum to zero, which the database enforces at commit.
  amountMinor: number;
}

// Posts a balanced journal entry, idempotent on (kind, reference) so a
// redelivered event posts once. Returns false when the entry already existed.
// Call inside a transaction (the webhook does) so the entry and its postings
// commit together and a failure leaves nothing behind; the postings are written
// as one multi-row insert, and the balance invariant is a deferred constraint
// checked at commit.
export async function postEntry(
  db: Kysely<DB>,
  entry: { kind: LedgerEntryKind; reference: string; currency: string; postings: Posting[] },
): Promise<boolean> {
  // Reject before touching the database, so a caller error is a clear domain
  // error and never a half-written entry. The database enforces the same rule.
  const imbalance = entry.postings.reduce((sum, p) => sum + p.amountMinor, 0);
  if (entry.postings.length === 0 || imbalance !== 0) {
    throw new Error(
      `ledger entry ${entry.kind}:${entry.reference} is unbalanced ` +
        `(${entry.postings.length} postings, imbalance ${imbalance})`,
    );
  }

  // A child span of the request that triggered the posting (a webhook or a
  // reconciliation run), so the trace runs from the HTTP request down to the
  // ledger write. The tracer is a no-op when tracing is off.
  return tracer.startActiveSpan('ledger.post_entry', async (span) => {
    span.setAttribute('ledger.kind', entry.kind);
    span.setAttribute('ledger.reference', entry.reference);
    span.setAttribute('ledger.currency', entry.currency);
    span.setAttribute('ledger.posting_count', entry.postings.length);
    try {
      const created = await db
        .insertInto('ledger_entries')
        .values({ kind: entry.kind, reference: entry.reference, currency: entry.currency })
        .onConflict((oc) => oc.columns(['kind', 'reference']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!created) {
        span.setAttribute('ledger.duplicate', true);
        return false;
      }
      await db
        .insertInto('ledger_postings')
        .values(
          entry.postings.map((p) => ({
            entry_id: created.id,
            account: p.account,
            amount_minor: String(p.amountMinor),
          })),
        )
        .execute();
      return true;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

// The signed balance of an account, summed in the database over bigint so a
// large number of rows does not lose precision; only the single result is
// turned into a Number. Sums across currencies, which is fine while the app is
// single-currency; M7b's admin balance views take a currency once a second one
// can post.
export async function accountBalance(db: Kysely<DB>, account: LedgerAccount): Promise<number> {
  const row = await db
    .selectFrom('ledger_postings')
    .select((eb) => eb.fn.sum<string>('amount_minor').as('balance'))
    .where('account', '=', account)
    .executeTakeFirst();
  return Number(row?.balance ?? 0);
}

// A settled charge: the provider owes the gross, recognized as revenue. Fees
// are posted separately from the provider's balance transactions (reconcile).
export async function postCharge(
  db: Kysely<DB>,
  input: { providerIntentId: string; amountMinor: number; currency: string },
): Promise<boolean> {
  return postEntry(db, {
    kind: 'charge',
    reference: input.providerIntentId,
    currency: input.currency,
    postings: [
      { account: 'stripe_receivable', amountMinor: input.amountMinor },
      { account: 'revenue', amountMinor: -input.amountMinor },
    ],
  });
}

export interface LedgerBalance {
  account: LedgerAccount;
  currency: string;
  balance_minor: number;
}

// Balances per account and currency for the admin ledger view. Grouped by
// currency so mixed minor units are never summed together.
export async function ledgerBalances(db: Kysely<DB>): Promise<LedgerBalance[]> {
  const rows = await db
    .selectFrom('ledger_postings')
    .innerJoin('ledger_entries', 'ledger_entries.id', 'ledger_postings.entry_id')
    .select(['ledger_postings.account as account', 'ledger_entries.currency as currency'])
    .select((eb) => eb.fn.sum<string>('ledger_postings.amount_minor').as('balance'))
    .groupBy(['ledger_postings.account', 'ledger_entries.currency'])
    .orderBy('ledger_postings.account')
    .execute();
  return rows.map((r) => ({
    account: r.account as LedgerAccount,
    currency: r.currency,
    balance_minor: Number(r.balance),
  }));
}

// A refund or a dispute sends money back out: it is an expense and it reduces
// what the provider owes. The internal event carries only what the ledger needs,
// so the ledger stays free of provider types.
export interface InternalLedgerEvent {
  kind: 'refund' | 'dispute';
  reference: string;
  amountMinor: number;
  currency: string;
}

const EXPENSE_ACCOUNT: Record<InternalLedgerEvent['kind'], LedgerAccount> = {
  refund: 'refunds',
  dispute: 'disputes',
};

export async function applyLedgerEvent(
  db: Kysely<DB>,
  event: InternalLedgerEvent,
): Promise<boolean> {
  return postEntry(db, {
    kind: event.kind,
    reference: event.reference,
    currency: event.currency,
    postings: [
      { account: EXPENSE_ACCOUNT[event.kind], amountMinor: event.amountMinor },
      { account: 'stripe_receivable', amountMinor: -event.amountMinor },
    ],
  });
}
