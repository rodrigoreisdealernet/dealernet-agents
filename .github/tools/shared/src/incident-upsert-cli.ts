#!/usr/bin/env node
/**
 * incident-upsert-cli.ts
 *
 * CLI wrapper for upsertIncident — the canonical factory incident create-or-update
 * path.  Agents invoke this instead of embedding bespoke `gh issue list/create` shell
 * snippets.
 *
 * Usage:
 *
 *   # PR-local terminal stuck incident (Rung-3 escalation ladder):
 *   npx tsx .github/tools/shared/src/incident-upsert-cli.ts \
 *     --kind pr-local \
 *     --pr-number 123 \
 *     --title "factory-stuck: PR #123 — <one-line summary>" \
 *     --body "<evidence trail>"
 *
 *   # Shared-cause CI/infra incident (any PR blocked by the same check):
 *   npx tsx .github/tools/shared/src/incident-upsert-cli.ts \
 *     --kind shared-cause \
 *     --failure-class pr-validation \
 *     --scope "Temporal worker tests" \
 *     --title "CI blocker: temporal worker tests failing — all PRs blocked" \
 *     --body "<evidence trail>"
 *
 * Output (one line):
 *   action=created|updated issue=#<N> url=<url> fp=<fingerprint-id>
 *
 * Required environment:
 *   GH_TOKEN or GITHUB_TOKEN  — GitHub token with issues:write
 *   GITHUB_REPOSITORY         — owner/repo (e.g. Volaris-AI/dia)
 */

import {
  classifyIncident,
  buildSharedCauseFingerprint,
  buildPrLocalFingerprint,
  upsertIncident,
  type IncidentKind,
} from "./incident-upsert.js";
import { createGitHubApiClient } from "./alert-github-client.js";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  kind?: IncidentKind;
  prNumber?: number;
  failureClass?: string;
  scope?: string;
  title: string;
  body: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  function get(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  const kindRaw = get("--kind");
  const kind: IncidentKind | undefined =
    kindRaw === "pr-local" || kindRaw === "shared-cause" ? kindRaw : undefined;

  const prNumberRaw = get("--pr-number");
  const prNumber = prNumberRaw !== undefined ? parseInt(prNumberRaw, 10) : undefined;

  const title = get("--title");
  const body = get("--body");

  if (!title || !body) {
    console.error(
      "incident-upsert-cli: --title and --body are required.\n" +
        "  pr-local:    --kind pr-local    --pr-number <N>\n" +
        "  shared-cause: --kind shared-cause --failure-class <class> --scope <scope>"
    );
    process.exit(1);
  }

  return {
    kind,
    prNumber,
    failureClass: get("--failure-class"),
    scope: get("--scope"),
    title,
    body,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error("incident-upsert-cli: GH_TOKEN or GITHUB_TOKEN must be set");
    process.exit(1);
  }

  const repoEnv = process.env["GITHUB_REPOSITORY"];
  if (!repoEnv || !repoEnv.includes("/")) {
    console.error(
      "incident-upsert-cli: GITHUB_REPOSITORY must be set to owner/repo"
    );
    process.exit(1);
  }
  const slashIdx = repoEnv.indexOf("/");
  const owner = repoEnv.slice(0, slashIdx);
  const repo = repoEnv.slice(slashIdx + 1);

  const { kind: explicitKind, prNumber, failureClass, scope, title, body } =
    parseArgs();

  // Auto-classify when --kind is omitted
  const kind: IncidentKind =
    explicitKind ?? classifyIncident({ failureClass });

  let fp: string;
  if (kind === "shared-cause") {
    if (!failureClass || !scope) {
      console.error(
        "incident-upsert-cli: shared-cause incidents require --failure-class and --scope"
      );
      process.exit(1);
    }
    fp = buildSharedCauseFingerprint(failureClass, scope);
  } else {
    if (prNumber === undefined || isNaN(prNumber)) {
      console.error(
        "incident-upsert-cli: pr-local incidents require --pr-number <N>"
      );
      process.exit(1);
    }
    fp = buildPrLocalFingerprint(prNumber);
  }

  const api = createGitHubApiClient(token);
  const result = await upsertIncident(
    { kind, fingerprintId: fp, title, body },
    owner,
    repo,
    api
  );

  console.log(
    `action=${result.action} issue=#${result.issueNumber} url=${result.issueUrl} fp=${result.fingerprintId}`
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
