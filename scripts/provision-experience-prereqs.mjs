#!/usr/bin/env node

import { randomBytes, randomInt } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const supabaseUrl = (process.env.E2E_SUPABASE_URL ?? '').replace(/\/$/, '');
const serviceKey = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const githubEnvPath = process.env.GITHUB_ENV ?? '';
const demoTenant = process.env.E2E_DEMO_TENANT ?? 'tenant-demo';
const ineligibleContractSourceRecordId =
  process.env.E2E_PORTAL_INELIGIBLE_CONTRACT_SOURCE_RECORD_ID ?? 'demo-baseline-rental-contract-001';
const MAX_AUTH_USER_PAGES = 20;
const BILLING_TOKEN_TTL_MS = 60 * 60 * 1000;
const PASSWORD_SPECIALS = '!@#$%^&*';
const ELIGIBLE_PORTAL_USER = {
  email: 'portal.eligible.e2e@dia-rental.dev',
  displayName: 'E2E Portal Eligible',
};
const INELIGIBLE_PORTAL_USER = {
  email: 'portal.ineligible.e2e@dia-rental.dev',
  displayName: 'E2E Portal Ineligible',
};

if (!supabaseUrl) {
  throw new Error('E2E_SUPABASE_URL is required to provision experience-suite prerequisites.');
}

if (!serviceKey) {
  throw new Error('E2E_SUPABASE_SERVICE_KEY is required to provision experience-suite prerequisites.');
}

const serviceHeaders = {
  apikey: serviceKey,
  Authorization: 'Bearer ' + serviceKey,
  Accept: 'application/json',
};

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function writeEnv(name, value) {
  const line = `${name}=${value}\n`;

  if (githubEnvPath) {
    appendFileSync(githubEnvPath, line);
    return;
  }

  process.stdout.write(line);
}

/**
 * Masks a sensitive value in GitHub Actions logs when runtime provisioning exports it.
 *
 * @param {string} value
 */
function maskGitHubSecret(value) {
  if (!githubEnvPath || typeof value !== 'string' || value.length === 0) {
    return;
  }

  process.stdout.write(`::add-mask::${value}\n`);
}

/**
 * Exports an environment variable and masks any related sensitive values first.
 *
 * @param {string} name
 * @param {string} value
 * @param {string[] | null | undefined} maskedValues Falls back to masking `value` when omitted.
 */
function writeSecretEnv(name, value, maskedValues) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  const valuesToMask = maskedValues ?? [value];

  for (const maskedValue of valuesToMask) {
    if (typeof maskedValue !== 'string' || maskedValue.length === 0) {
      throw new Error(`Masked values for ${name} must be non-empty strings.`);
    }

    maskGitHubSecret(maskedValue);
  }

  writeEnv(name, value);
}

