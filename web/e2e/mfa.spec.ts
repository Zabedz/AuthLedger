import { expect, test } from '@playwright/test';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const PASSWORD = 'a-strong-e2e-password';

const crypto = new NobleCryptoPlugin();
const base32 = new ScureBase32Plugin();

function uniqueEmail(): string {
  return `mfa-e2e-${process.hrtime.bigint()}@example.com`;
}

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

test('enroll TOTP, then sign in with a second factor', async ({ page }) => {
  const email = uniqueEmail();

  // Register and verify.
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.goto(await waitForVerifyLink(email));
  await expect(page.getByText('You can sign in now')).toBeVisible();

  // Sign in (no MFA yet) and enroll.
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

  // Sign out, then sign back in through the second factor.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Two-factor code' })).toBeVisible();
  await page.getByLabel('Authenticator code or recovery code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await expect(page.getByText('Two-factor authentication is on')).toBeVisible();
});
