import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import type { Credentials, UserEnvelope } from '@authledger/shared';
import { ApiError, api } from './api.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function useSession() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

function AuthForm() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState<Credentials>({ email: '', password: '' });

  const submit = useMutation({
    mutationFn: async (body: Credentials): Promise<UserEnvelope> => {
      // Register creates the account, then logs in with the same credentials
      // so the flow ends signed in.
      if (mode === 'register') {
        await api.register(body);
      }
      return api.login(body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate(form);
      }}
    >
      <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
      <label>
        Email
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
          minLength={8}
        />
      </label>
      <button type="submit" disabled={submit.isPending}>
        {mode === 'login' ? 'Sign in' : 'Register'}
      </button>
      {submit.error instanceof ApiError && <p role="alert">{submit.error.message}</p>}
      <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account?' : 'Have an account?'}
      </button>
    </form>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  const revoke = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });

  if (sessions.isLoading) return <p>Loading sessions...</p>;

  return (
    <ul>
      {sessions.data?.sessions.map((s) => (
        <li key={s.id}>
          {new Date(s.created_at).toLocaleString()} from {s.ip ?? 'unknown'}
          {s.current ? ' (this device)' : null}
          {!s.current && (
            <button type="button" onClick={() => revoke.mutate(s.id)}>
              Revoke
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Dashboard({ email }: { email: string }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <section>
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      <button type="button" onClick={() => logout.mutate()}>
        Sign out
      </button>
      <h2>Active sessions</h2>
      <Sessions />
    </section>
  );
}

function Shell() {
  const session = useSession();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '32rem' }}>
      <h1>authledger</h1>
      {session.isLoading ? (
        <p>Loading...</p>
      ) : session.data ? (
        <Dashboard email={session.data.user.email} />
      ) : (
        <AuthForm />
      )}
    </main>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
