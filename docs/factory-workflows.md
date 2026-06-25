# Software Factory — Catálogo dos Workflows (GitHub Actions)

> Documento compilado a partir da análise individual de cada um dos **24 workflows** em
> `.github/workflows.disabled/` (CI desligado nesta cópia de lab — em produção ficam em
> `.github/workflows/`). Cada seção segue a mesma estrutura: Gatilhos · Propósito · Jobs/passos ·
> Determinístico vs LLM · Permissões/segredos/concorrência/timeouts · Saídas/efeitos · Dependências.

> **Veja também:** [factory-agents.md](./factory-agents.md) — catálogo dos 27 agentes LLM que estes
> workflows invocam, + a config `factory.yml` e **dois diagramas Mermaid** (esteira PR→produção e
> cadências/monitores).

## Visão geral

A "software factory" é o sistema autônomo que **tria, desenha, constrói, revisa, faz deploy, verifica
e monitora** o próprio produto Dealernet. Ela envolve sessões LLM (agentes definidos em `.github/agents/*.agent.md`,
executados pelo runtime TS compartilhado `.github/tools/shared/`) numa **casca determinística** de GitHub
Actions. Organiza-se em **6 bandas** (convenção de nome `«Banda» · «Nome»`):

| Banda | O que faz | Workflows |
|---|---|---|
| **CI gate / Verify (por-PR)** | Barra merges quebrados | `pr-validation`, `pr-enrichment`, `k8s-render-validate`, `architecture-audit` |
| **Build** | Constrói/espelha imagens imutáveis | `build-images`, `mirror-temporal-ui-image` |
| **Deploy** | Promove digests por ambiente | `deploy-dev`, `deploy-test`, `deploy-prod` |
| **Verify (deployado/nightly)** | Testa o ambiente real | `code-quality`, `e2e-dev`, `visual-ux` |
| **Agents (cadência + ciclo de PR)** | Movem backlog e PRs | `pipeline-fast/hourly/daily/weekly`, `pr-loop`, `agent-tech-reviewer`, `roadmap-curation` |
| **Monitor** | Detectam falhas → incidentes deduplicados | `monitor-actions`, `monitor-deploy`, `monitor-ops`, `alert-incident-bridge`, `agent-cluster-guardian` |

### Runtime compartilhado (`.github/tools/shared/src/`)
`run-agent.ts` (instancia sessão Copilot SDK a partir de um `.agent.md`), `agent-loader.ts`,
`factory-config.ts`, `github-context.ts`, `permissions.ts`, `logging.ts`, `run-pr-pipeline.ts`,
`pr-snapshot.ts`, `pr-ordering.ts`, `pr-state.ts`, `ci-retrigger.ts`, `dedupe.ts`, `incident-upsert.ts`,
`alert-incident-bridge.ts`, `alert-github-client.ts`. Scripts auxiliares em `.github/scripts/*.mjs|*.sh`.

### Tabela-mestre

| Workflow | Banda | Gatilho | Determinístico / LLM | Efeito principal |
|---|---|---|---|---|
| pr-validation | CI gate | PR + push main | **Determinístico** | Único guardião de merge (46 jobs) |
| pr-enrichment | CI gate | PR opened/sync | **Determinístico** | Labels de risco/lane via github-script |
| k8s-render-validate | CI gate | PR/push (paths infra) | **Determinístico** | helm template + kubeconform |
| architecture-audit | CI gate/Verify | PR(paths)+diário | **Determinístico** (Python AST/regex) | Auditoria + gate de segurança de workflow |
| build-images | Build | PR + push main | **Determinístico** | Imagens no ACR + digest imutável |
| mirror-temporal-ui-image | Build | dispatch+6h+push | **Determinístico** | Espelha Temporal UI p/ ACR |
| deploy-dev | Deploy | workflow_run(Build) | **Determinístico** | Helm em `dia-dev` + bootstrap DB |
| deploy-test | Deploy | dispatch (sha) | **Determinístico** | UAT human-gated em `dia-test` |
| deploy-prod | Deploy | dispatch (sha) | **Determinístico** | Produção `dia-prod` (gate humano) |
| code-quality | Verify | diário | Misto (scan determ. + revisor LLM) | SAST/lint → tickets dedup |
| e2e-dev | Verify | horário + pós-deploy | **Determinístico** | Playwright + stamp known-good |
| visual-ux | Verify/Agents | diário | Misto (captura determ. + visão LLM) | Tickets de UX/acessibilidade |
| pipeline-fast | Agents | cron :00 (15min) | LLM (orquestração determ.) | Triagem/review de PRs/issues |
| pipeline-hourly | Agents | cron :30 | LLM | Specs/ADRs, QA, ops posture |
| pipeline-daily | Agents | diário 06:00 | LLM + scripts publish | Docs, release-notes, discovery |
| pipeline-weekly | Agents | diário 07:00 | LLM + scripts publish | Charter + modelo operacional |
| pr-loop | Agents | workflow_run(Build)+30min | LLM (orquestração determ.) | Merge autônomo por-PR |
| agent-tech-reviewer | Agents | workflow_run+15min | LLM | Veredito de review terminal |
| roadmap-curation | Agents | diário 03:30 | LLM | Hierarquia Initiative→Epic→Story |
| monitor-actions | Monitor | cron 15min | LLM | Incidentes de runs falhos |
| monitor-deploy | Monitor | workflow_run(failure) | LLM | Sentinel de deploy falho |
| monitor-ops | Monitor | cron 15min | LLM | Ops Monitor (SLA/zero-finding) |
| alert-incident-bridge | Monitor | repository_dispatch | **Determinístico** | Alertmanager → GitHub Issues |
| agent-cluster-guardian | Monitor | cron :45 | LLM (preflight determ.) | Saúde dos namespaces `dia-*` |

