// Fine-grained authorization for money operations: the rules a single RBAC
// permission cannot express on its own, namely resource ownership and amount
// ceilings. These are pure functions returning a decision plus a reason, so the
// money endpoints in M6/M7 call them and record the reason on the audit entry
// for both allow and deny. Capabilities are resolved from the RBAC permission
// set by the caller, which keeps these functions database-free and unit-testable.

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

const allow = (reason: string): PolicyDecision => ({ allowed: true, reason });
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });

export type MoneyCapability =
  'payments.view_any' | 'payments.refund' | 'payments.refund_over_ceiling' | 'ledger.reconcile';

export interface MoneyActor {
  userId: string;
  capabilities: ReadonlySet<MoneyCapability>;
}

// A payment as the policy needs to see it: who owns it and how much it moves, in
// integer minor units, never floats.
export interface PaymentResource {
  ownerId: string;
  amountMinor: number;
}

// A refund at or below this moves on the operator's own authority; above it a
// second capability is required, so a large refund cannot ride a routine grant.
export const REFUND_CEILING_MINOR = 50_000;

// Initiating a payment has no rule beyond being a signed-in account acting for
// itself; the decision point exists so M6 records the same audit reason as the
// gated actions.
export function canInitiatePayment(actor: MoneyActor): PolicyDecision {
  return allow(`account ${actor.userId} initiates its own payment`);
}

export function canViewPayment(actor: MoneyActor, payment: PaymentResource): PolicyDecision {
  if (actor.userId === payment.ownerId) {
    return allow('owner views own payment');
  }
  if (actor.capabilities.has('payments.view_any')) {
    return allow('has payments.view_any');
  }
  return deny('not the owner and lacks payments.view_any');
}

export function canRefundPayment(actor: MoneyActor, payment: PaymentResource): PolicyDecision {
  if (!actor.capabilities.has('payments.refund')) {
    return deny('lacks payments.refund');
  }
  if (
    payment.amountMinor > REFUND_CEILING_MINOR &&
    !actor.capabilities.has('payments.refund_over_ceiling')
  ) {
    return deny(
      `amount ${payment.amountMinor} exceeds the ${REFUND_CEILING_MINOR} refund ceiling without payments.refund_over_ceiling`,
    );
  }
  return allow('has payments.refund within authority');
}

export function canReconcile(actor: MoneyActor): PolicyDecision {
  return actor.capabilities.has('ledger.reconcile')
    ? allow('has ledger.reconcile')
    : deny('lacks ledger.reconcile');
}
