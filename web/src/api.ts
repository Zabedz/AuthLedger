import type {
  AcceptedReply,
  Credentials,
  ErrorReply,
  SessionList,
  UserEnvelope,
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
  login: (creds: Credentials) => request<UserEnvelope>('/auth/login', jsonBody(creds)),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<UserEnvelope>('/auth/me'),
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
};