---

# Banda: CI gate / Verify (por-PR)

## pr-validation.yml
**Gatilhos:** `pull_request`→`main` e `push`→`main`. Em PRs cancela execuções antigas (`cancel-in-progress: true`); em push ao trunk, não.
**Propósito:** CI gate completo — único guardião de merge. Valida frontend, worker Temporal, charts Helm, ~35 suites de contrato Supabase (RLS, reset-path, comportamental) e as próprias ferramentas de `.github`.
**Jobs (paralelos, ~46):** `shared-tools` (Vitest do runtime TS); `frontend` (ESLint+build+Vitest, artefato `unit-results`); `coverage` (só push main, não-gating, `coverage-compute.mjs`); `static-analysis` (tsc/ruff/shellcheck/hadolint/gitleaks, report-only); `temporal` (timeout 90min, pytest com escopo por diff, Supabase CLI); `helm-charts` (valida imagem UI no ACR + `ci-test.sh` dos charts); ~35 jobs `supabase-*` (cada um um `supabase/tests/run_*.sh`); `validation-summary` (agrega); `publish-test-history` (só push main → grava `runs.jsonl`+dashboard na branch `ci-history`, retry 5x).
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:read`,`pull-requests:read` (job de history eleva p/ `contents:write`); `GITHUB_TOKEN`, `ACR_USERNAME/PASSWORD`, var `ACR_LOGIN_SERVER`. Timeouts: temporal 90min, coverage 20, static 15.
**Saídas:** artefatos `*-results` (7d); em push main, commit em `ci-history`; Step Summary com link.
**Dependências:** `.github/scripts/coverage-compute.mjs`, `test-history-record.mjs`, `test-history-render.mjs`, `temporal-ui-image.sh`; suites `supabase/tests/run_*.sh`, `charts/*/ci-test.sh`, `deploy/openbao/ci-test.sh`.

## pr-enrichment.yml
**Gatilhos:** `pull_request` (`opened`,`synchronize`,`reopened`).
**Propósito:** enriquecer cada PR com labels de risco e lanes de revisão especializada, alimentando o merge autônomo.
**Jobs:** job único `enrich` — checkout (`fetch-depth:0`) + `actions/github-script@v7` (JS inline): lista arquivos alterados, classifica superfícies (`frontend/temporal/supabase/platform`), resolve issues linkadas (`closes/fixes #N`), avalia `risk:high|medium|low`, detecta edição de migration já aplicada → `needs-database-review`, mudanças de plataforma → `needs-platform-review`, ausência de testes → `needs-tests`, overlap de arquivos entre PRs abertos, aplica/remove labels idempotentemente.
**Determinístico vs LLM:** 100% determinístico (JS + REST API).
**Permissões/segredos:** `contents:read`,`issues:write`,`pull-requests:write`; só `GITHUB_TOKEN`. Concorrência por PR, `cancel-in-progress:true`.
**Saídas:** labels + Step Summary (sem commits, sem comentários).
**Dependências:** `actions/checkout@v4`, `actions/github-script@v7`.

## k8s-render-validate.yml
**Gatilhos:** PR/push `main` filtrado por paths `charts/**`, `deploy/k8s/**`, `deploy/openbao/**`.
**Propósito:** gate de CI puro — renderiza charts Helm e valida schema dos manifests (sem contatar cluster).
**Jobs:** `render-validate` — Helm 3.18.3 + kubeconform 0.6.7; `helm lint`+`template` de `charts/app` (perfis base/dev/test/prod) e `charts/observability`; `kubeconform -strict` dos manifests renderizados; valida `deploy/k8s/*.yaml` e `deploy/openbao/*.yaml`; `deploy/openbao/ci-test.sh`.
**Determinístico vs LLM:** 100% determinístico (versões fixadas).
**Permissões:** `contents:read`. Sem segredos.
**Saídas:** Step Summary; falha bloqueia merge.
**Dependências:** `charts/app`, `charts/observability`, repo Helm `prometheus-community`.

## architecture-audit.yml
**Gatilhos:** diário 06:00, `workflow_dispatch`, e PR→`main` filtrado por `temporal/src/**`, `supabase/migrations/**`, `.github/workflows/**`, `scripts/audit/**`.
**Propósito:** capturar defeitos invisíveis ao review por-diff: wiring cross-file (Temporal), postura de segurança de workflows, comportamento vs existência (views/RLS).
**Jobs:** `audit` (report-only, sempre exit 0 → `python scripts/audit/run_audits.py` + pytest do tooling); `workflow-security-gate` (**gating** → `check_workflow_security.py --strict`, exit 1 bloqueia merge).
**Checks (Python AST/regex, determinísticos):** `check_temporal_registration` (todo `@workflow.defn`/`@activity.defn` está registrado no `worker.py`); `check_workflow_security` (flag `pull_request_target`+`secrets.*`, `permissions: write-all`); `check_view_security_invoker` (toda VIEW exposta tem `security_invoker`).
**Permissões:** `contents:read`. Concorrência por ref, `cancel-in-progress:true`.
**Saídas:** findings no Step Summary (worklist p/ agentes revisores); gate bloqueia merge.
**Dependências:** `scripts/audit/*.py`, `temporal/tests/test_architecture_audit.py`.

---

# Banda: Build

## build-images.yml
**Gatilhos:** `pull_request` (build-only) e `push`→`main` (build + push condicional ao ACR).
**Propósito:** construir imagens `frontend` e `temporal-worker`; push tratado como efeito colateral controlado (gated).
**Jobs:** job `build-images` em matriz (2 imagens em paralelo): Buildx → **push-gate** (`build-images-metadata.sh push-gate`: só `push`+main+credenciais ACR presentes) → tags imutáveis por SHA (`image-tags`) → build args (`VITE_COMMIT_SHA`/`VITE_BUILD_TIME` só p/ frontend) → `docker/build-push-action@v6` → grava digest `sha256:` como artefato `image-digest-<name>` (90d, ADR-0062).
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:read`; `ACR_USERNAME/PASSWORD` + var `ACR_LOGIN_SERVER` p/ push.
**Saídas:** imagens no ACR com tag por SHA; digest como artefato.
**Dependências:** `.github/scripts/build-images-metadata.sh` (modos push-gate/image-tags/skip-message), `resolve-image-digest.sh` (resolve digest via `imagetools inspect`, sem pull).

## mirror-temporal-ui-image.yml
**Gatilhos:** `workflow_dispatch`, cron `17 */6 * * *`, e push em `main` que toque `charts/app/values.yaml`/`temporal-ui-image.sh`/o workflow.
**Propósito:** espelhar a imagem do Temporal UI (Docker Hub → ACR) para evitar rate-limit anônimo e dependência externa (issue #1183).
**Jobs:** checkout → Buildx → `temporal-ui-image.sh mirror` (lê repo/tag de `charts/app/values.yaml`, login ACR/DockerHub, idempotente: se já existe no ACR não faz nada, senão `imagetools create`+valida).
**Determinístico vs LLM:** 100% determinístico (shell+Python).
**Permissões/segredos:** `contents:read`; `ACR_*`, `DOCKERHUB_*`, var `ACR_LOGIN_SERVER`.
**Saídas:** imagem adicionada ao ACR.
**Dependências:** `.github/scripts/temporal-ui-image.sh` (modos resolve/validate/mirror), `charts/app/values.yaml`.

---

# Banda: Deploy

## deploy-dev.yml
**Gatilhos:** `workflow_run` ao concluir "Build Images" com sucesso em `main`; `workflow_dispatch` (`build_run_id`, `sha_tag`).
**Propósito:** promover imagens recém-construídas ao namespace `dia-dev` (AKS), por digest imutável (ADR-0010).
**Jobs:** `preflight` (gates desacoplados `app_enabled` e `bootstrap_enabled`); `deploy` (kubeconfig scoped 600, baixa `image-digest-*`, valida `sha256`, auto-heal de estado Helm pendente, `helm upgrade --install rental-app --wait 10m`, diagnóstico em falha); `bootstrap-db` (RBAC idempotente + Job in-cluster que aplica migrations comprimidas + valida seed demo 2x); `*-failure-sentinel` (abrem/atualizam issues com fingerprint).
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:read`,`actions:read`; `KUBE_CONFIG_DEV`, `KUBE_CONFIG_DEV_DB_BOOTSTRAP`, var `ACR_LOGIN_SERVER`. Concorrência `deploy-dev`, sem cancelar (auto-heal sempre roda).
**Saídas:** release `rental-app` em `dia-dev`; migrations aplicadas; issues em falha.
**Dependências:** encadeia `e2e-dev`; esteira usa `resolve-image-digest.sh` e `release-ledger-record.mjs`.

