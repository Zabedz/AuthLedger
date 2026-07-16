import type Stripe from 'stripe';
import type { InternalPaymentEvent, PaymentEventKind } from './payments.js';
import type { InternalLedgerEvent } from './ledger.js';
import type { Settlement } from './reconciliation.js';

// The one place provider event and object type names appear. It turns a verified
// Stripe event into an internal event, or null for a type we do not model yet
// (the inbox stores those as unhandled rather than failing). Keeping the Stripe
// vocabulary here is what lets the payment model and the ledger stay provider-free.
const KIND_BY_TYPE: Record<string, PaymentEventKind> = {
  'payment_intent.processing': 'processing',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'canceled',
};

// A payment-status event, applied to the payment row.
export function mapStripeEvent(event: Stripe.Event): InternalPaymentEvent | null {
  const kind = KIND_BY_TYPE[event.type];
  if (!kind) {
    return null;
  }
  const intent = event.data.object as Stripe.PaymentIntent;
  return { kind, providerIntentId: intent.id, at: new Date(event.created * 1000) };
}

// A ledger event (money going back out), posted to the ledger. Separate from the
// payment-status mapping because a refund or dispute does not change the payment
// row, only the books.
export function mapLedgerEvent(event: Stripe.Event): InternalLedgerEvent | null {
  switch (event.type) {
    case 'refund.created': {
      const refund = event.data.object as Stripe.Refund;
      return {
        kind: 'refund',
        reference: refund.id,
        amountMinor: refund.amount,
        currency: refund.currency,
      };
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      return {
        kind: 'dispute',
        reference: dispute.id,
        amountMinor: dispute.amount,
        currency: dispute.currency,
      };
    }
    default:
      return null;
  }
}

// A settled charge from a pulled balance transaction. Only charge/payment types
// are settlements; payouts, transfers, and refunds are skipped, so their fees
// are not posted as charge fees. This is the one place the balance-transaction
// shape (the source charge and its intent) is read.
export function mapBalanceTransaction(txn: Stripe.BalanceTransaction): Settlement | null {
  if (txn.type !== 'charge' && txn.type !== 'payment') {
    return null;
  }
  const source = txn.source as Stripe.Charge | null;
  return {
    balanceTxnId: txn.id,
    intentId: typeof source?.payment_intent === 'string' ? source.payment_intent : null,
    amountMinor: txn.amount,
    feeMinor: txn.fee,
    currency: txn.currency,
    // Set exactly when the provider converted the charge into the account
    // currency (a numeric exchange rate); an unconverted settlement must agree
    // with the ledger on both currency and amount, a converted one can be
    // compared on neither.
    converted: typeof txn.exchange_rate === 'number',
  };
}
