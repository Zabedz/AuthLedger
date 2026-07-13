import { describe, expect, it } from 'vitest';
import {
  canInitiatePayment,
  canRefundPayment,
  canReconcile,
  canViewPayment,
  REFUND_CEILING_MINOR,
  type MoneyActor,
} from '../src/domain/policy.js';
import type { PermissionAction } from '../src/domain/authz.js';

function actor(userId: string, ...capabilities: PermissionAction[]): MoneyActor {
  return { userId, capabilities: new Set(capabilities) };
}

describe('payment view policy', () => {
  it('lets the owner view their own payment', () => {
    const d = canViewPayment(actor('u1'), { ownerId: 'u1', amountMinor: 100 });
    expect(d.allowed).toBe(true);
  });

  it('lets a holder of payments.view_any view any payment', () => {
    const d = canViewPayment(actor('staff', 'payments.view_any'), {
      ownerId: 'u1',
      amountMinor: 100,
    });
    expect(d).toEqual({ allowed: true, reason: 'has payments.view_any' });
  });

  it('denies a stranger without the capability, with a reason', () => {
    const d = canViewPayment(actor('u2'), { ownerId: 'u1', amountMinor: 100 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not the owner/);
  });
});

describe('refund policy', () => {
  it('denies anyone without payments.refund', () => {
    expect(canRefundPayment(actor('u1'), { ownerId: 'u1', amountMinor: 100 }).allowed).toBe(false);
  });

  it('allows a refund at or below the ceiling with payments.refund', () => {
    const d = canRefundPayment(actor('staff', 'payments.refund'), {
      ownerId: 'u1',
      amountMinor: REFUND_CEILING_MINOR,
    });
    expect(d.allowed).toBe(true);
  });

  it('denies a refund over the ceiling without the elevated capability', () => {
    const d = canRefundPayment(actor('staff', 'payments.refund'), {
      ownerId: 'u1',
      amountMinor: REFUND_CEILING_MINOR + 1,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('ceiling');
  });

  it('allows an over-ceiling refund when the elevated capability is present', () => {
    const d = canRefundPayment(actor('lead', 'payments.refund', 'payments.refund_over_ceiling'), {
      ownerId: 'u1',
      amountMinor: REFUND_CEILING_MINOR + 1,
    });
    expect(d.allowed).toBe(true);
  });
});

describe('initiate and reconcile policy', () => {
  it('always allows an account to initiate its own payment', () => {
    expect(canInitiatePayment(actor('u1')).allowed).toBe(true);
  });

  it('gates reconciliation on ledger.reconcile', () => {
    expect(canReconcile(actor('u1')).allowed).toBe(false);
    expect(canReconcile(actor('fin', 'ledger.reconcile')).allowed).toBe(true);
  });
});
