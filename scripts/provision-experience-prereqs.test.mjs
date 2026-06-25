import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const moduleUrl = new URL('./provision-experience-prereqs.mjs', import.meta.url);

function setRequiredEnv(overrides = {}) {
  const previous = {
    E2E_SUPABASE_URL: process.env.E2E_SUPABASE_URL,
    E2E_SUPABASE_SERVICE_KEY: process.env.E2E_SUPABASE_SERVICE_KEY,
    E2E_DEMO_TENANT: process.env.E2E_DEMO_TENANT,
    GITHUB_ENV: process.env.GITHUB_ENV,
  };

  process.env.E2E_SUPABASE_URL = 'https://example.supabase.test';
  process.env.E2E_SUPABASE_SERVICE_KEY = 'service-key';
  process.env.E2E_DEMO_TENANT = 'tenant-demo';

  if (overrides.GITHUB_ENV === undefined) {
    delete process.env.GITHUB_ENV;
  } else {
    process.env.GITHUB_ENV = overrides.GITHUB_ENV;
  }

  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

async function importProvisionModule(testIdentifier) {
  return import(`${moduleUrl.href}?case=${testIdentifier}`);
}

async function captureStdout(run) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = (chunk, encoding, callback) => {
    stdout += String(chunk);
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  };

  try {
    await run();
    return stdout;
  } catch (error) {
    if (error && typeof error === 'object') {
      error.capturedStdout = stdout;
    }
    throw error;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

test('createBillingTokenExpiryIso returns a one-hour ISO expiry', async () => {
  const previous = setRequiredEnv();

  try {
    const { createBillingTokenExpiryIso } = await importProvisionModule('expiry');
    assert.equal(createBillingTokenExpiryIso(0), '1970-01-01T01:00:00.000Z');
    assert.equal(
      createBillingTokenExpiryIso(Date.parse('2026-12-31T23:30:00.000Z')),
      '2027-01-01T00:30:00.000Z'
    );
    assert.equal(
      createBillingTokenExpiryIso(Date.parse('2026-06-20T05:30:00.000Z')),
      '2026-06-20T06:30:00.000Z'
    );
  } finally {
    restoreEnv(previous);
  }
});

test('writeSecretEnv masks each secret before exporting the env var', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'provision-prereqs-test-'));
  const githubEnvPath = path.join(tempDir, 'github.env');
  writeFileSync(githubEnvPath, '');

  const previous = setRequiredEnv({ GITHUB_ENV: githubEnvPath });

  try {
    const stdout = await captureStdout(async () => {
      const { writeSecretEnv } = await importProvisionModule('masking');
      writeSecretEnv('SECRET_NAME', 'exported-value', ['mask-one', 'mask-two']);
    });

    assert.equal(stdout, '::add-mask::mask-one\n::add-mask::mask-two\n');
    assert.equal(readFileSync(githubEnvPath, 'utf8'), 'SECRET_NAME=exported-value\n');
  } finally {
    restoreEnv(previous);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeSecretEnv skips masking when GITHUB_ENV is unset', async () => {
  const previous = setRequiredEnv();

  try {
    const stdout = await captureStdout(async () => {
      const { writeSecretEnv } = await importProvisionModule('stdout-fallback');
      writeSecretEnv('SECRET_NAME', 'exported-value', ['mask-one']);
    });

    assert.equal(stdout, 'SECRET_NAME=exported-value\n');
  } finally {
    restoreEnv(previous);
  }
});

test('writeSecretEnv rejects empty exported or masked values', async () => {
  const previous = setRequiredEnv();

  try {
    const { writeSecretEnv } = await importProvisionModule('validation');
    assert.throws(() => writeSecretEnv('SECRET_NAME', '', ['mask-one']), /SECRET_NAME must be a non-empty string\./);
    assert.throws(
      () => writeSecretEnv('SECRET_NAME', 'exported-value', ['']),
      /Masked values for SECRET_NAME must be non-empty strings\./
    );
  } finally {
    restoreEnv(previous);
  }
});