## deploy-test.yml
**Gatilhos:** só `workflow_dispatch` — inputs `sha` (preferido, da branch `releases-ledger`), `build_run_id` (legado), `sha_tag`. Exatamente um dos dois primeiros.
**Propósito:** Fase 2 — promover ao namespace `dia-test` (UAT) o **mesmo digest** já no ACR, sem rebuild (ADR-0010/0062).
**Jobs:** `preflight` (exige `K8S_DEPLOY_ENABLED`, `DIA_TEST_NAMESPACE`, `KUBE_CONFIG_TEST`, `DIA_TEST_GATE_CONFIRMED`); `deploy` (no **GitHub Environment `test`** = gate humano com required reviewers): resolve digest via `resolve-image-digest.sh` (path sha) ou baixa artefatos (legado), `helm upgrade --install rental-app` com `values-test.yaml`, depois observabilidade em `dia-observability`.
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:read`,`actions:read`; `KUBE_CONFIG_TEST`, `ACR_*`. Concorrência `deploy-test`, sem cancelar. Gate = write-access (dispatch manual).
**Saídas:** deploy em `dia-test` (dados isolados); observabilidade.
**Dependências:** `build-images.yml`, branch `releases-ledger`, charts `app`/`observability`, runbook de promoção.

## deploy-prod.yml
**Gatilhos:** só `workflow_dispatch` — inputs `sha` (preferido), `build_run_id`, `sha_tag`.
**Propósito:** promover digests imutáveis a `dia-prod` (nunca reconstrói).
**Jobs:** `preflight` (`DIA_PROD_GATE_CONFIRMED`, `KUBE_CONFIG_PROD`); `deploy` vinculado ao **Environment `prod`** (aprovação humana): resolve digest, `helm upgrade --install rental-app` com `values-prod.yaml` + observabilidade.
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:read`,`actions:read`; `KUBE_CONFIG_PROD`, `ACR_*`. Concorrência `deploy-prod`, sem cancelar. Sem rollback automático declarado.
**Saídas:** releases `rental-app` e `observability` em prod.
**Dependências:** `resolve-image-digest.sh`, charts, `build-images.yml`, downstream `smoke-dev-test-prod`.

