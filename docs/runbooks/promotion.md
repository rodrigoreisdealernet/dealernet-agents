# Runbook: Promoting a release (dev → UAT → prod)

How to promote a **known-good build** through the environments, with the human gates.
Design of record: [ADR-0062](../adrs/0062-gated-promotion-known-good-digest-per-env-data-isolation.md).
Companion: [ci-cd-pipelines.md](../architecture/ci-cd-pipelines.md) · [deployment.md](../architecture/deployment.md).

> **Naming:** "UAT" is the **`test`** environment (`wynne-test` namespace, `deploy-test.yml`,
> the `test` GitHub Environment). Kept named `test` internally; we call it UAT in conversation.

---

## The model in one line

`main` auto-deploys to **dev**; dev's green e2e smoke stamps that commit **known-good**;
a human **approves** promoting a chosen known-good SHA to **UAT**, then to **prod**. The same
immutable image digest rides the whole way (ADR-0010) — no rebuilds, and promoting an *older*
clean commit instead of HEAD is a first-class action.

```
merge → main → build-images → deploy-dev → e2e-dev smoke ──passes──▶ stamp known-good (releases-ledger)
                                                                          │
                              human picks a known-good SHA + approves ◀───┘
                                          │
                          deploy-test (UAT)  ──human approval (test Environment)──▶ wynne-test
                                          │
                          deploy-prod       ──human approval (prod Environment)──▶ wynne-prod
```

---

## 1. Find a known-good build to promote

Known-good builds are recorded on the orphan **`releases-ledger`** branch:

```bash
# The default pick (latest commit whose dev deploy passed e2e smoke):
gh api repos/:owner/:repo/contents/latest-known-good.txt?ref=releases-ledger \
  --jq '.content' | base64 -d

# Browse recent known-good builds (newest last):
gh api repos/:owner/:repo/contents/known-good.jsonl?ref=releases-ledger \
  --jq '.content' | base64 -d | tail -10
```

Each line is `{ ts, sha, sha_short, smoke, e2e_run_id, e2e_run_url, deploy_run_id, trigger }`.
Pick the `sha` you want — **the latest, or deliberately an earlier one** if a later build
introduced a problem.

> A build only appears here if its dev deploy passed the **gating** e2e smoke. If the ledger
> is empty, no build has passed dev smoke yet — fix dev before promoting.

## 2. Promote to UAT (`wynne-test`)

```bash
gh workflow run deploy-test.yml -f sha=<known-good-sha>
```

The deploy job resolves the immutable digest from ACR by that SHA and pauses on the **`test`
Environment**'s required-reviewer gate. Approve it in the Actions UI (Deployments → review).
Then run UAT validation.

## 3. Promote to prod (`wynne-prod`)

Only after UAT is verified. Promote the **same SHA**:

```bash
gh workflow run deploy-prod.yml -f sha=<same-sha>
```

The job pauses on the **`prod`** Environment's required-reviewer gate. Approve to ship.

## 4. Rollback

Re-promote the previous known-good SHA — it's just another promotion:

```bash
gh workflow run deploy-prod.yml -f sha=<previous-known-good-sha>
```

(Helm `--atomic`/rollback still applies within a single deploy; cross-release rollback is a
re-promote.)

---

## One-time setup (required for the human gates)

The gates are **GitHub Environments with Required Reviewers** — configured in repo settings,
not code. A GitHub Environment is a named settings object that holds an approval rule; a
deploy job tagged `environment: <name>` is paused by GitHub until a required reviewer
approves it in the Actions UI. That pause **is** the human gate. (It is unrelated to the
Kubernetes namespace that happens to share the name.)

> **Current state (verified):** only the `copilot` and `dev` environments exist. **Neither
> `test` nor `prod` is created yet**, so today a `deploy-test`/`deploy-prod` dispatch would
> run with **no approval pause**. You must create both and add reviewers — until you do, the
> `environment:` lines in the workflows have no gating effect.

### Preflight guard (defaults closed)

Both `deploy-test.yml` and `deploy-prod.yml` contain a preflight step that **hard-fails** if
`K8S_DEPLOY_ENABLED=true` but the corresponding gate-confirmed variable is not set:

| Workflow | Required variable | Effect if absent when K8S enabled |
|----------|-------------------|-----------------------------------|
| `deploy-test.yml` | `WYNNE_TEST_GATE_CONFIRMED=true` | preflight exits 1, deploy is blocked |
| `deploy-prod.yml` | `WYNNE_PROD_GATE_CONFIRMED=true` | preflight exits 1, deploy is blocked |

This means promotion **cannot proceed on an unprotected environment by accident**: you must
explicitly set the gate-confirmed variable — and the intended sequence is to do so only
_after_ the GitHub Environment has required reviewers configured.

**Click-by-click (do this once per environment, for `test` and `prod`):**
1. Repo → **Settings → Environments → New environment** → name it exactly `test` (then repeat for `prod`).
2. Tick **Required reviewers** → add yourself (and/or the release approvers). Save.
3. (Recommended) **Deployment branches and tags → Selected branches** → allow only `main`.
4. (Optional) Add a **wait timer** for prod if you want a cool-off before deploys run.
5. **Verify** the environment is protected: trigger a test dispatch and confirm GitHub pauses for approval before proceeding.
6. Only after step 5 is confirmed: set the gate-confirmed repo variable:
   ```bash
   gh variable set WYNNE_TEST_GATE_CONFIRMED --body true   # for UAT
   gh variable set WYNNE_PROD_GATE_CONFIRMED --body true   # for prod
   ```

**Programmatic equivalent** (needs the reviewer's numeric user id — `gh api user --jq .id`):
```bash
REPO=Volaris-AI/wynne-lvl-3
for ENV in test prod; do
  gh api -X PUT "repos/$REPO/environments/$ENV" \
    -f "reviewers[][type]=User" -F "reviewers[][id]=$(gh api user --jq .id)" \
    -f "deployment_branch_policy[protected_branches]=true" \
    -f "deployment_branch_policy[custom_branch_policies]=false"
done
# Then confirm the gate is active, then set the variables:
gh variable set WYNNE_TEST_GATE_CONFIRMED --body true
gh variable set WYNNE_PROD_GATE_CONFIRMED --body true
```

**Secrets/vars the `sha` path needs** (already used by `build-images`): `vars.ACR_LOGIN_SERVER`,
`secrets.ACR_USERNAME`, `secrets.ACR_PASSWORD`, plus the per-env `KUBE_CONFIG_TEST`/`KUBE_CONFIG_PROD`
and `K8S_DEPLOY_ENABLED` + `WYNNE_TEST_NAMESPACE`/`WYNNE_PROD_NAMESPACE` + `WYNNE_TEST_GATE_CONFIRMED`/`WYNNE_PROD_GATE_CONFIRMED`.

## Legacy path (fallback)

If you must promote a build that predates the ledger, pass the Build Images run id instead:
`gh workflow run deploy-test.yml -f build_run_id=<run-id>` (works only while that run's digest
artifacts survive — 90 days). Prefer `sha`.

## ⚠️ Per-environment data isolation

Each environment must use **its own database/schema** (ADR-0062). Do **not** enable UAT/prod
against the shared dev `wynne-supabase` data — promoting compute means nothing if all
environments share one database. Stand up per-env data **before** prod carries real data.
