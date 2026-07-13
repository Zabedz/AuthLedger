import { expect, test } from '@playwright/test';

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const PASSWORD = 'a-strong-e2e-password';

function uniqueEmail(): string {
  return `e2e-${process.hrtime.bigint()}@example.com`;
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

// Poll Mailpit for a message to an address whose subject matches, return body.
async function waitForEmail(email: string, subject = /.*/): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages`);
    const { messages } = (await res.json()) as { messages: MailpitMessage[] };
    const match = messages.find(
      (m) => m.To.some((t) => t.Address === email) && subject.test(m.Subject),
    );
    if (match) {
      const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${match.ID}`)).json()) as {
        Text: string;
      };
      return full.Text;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${email} matching ${subject}`);
}

function linkPath(body: string): string {
  const match = body.match(/https?:\/\/[^\s]+/);
  if (!match) throw new Error(`no link in email body: ${body}`);
  return new URL(match[0]).pathname + new URL(match[0]).search;
}

test('register shows a check-your-email screen and does not sign in', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'al_session')).toBeUndefined();
});

test('full journey: register, verify via email link, sign in, sign out', async ({
  page,
  context,
}) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const verifyPath = linkPath(await waitForEmail(email, /verify/i));
  await page.goto(verifyPath);
  await expect(page.getByText('You can sign in now')).toBeVisible();

  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  // A verified account shows no unverified banner.
  await expect(page.getByText('Your email is not verified')).toHaveCount(0);

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'al_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');

  // Sign out drives a body-less POST, the shape a JSON content-type would 400.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('reset password via email link, then sign in with the new password', async ({ page }) => {
  const email = uniqueEmail();

  // Register and verify so the account exists.
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await waitForEmail(email, /verify/i);

  // Request a reset.
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const resetBody = await waitForEmail(email, /reset/i);
  await page.goto(linkPath(resetBody));
  await page.getByLabel('New password').fill('a-different-password');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByText('You can sign in now')).toBeVisible();

  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-different-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
});
