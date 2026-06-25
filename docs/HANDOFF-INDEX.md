# Pacote de Reverse-Engineering & Handoff — Dealernet

> Índice dos documentos produzidos ao **levantar, executar e dissecar** o sistema de referência Dealernet
> nesta sessão. Objetivo: alimentar a **sessão oficial do produto** para implementar um produto similar.
> Estes arquivos são *artefatos de handoff* (engenharia reversa), não a documentação canônica do produto
> de referência (essa fica em `README.md`, `OPERATIONS.md`, `docs/architecture/`, `docs/adrs/`).

## Comece por aqui
1. **[handoff-product-planning.md](./handoff-product-planning.md)** — o briefing-mestre: o que é o
   sistema, stack, modelo de dados, **as 10 armadilhas reais**, e o que a sessão oficial deve produzir.
   *(É este que você cola/entrega na sessão oficial.)*

## Referências de arquitetura (engenharia reversa)
2. **[operations-factory-flow.md](./operations-factory-flow.md)** — o **produto**: ciclo agentic
   Temporal (scope→assess(LLM)→finding→approval) + 2 diagramas + pontos de design.
3. **[factory-workflows.md](./factory-workflows.md)** — a **software factory**: os 24 GitHub Actions
   workflows (6 bandas), tabela-mestre, espinha determinística + diagrama de encadeamento.
4. **[factory-agents.md](./factory-agents.md)** — os **27 agentes LLM** (`.agent.md`) + `factory.yml`
   + 2 diagramas (esteira PR→produção; cadências/monitores).

## Como rodar o sistema de referência localmente (validado nesta sessão)
- **Supabase isolado:** `npx supabase start` (project_id `dia`, portas 5433x) → app em
  `:54331`, Studio `:54333`. Frontend: `cd frontend && npm run dev -- --port 3010` (proxy `/api/ops`
  no `vite.config.ts`). Login admin: `admin@dia-rental.dev / DealernetAdmin#2026`.
- **Operations Factory:** `docker compose -p dia-ops --env-file .env.dia-ops -f
  docker-compose.dia-ops.yml up -d` → Temporal UI `:8088`, ops-api `:8000`. Worker/ops-api falam
  com o Supabase via `host.docker.internal:54331` + Azure OpenAI (`.env.dia-ops`).
- **Custo:** schedules do Temporal **deletadas/desabilitadas** (kill-switch). LLM só sob disparo manual.

## Mapa de leitura por objetivo
| Quero… | Leia |
|---|---|
| Entregar contexto à sessão oficial | `handoff-product-planning.md` |
| Replicar o ciclo de findings/aprovação | `operations-factory-flow.md` |
| Replicar a automação de CI/CD/agentes | `factory-workflows.md` + `factory-agents.md` |
| Evitar os erros que travaram a execução | §5 de `handoff-product-planning.md` |