---

# Banda: Verify (deployado / nightly)

## code-quality.yml
**Gatilhos:** diário 04:00 + `workflow_dispatch` (sem trigger de PR — fora do caminho crítico).
**Propósito:** SAST profundo **report-only** → backlog que a factory queima; um agente abre tickets dedup.
**Jobs:** `codeql` (matrix js/python, `continue-on-error`); `scan` (30min: tsc, eslint, ruff, shellcheck, hadolint, gitleaks, semgrep, trivy, npm-audit, pip-audit → `quality-compute.mjs` → artefato `quality-findings` 14d + registra metric `quality` em `ci-history`); `review` (LLM `code-quality-reviewer` abre tickets dedup).
**Determinístico vs LLM:** `codeql`+`scan` determinísticos; `review` é LLM.
**Permissões/segredos:** `contents:read` (scan eleva p/ `write`+`security-events:read`; review p/ `issues:write`); `GITHUB_TOKEN`, `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`.
**Saídas:** artefato findings; commit em `ci-history`; alertas CodeQL; issues dedup.
**Dependências:** `quality-compute.mjs`, `qa-targets.mjs` (SLOs `qa-targets.json`).

## e2e-dev.yml
**Gatilhos:** cron `17 * * * *`; `workflow_run` de "Deploy Dev" (completed); `workflow_dispatch`.
**Propósito:** smoke Playwright contra o dev **deployado** (browser real, multi-role); porta do ledger de releases.
**Jobs:** `e2e` (gating: 7 specs smoke/auth/roles/ops-findings/ops-approval/dispatch/branch-counts; artefato `smoke-results`); `e2e-failure-sentinel` (incidente dedup via `incident-upsert-cli.ts`, fingerprint `e2e-dev-failure`); `entity-drilldown` (gating); `experience` (não-gating); `publish-history` (grava `runs.jsonl`+`trend.svg` na branch `e2e-history`; se veio de deploy-dev OK e smoke passou → `release-ledger-record.mjs` grava SHA known-good na branch `releases-ledger`).
**Determinístico vs LLM:** 100% determinístico.
**Permissões/segredos:** `contents:write` (push ledgers), `issues:write` (sentinel); credenciais de 4 roles + `E2E_SUPABASE_SERVICE_KEY/ANON_KEY`. Concorrência `e2e-dev`, `cancel-in-progress:true`.
**Saídas:** branches `e2e-history` e `releases-ledger`; incidentes; artefatos.
**Dependências:** `e2e-history-record.mjs`, `e2e-history-render.mjs`, `release-ledger-record.mjs`; depende de `deploy-dev`.

