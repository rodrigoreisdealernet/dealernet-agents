# /recreate-stack

Destrói, rebuilda e sobe **toda a stack local do zero com dados limpos (seed only)** e valida que tudo está funcionando. Encapsula o runbook manual de recriação do ambiente: derruba os containers, zera o Supabase, reconstrói a imagem da aplicação, reaplica migrations + seed, recria os usuários demo, sobe a stack e verifica a saúde de ponta a ponta.

## Usage

```
/recreate-stack                     # rebuild completo (--no-cache) + verificação
/recreate-stack --no-build          # pula o rebuild da imagem (reuso da imagem atual; mais rápido)
/recreate-stack --with-frontend     # também sobe o frontend-portal (Vite dev)
```

## What this command does

Cada execução **zera os dados do Supabase** (estado limpo, somente seed). Fases:

1. **Preflight** — confere `docker`, `supabase` CLI, `curl`, `docker compose` v2 e os arquivos `.env` e `frontend-portal/.env.local` (credenciais demo). Segredos nunca são impressos nem commitados.
2. **Teardown** — `docker compose -f docker-compose.dia-ops.yml down -v` e `supabase stop --no-backup` (wipe dos volumes).
3. **Rebuild** — `docker compose -f docker-compose.dia-ops.yml build --no-cache` reconstrói `dia-ops-app:local` (worker Temporal + ops-api). Pulado com `--no-build`.
4. **Supabase do zero** — `supabase start` aplica todas as migrations e `seed.sql` automaticamente; valida que migrations > 0 e `public.entities` > 0.
5. **Usuários demo** — reaproveita `scripts/seed-demo-users.sh` (com `DEMO_TENANT` explícito e um shim de `psql` que encaminha para o container quando o host não tem `psql`); valida que ≥ 4 usuários `@dia-rental.dev` existem.
6. **Sobe dia-ops** — `docker compose -f docker-compose.dia-ops.yml up -d`.
7. **Frontend (opcional)** — com `--with-frontend`, sobe `frontend-portal` em Vite dev (`CHOKIDAR_USEPOLLING=1` por causa do `/mnt/c`/WSL) ou reaproveita um já em execução.
8. **Verificação** — espera o `ops-api` responder `200` em `/docs`, confere `Worker started` nos logs do worker e testa o login demo no GoTrue (`200`). Imprime um resumo com todos os endpoints e sai com código ≠ 0 se algo falhar.

## Implementation

Toda a lógica robusta vive em `scripts/recreate-stack.sh` (fonte da verdade executável). O comando apenas o invoca, repassando os argumentos:

```bash
bash scripts/recreate-stack.sh $ARGUMENTS
```

## Notes & gotchas

- **Destrutivo por design.** O objetivo é um ambiente limpo e reproduzível; não use se precisar preservar dados locais.
- **DB Supabase compartilhado:** este comando usa `supabase stop --no-backup` + `supabase start --ignore-health-check` (não `supabase db reset`), recriando o ambiente do zero. O `--ignore-health-check` evita que o container `storage` (não usado pelo app, e lento para vincular a porta em `/mnt/c`) derrube DB/Auth/REST por timeout do health check; esses serviços são validados explicitamente nas fases finais. Não rode em paralelo com outras sessões que dependem do mesmo Supabase local.
- **Credenciais demo** vêm de `frontend-portal/.env.local` (`VITE_DEMO_EMAIL`, `VITE_DEMO_PASSWORD`, `VITE_SUPABASE_ANON_KEY`) e a `SUPABASE_SERVICE_ROLE_KEY` de `.env` — ambos gitignored.
- **Endpoints após sucesso:** Portal `:5174` (com `--with-frontend`), Supabase API `:54331`, Studio `:54333`, ops-api `:8000/docs`, Temporal UI `:8088`.
