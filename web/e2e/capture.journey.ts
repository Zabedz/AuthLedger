import { expect, test, type Page } from '@playwright/test';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { Client } from 'pg';

// Produces the docs/media assets: one screenshot per screen of the journey and
// a recorded video the README GIF is cut from. Not a test; it runs only through
// playwright.capture.config.ts. Deliberately paced (small waits) so the video
// reads at gif speed.
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const MAILPIT_UI = process.env.MAILPIT_UI_URL ?? 'http://localhost:8025';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://authledger:authledger@localhost:5432/authledger_e2e';
const MEDIA = '../docs/media';
const EMAIL = 'demo@authledger.test';
const PASSWORD = 'a-demo-password-1';

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

async function grantAdmin(email: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'admin'
       ON CONFLICT DO NOTHING`,
      [email],
    );
  } finally {
    await client.end();
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${MEDIA}/${name}.png`, fullPage: false });
}

test.use({
  viewport: { width: 1100, height: 720 },
  video: { size: { width: 1100, height: 720 }, mode: 'on' },
});

test('capture the journey', async ({ page }) => {
  test.setTimeout(180_000);

  // Sign-in and registration.
  await page.goto('/');
  await shot(page, '01-sign-in');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await shot(page, '02-register');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await shot(page, '03-check-your-email');

  // The verification email in Mailpit.
  const verifyPath = await waitForVerifyLink(EMAIL);
  await page.goto(MAILPIT_UI);
  await shot(page, '04-mailpit-inbox');
  await page.goto(verifyPath);
  await expect(page.getByText('You can sign in now')).toBeVisible();
  await shot(page, '05-verified');

  // Sign in and enroll a second factor.
  await page.goto('/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await shot(page, '06-signed-in');

  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await page.locator('code').first().innerText()).trim();
  await shot(page, '07-mfa-enroll');
  await page.getByLabel('Code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByText('Save these recovery codes')).toBeVisible();
  await shot(page, '08-recovery-codes');

  // The second factor at sign-in.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor code' })).toBeVisible();
  await shot(page, '09-two-factor');
  await page.getByLabel('Authenticator code or recovery code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  // The Stripe Payment Element, when keys are configured.
  if (process.env.STRIPE_PUBLISHABLE_KEY) {
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expect(page.frameLocator('iframe').first().getByLabel('Card number')).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(1500);
    await shot(page, '10-payment-element');
    await page.getByRole('button', { name: 'Cancel' }).click();
  }

  // The admin panel, seen as an admin.
  await grantAdmin(EMAIL);
  await page.reload();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '11-admin-panel');

  // Swagger UI, the dev-only API console.
  await page.goto('/api/docs');
  await page.waitForTimeout(1500);
  await shot(page, '12-swagger-ui');
});