## visual-ux.yml
**Gatilhos:** diário 05:00 + `workflow_dispatch`.
**Propósito:** review visual diário **não-bloqueante** → backlog de UX/acessibilidade.
**Jobs:** captura (`playwright.visual.config.ts` com `CAPTURE_UX=1` → screenshots desktop+mobile + axe-core via `ux-capture.fixture.ts`); reflexão (LLM `ux-vision-reviewer` envia screenshots ao modelo de visão → abre tickets `ux` dedup); upload `visual-ux-artifacts` (14d).
**Determinístico vs LLM:** captura determinística; crítica é LLM (modelo de visão).
**Permissões/segredos:** `contents:read`,`issues:write`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`, credenciais E2E. Timeout 120min (reflexão 35).
**Saídas:** issues `ux` dedup; artefato de screenshots/axe.
**Dependências:** `ux-vision-reviewer.agent.md`, `experience.spec.ts`, runtime compartilhado.

---

# Banda: Agents (cadência + ciclo de PR)

## pipeline-fast.yml
**Gatilhos:** cron `*/15 * * * *` (timer-only, intencional p/ evitar self-cancellation thrash) + `workflow_dispatch`.
**Propósito:** uma passagem curta (~15min) de triagem/review de PRs e issues (ADR-0025). Merges ficam no `pr-loop`.
**Jobs/estágios (cada um `run-agent.ts --agent X`):** 1) `product-owner` (triagem); 2-4 condicionais por label (`database-steward`/`security-reviewer`/`platform-engineer`); 5) `tech-reviewer` (timeout 1200s).
**Determinístico vs LLM:** orquestração (seleção condicional por label, timeouts, summary) determinística; cada estágio é sessão LLM (modelo gpt-5.x).
**Permissões/segredos:** `contents:read`,`issues:write`,`pull-requests:write`,`actions:write`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Concorrência `pipeline-fast`, sem cancelar.
**Saídas:** labels/comentários/aprovações; Step Summary.
**Dependências:** `run-agent.ts`, `agent-loader.ts`, `factory-config.ts`, `permissions.ts`; alimenta `pr-loop`.

## pipeline-hourly.yml
**Gatilhos:** cron `30 * * * *` (offset do fast) + `workflow_dispatch`.
**Propósito:** cadência horária — backlog→specs e vigilância de qualidade/ops, separando lane pública de privada.
**Jobs:** `pipeline_public` (45min: `factory-architect`→`qa-manager`→`operations-manager` public); `private_lane_preflight` (valida secrets/runner self-hosted); `pipeline_private` (self-hosted: `operations-manager` private + `cluster-guardian`); `private_lane_degraded` (exit 1 se preflight falha).
**Determinístico vs LLM:** estágios produtivos LLM; preflight/summary determinísticos.
**Permissões/segredos:** `contents:read`,`issues:write`,...; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Concorrência sem cancelar.
**Saídas:** issues/PRs; Step Summary; falha explícita se lane privada degradada.
**Dependências:** `run-agent.ts`, `.github/agents/*`, `.github/factory.yml`.

## pipeline-daily.yml
**Gatilhos:** diário 06:00 + `workflow_dispatch`.
**Propósito:** varreduras diárias: docs, release-notes e discovery de produto.
**Jobs/estágios:** `docs-improver`, `user-docs-manager`, `release-notes-curator`, `release-marketer`, **`release-notes-publish.sh`** (determinístico, abre PR), `trend-analyst`, `market-scout`, `product-strategist` (15min), `discovery-critic`, **`discovery-publish.sh`** (determinístico, abre PR). Todos `continue-on-error`.
**Determinístico vs LLM:** estágios de publish são scripts bash; demais são LLM.
**Permissões/segredos:** mínimas + `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Concorrência sem cancelar.
**Saídas:** issues (docs/trends), 2 PRs noturnos (release-notes, discovery).
**Dependências:** `run-agent.ts`, `scripts/release-notes-publish.sh`, `scripts/discovery-publish.sh`.

## pipeline-weekly.yml
**Gatilhos:** diário 07:00 (provisório; intenção semanal/domingo) + `workflow_dispatch`.
**Propósito:** reflexão e roadmap — mantém `docs/agentic-charter.md` e o modelo operacional `docs/discovery/domain/`.
**Jobs/estágios:** `agentic-reflector` (LLM 18min) → **`agentic-charter-publish.sh`**; `domain-cartographer` (LLM 48min) → **`operating-model-reconcile.sh`** (marca tarefas `supported` por issues fechadas com tag `<role>:<task-id>`) → **`operating-model-publish.sh`** → **`operating-model-epics.sh`** (1 epic por papel em `queue:product`).
**Determinístico vs LLM:** 2 estágios LLM; 4 scripts bash determinísticos.
**Permissões/segredos:** mínimas + `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`.
**Saídas:** PRs (charter, modelo operacional); issues/epics.
**Dependências:** scripts `operating-model-*`, `agentic-charter-publish.sh`.

## pr-loop.yml
**Gatilhos:** `workflow_run`("Build Images" completed) + cron `*/30` (backstop) + `workflow_dispatch`.
**Propósito:** loop por-PR — uma sessão LLM **independente e curta por PR** + sessão final de atribuição. Extraído do `pipeline-fast` porque como estágio de 20min só cobria ~12 PRs/passagem.
**Jobs:** checkout → Node 22 → `npm ci` → injeta PAT como credencial git local → `npx tsx src/run-pr-pipeline.ts` (`timeout 17400`).
**Determinístico vs LLM:** `run-pr-pipeline.ts` é o **orquestrador determinístico** (snapshots, ordem oldest-first, filtro acionável, ledger de stuck, budgets); o LLM (`project-manager.agent.md`) só vê 1 PR por sessão.
**Ferramentas TS:** `run-pr-pipeline`, `pr-snapshot` (1 query GraphQL batched), `pr-ordering` (ordem+skip conservador), `pr-state` (ledger de stuck via fingerprint, exclui commits do ci-retrigger), `ci-retrigger` (commit vazio p/ desbloquear CI travada por gate de ator, cap 75 PRs).
**Permissões/segredos:** `contents:read`,`issues:write`,`pull-requests:write`,`actions:write`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Job 300min/loop 270min/por-PR 8min. Concorrência `pr-loop`, sem cancelar (coalescing).
**Saídas:** marcadores de estado nos PRs; commits vazios (ci-retrigger); merges/labels/atribuições; Step Summary.
**Dependências:** contrato `test_pipeline_fast_workflow_contract.py`; `@github/copilot-sdk`.

## agent-tech-reviewer.yml
**Gatilhos:** `workflow_run`("Build Images") + cron `*/15` + `workflow_dispatch`.
**Propósito:** Tech Reviewer LLM inspeciona PRs `queue:review` e emite veredito terminal (aprovar/solicitar mudanças). A fila de merge depende exclusivamente dessa aprovação.
**Jobs:** checkout → Node 22 → `npm ci` → `run-agent.ts --agent tech-reviewer`.
**Determinístico vs LLM:** infra determinística; passo do agente é LLM (gpt-5.4, ferramenta `gh`). Timeout 20min (frontmatter).
**Permissões/segredos:** `contents:read`,`pull-requests:write`,`issues:write`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Concorrência sem cancelar.
**Saídas:** `gh pr review --approve` ou label `tech-approved`; `--request-changes`; labels; autoria de ADRs; Step Summary.
**Dependências:** `tech-reviewer.agent.md`, runtime compartilhado.

## roadmap-curation.yml
**Gatilhos:** diário 03:30 (antes do daily) + `workflow_dispatch`.
**Propósito:** higiene do Project #15 — mantém hierarquia **Initiative→Epic→Story** (sem órfãs; toda issue no board).
**Jobs:** checkout → Node 22 → `npm ci` → Preflight (exige `COPILOT_TOKEN`) → `roadmap-curator` (LLM claude-sonnet-4.6, 35min) → Summarise → falha visível se curator erra.
**Determinístico vs LLM:** preflight/summary determinísticos; curadoria é LLM (lê runbook, resolve IDs do Project via GraphQL). Design convergente/idempotente.
**Permissões/segredos:** `contents:read`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT` (escopos project+issues). Job 40min.
**Saídas:** sub-issues (GraphQL `addSubIssue`), itens no Project, novas Initiatives/Epics (cap ~6), campos Queue/Phase/Risk.
**Dependências:** `roadmap-curator.agent.md`, `docs/runbooks/project-board-ops.md`.

