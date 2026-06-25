#!/usr/bin/env bash
# Guard-rail (armadilha #1 do Wynne): rejeita prefixos de versão de migration duplicados.
# O Supabase CLI usa o timestamp/versão como chave primária — duplicatas abortam o
# `supabase start`/`db reset`. Este check barra o problema no CI, antes de quebrar o
# ambiente local de qualquer pessoa.
set -euo pipefail

MIG_DIR="supabase/migrations"
if [ ! -d "$MIG_DIR" ]; then
  echo "Sem $MIG_DIR — nada a checar."
  exit 0
fi

dups="$(find "$MIG_DIR" -maxdepth 1 -name '*.sql' -printf '%f\n' \
  | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -d)"

if [ -n "$dups" ]; then
  echo "::error::Versões de migration duplicadas (Supabase usa a versão como PK):"
  echo "$dups"
  echo "Renomeie a segunda de cada par (ex.: +1s no timestamp) para garantir unicidade."
  exit 1
fi

total="$(find "$MIG_DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
echo "OK: todas as $total migrations têm versão única."
