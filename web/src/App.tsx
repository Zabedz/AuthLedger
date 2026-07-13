import { useEffect, useState } from 'react';
import type { HealthzReply, ReadyzReply } from '@authledger/shared';

type ApiState<T> =
  { phase: 'loading' } | { phase: 'ok'; data: T } | { phase: 'error'; message: string };

function useApi<T>(path: string): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(path)
      .then(async (res) => {
        const data = (await res.json()) as T;
        if (!cancelled) setState({ phase: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ phase: 'error', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return state;
}

export function App() {
  const health = useApi<HealthzReply>('/api/healthz');
  const ready = useApi<ReadyzReply>('/api/readyz');

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '40rem' }}>
      <h1>authledger</h1>
      <p>
        Identity and payments: hand-built auth/authz and a Stripe-integrated double-entry ledger.
        This page is the walking-skeleton placeholder; it reports API health through the same-origin{' '}
        <code>/api</code> proxy.
      </p>
      <h2>API status</h2>
      <dl>
        <dt>healthz</dt>
        <dd>
          {health.phase === 'ok'
            ? `${health.data.status} (up ${health.data.uptime_s}s)`
            : health.phase}
        </dd>
        <dt>readyz</dt>
        <dd>
          {ready.phase === 'ok'
            ? ready.data.checks
                .map((c) => `${c.name}: ${c.ok ? 'ok' : (c.detail ?? 'failed')}`)
                .join(', ')
            : ready.phase}
        </dd>
      </dl>
    </main>
  );
}
