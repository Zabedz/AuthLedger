import type { Kysely } from 'kysely';
import type Stripe from 'stripe';
import type { DB } from '../db/types.js';
import { postEntry } from './ledger.js';
import { mapBalanceTransaction } from './stripe-mapping.js';

// A settled charge as the ledger needs it, projected from a provider balance
// transaction by the mapping module so reconcile itself sees no provider types.
export interface Settlement {
  balanceTxnId: string;
  intentId: string | null;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  // True when the provider converted into the account currency, in which case
  // the settled gross is not comparable to the ledger's presentment gross.
  converted: boolean;
}

// A settled amount the provider records that the ledger does not.
export interface Discrepancy {
  reference: string;
  amountMinor: number;
  reason: string;
}

export interface ReconciliationRun {
  checked: number;
  feesPostedMinor: number;
  discrepancies: Discrepancy[];
}

// Reconciles the ledger against settled charges from the provider (its balance
// transactions are the record of settled amounts and fees; the webhook is a
// delivery channel, not the source of truth). Two jobs: post the provider fee
// for each settlement (the webhook does not carry it), idempotent per
// balance-transaction id, and flag any settled charge with no ledger entry.
export async function reconcile(
  db: Kysely<DB>,
  settlements: Settlement[],
): Promise<ReconciliationRun> {
  let feesPostedMinor = 0;
  const discrepancies: Discrepancy[] = [];

  for (const settlement of settlements) {
    if (settlement.feeMinor > 0) {
      const posted = await db.transaction().execute((trx) =>
        postEntry(trx, {
          kind: 'fee',
          reference: settlement.balanceTxnId,
          currency: settlement.currency,
          postings: [
            { account: 'fees', amountMinor: settlement.feeMinor },
            { account: 'stripe_receivable', amountMinor: -settlement.feeMinor },
          ],
        }),
      );
      if (posted) {
        feesPostedMinor += settlement.feeMinor;
      }
    }

    // A settled charge must have a ledger charge, keyed by the payment intent;
    // a charge with no intent (a direct Charges-API charge) is not checked. An
    // unconverted settlement must also agree with the ledger on currency and
    // gross amount. A converted one (a usd charge on a gbp account arrives as
    // gbp) can be compared on neither, since its gross is a different currency
    // from the ledger's presentment gross; exchange-rate verification is
    // deferred (ADR-025).
    if (settlement.intentId) {
      const posting = await db
        .selectFrom('ledger_entries')
        .innerJoin('ledger_postings', 'ledger_postings.entry_id', 'ledger_entries.id')
        .select(['ledger_postings.amount_minor', 'ledger_entries.currency'])
        .where('ledger_entries.kind', '=', 'charge')
        .where('ledger_entries.reference', '=', settlement.intentId)
        .where('ledger_postings.account', '=', 'stripe_receivable')
        .executeTakeFirst();
      if (!posting) {
        discrepancies.push({
          reference: settlement.intentId,
          amountMinor: settlement.amountMinor,
          reason: 'settled charge missing from the ledger',
        });
      } else if (!settlement.converted && posting.currency !== settlement.currency) {
        discrepancies.push({
          reference: settlement.intentId,
          amountMinor: settlement.amountMinor,
          reason: `currency mismatch: ledger ${posting.currency}, provider ${settlement.currency}`,
        });
      } else if (!settlement.converted && Number(posting.amount_minor) !== settlement.amountMinor) {
        discrepancies.push({
          reference: settlement.intentId,
          amountMinor: settlement.amountMinor,
          reason: `amount mismatch: ledger ${posting.amount_minor}, provider ${settlement.amountMinor}`,
        });
      }
    }
  }

  return { checked: settlements.length, feesPostedMinor, discrepancies };
}

// Bounds the recorded failure text: enough to diagnose, never a full provider
// response body.
const ERROR_TEXT_MAX = 500;

async function recordFailedRun(db: Kysely<DB>, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .insertInto('reconciliations')
    .values({
      checked: 0,
      fees_posted_minor: '0',
      discrepancy_count: 0,
      discrepancies: JSON.stringify([]),
      status: 'failed',
      error: message.slice(0, ERROR_TEXT_MAX),
    })
    .execute();
}

// A transaction created while the previous run was in flight can postdate that
// run's page snapshot; overlapping the window by an hour re-reads that edge,
// and fee posting is idempotent, so the overlap costs nothing.
const WATERMARK_OVERLAP_S = 3600;
// A loud bound, far above this project's volume. A window that still has more
// after this many pages fails the run rather than silently under-scanning.
const MAX_PAGES = 10;

// The provider transactions to reconcile: windowed on the newest successful
// run (ADR-025) and paged on has_more. The first run ever scans one unwindowed
// page, which covers the account's whole test history at this volume.
async function listBalanceTransactions(
  db: Kysely<DB>,
  stripe: Stripe,
): Promise<Stripe.BalanceTransaction[]> {
  const lastOk = await db
    .selectFrom('reconciliations')
    .select('ran_at')
    .where('status', '=', 'ok')
    .orderBy('ran_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  const params: Stripe.BalanceTransactionListParams = { limit: 100, expand: ['data.source'] };
  if (lastOk) {
    params.created = {
      gte: Math.floor(lastOk.ran_at.getTime() / 1000) - WATERMARK_OVERLAP_S,
    };
  }

  const txns: Stripe.BalanceTransaction[] = [];
  let page = await stripe.balanceTransactions.list(params);
  txns.push(...page.data);
  // The unwindowed first run stops at one page no matter what: paging a large
  // history into the cap would fail the run, a failed run never sets the
  // watermark, and every retry would repeat the same full scan. One page seeds
  // the watermark; older history is a manual concern, as ADR-025 accepts.
  if (!lastOk) {
    return txns;
  }
  let pages = 1;
  while (page.has_more) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `reconciliation window holds more than ${MAX_PAGES * 100} balance transactions; ` +
          'refusing to under-scan silently',
      );
    }
    page = await stripe.balanceTransactions.list({
      ...params,
      starting_after: page.data[page.data.length - 1]!.id,
    });
    txns.push(...page.data);
    pages += 1;
  }
  return txns;
}

// Fetches the provider's balance transactions, projects them to settlements, and
// reconciles, then records the outcome so the admin view and the logs have the
// history and a scheduled run leaves a trail. Both the admin route and the
// scheduled job call this. A failed run is recorded too, then rethrown: silence
// in the run history must mean "did not run", never "ran and broke".
export async function runAndRecordReconciliation(
  db: Kysely<DB>,
  stripe: Stripe,
): Promise<ReconciliationRun & { id: string }> {
  try {
    const txns = await listBalanceTransactions(db, stripe);
    const settlements = txns.map(mapBalanceTransaction).filter((s): s is Settlement => s !== null);
    const result = await reconcile(db, settlements);

    // The success insert sits inside the try on purpose: if it fails after
    // reconcile committed its fee entries, the run flows through the failure
    // recording below instead of leaving silence in the history.
    const row = await db
      .insertInto('reconciliations')
      .values({
        checked: result.checked,
        fees_posted_minor: String(result.feesPostedMinor),
        discrepancy_count: result.discrepancies.length,
        discrepancies: JSON.stringify(result.discrepancies),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ...result, id: row.id };
  } catch (err) {
    await recordFailedRun(db, err).catch((recordErr: unknown) => {
      // Keep the original cause; losing it to the recording failure would hide
      // what actually broke.
      throw new AggregateError(
        [err, recordErr],
        'reconciliation failed and the failure row could not be recorded',
      );
    });
    throw err;
  }
}
