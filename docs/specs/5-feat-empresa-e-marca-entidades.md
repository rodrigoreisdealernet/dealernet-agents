# Spec — Issue #5: Empresa e Marca — entidades + CRUD

## Overview

Criar os dados mestres do piloto DIA — `company` (empresa/concessionária) e `brand` (marca) — cada uma com CRUD completo: migration + RPCs de escrita endurecidas + RLS + view + tela de cadastro/listagem. Segue a mesma fatia vertical e convenções da #4 (Veículo): modelo genérico `entities` + `entity_versions` (JSONB, SCD2), escrita só via RPC, leitura via view `security_invoker`.

## Problem / Context

`company` e `brand` são os cadastros base que o veículo (#4) e as vendas (issues seguintes) vão referenciar. O entity_type `company` já aparece no seed atual (`demo-baseline-company-*`); `brand` é novo. A entidade `vehicle` (#4) já validou ponta a ponta o caminho reusável — RPC `SECURITY DEFINER` com guarda de role `admin`/`branch_manager`, view com `security_invoker=true`, tela nativa registrada no portal e seed idempotente por `source_record_id`. Esta issue replica esse padrão para duas entidades simples de cadastro, sem campos derivados.

## Acceptance Criteria

- [ ] **Empresa cadastrável** — Um usuário com perfil de administração consegue criar, editar e inativar uma empresa informando razão social, nome fantasia, CNPJ, cidade, estado e situação (ativo/inativo); empresas inativadas deixam de aparecer na listagem corrente, mas seu histórico é preservado (nada é apagado fisicamente).
- [ ] **Marca cadastrável** — Um usuário com perfil de administração consegue criar, editar e inativar uma marca informando nome, segmento (automóveis/caminhões/motos) e situação (ativo/inativo); marcas inativadas saem da listagem corrente preservando o histórico.
- [ ] **Validação de dados** — Tentativas de salvar empresa ou marca com situação ou segmento fora dos valores permitidos, ou sem os campos obrigatórios (razão social/CNPJ para empresa; nome/segmento para marca), são rejeitadas com mensagem de erro e nada é gravado.
- [ ] **Controle de acesso** — Qualquer usuário autenticado consegue listar empresas e marcas; apenas perfis admin/branch_manager conseguem criar, editar ou inativar. Perfil somente-leitura (read_only) recebe erro de permissão ao tentar qualquer escrita, e não existe caminho de escrita direta fora das operações oficiais (a escrita ocorre só via RPC).
- [ ] **Telas de listagem e cadastro** — As páginas de Empresas e de Marcas ficam acessíveis pela navegação do portal e exibem os registros ativos com seus campos, permitindo as ações criar/editar/inativar a partir da própria tela.
- [ ] **Dados demo após reset** — Após aplicar migration + seed e resetar o ambiente, as listagens de Empresas e Marcas trazem pelo menos 2 empresas demo e 3 marcas demo idempotentes (reaplicar o seed não duplica registros); consultar as views correntes (`v_dia_company_current`, `v_dia_brand_current`) retorna esses dados.

## Non-Goals

- Vínculo formal entre veículo ↔ empresa/marca (chaves/relacionamentos) — issues seguintes.
- Campos além dos especificados (sem endereço completo, contatos, logotipo, etc.).
- Configuração de validação avançada de CNPJ (dígito verificador / consulta externa).

## Out-of-Scope

- Hierarquia organizacional (matriz/filial, regiões).
- Vendas e Oficina.
- Importação em massa de empresas/marcas legadas.
- Relatórios/BI sobre empresas e marcas.

---

## Apêndice técnico — padrões aterrados (referência do coder)

> Os caminhos abaixo são pistas; o coder DEVE reabrir cada arquivo e confirmar assinaturas/colunas reais antes de implementar. Reaproveitar diretamente o padrão da #4.

- **Migration de referência (#4):** molde direto — registra o entity_type no catálogo; define helper de guarda de writer (`service_role` OU `authenticated` + role `admin`/`branch_manager`, erro `42501`); helper de validação de `data` (enums + obrigatórios, erro `22023`); RPCs `create_/update_/delete_` com `SECURITY DEFINER`, `set search_path = public, pg_temp`, `revoke all from public` + `grant execute to authenticated, service_role`. `company` já consta no catálogo; **adicionar `brand`**.
- **`delete_` = soft-delete:** anexar nova versão SCD2 com `retired=true`/`retired_at` e `status='inativo'` (não `DELETE` físico).
- **Views:** `v_dia_company_current` e `v_dia_brand_current` `WITH (security_invoker = true)`, derivando do estado corrente filtrando `retired=false`; expor os campos do `data` e `grant select to authenticated, service_role`.
- **Seed:** `supabase/seed.sql` — replicar o padrão idempotente (`DELETE ... LIKE 'demo-dia-company-%'`/`'demo-dia-brand-%'` e reinserir via `rental_upsert_entity_current_state` sob role `service_role`). Mínimo 2 empresas + 3 marcas.
- **Frontend (telas nativas):** registrar telas `dia-companies` e `dia-brands` no registry do portal (`frontend-portal/src/portal/renderers/`), espelhando a tela de Veículos; adicionar itens de navegação.
- **Teste de contrato:** espelhar o teste de CRUD do veículo cobrindo: criar como admin/branch_manager sucede; read_only falha `42501`; enums/obrigatórios inválidos falham `22023`; soft-delete some da view mas preserva histórico; update incrementa version preservando v1.
