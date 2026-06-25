# Spec — Issue #10: Venda de Peças — entidade transacional + CRUD (baixa de estoque)

## Overview

Criar a entidade transacional `part_sale` (venda de peça) com CRUD que **baixa o estoque** da peça vendida, completando o conceito de Peças junto com a #8. A venda é registrada por RPC atômica que valida o estoque, decrementa `quantity_in_stock` da peça referenciada e grava a venda numa única transação; o cancelamento estorna a quantidade ao estoque. Entrega tela nativa `/dia/part-sales`, view de leitura `v_dia_part_sale_current` e seed demo idempotente coerente com o estoque semeado na #8.

## Problem / Context

A #8 entregou a peça (`entity_type = 'part'`, view `v_dia_part_current` com `quantity_in_stock` e `stock_status` zerado/critico/baixo/ok) mas **sem movimento de estoque** — só CRUD cadastral. O piloto DIA precisa registrar a venda de balcão de peças e ver o estoque cair de fato (e o `stock_status` mudar, p. ex. de `ok` para `critico` ou `zerado`). A regra crítica é **não deixar estoque negativo**: a baixa e a validação de saldo precisam ser atômicas. O repo já tem o padrão de escrita endurecida (`dia_assert_part_writer` / `create_part` em `20260625150200_dia_part_entity_crud.sql`, e o RPC-hardening em `20260607133000_authenticated_write_rpc_hardening.sql`): esta fatia replica esse padrão para `part_sale`, somando a lógica transacional de baixa/estorno que a entidade `part` (cadastral) não tinha.

## Acceptance Criteria

- [ ] **Dado** um usuário com perfil `admin` ou `branch_manager` e uma peça com saldo suficiente, **quando** ele registra uma venda (part_id, quantity, unit_price, opcional discount, sale_date, customer, salesperson, channel=balcao), **então** a venda é gravada como `part_sale`, o `quantity_in_stock` da peça é decrementado por `quantity` na mesma transação, e o `total` derivado (`quantity × unit_price − discount`) é exposto na leitura.
- [ ] **Dado** uma peça com saldo X, **quando** se tenta vender `quantity` > X, **então** a operação é rejeitada com erro de validação e **nenhuma** linha de venda é criada e o estoque **permanece em X** (nunca negativo).
- [ ] **Dado** uma venda existente, **quando** um `admin`/`branch_manager` a cancela, **então** a quantidade vendida é **devolvida** ao `quantity_in_stock` da peça (estorno atômico) e a venda fica marcada como cancelada (sem DELETE físico; histórico preservado).
- [ ] **Dado** o controle de acesso, **então** a leitura de vendas é permitida a qualquer `authenticated`; a escrita ocorre **somente via RPC** (sem INSERT/UPDATE direto do cliente); `admin`/`branch_manager` podem vender e cancelar; `read_only` (e papéis não listados) recebem negação com `errcode = 42501`.
- [ ] **Dado** a tela de vendas, **quando** o usuário abre `/dia/part-sales`, **então** vê a lista de vendas com **número/descrição da peça** (join com `part`), quantity, unit_price, total, sale_date, customer e salesperson; pode **registrar** uma venda e **cancelar** uma venda pelas RPCs; e após vender, o saldo da peça em `/dia/parts` reflete a baixa. A tela está registrada no registry e tem item no menu.
- [ ] **Dado** o ambiente após reset+seed, **então** existem ~12 vendas de peças demo idempotentes (`source_record_id LIKE 'demo-dia-part-sale-%'`) no mês corrente/anterior, coerentes com o estoque semeado na #8 (algumas peças chegando a `critico`/`zerado` por efeito das vendas).
- [ ] **Dado** o fluxo ponta-a-ponta validado após reset: registrar venda pela tela **reduz** `quantity_in_stock` e **pode mudar** o `stock_status`; cancelar **estorna**; vender acima do estoque é **bloqueado**.

## Non-Goals