function parseScheduleScopeContext(rawUrl) {
  const parsed = new URL(rawUrl, 'https://dia.invalid');
  const contractId = parsed.pathname.match(/\/portal\/schedule\/([^/?#]+)/)?.[1] ?? '';
  const scopeToken = parsed.searchParams.get('scope') ?? '';

  if (!contractId || !scopeToken) {
    throw new Error(
      `Portal schedule demo URL must match /portal/schedule/:contractId?scope=<token>, got "${rawUrl}".`
    );
  }

  return { contractId, scopeToken };
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      ...serviceHeaders,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const method = init.method ?? 'GET';
    console.error(`${method} ${path} failed (${response.status})`);
    throw new Error(`${method} ${path} failed (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function fetchFirst(path) {
  const rows = await fetchJson(path);

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Expected at least one row from ${path}.`);
  }

  return rows[0];
}

async function callRpc(name, payload = {}) {
  return fetchJson(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function findAuthUserByEmail(email) {
  const target = email.toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= MAX_AUTH_USER_PAGES; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    const payload = await fetchJson(`/auth/v1/admin/users?${params.toString()}`);
    const users = Array.isArray(payload?.users) ? payload.users : Array.isArray(payload) ? payload : [];
    const match = users.find((user) => typeof user?.email === 'string' && user.email.toLowerCase() === target);

    if (match) {
      return match;
    }

    if (users.length < perPage) {
      return null;
    }
  }

  throw new Error(`Portal auth user search for ${email} exceeded pagination budget.`);
}

async function upsertPortalCustomerUser({ email, displayName, customerId, password }) {
  const body = {
    email,
    password,
    email_confirm: true,
    app_metadata: {
      role: 'portal_customer',
      tenant: demoTenant,
      customer_id: customerId,
      customer_ids: [customerId],
    },
    user_metadata: {
      display_name: displayName,
    },
  };

  const existingUser = await findAuthUserByEmail(email);

  if (existingUser?.id) {
    const updated = await fetchJson(`/auth/v1/admin/users/${existingUser.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const updatedUser = updated?.user ?? updated;

    return {
      id: assertNonEmptyString(updatedUser?.id, `updated auth user id for ${email}`),
      email,
      password,
    };
  }

  const created = await fetchJson('/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const createdUser = created?.user ?? created;

  return {
    id: assertNonEmptyString(createdUser?.id, `created auth user id for ${email}`),
    email,
    password,
  };
}

async function upsertPortalGrant({ authUserId, customerId, billingAccountId }) {
  await fetchJson('/rest/v1/portal_customer_access_grant?on_conflict=auth_user_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([
      {
        tenant_id: demoTenant,
        auth_user_id: authUserId,
        customer_id: customerId,
        billing_account_ids: [billingAccountId],
        status: 'active',
      },
    ]),
  });
}

async function fetchContractContext(contractId) {
  const row = await fetchFirst(
    `/rest/v1/v_rental_contract_current?select=entity_id,data,status&entity_id=eq.${encodeURIComponent(contractId)}&limit=1`
  );
  const data = row?.data ?? {};

  return {
    contractId: assertNonEmptyString(row?.entity_id ?? contractId, 'contract entity id'),
    customerId: assertNonEmptyString(data.customer_id, `customer_id for contract ${contractId}`),
    billingAccountId: assertNonEmptyString(data.billing_account_id, `billing_account_id for contract ${contractId}`),
    jobSiteId: assertNonEmptyString(data.job_site_id, `job_site_id for contract ${contractId}`),
  };
}

async function fetchContractIdBySourceRecordId(sourceRecordId) {
  const row = await fetchFirst(
    `/rest/v1/entities?select=id&entity_type=eq.rental_contract&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&limit=1`
  );

  return assertNonEmptyString(row?.id, `contract id for source record ${sourceRecordId}`);
}

function createPassword() {
  const chars = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(26)],
    'abcdefghijklmnopqrstuvwxyz'[randomInt(26)],
    '0123456789'[randomInt(10)],
    PASSWORD_SPECIALS[randomInt(PASSWORD_SPECIALS.length)],
    ...randomBytes(18).toString('base64url').split(''),
  ];

  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }

  return chars.join('');
}

/**
 * Returns the billing token expiry as an ISO 8601 string one hour after `now`.
 *
 * @param {number} now
 */
function createBillingTokenExpiryIso(now = Date.now()) {
  return new Date(now + BILLING_TOKEN_TTL_MS).toISOString();
}

async function main() {
  const scheduleUrlFromEnv = process.env.E2E_PORTAL_SCHEDULE_SCOPED_URL?.trim() ?? '';
  const scheduleUrlRaw = scheduleUrlFromEnv
    ? scheduleUrlFromEnv
    : assertNonEmptyString(await callRpc('portal_get_demo_portal_url', {}), 'portal_get_demo_portal_url() result');
  const scheduleContext = parseScheduleScopeContext(scheduleUrlRaw);
  const eligibleContract = await fetchContractContext(scheduleContext.contractId);

  const ineligibleContractId = await fetchContractIdBySourceRecordId(ineligibleContractSourceRecordId);
  const ineligibleContract = await fetchContractContext(ineligibleContractId);

  const eligiblePortalUser = await upsertPortalCustomerUser({
    email: ELIGIBLE_PORTAL_USER.email,
    displayName: ELIGIBLE_PORTAL_USER.displayName,
    customerId: eligibleContract.customerId,
    password: createPassword(),
  });
  await upsertPortalGrant({
    authUserId: eligiblePortalUser.id,
    customerId: eligibleContract.customerId,
    billingAccountId: eligibleContract.billingAccountId,
  });

  const ineligiblePortalUser = await upsertPortalCustomerUser({
    email: INELIGIBLE_PORTAL_USER.email,
    displayName: INELIGIBLE_PORTAL_USER.displayName,
    customerId: ineligibleContract.customerId,
    password: createPassword(),
  });
  await upsertPortalGrant({
    authUserId: ineligiblePortalUser.id,
    customerId: ineligibleContract.customerId,
    billingAccountId: ineligibleContract.billingAccountId,
  });

  const billingTokenResult = await callRpc('portal_issue_billing_update_token', {
    p_tenant_id: demoTenant,
    p_billing_account_id: eligibleContract.billingAccountId,
    p_customer_id: eligibleContract.customerId,
    p_expires_at: createBillingTokenExpiryIso(),
    p_issued_by: 'e2e-automated-provisioning',
  });
  const billingToken = Array.isArray(billingTokenResult) ? billingTokenResult[0] : billingTokenResult;
  const billingTokenId = assertNonEmptyString(billingToken?.token_id, 'portal_issue_billing_update_token token_id');
  const billingRawToken = assertNonEmptyString(billingToken?.raw_token, 'portal_issue_billing_update_token raw_token');

  // Catalog reuses the schedule-style query parameter because the scope token is
  // submitted back to RPCs on page load and form submit. Billing-update follows
  // the intake pattern: the raw token stays in the URL fragment so the browser
  // does not send it to the server and the app can scrub it after bootstrapping.
  const billingUpdateUrl = `/portal/billing-update/${billingTokenId}#token=${billingRawToken}`;
  writeEnv('E2E_PORTAL_CATALOG_SCOPED_URL', `/portal/catalog/${eligibleContract.jobSiteId}?scope=${scheduleContext.scopeToken}`);
  writeSecretEnv(
    'E2E_PORTAL_BILLING_UPDATE_SCOPED_URL',
    billingUpdateUrl,
    [billingRawToken, billingUpdateUrl]
  );
  writeEnv('E2E_PORTAL_CUSTOMER_EMAIL', eligiblePortalUser.email);
  writeSecretEnv('E2E_PORTAL_CUSTOMER_PASSWORD', eligiblePortalUser.password);
  writeEnv('E2E_PORTAL_INELIGIBLE_CUSTOMER_EMAIL', ineligiblePortalUser.email);
  writeSecretEnv('E2E_PORTAL_INELIGIBLE_CUSTOMER_PASSWORD', ineligiblePortalUser.password);

  console.log(`Provisioned experience prerequisites for 2 portal customers and billing-update token ${billingTokenId}.`);
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

export { createBillingTokenExpiryIso, writeSecretEnv };

if (isMainModule()) {
  await main();
}
