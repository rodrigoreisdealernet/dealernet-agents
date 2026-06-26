# Spec — Issue #109: CI Frontend Portal Tests falha com `node: bad option: --experimental-strip-types`

## Overview
O job de CI **Frontend Portal (lint, build, test)** falha de forma sistemática no
`main` no step **Tests**, com `node: bad option: --experimental-strip-types`
(exit 9). O objetivo é restaurar o sinal verde do job sem perder a capacidade de
type-stripping de que os testes dependem.

## Problem / Context
- O script `test` em `frontend-portal/package.json` invoca
  `node --test --experimental-strip-types scripts/verify-*.mjs`.
- `--experimental-strip-types` só existe a partir do **Node 22.6**.
- O workflow `.github/workflows/ci.yml` configura `actions/setup-node` com
  `node-version: '20'` → a flag não é reconhecida → `exit 9`.
- A flag **é necessária**: `frontend-portal/scripts/verify-kpi-format.mjs` importa
  diretamente um módulo TypeScript
  (`import { formatBRL, formatBRLKpi } from '../src/portal/renderers/screens/format.ts'`),
  que exige type-stripping em runtime. Portanto **remover** a flag quebraria esse
  teste — a correção correta é **alinhar a versão do Node** do runner (≥ 22.6),
  consistente com o ambiente local (Node 22.x) onde `npm test` passa.

## Acceptance Criteria
1. **Dado** o job "Frontend Portal (lint, build, test)" no CI, **quando** o step
   Tests roda `npm test`, **então** ele executa sem o erro
   `node: bad option: --experimental-strip-types`.
2. **Dado** o runner de CI, **quando** `actions/setup-node` provê o Node,
   **então** a versão é ≥ 22.6 (alinhada à exigida por `--experimental-strip-types`
   e ao ambiente local).
3. **Dado** o teste `verify-kpi-format.mjs` que importa `format.ts`, **quando**
   `npm test` roda no CI, **então** o type-stripping continua funcionando (o teste
   passa, a flag é preservada).
4. **Dado** o job completo, **quando** o CI roda no `main`, **então** os steps
   lint, build e test passam (job verde).

## Non-Goals
- Reescrever os scripts `verify-*.mjs` ou migrar a estratégia de testes.
- Alterar o script `test` do `package.json` (a flag permanece, pois é necessária).
- Mexer em outros jobs do `ci.yml` além do alinhamento de versão do Node do job
  frontend.

## Out-of-scope
- Issue #70 (metering) — não relacionada.
- Bump de dependências npm ou refactor do `frontend-portal`.