---

# Banda: Monitor

## monitor-actions.yml
**Gatilhos:** cron `*/15` + `workflow_dispatch`.
**Propósito:** vigiar a fila do GitHub Actions — investigar (ler logs reais), achar causa raiz e abrir incidentes precisos dedup.
**Jobs:** checkout → Node 22 → `npm ci` → `run-agent.ts --agent actions-monitor`.
**Determinístico vs LLM:** LLM (gpt-5.4, ferramenta `gh`) decide quais runs/logs investigar; dedupe é determinística.
**Permissões/segredos:** `contents:read`,`issues:write`,`actions:write`; `PROJECT_MANAGER_PAT`, `AZURE_API_KEY/BASE/VERSION`. Sem cancelar.
**Saídas:** issues dedup via `incident-upsert` + `dedupe` (fingerprints `shared-cause-<sha>` / `factory-stuck-pr-<n>`).
**Dependências:** `actions-monitor.agent.md`, `incident-upsert.ts`, `dedupe.ts`.

## monitor-deploy.yml
**Gatilhos:** `workflow_run`("Deploy Dev"/"E2E dev") com conclusão `failure`; `workflow_dispatch` (`run_id` opcional).
**Propósito:** eliminar "silent deployment failure" — event-driven no exato momento da falha (o monitor-actions só vê 40 runs recentes).
**Jobs:** `sentinel` (só se `failure`): checkout → Node 22 → `npm ci` → `run-agent.ts --agent deploy-sentinel`.
**Determinístico vs LLM:** LLM (gpt-5.4) lê logs, classifica em buckets (helm-lock/image-pull/bootstrap/smoke/timeout/startup/other), dedup, abre/atualiza issues. Nunca toca cluster.
**Permissões/segredos:** `contents:read`,`issues:write`,`actions:read`; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Concorrência por `run_id`, sem cancelar. Timeout 12min.
**Saídas:** issues `auto:deploy`/`priority:critical`/`queue:platform`.
**Dependências:** `deploy-sentinel.agent.md`, `gh`.

