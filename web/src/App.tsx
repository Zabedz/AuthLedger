import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Credentials, RoleNameValue } from '@authledger/shared';
import { ApiError, api } from './api.js';

// Load Stripe.js once (the app serves a single publishable key).
let stripePromise: Promise<StripeJs | null> | null = null;
function getStripe(publishableKey: string): Promise<StripeJs | null> {
  stripePromise ??= loadStripe(publishableKey);
  return stripePromise;
}

const ASSIGNABLE_ROLES: RoleNameValue[] = ['admin', 'auditor', 'finance'];

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const page = { fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '32rem' };

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

// The OAuth callback bounces back to /?oauth_error=1 when the provider round-trip
// fails, so the sign-in screen can say so.
function oauthFailed(): boolean {
  return new URLSearchParams(window.location.search).get('oauth_error') === '1';
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

function MfaChallenge({ onRestart, onSuccess }: { onRestart: () => void; onSuccess?: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: () => api.loginMfa(code),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      onSuccess?.();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <h2>Two-factor code</h2>
      <label>
        Authenticator code or recovery code
        <input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
      </label>
      <button type="submit" disabled={verify.isPending}>
        Verify
      </button>
      {/* A challenge is single-use, so a wrong code needs a fresh login. */}
      {verify.error instanceof ApiError && (
        <p role="alert">
          {verify.error.message}{' '}
          <button type="button" onClick={onRestart}>
            Start over
          </button>
        </p>
      )}
    </form>
  );
}

const providerLabels: Record<string, string> = { google: 'Google', github: 'GitHub' };

// A full-page link per configured provider: OAuth needs a real browser redirect,
// not a fetch. Nothing renders until the server says which providers are wired up.
function OAuthButtons() {
  const providers = useQuery({ queryKey: ['oauth-providers'], queryFn: api.oauthProviders });
  if (!providers.data?.providers.length) return null;
  return (
    <nav aria-label="Social login">
      {providers.data.providers.map((p) => (
        <a key={p} href={`/api/auth/oauth/${p}/start`}>
          Continue with {providerLabels[p] ?? p}
        </a>
      ))}
    </nav>
  );
}

function AuthForm() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [form, setForm] = useState<Credentials>({ email: '', password: '' });

  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (reply) => {
      if (!('mfa_required' in reply)) {
        void qc.invalidateQueries({ queryKey: ['me'] });
      }
    },
  });
  const register = useMutation({ mutationFn: api.register });
  const forgot = useMutation({ mutationFn: (email: string) => api.requestPasswordReset(email) });

  // Password verified but a second factor is needed.
  if (login.data && 'mfa_required' in login.data) {
    return <MfaChallenge onRestart={() => login.reset()} />;
  }

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
      {mode === 'login' && oauthFailed() && (
        <p role="alert">That social login did not complete. Try again.</p>
      )}
      {mode === 'login' && <OAuthButtons />}
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

function MfaSettings({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const invalidateMe = () => qc.invalidateQueries({ queryKey: ['me'] });
  const [code, setCode] = useState('');
  const setup = useMutation({ mutationFn: api.mfaSetup });
  const enable = useMutation({ mutationFn: () => api.mfaEnable(code), onSuccess: invalidateMe });
  const disable = useMutation({ mutationFn: () => api.mfaDisable(code), onSuccess: invalidateMe });

  // Recovery codes win over the enabled state: enabling flips mfa_enabled, but
  // the codes are shown once and must not be replaced by the disable form.
  if (enable.isSuccess) {
    return (
      <div>
        <p role="status">Two-factor authentication is on. Save these recovery codes:</p>
        <ul>
          {enable.data.recovery_codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (enabled) {
    return (
      <div>
        <p role="status">Two-factor authentication is on.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <label>
            Current code to disable
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <button type="submit">Disable</button>
          {disable.error instanceof ApiError && <p role="alert">{disable.error.message}</p>}
        </form>
      </div>
    );
  }

  if (setup.data) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          enable.mutate();
        }}
      >
        <p>
          Add this secret to your authenticator, then enter a code to confirm.
          <br />
          <code>{setup.data.secret}</code>
        </p>
        <label>
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} required />
        </label>
        <button type="submit">Enable</button>
        {enable.error instanceof ApiError && <p role="alert">{enable.error.message}</p>}
      </form>
    );
  }

  return (
    <button type="button" onClick={() => setup.mutate()}>
      Set up two-factor authentication
    </button>
  );
}

