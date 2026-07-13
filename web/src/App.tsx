import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import type { Credentials } from '@authledger/shared';
import { ApiError, api } from './api.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const page = { fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '32rem' };

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

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
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [form, setForm] = useState<Credentials>({ email: '', password: '' });

  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const register = useMutation({ mutationFn: api.register });
  const forgot = useMutation({ mutationFn: (email: string) => api.requestPasswordReset(email) });

  if (register.isSuccess) {
    return (
      <section>
        <h2>Check your email</h2>
        <p>If that address is new, a verification link is on its way.</p>
      </section>
    );
  }
  if (forgot.isSuccess) {
    return (
      <section>
        <h2>Check your email</h2>
        <p>If an account exists for that address, a reset link is on its way.</p>
      </section>
    );
  }

  const error = login.error ?? register.error ?? forgot.error;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === 'login') login.mutate(form);
        else if (mode === 'register') register.mutate(form);
        else forgot.mutate(form.email);
      }}
    >
      <h2>
        {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Reset password'}
      </h2>
      <label>
        Email
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
      </label>
      {mode !== 'forgot' && (
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
      )}
      <button type="submit">
        {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Register' : 'Send reset link'}
      </button>
      {error instanceof ApiError && <p role="alert">{error.message}</p>}
      <nav>
        <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Need an account?' : 'Have an account?'}
        </button>
        {mode === 'login' && (
          <button type="button" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        )}
      </nav>
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

function Dashboard({ email, verified }: { email: string; verified: boolean }) {
  const qc = useQueryClient();
  const invalidateMe = () => qc.invalidateQueries({ queryKey: ['me'] });
  const logout = useMutation({ mutationFn: api.logout, onSuccess: invalidateMe });
  const resend = useMutation({ mutationFn: () => api.resendVerification(email) });
  const remove = useMutation({ mutationFn: api.deleteAccount, onSuccess: invalidateMe });

  return (
    <section>
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      {!verified && (
        <p role="status">
          Your email is not verified.{' '}
          <button type="button" onClick={() => resend.mutate()} disabled={resend.isSuccess}>
            {resend.isSuccess ? 'Verification sent' : 'Resend verification'}
          </button>
        </p>
      )}
      <button type="button" onClick={() => logout.mutate()}>
        Sign out
      </button>
      <h2>Active sessions</h2>
      <Sessions />
      <h2>Danger zone</h2>
      <button
        type="button"
        onClick={() => {
          if (window.confirm('Delete your account and all data?')) remove.mutate();
        }}
      >
        Delete account
      </button>
    </section>
  );
}

// Email verification runs on load: the link itself is the confirmation, no
// extra click. Modeled as a query keyed by the token so React Query dedupes it
// to a single request and caches the result across strict-mode's remount; a
// plain effect would fire twice and the second call would hit a spent token.
function VerifyEmail() {
  const token = tokenFromUrl();
  const verify = useQuery({
    queryKey: ['verify-email', token],
    queryFn: () => api.verifyEmail(token),
    enabled: token !== '',
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return (
    <section>
      <h2>Verify email</h2>
      {!token && <p role="alert">This link is missing its token.</p>}
      {verify.isLoading && <p role="status">Verifying...</p>}
      {verify.isSuccess && <p role="status">Done. You can sign in now.</p>}
      {verify.error instanceof ApiError && <p role="alert">{verify.error.message}</p>}
    </section>
  );
}

// Password reset needs the new password, so it stays a form.
function ResetPassword() {
  const token = tokenFromUrl();
  const [password, setPassword] = useState('');
  const reset = useMutation({ mutationFn: () => api.resetPassword(token, password) });

  return (
    <section>
      <h2>Reset password</h2>
      {!token && <p role="alert">This link is missing its token.</p>}
      {reset.isSuccess ? (
        <p role="status">Done. You can sign in now.</p>
      ) : (
        token && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reset.mutate();
            }}
          >
            <label>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>
            <button type="submit" disabled={reset.isPending}>
              Reset password
            </button>
            {reset.error instanceof ApiError && <p role="alert">{reset.error.message}</p>}
          </form>
        )
      )}
    </section>
  );
}

function Shell() {
  const session = useSession();
  if (session.isLoading) return <p>Loading...</p>;
  return session.data ? (
    <Dashboard email={session.data.user.email} verified={session.data.user.email_verified} />
  ) : (
    <AuthForm />
  );
}

function Router() {
  const path = window.location.pathname;
  if (path === '/verify-email') return <VerifyEmail />;
  if (path === '/reset-password') return <ResetPassword />;
  return <Shell />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main style={page}>
        <h1>authledger</h1>
        <Router />
      </main>
    </QueryClientProvider>
  );
}
