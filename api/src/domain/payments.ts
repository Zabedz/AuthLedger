import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export type PaymentStatus = 'created' | 'processing' | 'succeeded' | 'failed' | 'canceled';

// The internal event model, free of any provider type. The mapping module turns
// a provider webhook into one of these, so nothing downstream sees the provider
// and the ledger (M7) builds on this model without touching the webhook pipeline.
export type PaymentEventKind = 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface InternalPaymentEvent {
  kind: PaymentEventKind;
  providerIntentId: string;
  // The provider event time, used to order applications.
  at: Date;
}

const STATUS_OF: Record<PaymentEventKind, PaymentStatus> = {
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

// Once a payment reaches one of these it never moves again, so a late or
// out-of-order delivery cannot downgrade a settled payment.
const TERMINAL: ReadonlySet<PaymentStatus> = new Set(['succeeded', 'failed', 'canceled']);

export type ApplyOutcome = 'applied' | 'ignored_stale' | 'ignored_terminal' | 'unknown_intent';

// Applies an internal event to the payment with the given provider intent id.
// Out-of-order safe: an event older than the last applied, or one that would
// move a terminal payment, is a no-op.
export async function applyPaymentEvent(
  db: Kysely<DB>,
  event: InternalPaymentEvent,
): Promise<ApplyOutcome> {
  const payment = await db
    .selectFrom('payments')
    .select(['id', 'status', 'last_event_at'])
    .where('provider_intent_id', '=', event.providerIntentId)
    .executeTakeFirst();
  if (!payment) {
    return 'unknown_intent';
  }
  if (TERMINAL.has(payment.status as PaymentStatus)) {
    return 'ignored_terminal';
  }
  // Strictly older only: provider event times are second-granular, so a
  // same-second forward move (processing then succeeded) must still apply. A
  // same-second event against a terminal row is already stopped above, and
  // 'processing' is the only non-terminal target, so an equal timestamp never
  // reorders two live states.
  if (payment.last_event_at && payment.last_event_at > event.at) {
    return 'ignored_stale';
  }
  await db
    .updateTable('payments')
    .set({ status: STATUS_OF[event.kind], last_event_at: event.at, updated_at: new Date() })
    .where('id', '=', payment.id)
    .execute();
  return 'applied';
}

export interface PaymentView {
  id: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  created_at: string;
}

function toView(row: {
  id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: Date;
}): PaymentView {
  return {
    // amount_minor is a bigint column; Number is exact for a single payment
    // (well under 2^53 minor units). Sum across rows in SQL, never by Number in
    // JS, so the ledger totals in M7 do not lose precision.
    id: row.id,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status as PaymentStatus,
    created_at: row.created_at.toISOString(),
  };
}

export async function listPaymentsForUser(db: Kysely<DB>, userId: string): Promise<PaymentView[]> {
  const rows = await db
    .selectFrom('payments')
    .select(['id', 'amount_minor', 'currency', 'status', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toView);
}

// The view plus the owner id, so the caller can run the ownership policy before
// returning it.
export async function getPayment(
  db: Kysely<DB>,
  id: string,
): Promise<{ ownerId: string; amountMinor: number; view: PaymentView } | undefined> {
  const row = await db
    .selectFrom('payments')
    .select(['id', 'user_id', 'amount_minor', 'currency', 'status', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return { ownerId: row.user_id, amountMinor: Number(row.amount_minor), view: toView(row) };
}
