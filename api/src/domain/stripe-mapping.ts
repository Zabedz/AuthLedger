import type Stripe from 'stripe';
import type { InternalPaymentEvent, PaymentEventKind } from './payments.js';

// The one place provider event and object type names appear. It turns a verified
// Stripe event into the internal event model, or null for a type we do not model
// yet (the inbox stores those as unhandled rather than failing). Keeping the
// Stripe vocabulary here is what lets the ledger build on the internal model.
const KIND_BY_TYPE: Record<string, PaymentEventKind> = {
  'payment_intent.processing': 'processing',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'canceled',
};

export function mapStripeEvent(event: Stripe.Event): InternalPaymentEvent | null {
  const kind = KIND_BY_TYPE[event.type];
  if (!kind) {
    return null;
  }
  const intent = event.data.object as Stripe.PaymentIntent;
  return { kind, providerIntentId: intent.id, at: new Date(event.created * 1000) };
}
