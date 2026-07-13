import { Type, type Static } from '@sinclair/typebox';

export const healthzReplySchema = Type.Object({
  status: Type.Literal('ok'),
  uptime_s: Type.Number(),
});
export type HealthzReply = Static<typeof healthzReplySchema>;

export const readyCheckSchema = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});
export type ReadyCheck = Static<typeof readyCheckSchema>;

export const readyzReplySchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('unavailable')]),
  checks: Type.Array(readyCheckSchema),
});
export type ReadyzReply = Static<typeof readyzReplySchema>;

export const credentialsSchema = Type.Object({
  email: Type.String({ format: 'email', maxLength: 254 }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});
export type Credentials = Static<typeof credentialsSchema>;

export const userSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  email_verified: Type.Boolean(),
  mfa_enabled: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
});
export type UserReply = Static<typeof userSchema>;

export const userEnvelopeSchema = Type.Object({ user: userSchema });
export type UserEnvelope = Static<typeof userEnvelopeSchema>;

// /me carries the caller's permission actions too, so the SPA shows admin UI
// only to accounts that hold the matching permission. The API still enforces.
export const meReplySchema = Type.Object({
  user: userSchema,
  permissions: Type.Array(Type.String()),
});
export type MeReply = Static<typeof meReplySchema>;

export const errorReplySchema = Type.Object({ error: Type.String() });
export type ErrorReply = Static<typeof errorReplySchema>;

// Non-enumerating reply: register, verification resend, and reset requests all
// return this whether or not the address exists.
export const acceptedReplySchema = Type.Object({ status: Type.Literal('accepted') });
export type AcceptedReply = Static<typeof acceptedReplySchema>;

export const emailRequestSchema = Type.Object({
  email: Type.String({ format: 'email', maxLength: 254 }),
});
export type EmailRequest = Static<typeof emailRequestSchema>;

export const tokenSchema = Type.Object({ token: Type.String({ minLength: 1, maxLength: 512 }) });
export type TokenBody = Static<typeof tokenSchema>;

export const resetPasswordSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 512 }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});
export type ResetPasswordBody = Static<typeof resetPasswordSchema>;

// Login returns either a session (with the user) or, when MFA is enabled, a
// signal to collect a second factor. The challenge itself rides in an HttpOnly
// cookie so it is never exposed to the SPA's JavaScript.
export const loginReplySchema = Type.Union([
  userEnvelopeSchema,
  Type.Object({ mfa_required: Type.Literal(true) }),
]);
export type LoginReply = Static<typeof loginReplySchema>;

export const mfaSetupReplySchema = Type.Object({
  secret: Type.String(),
  otpauth_uri: Type.String(),
});
export type MfaSetupReply = Static<typeof mfaSetupReplySchema>;

export const totpCodeSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' }),
});
export type TotpCodeBody = Static<typeof totpCodeSchema>;

// A TOTP (6 digits) or a recovery code; used where either is accepted.
export const mfaCodeSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 40 }),
});
export type MfaCodeBody = Static<typeof mfaCodeSchema>;

export const recoveryCodesSchema = Type.Object({ recovery_codes: Type.Array(Type.String()) });
export type RecoveryCodesReply = Static<typeof recoveryCodesSchema>;

// The social-login providers the server has credentials for, so the SPA renders
// a button only where a real flow exists.
export const oauthProvidersSchema = Type.Object({ providers: Type.Array(Type.String()) });
export type OAuthProvidersReply = Static<typeof oauthProvidersSchema>;

// The assignable roles, mirroring ROLE_NAMES and the roles seeded in migration
// 0006. Used to validate the :role path param on the admin grant/revoke routes.
export const roleNameSchema = Type.Union([Type.Literal('admin'), Type.Literal('auditor')]);
export type RoleNameValue = Static<typeof roleNameSchema>;

