# SPEC: Alinhar documentação de arquitetura/ops ao estado real dos workflows

Issue: #50

## Overview

Alinhar os documentos de arquitetura e operações para refletir o estado real:
apenas `ci.yml` está ativo em `.github/workflows/`; os demais workflows (deploy,
cadência da fábrica, monitoramento, e2e) estão desativados em
`.github/workflows.disabled/`. A documentação hoje afirma que estes workflows
rodam automaticamente (horário, diário, semanal, por merge), induzindo ao erro.

## Problem / Context

- **Realidade atual**: Toda a automação de CI/CD e da "software factory" no
  GitHub Actions está desativada. Apenas `ci.yml` (validação) está ativo.
- **Documentação divergente**: Docs de arquitetura e operações (`MONITORING.md`,
  `OPERATIONS.md`, `docs/architecture/ci-cd-pipelines.md`,
  `docs/architecture/software-factory.md`, `docs/architecture/operations-factory.md`)
  descrevem:
  - Pipelines de cadência rodando **nightly** (`pipeline-daily`), **hourly**
    (`pipeline-hourly`), **per-PR** (`pipeline-fast`), **semanal**
    (`pipeline-weekly`).
  - Agentes funcionando **automaticamente** em GitHub Actions via cron.
  - Deploy automático para dev (pós-merge), testes E2E executando horariamente,
    monitoramento contínuo.
- **Impacto**: Leitores (maintainers, contributors) esperam automação que não
  existe; podem tentar ativar workflows que precisam de ajustes, ou perder
  confiança na documentação.
- **Realidade omitida**: A fábrica *hoje* funciona via skills locais do Claude
  Code (`/ship-issue`, `/ship-batch`), não via cron/Actions.

## Acceptance Criteria

- `MONITORING.md` não instrui o leitor a monitorar cron/schedule events que estão
  desativados. Deixa claro: (1) quais pipelines estão desativados; (2) como a
  fábrica atualmente opera (skills locais).
- `OPERATIONS.md` remove ou marca como "desativado" toda instrução de
  troubleshooting/operação para workflows em `workflows.disabled/`. Aclara o
  status de deploy automático, E2E scheduler, e monitoramento contínuo.
- `docs/architecture/ci-cd-pipelines.md` nota explicitamente que as pipelines
  descritas ("agent clock"/cadência) estão em `workflows.disabled/` e não rodam
  automaticamente hoje. Separa o que roda (`ci.yml`) do que está parado
  (`pipeline-fast`, `pipeline-hourly`, `pipeline-daily`, `pipeline-weekly`, etc.).
- `docs/architecture/software-factory.md` e
  `docs/architecture/operations-factory.md` removem ou contextualizam claims de
  "agentes rodando em GitHub Actions em cadência"; onde mencionam cron/schedule,
  deixam claro que está em `workflows.disabled/`.
- Nenhuma página de arquitetura/ops afirma "roda nightly/hourly/per-merge" para um
  workflow que está desativado, sem indicar explicitamente que está parado.
- Não há instruções operacionais "vivas" (ex.: "aprove o deploy de prod", "dispare
  pipeline-hourly") apresentadas como ativas para workflows desativados.

## Non-Goals

- Reativar workflows desativados — apenas documentar o estado real.
- Redesenhar a arquitetura da fábrica — apenas alinhar documentação à realidade.
- Adicionar instruções para reativar workflows.

## Out-of-Scope

- Mudanças em qualquer YAML de workflow (ativos ou em `workflows.disabled/`).
- Decisão de quando/como reativar a automação (refatoração futura).
- Templates em `doc_templates/` — apenas docs em produção
  (`docs/architecture/*`, `MONITORING.md`, `OPERATIONS.md`, ADRs afetados).
- ADRs que descrevem decisões históricas, exceto onde fazem claims sobre
  automação *atualmente ativa*.