## monitor-ops.yml
**Gatilhos:** cron `*/15` + `workflow_dispatch`. Timeout 12min.
**Propósito:** Ops Monitor da Operations Factory — 3 checagens: (1) runs de ops falhos/travados (>30min) nas últimas 4h; (2) aprovações além do SLA (24h; 4h se severidade alta ou impacto ≥ $1000); (3) anomalia zero-finding (≥3 runs consecutivos sem incidente).
**Jobs:** checkout → Node 22 → `npm ci` → `run-agent.ts --agent ops-monitor`.
**Determinístico vs LLM:** LLM (gpt-5.4) raciocina e decide incidentes; sem triagem determinística.
**Permissões/segredos:** `contents:read`,`issues:write`,`actions:read`; `PROJECT_MANAGER_PAT`, `AZURE_API_*`. Opcional `SUPABASE_URL/SERVICE_ROLE_KEY` (lê `ops_agent_status_view`).
**Saídas:** Step Summary (tabela de saúde); issues `auto:ops`/`queue:ops`, fingerprint `ops-monitor:<tenant>:<agent>:<failure_kind>:<scope>` (máx 3/run).
**Dependências:** `ops-monitor.agent.md`, `OPERATIONS.md`, `gh`/`curl`.

## alert-incident-bridge.yml
**Gatilhos:** `repository_dispatch` (event-type `alertmanager-alert`, chamado pelo adaptador webhook do Alertmanager) + `workflow_dispatch` (payload sintético `TemporalWorkerDown` p/ teste).
**Propósito:** ponte Alertmanager(Prometheus) → GitHub Issues deduplicadas (`auto:alert`,`queue:ops`).
**Jobs:** `bridge` — Node 22 → `npm ci` → resolve payload (valida JSON, grava em `/tmp`) → `alert-incident-bridge.ts --payload <json>`.
**Determinístico vs LLM:** 100% determinístico (TS puro).
**Permissões/segredos:** `contents:read`,`issues:write`; só `GITHUB_TOKEN`. Concorrência sem cancelar.
**Saídas:** por alerta: `created`/`updated`(re-notifica)/`resolved`.
**Dependências:** `alert-incident-bridge.ts` (orquestra), `alert-github-client.ts` (REST via fetch), `incident-upsert.ts` (classifica pr-local/shared-cause), `dedupe.ts` (SHA-256→fingerprint + marcador HTML).

