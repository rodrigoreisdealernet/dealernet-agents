#!/usr/bin/env node
// release-ledger-record.mjs — append one "known-good" record to the release ledger
// on the orphan `releases-ledger` branch (sibling of the ci-history / e2e-history
// ledgers). A build becomes known-good when the dev deploy of that exact commit
// passed the gating e2e smoke (ADR-0062). Promotion to UAT/prod then SELECTS a
// known-good SHA from this ledger instead of shipping the head of main.
//
// This emits the record line to stdout; the workflow step appends it to
// `known-good.jsonl` (and refreshes `latest-known-good.txt`) on the ledger branch
// with the same fetch/rebase retry loop e2e-history uses, so concurrent runs can't
// clobber each other.
//
// Usage:
//   node release-ledger-record.mjs --sha <full-sha> [--smoke passed] [--deploy-run-id <id>]
//
// Run metadata is read from the GitHub Actions environment (GITHUB_*).
//
// Record schema (one JSON object per line in known-good.jsonl):
//   { ts, sha, sha_short, smoke, e2e_run_id, e2e_run_url, deploy_run_id, trigger }

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const sha = arg('sha', process.env.GITHUB_SHA || '');
if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
  console.error(`release-ledger-record: --sha must be a commit SHA (got: '${sha}')`);
  process.exit(1);
}

const env = process.env;
const runId = env.GITHUB_RUN_ID || '';
const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
const repo = env.GITHUB_REPOSITORY || '';

const record = {
  ts: new Date().toISOString(),
  sha,
  sha_short: sha.slice(0, 12),
  smoke: arg('smoke', 'passed'),
  e2e_run_id: runId,
  e2e_run_url: runId && repo ? `${serverUrl}/${repo}/actions/runs/${runId}` : '',
  deploy_run_id: arg('deploy-run-id', ''),
  trigger: env.GITHUB_EVENT_NAME || '',
};

process.stdout.write(JSON.stringify(record) + '\n');
