# Spec — Vendas de Veículos (issue #130)

## Contexto

No menu **Concessionária › Peças** já existem dois itens: **Estoque de Peças** e **Venda de Peças** (`PartSales.tsx`). Já o grupo **Concessionária › Veículos** tem apenas **Estoque de Veículos** (`VehiclesInventory.tsx`), que hoje lista **todos** os veículos — em estoque e vendidos juntos. Falta a simetria com Peças: um item **Vendas de Veículos** e a separação clara entre o que está em estoque e o que já foi vendido.

## Objetivo

Replicar, no grupo **Veículos**, o mesmo padrão do grupo **Peças**:
- **Estoque de Veículos** passa a mostrar **apenas** veículos com `status = 'em_estoque'`.
- Novo item **Vendas de Veículos** mostra **apenas** veículos com `status = 'vendido'`.

## Critérios de aceite

1. No menu **Concessionária › Veículos** existe um novo item **"Vendas de Veículos"**, irmão de "Estoque de Veículos" — do mesmo modo que "Venda de Peças" é irmão de "Estoque de Peças".
2. Abrir **Estoque de Veículos** lista **somente** veículos em estoque (nenhum veículo vendido aparece); KPIs e contagens refletem apenas o estoque.
3. Abrir **Vendas de Veículos** lista **somente** veículos vendidos (nenhum veículo em estoque aparece).
4. A tela **Vendas de Veículos** segue o layout/estilo das telas existentes (`ScreenShell`, `KpiCard`, tabela corporativa), com KPIs adequados a vendas (ex.: unidades vendidas, receita) e valores em **R$** no padrão pt-BR.
5. Textos das telas e do novo item de menu estão internacionalizados (**pt-BR** e **en-US**), sem chaves cruas vazando na UI.
6. `npm run build` (`tsc -b`) e `npm test` passam; sem regressão nas telas existentes.

## Escopo técnico (descoberto no código)

- **Menu:** `frontend-portal/src/portal/lib/portalApi.ts` (`MOCK_MENU`), grupo `dealership-veiculos` — adicionar um item `dia-vehicle-sales` ao lado de `dia-vehicles`, espelhando o `dealership-part-sales`.
- **Registro de tela:** `frontend-portal/src/portal/renderers/registry.ts` — registrar `dia-vehicle-sales` (lazy import) apontando para a nova tela.
- **Telas:** `frontend-portal/src/portal/renderers/screens/VehiclesInventory.tsx` (filtrar `em_estoque`) e nova `VehicleSales.tsx` (filtrar `vendido`), seguindo o molde de `PartSales.tsx`.
- **Dados:** leitura de `v_dia_vehicle_current` via `getVehicles()` em `frontend-portal/src/portal/lib/agentsApi.ts`; a coluna `status` ∈ {`em_estoque`, `vendido`}. O filtro pode ser um parâmetro opcional em `getVehicles(status?)` ou aplicado no cliente — manter a leitura via view (RLS `authenticated`), **sem** INSERT/UPDATE direto.
- **i18n:** `frontend-portal/src/i18n/messages/pt-BR.json` e `en-US.json` — ajustar o bloco `screens.vehiclesInventory` (textos de "estoque") + novo bloco `screens.vehicleSales` + rótulo do item de menu.

## Não-objetivos / fora de escopo

- **Não** criar RPC de "registrar venda de veículo": marcar um veículo como vendido continua sendo feito pela edição em **Estoque de Veículos** (o campo Status já existe: `em_estoque`/`vendido`). Esta demanda é a separação de visões + o novo item de menu.
- Sem mudanças de schema/migrations — a coluna `status` já existe em `v_dia_vehicle_current`.
- Sem mexer no menu real (SP `SP_PortalDMS_Menu`) nem no `EXTRA_MENU` (iframe Compras) de `portalApiReal.ts`.

## Validação

```bash
cd frontend-portal && npm run build && npm test
```
QA manual: abrir as duas telas e confirmar que Estoque mostra só `em_estoque` e Vendas mostra só `vendido`.

---
_Spec gerada via fluxo AI-DLC (profundidade mínima — mudança simples e bem definida)._

