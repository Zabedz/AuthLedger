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

// Inserts the payment row for a freshly created intent, or returns the existing
// one when the idempotency key was already used (a retry), so one key is one
// row. The Stripe intent is deduped in parallel by passing the same key as
// Stripe's idempotency key, so a retry is one charge on both sides.
export async function recordCreatedPayment(
  db: Kysely<DB>,
  input: {
    userId: string;
    idempotencyKey: string;
    providerIntentId: string;
    amountMinor: number;
    currency: string;
  },
): Promise<{ id: string; status: PaymentStatus; created: boolean }> {
  const inserted = await db
    .insertInto('payments')
    .values({
      user_id: input.userId,
      idempotency_key: input.idempotencyKey,
      provider_intent_id: input.providerIntentId,
      amount_minor: String(input.amountMinor),
      currency: input.currency,
      status: 'created',
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning(['id', 'status'])
    .executeTakeFirst();
  if (inserted) {
    return { id: inserted.id, status: inserted.status as PaymentStatus, created: true };
  }
  // The key was already used (a retry): return the existing row unchanged.
  const row = await db
    .selectFrom('payments')
    .select(['id', 'status'])
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirstOrThrow();
  return { id: row.id, status: row.status as PaymentStatus, created: false };
}

// The cumulative amount already refunded on a payment. The refund ceiling is
// checked against this running total, so partial refunds cannot add up past it.
export async function refundedTotal(db: Kysely<DB>, paymentId: string): Promise<number> {
  const row = await db
    .selectFrom('refunds')
    .select((eb) => eb.fn.sum<string>('amount_minor').as('total'))
    .where('payment_id', '=', paymentId)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

export async function findRefundByKey(
  db: Kysely<DB>,
  idempotencyKey: string,
): Promise<{ amountMinor: number } | undefined> {
  const row = await db
    .selectFrom('refunds')
    .select('amount_minor')
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row ? { amountMinor: Number(row.amount_minor) } : undefined;
}

export async function recordRefund(
  db: Kysely<DB>,
  input: {
    paymentId: string;
    idempotencyKey: string;
    amountMinor: number;
    providerRefundId: string;
    createdBy: string;
  },
): Promise<void> {
  await db
    .insertInto('refunds')
    .values({
      payment_id: input.paymentId,
      idempotency_key: input.idempotencyKey,
      amount_minor: String(input.amountMinor),
      provider_refund_id: input.providerRefundId,
      created_by: input.createdBy,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .execute();
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

// The view plus the owner id and provider intent id, so the caller can run the
// ownership policy and, for a refund, reach the intent at the provider.
export async function getPayment(
  db: Kysely<DB>,
  id: string,
): Promise<
  | { ownerId: string; amountMinor: number; providerIntentId: string | null; view: PaymentView }
  | undefined
> {
  const row = await db
    .selectFrom('payments')
    .select([
      'id',
      'user_id',
      'provider_intent_id',
      'amount_minor',
      'currency',
      'status',
      'created_at',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return {
    ownerId: row.user_id,
    amountMinor: Number(row.amount_minor),
    providerIntentId: row.provider_intent_id,
    view: toView(row),
  };
}