// Role management for accounts holding users.read. Grant/revoke buttons appear
// only with roles.assign; the API enforces either way, so this is UI gating.
function AdminPanel({ canAssign }: { canAssign: boolean }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: api.adminUsers });
  const onSettled = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const grant = useMutation({
    mutationFn: (v: { userId: string; role: RoleNameValue }) => api.grantRole(v.userId, v.role),
    onSuccess: onSettled,
  });
  const revoke = useMutation({
    mutationFn: (v: { userId: string; role: RoleNameValue }) => api.revokeRole(v.userId, v.role),
    onSuccess: onSettled,
  });
  const error = grant.error ?? revoke.error;

  if (users.isLoading) return <p>Loading users...</p>;

  return (
    <div>
      {error instanceof ApiError && <p role="alert">{error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Roles</th>
            {canAssign && <th>Manage</th>}
          </tr>
        </thead>
        <tbody>
          {users.data?.users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.roles.join(', ') || '-'}</td>
              {canAssign && (
                <td>
                  {ASSIGNABLE_ROLES.map((role) => {
                    const has = u.roles.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        onClick={() => (has ? revoke : grant).mutate({ userId: u.id, role })}
                      >
                        {has ? `Revoke ${role}` : `Grant ${role}`}
                      </button>
                    );
                  })}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The card step: mount once the intent exists (Elements needs its client
// secret). confirmPayment with redirect: 'if_required' settles a card inline;
// the webhook then moves the payment to succeeded.
function PayForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setPaying(true);
        setError(null);
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.origin },
          redirect: 'if_required',
        });
        if (result.error) {
          setError(result.error.message ?? 'Payment failed');
          setPaying(false);
        } else {
          onPaid();
        }
      }}
    >
      <PaymentElement />
      <button type="submit" disabled={!stripe || paying}>
        Pay
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Payments() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['payment-config'], queryFn: api.paymentConfig });
  const list = useQuery({ queryKey: ['payments'], queryFn: api.payments });
  const [dollars, setDollars] = useState('10.00');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // One key per attempt: reused across resubmits (so a retry is one charge) and
  // rotated when the amount changes or a payment finishes.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () => api.createPayment(Math.round(Number(dollars) * 100), 'usd', idempotencyKey),
    onSuccess: (reply) => setClientSecret(reply.client_secret),
  });

  const publishableKey = config.data?.publishable_key;
  if (config.isLoading) return <p>Loading...</p>;
  if (!publishableKey) return <p role="status">Payments are not configured.</p>;

  const freshAttempt = () => {
    setClientSecret(null);
    setIdempotencyKey(crypto.randomUUID());
  };
  const onPaid = () => {
    freshAttempt();
    void qc.invalidateQueries({ queryKey: ['payments'] });
  };

  return (
    <div>
      {clientSecret ? (
        <Elements stripe={getStripe(publishableKey)} options={{ clientSecret }}>
          <PayForm onPaid={onPaid} />
          <button type="button" onClick={freshAttempt}>
            Cancel
          </button>
        </Elements>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Amount (USD)
            <input
              type="number"
              min="0.50"
              step="0.01"
              required
              value={dollars}
              onChange={(e) => {
                setDollars(e.target.value);
                setIdempotencyKey(crypto.randomUUID());
              }}
            />
          </label>
          <button type="submit" disabled={create.isPending}>
            Continue to payment
          </button>
          {create.error instanceof ApiError && <p role="alert">{create.error.message}</p>}
        </form>
      )}
      <h3>Your payments</h3>
      {list.data?.payments.length === 0 && <p>No payments yet.</p>}
      <ul>
        {list.data?.payments.map((p) => (
          <li key={p.id}>
            {(p.amount_minor / 100).toFixed(2)} {p.currency.toUpperCase()} - {p.status}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dashboard({
  email,
  verified,
  mfaEnabled,
  permissions,
}: {
  email: string;
  verified: boolean;
  mfaEnabled: boolean;
  permissions: string[];
}) {
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
      <h2>Payments</h2>
      <Payments />
      <h2>Two-factor authentication</h2>
      <MfaSettings enabled={mfaEnabled} />
      {permissions.includes('users.read') && (
        <>
          <h2>Administration</h2>
          <AdminPanel canAssign={permissions.includes('roles.assign')} />
        </>
      )}
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

// Email verification runs on load: the link itself is the confirmation.
// Modeled as a query keyed by the token so React Query dedupes it to a single
// request and caches the result across strict-mode's remount; a plain effect
// would fire twice and the second call would hit a spent token.
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
    <Dashboard
      email={session.data.user.email}
      verified={session.data.user.email_verified}
      mfaEnabled={session.data.user.mfa_enabled}
      permissions={session.data.permissions}
    />
  ) : (
    <AuthForm />
  );
}

// After OAuth on an MFA account, the callback lands here with a challenge cookie
// set. Verifying mints the session, so a full navigation to / shows the dashboard.
function MfaRoute() {
  return (
    <section>
      <MfaChallenge
        onRestart={() => window.location.assign('/')}
        onSuccess={() => window.location.assign('/')}
      />
    </section>
  );
}

function Router() {
  const path = window.location.pathname;
  if (path === '/verify-email') return <VerifyEmail />;
  if (path === '/reset-password') return <ResetPassword />;
  if (path === '/mfa') return <MfaRoute />;
  return <Shell />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main style={page}>
        <h1>AuthLedger</h1>
        <Router />
      </main>
    </QueryClientProvider>
  );
}
