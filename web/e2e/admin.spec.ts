import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

const PASSWORD = 'a-strong-e2e-password';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://authledger:authledger@localhost:5432/authledger_e2e';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${process.hrtime.bigint()}@example.com`;
}

// The first admin is seeded out of band (in production, ADMIN_EMAIL at boot);
// here the test grants it directly so it can exercise the panel as an admin.
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

async function register(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

test('an admin grants and revokes a role from the admin panel', async ({ page }) => {
  const adminEmail = uniqueEmail('admin-e2e');
  const memberEmail = uniqueEmail('member-e2e');

  await register(page, memberEmail);
  await register(page, adminEmail);
  await grantAdmin(adminEmail);

  await signIn(page, adminEmail);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: memberEmail });
  await row.getByRole('button', { name: 'Grant auditor' }).click();
  await expect(row.getByRole('button', { name: 'Revoke auditor' })).toBeVisible();
  await expect(row).toContainText('auditor');

  await row.getByRole('button', { name: 'Revoke auditor' }).click();
  await expect(row.getByRole('button', { name: 'Grant auditor' })).toBeVisible();
});

test('a signed-in member sees no administration section', async ({ page }) => {
  const email = uniqueEmail('member-only-e2e');
  await register(page, email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeHidden();
});