## agent-cluster-guardian.yml
**Gatilhos:** cron `:45` (offset do hourly :30) + `workflow_dispatch` (`run_remediation`, default false).
**Propósito:** monitorar saúde dos namespaces `dia-*` no AKS em **read-only**; remediação é opt-in manual com aprovação humana.
**Jobs:** `preflight` (valida secrets, perfil `kubernetes-app`, allowlist `dia-*`, runner self-hosted online); `detect` (lane self-hosted, `cluster-guardian` read-only); `remediate` (só se dispatch + `run_remediation=true` + **Environment `cluster-remediation`** aprovado → `cluster-remediator` com mutação); `detect_degraded` (se preflight falha).
**Determinístico vs LLM:** preflight/summary determinísticos; detect/remediate são LLM.
**Permissões/segredos:** `contents:read`,`issues:write`,...; `COPILOT_TOKEN`, `PROJECT_MANAGER_PAT`. Acesso ao cluster via runner privado (não kubeconfig em segredo). Sem cancelar.
**Saídas:** Step Summaries; incidentes; mutações no cluster só sob os 4 gates.
**Dependências:** `cluster-guardian.agent.md`, `cluster-remediator.agent.md`, `factory.yml`.

---

# Espinha determinística transversal (padrões reaproveitados)

1. **Fingerprint SHA-256 → ID estável** (`dedupe.ts`): marcador `<!-- fingerprint:id -->` no corpo da issue é a primitiva canônica de dedupe de incidentes (usada por monitor-*, alert-bridge, e2e-sentinel) — espelhada no `finding.fingerprint` do produto.
2. **Promoção por digest imutável** (ADR-0010/0062): build grava digest; deploys resolvem o digest pelo `:<sha>` no ACR (`resolve-image-digest.sh`); `releases-ledger` guarda os known-good.
3. **Ledgers append-only em branches órfãs:** `ci-history`, `e2e-history` (runs.jsonl + trend.svg), `releases-ledger`.
4. **Gates desacoplados + human gate via GitHub Environments:** `test`/`prod`/`cluster-remediation` exigem required reviewers; preflight separa pré-requisitos.
5. **Concorrência `cancel-in-progress: false`** na maioria (promoções/monitores nunca são descartados; coalescing de eventos), exceto validação/enriquecimento por-PR.
6. **Orquestração determinística envolvendo o LLM:** ordem, skip, budgets, timeouts, ledger de stuck e seleção condicional por label são código; o LLM só faz o julgamento e nunca vê a fila inteira.
7. **Report-only → ratchet a gating:** novos checks entram sem bloquear e só viram gate quando a contagem segura no alvo (`qa-targets.json`).

> **Observação:** nesta cópia o diretório está como `.github/workflows.disabled/` — nenhum desses
> workflows dispara automaticamente aqui. Em produção, a esteira encadeia:
> `build-images` → `deploy-dev` → `e2e-dev` (stamp known-good) → promoção manual `deploy-test`/`deploy-prod`;
> em paralelo, as pipelines de cadência e os monitores rodam por cron/eventos.
