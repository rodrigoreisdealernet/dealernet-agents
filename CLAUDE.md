# CLAUDE.md — mapa de entrada do repositório

**O produto:** DMS automotivo com BI agêntico **DIA** — Portal DMS para concessionárias (React 18 + Vite + Tailwind), workers **Temporal** em Python e Postgres **Supabase** auto-hospedado.

> O narrativo de aluguel de equipamentos (template Wynne) ainda presente no [`README.md`](./README.md) está em correção (issue #41). Para a identidade do produto, confie neste CLAUDE.md.

## Comece por aqui (leia antes de mudar código)

1. A **issue + critérios de aceite** que você está atendendo (e a spec aprovada em [`docs/specs/`](./docs/specs/)).
2. ADRs relevantes em [`docs/adrs/`](./docs/adrs/) — as decisões dentro das quais você trabalha.
3. [`README.md`](./README.md) — produto, ambientes e comandos.
4. [`AGENTS.md`](./AGENTS.md) — convenções de código, commits/PR e comandos canônicos.
5. [`DATABASE.md`](./DATABASE.md) — modelo de entidade genérico + SCD2, **ao mexer em schema**.

## Arquitetura em uma tela

O produto roda sobre Supabase (Postgres + PostgREST), com operações orquestradas no Temporal. Duas fábricas autônomas o sustentam: a **software factory** ([`.github/`](./.github/) — agentes por papel + GitHub Actions) que projeta, constrói e entrega o produto; e a **Operations Factory** (Temporal + Azure OpenAI) que automatiza o back-office para quem usa o software. Diagramas: [`docs/architecture/`](./docs/architecture/README.md).

## Mapa do repositório

| Caminho | O que tem lá |
|---------|--------------|
| [`frontend-portal/`](./frontend-portal/) | Portal DMS (React 18 + Vite + Tailwind); telas nativas em `src/portal/renderers/screens/` |
| [`temporal/`](./temporal/) | Workers Python — workflows, activities e testes pytest ([`temporal/tests/`](./temporal/tests/)) |
| [`supabase/`](./supabase/) | Migrations, seed e testes de contrato RLS ([`supabase/tests/`](./supabase/tests/)) |
| [`charts/`](./charts/) | Helm charts (app, monitoramento, observabilidade) |
| [`deploy/`](./deploy/) | Superfície de deploy Kubernetes + OpenBao |
| [`scripts/`](./scripts/) | Scripts de bootstrap e ops |
| [`.github/`](./.github/) | Software factory — agentes (`agents/`) e workflows (`workflows/`) |
| [`docs/`](./docs/) | [arquitetura](./docs/architecture/README.md), [ADRs](./docs/adrs/), [specs](./docs/specs/), [discovery](./docs/discovery/), [runbooks](./docs/runbooks/) |

## Como entregar uma mudança

Use **`/ship-issue <n>`** ([`.claude/commands/ship-issue.md`](./.claude/commands/ship-issue.md)) para uma issue, ou **`/ship-batch`** ([`.claude/commands/ship-batch.md`](./.claude/commands/ship-batch.md)) para várias. Pipeline:

```
spec → approve → code → tests → test-review → code-review → PR
```

Os quatro papéis vivem em [`.claude/agents/`](./.claude/agents/) (`spec`, `coder`, `tester`, `reviewer`). Humanos entram em **dois gates**: aprovação da spec e merge do PR (no `/ship-batch` a spec é auto-aprovada; o gate humano é só o merge).

**Gotchas reais:**
- O frontend real é **`frontend-portal/`**, não o antigo `frontend/` (removido). Issues antigas citam caminhos do JSON-engine — ignore-os e descubra a estrutura real.
- **`rental_entity_type_catalog` é uma VIEW de `VALUES` hard-coded**, não tabela. Ao adicionar um entity_type, faça `create or replace` com a lista COMPLETA + o novo tipo — nunca derrube os existentes (suas current-state views ficam vazias).
- DB Supabase é **único e compartilhado**, sem CLI `supabase` no PATH. Valide SQL contra o container: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1` — **nunca** `supabase db reset` (quebra runs paralelos).

## Validação / checks

```bash
cd frontend-portal && npm run lint && npm run build && npm test
python -m pytest temporal/tests/ -v
node --test --test-concurrency=1 supabase/tests/*.test.mjs
```

---

Este CLAUDE.md é um mapa: onde ele se sobrepõe a [`README.md`](./README.md), [`AGENTS.md`](./AGENTS.md) ou [`DATABASE.md`](./DATABASE.md), prevalecem esses docs vivos.
