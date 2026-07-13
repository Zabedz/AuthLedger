import type {
  AcceptedReply,
  AdminUserList,
  AuditList,
  Credentials,
  ErrorReply,
  LoginReply,
  MeReply,
  MfaSetupReply,
  OAuthProvidersReply,
  PaymentConfig,
  PaymentIntentReply,
  PaymentList,
  RecoveryCodesReply,
  RoleNameValue,
  SessionList,
  UserEnvelope,
  UserRolesReply,
} from '@authledger/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // A JSON content-type on a body-less POST/DELETE makes Fastify reject the
    // empty body; only send it when there is a body.
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as ErrorReply;
    throw new ApiError(res.status, body.error);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const jsonBody = (value: object): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

export const api = {
  register: (creds: Credentials) => request<AcceptedReply>('/auth/register', jsonBody(creds)),
  login: (creds: Credentials) => request<LoginReply>('/auth/login', jsonBody(creds)),
  // The challenge rides in an HttpOnly cookie set by /login; only the code goes up.
  loginMfa: (code: string) => request<UserEnvelope>('/auth/login/mfa', jsonBody({ code })),
  oauthProviders: () => request<OAuthProvidersReply>('/auth/oauth/providers'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<MeReply>('/auth/me'),
  sessions: () => request<SessionList>('/auth/sessions'),
  revokeSession: (id: string) => request<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  deleteAccount: () => request<void>('/auth/account', { method: 'DELETE' }),
  verifyEmail: (token: string) => request<AcceptedReply>('/auth/verify-email', jsonBody({ token })),
  resendVerification: (email: string) =>
    request<AcceptedReply>('/auth/verify-email/resend', jsonBody({ email })),
  requestPasswordReset: (email: string) =>
    request<AcceptedReply>('/auth/password-reset/request', jsonBody({ email })),
  resetPassword: (token: string, password: string) =>
    request<AcceptedReply>('/auth/password-reset', jsonBody({ token, password })),
  mfaSetup: () => request<MfaSetupReply>('/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: (code: string) => request<RecoveryCodesReply>('/auth/mfa/enable', jsonBody({ code })),
  mfaDisable: (code: string) => request<void>('/auth/mfa/disable', jsonBody({ code })),
  adminUsers: () => request<AdminUserList>('/admin/users'),
  adminAudit: () => request<AuditList>('/admin/audit'),
  grantRole: (userId: string, role: RoleNameValue) =>
    request<UserRolesReply>(`/admin/users/${userId}/roles/${role}`, { method: 'PUT' }),
  revokeRole: (userId: string, role: RoleNameValue) =>
    request<UserRolesReply>(`/admin/users/${userId}/roles/${role}`, { method: 'DELETE' }),
  paymentConfig: () => request<PaymentConfig>('/payments/config'),
  payments: () => request<PaymentList>('/payments'),
  createPayment: (amount_minor: number, currency: string, idempotencyKey: string) =>
    request<PaymentIntentReply>('/payments', {
      method: 'POST',
      body: JSON.stringify({ amount_minor, currency }),
      headers: { 'idempotency-key': idempotencyKey },
    }),
};
