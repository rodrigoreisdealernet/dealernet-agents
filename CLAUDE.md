# CLAUDE.md — mapa de entrada do repositório

**O produto:** DMS automotivo com BI agêntico **DIA** — Portal DMS para concessionárias (React 18 + Vite + Tailwind), workers **Temporal** em Python e Postgres **Supabase** auto-hospedado.

> O narrativo de aluguel de equipamentos (template Wynne) ainda presente no [`README.md`](./README.md) está em correção (issue #41). Para a identidade do produto, confie neste CLAUDE.md.
>
> Este é o documento canônico de contribuição. **`AGENTS.md` é um symlink para `CLAUDE.md`** — leia este arquivo; ferramentas que procuram `AGENTS.md` enxergam o mesmo conteúdo.

## Comece por aqui (leia antes de mudar código)

1. A **issue + critérios de aceite** que você está atendendo (e a spec aprovada em [`docs/specs/`](./docs/specs/)).
2. ADRs relevantes em [`docs/adrs/`](./docs/adrs/) — as decisões dentro das quais você trabalha.
3. [`README.md`](./README.md) — produto, ambientes e comandos; [`docs/architecture/`](./docs/architecture/README.md) para os diagramas do sistema.
4. **Ao mexer em schema:** [`DATABASE.md`](./DATABASE.md) (modelo de entidade genérico + SCD2), [`Guide_for_agents_using_supabase_template.md`](./Guide_for_agents_using_supabase_template.md) e [`Generalisable_schema.md`](./Generalisable_schema.md).

## Arquitetura em uma tela

O produto roda sobre Supabase (Postgres + PostgREST), com operações orquestradas no Temporal. Duas fábricas autônomas o sustentam: a **software factory** ([`.github/`](./.github/) — agentes por papel + GitHub Actions) que projeta, constrói e entrega o produto; e a **Operations Factory** (Temporal + Azure OpenAI) que automatiza o back-office para quem usa o software. Diagramas: [`docs/architecture/`](./docs/architecture/README.md).

## Mapa do repositório

| Caminho | O que tem lá |
|---------|--------------|
| [`frontend-portal/`](./frontend-portal/) | Portal DMS (React 18 + Vite + Tailwind); gerenciador de janelas MDI; telas nativas em `src/portal/renderers/screens/` |
| [`temporal/`](./temporal/) | Workers Python — workflows, activities e testes pytest ([`temporal/tests/`](./temporal/tests/)) |
| [`supabase/`](./supabase/) | `config.toml`, `migrations/*.sql` (ordem por timestamp), `seed.sql` e testes de contrato RLS ([`supabase/tests/`](./supabase/tests/)) |
| [`charts/`](./charts/) | Helm charts (app, monitoramento, observabilidade) |
| [`deploy/`](./deploy/) | Superfície de deploy Kubernetes + OpenBao |
| [`scripts/`](./scripts/) | Scripts de bootstrap e ops |
| [`doc_templates/`](./doc_templates/) | Templates de documentação reutilizáveis |
| [`.github/`](./.github/) | Software factory — agentes (`agents/`) e workflows (`workflows/`) |
| [`docs/`](./docs/) | [arquitetura](./docs/architecture/README.md), [ADRs](./docs/adrs/), [specs](./docs/specs/), [discovery](./docs/discovery/), [runbooks](./docs/runbooks/) |

## Estrutura & organização de módulos

- A documentação de mais alto nível vive na raiz ([`README.md`](./README.md), [`DATABASE.md`](./DATABASE.md), [`Guide_for_agents_using_supabase_template.md`](./Guide_for_agents_using_supabase_template.md), [`Generalisable_schema.md`](./Generalisable_schema.md)) — é o caminho mais rápido para entender schema e roadmap. Templates reutilizáveis em [`doc_templates/`](./doc_templates/).
- Assets do Supabase em [`supabase/`](./supabase/): `config.toml` (config da CLI), `migrations/*.sql` (ordenadas por timestamp) e `seed.sql` (carrega após as migrations).
- O código da aplicação está versionado: [`frontend-portal/`](./frontend-portal/) (Portal DMS, telas nativas em `src/portal/renderers/screens/`) e [`temporal/`](./temporal/) (worker Python em `src/`). O antigo `frontend/` (dia-frontend, motor de UI dirigido por JSON sobre o domínio Wynne) foi removido junto com a poda do schema do domínio Wynne.
- Migrations seguem padrão modular (model `core` primeiro, `analytics` em seguida). Coloque novas tabelas de domínio em **novos** arquivos de migration, sem editar os já publicados.

## Build, testes e desenvolvimento (comandos)

- `supabase start` — sobe o stack Supabase local (Postgres, Studio, API, Realtime) usando `supabase/config.toml`. Requer Docker e a Supabase CLI.
- `supabase db reset --config supabase/config.toml` — recria o banco local, aplica todas as migrations em ordem e roda `seed.sql`. Rode antes de abrir um PR para manter as migrations verdes — **exceto** no ambiente compartilhado (veja Gotchas).
- Stack completo (Supabase stub + Temporal + frontend) via Makefile: `make up` (use `USE_DEV=1 make up` para live-reload), `make down`, `make reset` (derruba volumes e recria), `make logs` / `make logs-temporal` / `make logs-frontend`.

## Estilo de código & convenções

- SQL em snake_case com PKs UUID (`default gen_random_uuid()`), colunas de timestamp `created_at`/`updated_at`, e booleanos como `is_current` para status SCD2.
- Prefira `jsonb` para payloads flexíveis (`entity_versions.data`, `time_series_points.data`); use fatos numéricos em `entity_facts` com referências claras a `fact_type`.
- Migrations são nomeadas `YYYYMMDDHHMMSS_descricao.sql`; mantenha-as idempotentes onde for prático (`create table if not exists`) e agrupe mudanças relacionadas.

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

### Commits & PRs

- O histórico favorece assuntos curtos e imperativos (ex.: "Renamed parent_entity_id…", "Add project overview"), com `feat:` ocasional. Mantenha o assunto ≤72 caracteres; adicione contexto no corpo quando necessário.
- Em descrições de PR inclua: propósito, resumo das mudanças de schema (tabelas, colunas, constraints), nomes dos arquivos de migration, impacto no seed e tarefas de follow-up. Linke issues quando aplicável; screenshots só quando houver mudança de UI.

## Validação / checks

```bash
cd frontend-portal && npm run lint && npm run build && npm test
python -m pytest temporal/tests/ -v
node --test --test-concurrency=1 supabase/tests/*.test.mjs
```

Ainda não há uma suíte automatizada ampla; para mudanças de schema, confie na Supabase CLI como verificação de segurança (`supabase db reset --config supabase/config.toml` para validar migrations + seed) ou, no ambiente compartilhado, no `docker exec ... psql` acima. Para QA manual, suba o stack e confira tabelas/funções novas via `psql` ou Supabase Studio antes de commitar.

## Logging

- **Regra de uma linha:** mensagens de log em uma única linha (não multi-linha) — garante eficiência com `grep`, filtragem com ferramentas Unix e análise automatizada. Se existir `docs/Logging.md`, siga-o no lugar desta regra.

## Segurança & configuração

- Não commite segredos (chaves de assinatura JWT, tokens Twilio etc.). Use variáveis de ambiente referenciadas nos comentários de `supabase/config.toml`.
- Mantenha configs de produção e local separadas; evite hard-coding de URLs ou credenciais em migrations ou seeds.

---

Este CLAUDE.md é o mapa canônico ([`AGENTS.md`](./AGENTS.md) é um symlink para ele): onde se sobrepõe a [`README.md`](./README.md) ou [`DATABASE.md`](./DATABASE.md), prevalecem esses docs vivos.

---

## AI-DLC — Spec Driven Development (framework instalado)

Este repositório usa o framework **AI-DLC** ([aidlc-workflows](https://github.com/rodrigoreisdealernet/aidlc-workflows), v1.0.0) para desenvolvimento orientado a especificação. Ao iniciar qualquer trabalho de desenvolvimento de software, **siga primeiro** o workflow abaixo; os detalhes das regras são resolvidos a partir de `.aidlc-rule-details/`.

@.github/instructions/ai-dlc-workflow.instructions.md
