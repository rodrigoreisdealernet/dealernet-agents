import { test, expect, type Page } from '@playwright/test';

/**
 * Authentication + role + data-access coverage (GATING).
 *
 * These exist because of a real production-class outage on dev: the role/RLS
 * migration never reached the deployed DB, so (a) authenticated users could read
 * NO base-table rows (every entity list was empty though data existed), (b) the
 * demo accounts carried no app_metadata.role so an "admin" showed as Read Only,
 * and (c) a broken write-RPC guard let read_only escalate to writes. Each test
 * below pins one of those down.
 *
 * Per-role credentials come from env (set as repo secrets). Each role's block
 * skips cleanly if its credentials are not configured.
 */

type RoleSpec = {
  key: string;
  label: string; // ROLE_LABELS value shown in the header badge
  email?: string;
  password?: string;
};

const ROLES: RoleSpec[] = [
  { key: 'admin', label: 'Admin', email: process.env.E2E_AUTH_EMAIL, password: process.env.E2E_AUTH_PASSWORD },
  { key: 'branch_manager', label: 'Branch Manager', email: process.env.E2E_MANAGER_EMAIL, password: process.env.E2E_MANAGER_PASSWORD },
  { key: 'field_operator', label: 'Field Operator', email: process.env.E2E_OPERATOR_EMAIL, password: process.env.E2E_OPERATOR_PASSWORD },
  { key: 'read_only', label: 'Read Only', email: process.env.E2E_READONLY_EMAIL, password: process.env.E2E_READONLY_PASSWORD },
];

async function signIn(page: Page, email: string, password: string) {
  // Login is a standalone page (no app chrome) — fill the form directly.
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

test('login page is standalone — no app chrome (header nav / sidebar) for unauthenticated users', async ({ page }) => {
  // Regression for #305: /login rendered the full app shell (sidebar + header nav).
  await page.goto('/login');
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toBeVisible();
  // The sidebar/header navigation must NOT be present on the login screen.
  await expect(page.getByRole('navigation'), 'login page must not render app navigation').toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Customers' })).toHaveCount(0);
});

test.describe('auth + role + data access (per demo role)', () => {
  for (const role of ROLES) {
    test.describe(`role: ${role.key}`, () => {
      test.skip(
        !role.email || !role.password,
        `Set ${role.key} demo credentials (email/password env) to run this role's checks.`
      );

      test(`signs in and the header shows the correct role badge ("${role.label}")`, async ({ page }) => {
        await signIn(page, role.email!, role.password!);
        // Regression: an admin account with a missing app_metadata.role claim
        // silently rendered as "Read Only".
        await expect(page.getByTestId('header-user-role')).toHaveText(role.label);
      });

      test('authenticated user can read real entity data (lists are not empty)', async ({ page }) => {
        // Regression: the missing authenticated_read RLS policy made every base-table
        // read return [] for authenticated users, so all entity lists were blank even
        // though the data existed. Every role can READ, so this holds for all of them.
        await signIn(page, role.email!, role.password!);
        await page.goto('/entities/branch');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        const rows = page
          .getByRole('button', { name: /^View$/ })
          .or(page.getByRole('link', { name: /^View$/ }));
        await expect(
          rows.first(),
          'branch list is empty for an authenticated user — authenticated_read RLS likely missing on the deployed DB'
        ).toBeVisible();
        expect(await rows.count(), 'expected at least one branch row').toBeGreaterThan(0);
      });
    });
  }
});

test.describe('write boundaries', () => {
  test('read_only cannot create a rental order and sees a clear permission message', async ({ page }) => {
    const email = process.env.E2E_READONLY_EMAIL;
    const password = process.env.E2E_READONLY_PASSWORD;
    test.skip(!email || !password, 'Set E2E_READONLY_EMAIL/E2E_READONLY_PASSWORD to run this.');

    await signIn(page, email!, password!);
    await page.goto('/rental/orders');
    await page.getByRole('button', { name: 'New Rental Order' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Create Order' }).click();

    // Regression: a broken write-RPC guard (reading a deprecated JWT-claim GUC)
    // let read_only escalate to writes; the order create must be blocked.
    await expect(page.getByText('Order creation blocked')).toBeVisible();
    await expect(page.getByText(/write access to create rental orders/i)).toBeVisible();
  });
});
