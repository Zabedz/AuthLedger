import type Stripe from 'stripe';
import type { InternalPaymentEvent, PaymentEventKind } from './payments.js';
import type { InternalLedgerEvent } from './ledger.js';

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
