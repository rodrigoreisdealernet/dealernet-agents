#!/usr/bin/env bash
# recreate-stack.sh — destrói, rebuilda e sobe TODA a stack local do zero com
# dados limpos (seed only) e valida que tudo está funcionando.
#
# Replica, de forma idempotente e auditável, o runbook manual:
#   1. Preflight (docker, supabase CLI, curl, arquivos .env)
#   2. Derruba dia-ops (down -v) + Supabase com wipe (supabase stop --no-backup)
#   3. Rebuild da imagem da aplicação dia-ops-app:local (--no-cache; salvo --no-build)
#   4. supabase start  → aplica migrations + seed.sql automaticamente (estado limpo)
#   5. Seed dos usuários demo (reaproveita scripts/seed-demo-users.sh)
#   6. Sobe a stack dia-ops (up -d)
#   7. (opcional, --with-frontend) sobe o frontend-portal Vite dev
#   8. Verifica saúde (containers, ops-api, worker, login GoTrue, sanity do seed)
#
# Uso:
#   scripts/recreate-stack.sh [--no-build] [--with-frontend] [--help]
#
# Cada execução ZERA os dados do Supabase (seed only). Rode quando quiser um
# ambiente limpo e reproduzível. Segredos vêm de .env e frontend-portal/.env.local
# (ambos gitignored) — este script nunca imprime senhas nem as commita.
set -euo pipefail

# ── Configuração ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

DIA_COMPOSE="docker-compose.dia-ops.yml"
ENV_FILE=".env"
PORTAL_ENV="frontend-portal/.env.local"
SUPA_DB_PORT="54332"           # Postgres exposto pela Supabase CLI (config.toml [db].port)
DEFAULT_SUPA_URL="http://127.0.0.1:54331"
OPS_API_DOCS="http://127.0.0.1:8000/docs"
DEMO_TENANT_FALLBACK="demo-ops-a"
HEALTH_TIMEOUT=90              # segundos para ops-api responder

DO_BUILD=1
WITH_FRONTEND=0

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { printf '[recreate-stack] %s\n' "$*"; }
ok()   { printf '[recreate-stack]   ✓ %s\n' "$*"; }
warn() { printf '[recreate-stack]   ! %s\n' "$*" >&2; }
die()  { printf '[recreate-stack] ERRO: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# Lê uma chave KEY=VALUE de um arquivo dotenv, removendo aspas simples/duplas.
read_env() { # read_env <file> <key>
  local file="$1" key="$2" val
  [ -f "$file" ] || return 1
  val="$(grep -E "^${key}=" "$file" | head -n1 | cut -d= -f2-)" || return 1
  val="${val%$'\r'}"                       # remove CR (arquivos WSL/Windows)
  val="${val#[\"\']}"; val="${val%[\"\']}" # remove aspas externas
  printf '%s' "$val"
}

# ── Parse de argumentos ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)      DO_BUILD=0 ;;
    --with-frontend) WITH_FRONTEND=1 ;;
    -h|--help)       usage ;;
    *) die "argumento desconhecido: $1 (use --help)" ;;
  esac
  shift
done

# ── Fase 0 — Preflight ────────────────────────────────────────────────────────
log "Fase 0/8 — Preflight"
for bin in docker supabase curl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' não encontrado no PATH."
done
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) indisponível."
docker info >/dev/null 2>&1 || die "Docker daemon não está respondendo."
[ -f "$DIA_COMPOSE" ] || die "ausente: $DIA_COMPOSE (rode na raiz do repo)."
[ -f "supabase/config.toml" ] || die "ausente: supabase/config.toml."
[ -f "$ENV_FILE" ] || die "ausente: $ENV_FILE (precisa de SUPABASE_SERVICE_ROLE_KEY)."
[ -f "$PORTAL_ENV" ] || die "ausente: $PORTAL_ENV (credenciais demo)."

SUPA_URL="$(read_env "$PORTAL_ENV" VITE_SUPABASE_URL || true)"; SUPA_URL="${SUPA_URL:-$DEFAULT_SUPA_URL}"
ANON_KEY="$(read_env "$PORTAL_ENV" VITE_SUPABASE_ANON_KEY || true)"
DEMO_EMAIL="$(read_env "$PORTAL_ENV" VITE_DEMO_EMAIL || true)"
DEMO_PASS="$(read_env "$PORTAL_ENV" VITE_DEMO_PASSWORD || true)"
[ -n "${ANON_KEY:-}" ]  || die "VITE_SUPABASE_ANON_KEY ausente em $PORTAL_ENV."
[ -n "${DEMO_EMAIL:-}" ] || die "VITE_DEMO_EMAIL ausente em $PORTAL_ENV."
[ -n "${DEMO_PASS:-}" ]  || die "VITE_DEMO_PASSWORD ausente em $PORTAL_ENV."

