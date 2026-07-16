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

    // A settled charge must have a ledger charge, keyed by the payment intent.
    // A charge with no intent (a direct Charges-API charge) is not checked.
    if (settlement.intentId) {
      const entry = await db
        .selectFrom('ledger_entries')
        .select('id')
        .where('kind', '=', 'charge')
        .where('reference', '=', settlement.intentId)
        .executeTakeFirst();
      if (!entry) {
        discrepancies.push({
          reference: settlement.intentId,
          amountMinor: settlement.amountMinor,
          reason: 'settled charge missing from the ledger',
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

// Fetches the provider's balance transactions, projects them to settlements, and
// reconciles, then records the outcome so the admin view and the logs have the
// history and a scheduled run leaves a trail. Both the admin route and the
// scheduled job call this. A failed run is recorded too, then rethrown: silence
// in the run history must mean "did not run", never "ran and broke". A single
// page is enough for this project's volume; a higher-volume job would page on
// has_more and window on the last run's time.
export async function runAndRecordReconciliation(
  db: Kysely<DB>,
  stripe: Stripe,
): Promise<ReconciliationRun & { id: string }> {
  try {
    const page = await stripe.balanceTransactions.list({ limit: 100, expand: ['data.source'] });
    const settlements = page.data
      .map(mapBalanceTransaction)
      .filter((s): s is Settlement => s !== null);
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