- Consumo de peças por Ordem de Serviço (a baixa via OS da #7 fica para depois).
- KPIs agregados de venda de peças (faturamento, margem, ranking) e views analíticas do dono.
- Devolução **parcial** de itens, emissão de NF e qualquer lançamento financeiro/contábil.
- Edição de uma venda já gravada (o fluxo é registrar/cancelar; correção = cancela + nova venda nesta fatia).
- Relacionamento formal (`relationships_v2`) entre `part_sale` e `part` — a referência é por `part_id` no JSONB nesta fatia.

## Out-of-scope

- Multi-canal além de `balcao` (e-commerce, telefone) e regras de preço/desconto por canal.
- Reserva/alocação de estoque, backorder ou estoque negativo permitido por exceção.
- Comissão de vendedor, metas, e integração com CRM de clientes.
- Concorrência de alto volume / locks avançados além da atomicidade transacional da RPC.

---

## Apêndice técnico — padrões aterrados

### Modelagem
- **`entity_type = 'part_sale'`** no modelo genérico (`entities` + `entity_versions` JSONB), registrado no catálogo `rental_entity_type_catalog` (a view VALUES `security_invoker` recriada em `20260625150200_dia_part_entity_crud.sql` — adicionar `('part_sale')`).
- Campos em `entity_versions.data`: `part_id` (uuid da entidade peça), `quantity` (numeric), `unit_price` (numeric), `discount` (numeric, opcional, default 0), `sale_date`, `customer`, `salesperson`, `channel` (`balcao`), `status` (`registrada`|`cancelada`). `total` é **derivado na view** (`quantity × unit_price − coalesce(discount,0)`), não persistido.

### RPCs endurecidas (padrão `create_part`)
- `dia_assert_part_sale_writer()` espelhando `dia_assert_part_writer`: exige `request.jwt.claim.role` = `service_role` OU (`authenticated` E `get_my_role() IN ('admin','branch_manager')`); senão `RAISE ... errcode='42501'`.
- `create_part_sale(p_data jsonb)` `SECURITY DEFINER`, `set search_path = public, pg_temp`, numa única transação: assert writer; validar payload (part_id existe e é `part`; quantity > 0; unit_price >= 0); ler saldo corrente da peça **com lock**; se `quantity > quantity_in_stock` → `RAISE EXCEPTION errcode='22023'` (sem gravar); decrementar `quantity_in_stock` da peça (nova versão SCD2); gravar a venda via `create_entity_with_version('part_sale', ...)`.
- `cancel_part_sale(p_entity_id uuid)`: assert writer; marca venda `status='cancelada'` (nova versão, sem DELETE) e **devolve** `quantity` ao estoque; idempotente.
- `GRANT EXECUTE` para `authenticated, service_role`; `REVOKE ... FROM public`.

### View de leitura
- `v_dia_part_sale_current` `WITH (security_invoker = true)`: vendas correntes (não canceladas) com **join à peça** para `part_number`/`description`, `quantity`, `unit_price`, `total` derivado, `sale_date`, `customer`, `salesperson`, `channel`, `status`. `GRANT SELECT TO authenticated, service_role`.

### Frontend nativo (molde `PartsInventory.tsx`)
- Tela `frontend-portal/src/portal/renderers/screens/PartSales.tsx`.
- Camada de dados em `frontend-portal/src/portal/lib/agentsApi.ts`: `getPartSales()` lendo `v_dia_part_sale_current`; `createPartSale()` / `cancelPartSale()` via `supabase.rpc(...)`.
- Registro em `frontend-portal/src/portal/renderers/registry.ts`: `'dia-part-sales': lazy(...)`.
- Nav em `frontend-portal/src/portal/lib/portalApi.ts`: novo filho na seção `dealership`, `componentKey: 'dia-part-sales'`, título "Venda de Peças".

### Seed idempotente
- Bloco novo, namespace `source_record_id LIKE 'demo-dia-part-sale-%'`, com `DELETE` prévio, ~12 vendas referenciando `part_id` das peças demo (`demo-dia-part-NNN`), `sale_date` no mês corrente/anterior, coerentes com o estoque da #8 (algumas peças chegando a `critico`/`zerado`).

### Testes de contrato
- `supabase/tests/part_sale_crud.test.mjs` espelhando `part_crud.test.mjs`: baixa de estoque, rejeição de over-stock (saldo inalterado), estorno no cancelamento, negação `42501` para `read_only`.