# Carrega .env (SUPABASE_SERVICE_ROLE_KEY etc.) para o docker compose interpolar.
set -a; # shellcheck disable=SC1090
. "./$ENV_FILE"; set +a
# Silencia avisos do compose para variáveis Azure opcionais (modo demo).
: "${AZURE_OPENAI_ENDPOINT:=}"; : "${AZURE_OPENAI_API_KEY:=}"
: "${AZURE_OPENAI_DEPLOYMENT:=}"; : "${AZURE_OPENAI_API_VERSION:=}"
: "${AZURE_OPENAI_INSECURE_SSL:=}"
export AZURE_OPENAI_ENDPOINT AZURE_OPENAI_API_KEY AZURE_OPENAI_DEPLOYMENT \
       AZURE_OPENAI_API_VERSION AZURE_OPENAI_INSECURE_SSL
ok "Preflight OK (build=$DO_BUILD frontend=$WITH_FRONTEND, Supabase em $SUPA_URL)"

# ── Fase 1 — Teardown ─────────────────────────────────────────────────────────
log "Fase 1/8 — Destruindo containers e dados (wipe)"
docker compose -f "$DIA_COMPOSE" down -v --remove-orphans 2>/dev/null || true
supabase stop --no-backup >/dev/null 2>&1 || true
ok "dia-ops removida e Supabase parado/zerado"

# ── Fase 2 — Rebuild da imagem ────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  log "Fase 2/8 — Rebuild dia-ops-app:local (--no-cache)"
  docker compose -f "$DIA_COMPOSE" build --no-cache
  ok "Imagem dia-ops-app:local reconstruída"
else
  log "Fase 2/8 — Rebuild pulado (--no-build)"
fi

# ── Fase 3 — Supabase do zero (migrations + seed) ─────────────────────────────
log "Fase 3/8 — supabase start (aplica migrations + seed.sql)"
# --ignore-health-check: o container de storage (NÃO usado pelo app) às vezes
# demora a vincular a porta 5000 em /mnt/c e tropeça no health check, fazendo a
# CLI dar rollback de TODA a stack. Ignoramos a saúde para não derrubar
# DB/Auth/REST — que são validados explicitamente nas fases seguintes.
supabase start --ignore-health-check >/dev/null
DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 '^supabase_db_' || true)"
[ -n "$DB_CONTAINER" ] || die "container supabase_db_* não subiu."
db_psql() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres "$@"; }

# Com --ignore-health-check a CLI pode retornar antes do Postgres aceitar conexões.
log "Aguardando Postgres aceitar conexões"
db_deadline=$(( SECONDS + 60 ))
until db_psql -tAc 'select 1' >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$db_deadline" ] || die "Postgres não ficou pronto em 60s."
  sleep 2
done

MIGRATIONS="$(db_psql -tAc 'select count(*) from supabase_migrations.schema_migrations;' 2>/dev/null | tr -d '[:space:]')"
ENTITIES="$(db_psql -tAc 'select count(*) from public.entities;' 2>/dev/null | tr -d '[:space:]')"
[ "${MIGRATIONS:-0}" -gt 0 ] || die "nenhuma migration aplicada."
[ "${ENTITIES:-0}" -gt 0 ]   || die "seed.sql não populou public.entities."
ok "Supabase no ar — $MIGRATIONS migrations, $ENTITIES entities seedadas"

# ── Fase 4 — Usuários demo ────────────────────────────────────────────────────
log "Fase 4/8 — Seed dos usuários demo"
# Tenant demo: prefere o fallback conhecido; senão o primeiro tenant_key seedado.
DEMO_TENANT="$(db_psql -tAc \
  "select tenant_key from public.tenants where tenant_key='${DEMO_TENANT_FALLBACK}' \
   union all (select tenant_key from public.tenants order by tenant_key limit 1) limit 1;" \
  2>/dev/null | tr -d '[:space:]')"
[ -n "$DEMO_TENANT" ] || die "nenhum tenant seedado para vincular usuários demo."

# scripts/seed-demo-users.sh chama 'psql <DSN>'. Se o host não tiver psql,
# instalamos um shim que encaminha para dentro do container Supabase.
SHIM_DIR=""
PATH_FOR_SEED="$PATH"
if ! command -v psql >/dev/null 2>&1; then
  SHIM_DIR="$(mktemp -d)"
  cat > "${SHIM_DIR}/psql" <<EOF
#!/usr/bin/env bash
# Shim: descarta o DSN do host e encaminha para o container Supabase.
shift
exec docker exec -i "${DB_CONTAINER}" psql -U postgres -d postgres "\$@"
EOF
  chmod +x "${SHIM_DIR}/psql"
  PATH_FOR_SEED="${SHIM_DIR}:$PATH"
fi
cleanup() { [ -n "$SHIM_DIR" ] && rm -rf "$SHIM_DIR"; }
trap cleanup EXIT