export const adminUserSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  email_verified: Type.Boolean(),
  mfa_enabled: Type.Boolean(),
  roles: Type.Array(roleNameSchema),
  created_at: Type.String({ format: 'date-time' }),
});
export const adminUserListSchema = Type.Object({ users: Type.Array(adminUserSchema) });
export type AdminUserList = Static<typeof adminUserListSchema>;

export const auditEventSchema = Type.Object({
  id: Type.String(),
  event: Type.String(),
  user_id: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  at: Type.String({ format: 'date-time' }),
  detail: Type.Unknown(),
});
export const auditListSchema = Type.Object({ events: Type.Array(auditEventSchema) });
export type AuditList = Static<typeof auditListSchema>;

export const userRolesSchema = Type.Object({ roles: Type.Array(roleNameSchema) });
export type UserRolesReply = Static<typeof userRolesSchema>;

export const paymentStatusSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('processing'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('canceled'),
]);

export const paymentSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  amount_minor: Type.Integer(),
  currency: Type.String(),
  status: paymentStatusSchema,
  created_at: Type.String({ format: 'date-time' }),
});
export type Payment = Static<typeof paymentSchema>;

export const paymentListSchema = Type.Object({ payments: Type.Array(paymentSchema) });
export type PaymentList = Static<typeof paymentListSchema>;

// Amounts are integer minor units; the Stripe minimum is 50 (50 cents).
export const createPaymentSchema = Type.Object({
  amount_minor: Type.Integer({ minimum: 50, maximum: 99_999_999 }),
  currency: Type.String({ minLength: 3, maxLength: 3 }),
});
export type CreatePaymentBody = Static<typeof createPaymentSchema>;

// The client secret mounts the Payment Element; it is not stored server-side.
export const paymentIntentReplySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  client_secret: Type.String(),
  status: paymentStatusSchema,
  amount_minor: Type.Integer(),
  currency: Type.String(),
});
export type PaymentIntentReply = Static<typeof paymentIntentReplySchema>;

export const refundBodySchema = Type.Object({
  amount_minor: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type RefundBody = Static<typeof refundBodySchema>;

export const refundReplySchema = Type.Object({
  refunded_minor: Type.Integer(),
  reason: Type.String(),
});
export type RefundReply = Static<typeof refundReplySchema>;

// Public: the SPA reads the publishable key to mount the Payment Element.
export const paymentConfigSchema = Type.Object({
  publishable_key: Type.Union([Type.String(), Type.Null()]),
});
export type PaymentConfig = Static<typeof paymentConfigSchema>;

export const ledgerBalanceSchema = Type.Object({
  account: Type.String(),
  currency: Type.String(),
  balance_minor: Type.Integer(),
});
export const ledgerBalancesSchema = Type.Object({ balances: Type.Array(ledgerBalanceSchema) });
export type LedgerBalances = Static<typeof ledgerBalancesSchema>;

export const discrepancySchema = Type.Object({
  reference: Type.String(),
  amount_minor: Type.Integer(),
  reason: Type.String(),
});

export const reconciliationResultSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  checked: Type.Integer(),
  fees_posted_minor: Type.Integer(),
  discrepancy_count: Type.Integer(),
  discrepancies: Type.Array(discrepancySchema),
});
export type ReconciliationResult = Static<typeof reconciliationResultSchema>;

export const reconciliationSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  ran_at: Type.String({ format: 'date-time' }),
  checked: Type.Integer(),
  fees_posted_minor: Type.Integer(),
  discrepancy_count: Type.Integer(),
});
export const reconciliationListSchema = Type.Object({
  reconciliations: Type.Array(reconciliationSummarySchema),
});
export type ReconciliationList = Static<typeof reconciliationListSchema>;

export const sessionItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  created_at: Type.String(),
  last_seen_at: Type.String(),
  ip: Type.Union([Type.String(), Type.Null()]),
  user_agent: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});
export type SessionItem = Static<typeof sessionItemSchema>;

export const sessionListSchema = Type.Object({ sessions: Type.Array(sessionItemSchema) });
export type SessionList = Static<typeof sessionListSchema>;
