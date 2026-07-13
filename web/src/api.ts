import type { Credentials, ErrorReply, SessionList, UserEnvelope } from '@authledger/shared';

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

export const api = {
  register: (body: Credentials) =>
    request<UserEnvelope>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: Credentials) =>
    request<UserEnvelope>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<UserEnvelope>('/auth/me'),
  sessions: () => request<SessionList>('/auth/sessions'),
  revokeSession: (id: string) => request<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
};