# seed-demo-users.sh tem uma validação final que exige findings seedados; no modo
# seed-only não há findings, então toleramos o exit != 0 e validamos por conta.
set +e
PATH="$PATH_FOR_SEED" \
  SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:${SUPA_DB_PORT}/postgres" \
  DEMO_TENANT="$DEMO_TENANT" \
  DEMO_ADMIN_PASS="$DEMO_PASS" \
  DEMO_OPERATOR_PASS="$DEMO_PASS" \
  bash scripts/seed-demo-users.sh >/dev/null 2>&1
set -e

DEMO_USERS="$(db_psql -tAc \
  "select count(*) from auth.users where email like '%@dia-rental.dev';" \
  2>/dev/null | tr -d '[:space:]')"
[ "${DEMO_USERS:-0}" -ge 4 ] || die "esperava >=4 usuários demo, encontrei ${DEMO_USERS:-0}."
ok "Usuários demo criados ($DEMO_USERS) no tenant $DEMO_TENANT"

# ── Fase 5 — Sobe dia-ops ─────────────────────────────────────────────────────
log "Fase 5/8 — Subindo a stack dia-ops"
docker compose -f "$DIA_COMPOSE" up -d
ok "Containers dia-ops iniciados"

# ── Fase 6 — Espera ops-api ───────────────────────────────────────────────────
log "Fase 6/8 — Aguardando ops-api (${OPS_API_DOCS})"
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$OPS_API_DOCS" 2>/dev/null)" = "200" ]; do
  [ "$SECONDS" -lt "$deadline" ] || die "ops-api não respondeu em ${HEALTH_TIMEOUT}s."
  sleep 3
done
ok "ops-api respondendo (200 em /docs)"

# ── Fase 7 — Frontend (opcional) ──────────────────────────────────────────────
FRONTEND_URL=""
if [ "$WITH_FRONTEND" -eq 1 ]; then
  log "Fase 7/8 — frontend-portal (Vite dev)"
  existing="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/ 2>/dev/null || true)"
  existing5173="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ 2>/dev/null || true)"
  if [ "$existing" = "200" ]; then
    FRONTEND_URL="http://127.0.0.1:5174"; ok "Vite já rodando em $FRONTEND_URL"
  elif [ "$existing5173" = "200" ]; then
    FRONTEND_URL="http://127.0.0.1:5173"; ok "Vite já rodando em $FRONTEND_URL"
  else
    [ -d frontend-portal/node_modules ] || ( log "Instalando deps do frontend"; cd frontend-portal && npm ci >/dev/null 2>&1; cd "$ROOT_DIR" )
    # /mnt/c (WSL) precisa de polling para o watcher do Vite funcionar.
    ( cd frontend-portal && CHOKIDAR_USEPOLLING=1 setsid npm run dev >/tmp/recreate-stack-vite.log 2>&1 & )
    for _ in $(seq 1 30); do
      for p in 5173 5174; do
        if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${p}/" 2>/dev/null)" = "200" ]; then
          FRONTEND_URL="http://127.0.0.1:${p}"; break 2
        fi
      done
      sleep 2
    done
    if [ -n "$FRONTEND_URL" ]; then ok "Vite iniciado em $FRONTEND_URL"
    else warn "Vite não respondeu a tempo; veja /tmp/recreate-stack-vite.log"; fi
  fi
else
  log "Fase 7/8 — frontend pulado (use --with-frontend para subir o Vite dev)"
fi

# ── Fase 8 — Verificação final ────────────────────────────────────────────────
log "Fase 8/8 — Verificação"
fail=0

worker="$(docker ps --format '{{.Names}}' | grep -m1 'dia-temporal-worker' || true)"
if [ -n "$worker" ] && docker logs "$worker" 2>&1 | grep -q 'Worker started'; then
  ok "Worker Temporal conectado (Worker started)"
else
  warn "Worker Temporal sem 'Worker started' nos logs"; fail=1
fi

login_code=""
for _ in $(seq 1 10); do
  login_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${SUPA_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${DEMO_EMAIL}\",\"password\":\"${DEMO_PASS}\"}" 2>/dev/null || true)"
  [ "$login_code" = "200" ] && break
  sleep 2
done
if [ "$login_code" = "200" ]; then ok "Login demo OK (${DEMO_EMAIL} → 200)"
else warn "Login demo falhou (HTTP ${login_code})"; fail=1; fi

echo
log "──────────────── Stack recriada do zero (seed only) ────────────────"
printf '  %-22s %s\n' "Portal DIA (frontend):" "${FRONTEND_URL:-não iniciado (use --with-frontend)}"
printf '  %-22s %s\n' "Supabase API:"          "$SUPA_URL"
printf '  %-22s %s\n' "Supabase Studio:"       "http://127.0.0.1:54333"
printf '  %-22s %s\n' "ops-api (FastAPI):"     "$OPS_API_DOCS"
printf '  %-22s %s\n' "Temporal UI:"           "http://127.0.0.1:8088"
printf '  %-22s %s\n' "Login demo:"            "$DEMO_EMAIL"
echo

[ "$fail" -eq 0 ] || die "verificação encontrou problemas (veja avisos acima)."
ok "Tudo no ar e validado."
