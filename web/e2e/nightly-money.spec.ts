import { expect, test, type Page } from '@playwright/test';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { Client } from 'pg';

// The full happy path in one journey: register, verify, enroll and pass MFA,
// pay, settle through a real Stripe webhook, refund, reconcile. It needs a
// Stripe test key and a webhook forwarder (stripe listen) pointed at the API,
// so it runs in the nightly workflow and self-skips in the plain CI e2e job.
// Card entry stays out of the browser on purpose: Stripe Radar serves a captcha
// to automated browsers, so the intent is confirmed server-side with a test
// payment method, which is the documented test-mode path.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://authledger:authledger@localhost:5432/authledger_e2e';
const PASSWORD = 'a-strong-e2e-password';

const crypto = new NobleCryptoPlugin();
const base32 = new ScureBase32Plugin();

async function totp(secret: string): Promise<string> {
  return new TOTP({ secret, issuer: 'AuthLedger', crypto, base32 }).generate();
}

async function waitForVerifyLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const { messages } = (await (await fetch(`${MAILPIT_API}/api/v1/messages`)).json()) as {
      messages: { ID: string; To: { Address: string }[]; Subject: string }[];
    };
    const match = messages.find(
      (m) => m.To.some((t) => t.Address === email) && /verify/i.test(m.Subject),
    );
    if (match) {
      const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${match.ID}`)).json()) as {
        Text: string;
      };
      const url = new URL(full.Text.match(/https?:\/\/[^\s]+/)![0]);
      return url.pathname + url.search;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verify email for ${email}`);
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function grantAdmin(email: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'admin'
       ON CONFLICT DO NOTHING`,
      [email],
    ),
  );
}

// The postings of one ledger entry, keyed by account, or null while the entry
// has not landed. Scoped to this run's own references: 'stripe listen' fans out
// every event on the shared test account, so a global balance can move under a
// concurrent run, but (kind, reference) is unique and ours alone.
async function entryPostings(
  kind: string,
  reference: string,
): Promise<Record<string, number> | null> {
  return withDb(async (client) => {
    const res = await client.query<{ account: string; amount_minor: string }>(
      `SELECT p.account, p.amount_minor
       FROM ledger_entries e JOIN ledger_postings p ON p.entry_id = e.id
       WHERE e.kind = $1 AND e.reference = $2`,
      [kind, reference],
    );
    if (res.rows.length === 0) return null;
    return Object.fromEntries(res.rows.map((r) => [r.account, Number(r.amount_minor)]));
  });
}

async function refundReference(paymentId: string): Promise<string> {
  return withDb(async (client) => {
    const res = await client.query<{ provider_refund_id: string }>(
      `SELECT r.provider_refund_id FROM refunds r WHERE r.payment_id = $1`,
      [paymentId],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0]!.provider_refund_id;
  });
}

// Same-origin fetch from inside the page, so the session cookie and the Origin
// header are the browser's own.
async function apiFetch(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, path, body, headers }) => {
      const res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body, headers },
  );
}

// Confirms the intent from the test process with Stripe's test payment method;
// settlement then arrives at the API as a signed webhook through the forwarder.
async function confirmIntent(providerIntentId: string): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${providerIntentId}/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'payment_method=pm_card_visa',
  });
  if (!res.ok) {
    throw new Error(`stripe confirm failed: ${res.status} ${await res.text()}`);
  }
}

test.skip(!STRIPE_KEY, 'needs STRIPE_SECRET_KEY (and a webhook forwarder); nightly only');

test('nightly: register, verify, MFA, pay, settle, refund, reconcile', async ({ page }) => {
  test.setTimeout(240_000);
  const email = `nightly-${process.hrtime.bigint()}@example.com`;

  // Register and verify through the real email flow.
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.goto(await waitForVerifyLink(email));
  await expect(page.getByText('You can sign in now')).toBeVisible();

  // Sign in, enroll TOTP, sign out, and back in through the second factor.
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await page.locator('code').first().innerText()).trim();
  await page.getByLabel('Code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByText('Save these recovery codes')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor code' })).toBeVisible();
  await page.getByLabel('Authenticator code or recovery code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  // Refund and reconcile are admin actions.
  await grantAdmin(email);

  // Pay: create the intent through the API as the signed-in user, confirm it
  // server-side, and wait for the settlement webhook to land in the ledger.
  const create = await apiFetch(
    page,
    'POST',
    '/api/payments',
    { amount_minor: 5000, currency: 'usd' },
    { 'idempotency-key': `nightly-${process.hrtime.bigint()}` },
  );
  expect(create.status).toBe(200);
  const { id: paymentId, client_secret } = create.json as { id: string; client_secret: string };
  const providerIntentId = client_secret.split('_secret_')[0]!;
  await confirmIntent(providerIntentId);

  await expect
    .poll(
      async () => {
        const list = await apiFetch(page, 'GET', '/api/payments');
        const payments = (list.json as { payments: { id: string; status: string }[] }).payments;
        return payments.find((p) => p.id === paymentId)?.status;
      },
      { timeout: 90_000, intervals: [2000] },
    )
    .toBe('succeeded');
  // The charge entry commits in the same transaction as the status change.
  expect(await entryPostings('charge', providerIntentId)).toEqual({
    stripe_receivable: 5000,
    revenue: -5000,
  });

  // Partial refund; the reversing entry arrives through the refund webhook.
  const refund = await apiFetch(
    page,
    'POST',
    `/api/payments/${paymentId}/refund`,
    { amount_minor: 2000 },
    { 'idempotency-key': `nightly-refund-${process.hrtime.bigint()}` },
  );
  expect(refund.status).toBe(200);
  const refundRef = await refundReference(paymentId);
  await expect
    .poll(async () => entryPostings('refund', refundRef), { timeout: 90_000, intervals: [2000] })
    .toEqual({ refunds: 2000, stripe_receivable: -2000 });

  // Reconcile: the run must record ok, and tonight's charge must not be flagged
  // (old test-mode settlements from previous nights have no rows in this fresh
  // database and are expected discrepancies).
  const recon = await apiFetch(page, 'POST', '/api/admin/reconcile');
  expect(recon.status).toBe(200);
  const reconBody = recon.json as { discrepancies: { reference: string }[] };
  expect(reconBody.discrepancies.map((d) => d.reference)).not.toContain(providerIntentId);

  const history = await apiFetch(page, 'GET', '/api/admin/reconciliations');
  const runs = (history.json as { reconciliations: { status: string }[] }).reconciliations;
  expect(runs[0]!.status).toBe('ok');
});
