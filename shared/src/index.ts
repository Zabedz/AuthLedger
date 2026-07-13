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
