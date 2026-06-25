# Spec #53: Bug — Drill de lojas do Morning Brief vazio: corrigir select de coluna inexistente (store_count)

## Overview

Corrigir a falha no drill de lojas do Morning Brief do Dono (issue #43, PR #48) onde nenhuma loja é renderizada ao expandir/abrir uma marca. A causa é que `getOwnerBriefByStore()` pede a coluna `store_count`, que não existe na view `v_dia_owner_brief_by_store` — PostgREST retorna 400 Bad Request, capturado e devolvido como lista vazia. A fix remove `store_count` do select por loja e ajusta os tipos para não exigir essa coluna no contexto de drill.

## Problema / Contexto

No Morning Brief do Dono, ao expandir uma marca na tabela (desktop) ou tocar numa marca nos cards (mobile), o drill para exibir as lojas daquela marca está vazio — o caret ▸→▾ alterna mas nenhuma linha de loja aparece, embora a view `v_dia_owner_brief_by_store` tenha os dados.

**Causa-raiz:** A função `getOwnerBriefByStore()` em `frontend-portal/src/portal/lib/agentsApi.ts` executa `.select(OWNER_BRIEF_STORE_COLS)`, que inclui `store_count` via herança de `OWNER_BRIEF_BRAND_COLS`. Porém, `v_dia_owner_brief_by_store` (definida em `supabase/migrations/20260626140000_dia_owner_brief_by_brand.sql`) **não expõe `store_count`** — só `brand_name`, `brand_id`, `store_name` e os 5 setores (novos/usados/peças/AT/FP). PostgREST rejeita com **400 Bad Request**. O erro é capturado pela função `unwrap()` e convertido em `[]`, e o componente fica sem lojas para renderizar.

**Evidência de rede (ambiente local):**
- `GET /rest/v1/v_dia_owner_brief_by_brand?select=...store_count...` → **200 OK** (a coluna existe)
- `GET /rest/v1/v_dia_owner_brief_by_store?select=...store_count...store_name` → **400 Bad Request** (coluna não existe)

**Raiz no código:**
- Linha ~930: `OwnerBriefStoreRow extends OwnerBriefBrandRow` → herda `store_count` como obrigatório
- Linha ~952-953: `OWNER_BRIEF_BRAND_COLS` inclui `store_count`; linha ~955 `OWNER_BRIEF_STORE_COLS` copia integralmente e adiciona `store_name`
- Linha ~969: `getOwnerBriefByStore()` usa `OWNER_BRIEF_STORE_COLS` no `.select()`, pedindo uma coluna que não existe

## Critérios de Aceite

- [ ] Ao expandir/abrir uma marca no Morning Brief, as **lojas daquela marca aparecem** na tela (desktop expandindo na tabela, mobile abrindo no card), cada linha mostrando as 5 células de setor (Novos, Usados, Peças, AT, FP) com destaque de FP <7d.
- [ ] A requisição HTTP `GET /rest/v1/v_dia_owner_brief_by_store?select=...` retorna **200 OK** (sem 400) — o `.select()` só pede colunas que realmente existem na view.
- [ ] A soma dos valores das lojas por marca continua batendo com a linha da marca (FP, FP em risco, resultado) — validar que a soma das lojas filtra corretamente para a marca selecionada, sem divergências de agrupamento.
- [ ] Uma **regressão de tipo** previne que o código volte a pedir coluna inexistente: `OwnerBriefStoreRow` não deve heredar `store_count` de `OwnerBriefBrandRow` — extrair uma tipo base sem `store_count`, deixar `OwnerBriefBrandRow` adicionar `store_count`, e `OwnerBriefStoreRow` adicionar apenas `store_name`.

## Não-Goals

- Adicionar `store_count` à view `v_dia_owner_brief_by_store` (coluna seria redundante por linha de loja; não está no escopo das colunas da view).
- Mudar o comportamento de renderização do drill (continua expandindo/fechando a marca na tabela desktop; mobile continua abrindo o card de marca).
- Rehistórico de testes (os testes de contrato SQL passam porque testam via `psql` com as colunas corretas; corrigir aqui não força refatoração em testes existentes, mas pode inspirar um novo teste de regressão).

## Out-of-Scope

- Implementação de um teste de regressão select-vs-schema (sugerido na issue mas é follow-up) — será tratado em issue separada se aprovado.
- Refatoração de `unwrap()` ou tratamento de erro do PostgREST 400 (deixar como está; a fix remove a raiz do erro).

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
