import { expect, test } from '@playwright/test';

// A distinct email per run keeps the shared e2e database from colliding
// across retries without a truncation hook.
function uniqueEmail(): string {
  return `e2e-${process.hrtime.bigint()}@example.com`;
}

const PASSWORD = 'a-strong-e2e-password';

test('register, land signed in, and see the session cookie', async ({ page, context }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();

  // The register-then-login flow must end signed in, not showing an error.
  await expect(page.getByText(`Signed in as`)).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'al_session');
  expect(session, 'session cookie is set').toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe('Lax');
});

test('sign out and back in through the browser', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  // Sign out drives a body-less POST /logout: this is the request shape that
  // a JSON content-type on an empty body would 400.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
});

test('wrong password surfaces an error and stays signed out', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid credentials');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
