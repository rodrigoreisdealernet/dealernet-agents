import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Gating E2E for the RapidCount variance-review journey on /branch/counts.
 *
 * These tests are GATING (failures block a deploy via e2e-dev.yml).
 *
 * Deterministic fixture strategy: each test seeds its own submitted count_task
 * via the Supabase service-role REST API so the journey does not depend on
 * pre-existing data.  The fixture is cleaned up in a finally block regardless
 * of outcome.
 *
 * Closes https://github.com/Volaris-AI/wynne-lvl-3/issues/1402 (follow-up
 * gating coverage requested in PR #1510 review comment 4491945403).
 */

const OPS_CAPABLE_EMAIL = process.env.E2E_MANAGER_EMAIL || process.env.E2E_AUTH_EMAIL;
const OPS_CAPABLE_PASSWORD = process.env.E2E_MANAGER_PASSWORD || process.env.E2E_AUTH_PASSWORD;
const E2E_SUPABASE_URL = process.env.E2E_SUPABASE_URL;
const E2E_SUPABASE_SERVICE_KEY = process.env.E2E_SUPABASE_SERVICE_KEY;

function serviceRoleHeaders() {
  if (!E2E_SUPABASE_SERVICE_KEY) {
    throw new Error('E2E_SUPABASE_SERVICE_KEY is required for service-role fixture seeding.');
  }
  return {
    apikey: E2E_SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + E2E_SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(OPS_CAPABLE_EMAIL!);
  await page.getByTestId('login-password').fill(OPS_CAPABLE_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

/**
 * Insert a count_task entity in 'submitted' state with one no-variance line
 * so rapidcount_review_count_variances can process it without needing real
 * inventory records (the reconciliation loop skips lines with has_variance=false).
 *
 * Returns the entity id so the caller can clean up afterwards.
 */
async function seedSubmittedCountTask(request: APIRequestContext, taskName: string): Promise<string> {
  const entityInsertResponse = await request.post(
    `${E2E_SUPABASE_URL!}/rest/v1/entities`,
    {
      headers: serviceRoleHeaders(),
      data: [{ entity_type: 'count_task' }],
    }
  );
  expect(entityInsertResponse.ok(), `entity insert failed: ${entityInsertResponse.status()}`).toBe(true);
  const [entity] = await entityInsertResponse.json() as Array<{ id: string }>;
  expect(entity?.id, 'entity id missing from insert response').toBeTruthy();

  const versionInsertResponse = await request.post(
    `${E2E_SUPABASE_URL!}/rest/v1/entity_versions`,
    {
      headers: serviceRoleHeaders(),
      data: [{
        entity_id: entity.id,
        version_number: 1,
        is_current: true,
        data: {
          name: taskName,
          status: 'submitted',
          assignee_name: 'E2E Tester',
          count_type: 'spot_check',
          schedule_type: 'ad_hoc',
          // One no-variance line: has_variance=false keeps the reconciliation loop
          // from needing real inventory entity records.
          variance_lines: [{
            inventory_id: '00000000-0000-0000-0000-000000000001',
            entity_type: 'stock_item',
            inventory_kind: 'stock',
            counted_quantity: 10,
            system_quantity: 10,
            variance_quantity: 0,
            has_variance: false,
          }],
          captured_counts: [{
            inventory_id: '00000000-0000-0000-0000-000000000001',
            counted_quantity: 10,
          }],
        },
      }],
    }
  );
  expect(versionInsertResponse.ok(), `entity_version insert failed: ${versionInsertResponse.status()}`).toBe(true);

  return entity.id;
}

async function deleteEntity(request: APIRequestContext, entityId: string): Promise<void> {
  // Cascade: entity_versions, time_series_points, and relationships_v2 all
  // reference entities.id with ON DELETE CASCADE so this single delete is enough.
  const deleteResponse = await request.delete(
    `${E2E_SUPABASE_URL!}/rest/v1/entities?id=eq.${entityId}`,
    { headers: serviceRoleHeaders() }
  );
  // Best-effort: log but don't fail the test on cleanup errors.
  if (!deleteResponse.ok()) {
    console.warn(`cleanup: failed to delete entity ${entityId}: ${deleteResponse.status()}`);
  }
}

test.describe('@smoke rapidcount variance review', () => {
  test.beforeEach(() => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run RapidCount variance review E2E.'
    );
    if (!E2E_SUPABASE_URL || !E2E_SUPABASE_SERVICE_KEY) {
      throw new Error(
        'E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY are required for the gating variance-review spec. ' +
        'Missing fixture-seeding credentials must not silently skip this gating path.'
      );
    }
  });

  test('submitted decision persists through reload and audit history', async ({ page, request }) => {
    const taskName = `E2E-Variance-Review-${randomUUID()}`;
    let seededEntityId: string | null = null;

    try {
      seededEntityId = await seedSubmittedCountTask(request, taskName);

      await signIn(page);
      await page.goto('/branch/counts', { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');

      await expect(
        page.getByRole('heading', { name: 'RapidCount Scheduling' }),
        'RapidCount Scheduling heading must be visible'
      ).toBeVisible();

      // Locate the seeded task row by its unique name.
      const seededTaskRow = page
        .getByTestId('count-task-row')
        .filter({ hasText: taskName });

      await expect(
        seededTaskRow,
        `count-task-row containing "${taskName}" must be visible after seeding`
      ).toBeVisible({ timeout: 15_000 });

      // The seeded task row must show a Submitted badge before the review.
      await expect(
        seededTaskRow.getByText('Submitted', { exact: true }),
        'seeded task row must show a Submitted badge before the review'
      ).toBeVisible({ timeout: 10_000 });

      // Fill in the review reason input on the seeded task row.
      const reasonInput = seededTaskRow.getByLabel('Variance review reason');
      await expect(
        reasonInput,
        'Variance review reason input must be visible on the seeded task row'
      ).toBeVisible({ timeout: 10_000 });

      const reviewReason = `E2E variance approved — validated against physical count ${Date.now()}`;
      await reasonInput.fill(reviewReason);

      // Intercept the review RPC before submitting.
      const reviewRpcPromise = page.waitForResponse(
        (response) =>
          response.url().includes('/rpc/rapidcount_review_count_variances') &&
          response.request().method() === 'POST'
      );

      await seededTaskRow.getByRole('button', { name: 'Approve Variance' }).click();

      // The RPC must succeed.
      const reviewRpcResponse = await reviewRpcPromise;
      expect(
        reviewRpcResponse.ok(),
        'rapidcount_review_count_variances RPC must return 200 — auth, function wiring, and persistence must pass'
      ).toBe(true);

      await page.waitForLoadState('networkidle');

      // The Approve Variance button must disappear from that row.
      await expect(
        seededTaskRow.getByRole('button', { name: 'Approve Variance' }),
        'Approve Variance button must disappear after the decision is persisted'
      ).not.toBeVisible({ timeout: 10_000 });

      // The seeded task row must no longer show a Submitted badge after the review.
      await expect(
        seededTaskRow.getByText('Submitted', { exact: true }),
        'Submitted badge must disappear from the reviewed task row after the decision is persisted'
      ).not.toBeVisible({ timeout: 10_000 });

      // The handler auto-selects the reviewed task — Audit History card must
      // surface the "submitted →" status transition and the reviewer's reason.
      const auditHistoryCard = page.getByTestId('audit-history-card');
      await expect(auditHistoryCard, 'Audit History card must be visible').toBeVisible();

      await expect.poll(
        async () => auditHistoryCard.getByText(/submitted/i).count(),
        {
          message: 'Audit History must show a status transition referencing "submitted" after the variance review',
          timeout: 10_000,
        }
      ).toBeGreaterThan(0);

      await expect(
        auditHistoryCard.getByText(reviewReason),
        'Audit History must surface the reviewer-provided reason as the note'
      ).toBeVisible({ timeout: 10_000 });

      // --- Reload: decision must be durable ---
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');

      await expect(
        page.getByRole('heading', { name: 'RapidCount Scheduling' }),
        'RapidCount Scheduling heading must still be visible after reload'
      ).toBeVisible();

      // Re-open audit history on the reviewed task to confirm the trail survived reload.
      const reviewedTaskRow = page
        .getByTestId('count-task-row')
        .filter({ hasText: taskName });

      // The reviewed task row must still not show a Submitted badge after reload.
      await expect(
        reviewedTaskRow.getByText('Submitted', { exact: true }),
        'Submitted badge must still be absent from the reviewed task row after reload — decision must be durable'
      ).not.toBeVisible({ timeout: 10_000 });

      // The Approve Variance button must also remain absent after reload.
      await expect(
        reviewedTaskRow.getByRole('button', { name: 'Approve Variance' }),
        'Approve Variance button must still be absent after reload — decision must be durable'
      ).not.toBeVisible();

      const viewAuditButton = reviewedTaskRow.getByRole('button', { name: 'View Audit' });
      await expect(
        viewAuditButton,
        'View Audit button must be present on the reviewed task row after reload'
      ).toBeVisible({ timeout: 10_000 });
      await viewAuditButton.click();

      await expect.poll(
        async () => auditHistoryCard.getByText(/submitted/i).count(),
        {
          message: 'Audit History must still show the "submitted" transition after reload',
          timeout: 10_000,
        }
      ).toBeGreaterThan(0);

      await expect(
        auditHistoryCard.getByText(reviewReason),
        'Audit History must still surface the reviewer reason after reload — audit trail must be durable'
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      if (seededEntityId) {
        await deleteEntity(request, seededEntityId);
      }
    }
  });
});
