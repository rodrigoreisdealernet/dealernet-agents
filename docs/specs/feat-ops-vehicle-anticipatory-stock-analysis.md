# Spec — Análise antecipatória de estoque de veículos (vehicle-aging-analyst)

> Metodologia: AI-DLC (Spec Driven Development). Brownfield — evolui o agente
> existente `vehicle-aging-analyst` (issues #32/#73/#118) sem mudar sua
> identidade (agent_key, workflow), apenas a **inteligência da análise**.

## 1. Intenção

O agente de estoque é o principal do sistema. Hoje ele só emite o aviso
`stock_aging_90d` ("veículo parado há ~90 dias"), disparado por um simples
limiar de dias. **Isso não tem utilidade**: todos na concessionária já sabem há
quanto tempo o veículo está parado. A IA deve **antecipar problemas reais e
não-óbvios** do estoque, sendo o **floor plan** (financiamento de estoque) o
maior deles.

## 2. Floor plan no ERP DealerNet (fonte de verdade)

Base de conhecimento GeneXus (`C:\Dev\Genexus\DWF\CSharpModel\web\gxcontext`):

- **Financiamento de estoque por veículo** junto a uma `Financeira`.
- `CarenciaFloorPlan` (por `Marca`): faixas `DiaInicial..DiaFinal → Percentual`.
  Ou seja, o **percentual cobrado depende da banda de dias** — uma **curva de
  custo escalonada**. À medida que o veículo envelhece, ele **cruza para bandas
  de percentual maior**.
- `EstoqueTipoFloorPlan` (domínio): `Nenhum | Juros | ValorFixo | IndiceQC` —
  tipo de cobrança.
- **Carência**: `VeiculoTipoFaturamento_CarenciaFloorPlan`, `FamiliaVeiculoDias`
  (`DiasCarencia`/`DiasFloorPlan`) — janela inicial sem (ou menor) cobrança.

**Insight central:** o custo de floor plan **não é linear** e **não é "90
dias"**. O que importa é a **transição de banda** — quando a carência termina ou
o veículo cruza para um percentual maior, o **carry mensal salta**. Antecipar
essas transições (e suas consequências de margem) é a análise de alto valor.

## 3. Requisitos

- **R1 — Remover o aviso de 90 dias.** `days_in_stock` deixa de ser gatilho;
  vira apenas evidência/contexto. Um veículo "velho" porém saudável (margem boa,
  banda estável, model_year corrente) **não** gera finding.
- **R2 — Floor plan antecipatório.** Modelar a curva escalonada (carência +
  bandas) e antecipar **escalonamento de banda** antes do salto de custo.
- **R3 — Outras antecipações de estoque** além do floor plan.
- **R4 — Determinístico + auditável.** Severidade, tipo e exposição financeira
  computados deterministicamente no scope; o LLM apenas prioriza, recomenda ação
  revisável e justifica (nunca aplica nada sozinho).
- **R5 — Aderência aos padrões** do repo (workflow scope→assess→dedupe→record;
  schema fechado registrado; config por tenant; dedupe por fingerprint;
  supersede de findings fora de escopo).

## 4. Desenho

### 4.1 Módulo determinístico `vehicle_inventory_signals.py`

Curva de floor plan (config `thresholds.floor_plan`, defaults ERP-grounded):

```
grace_days = 30
bands = [ {until_day: 60, monthly_rate: 0.010},
          {until_day: 90, monthly_rate: 0.015},
          {until_day: 120, monthly_rate: 0.020},
          {until_day: null, monthly_rate: 0.025} ]   # 121+
escalation_window_days = 7
```

Funções puras: banda atual por dias; `days_to_next_band` + `next_monthly_rate`;
`monthly_carry = cost * rate`; `accrued_floor_plan(cost, days)` (integração
piecewise das bandas, carência = 0); `projected_accrued(cost, days, +k)`.

### 4.2 Sinais antecipatórios (cada um é um `finding_type`)

1. **`floor_plan_band_escalation`** — `cost>0` e faltam ≤ `escalation_window_days`
   para cruzar para uma banda de percentual maior (inclui o fim da carência:
   0 → cobrança). Exposição = aumento do carry mensal `cost*(next_rate-cur_rate)`.
   Severidade pela magnitude do salto (e sair da carência é ≥ high).
2. **`margin_erosion`** — margem bruta conhecida (`sale_price-cost`). Dispara se o
   floor plan acumulado já consumiu ≥ `margin_floor_pct` (50%) da margem, **ou** o
   projetado +30d torna a unidade negativa, **ou** já está negativa. Exposição =
   floor plan acumulado. Severidade: negativa→critical; vira negativa em 30d→high;
   senão medium.
3. **`carryover_model_year`** — `condition='novo'`, `model_year < ano corrente` e
   `days_in_stock ≥ carryover_min_days` (45). Leftover/obsolescência: a próxima
   model year chega e a janela de venda com margem fecha. Exposição = carry
   projetado +30d. Severidade por anos atrás (≥2→critical/high; 1→high/medium).

Um veículo entra em escopo se tiver **≥1 sinal**. `finding_type` primário = sinal
de maior severidade (desempate por prioridade fixa floor_plan → margin →
carryover). `signals[]` lista todos os disparados. `estimated_exposure` = exposição
do sinal primário. Fingerprint = `sha256(tenant:vehicle:finding_type)`.

### 4.3 Dados

Reusa `v_dia_vehicle_current` (cost, sale_price, days_in_stock, model_year,
condition, brand, store, purchase_date). A view mantém seu `floor_plan_cost`
linear apenas para display; **o agente computa o acúmulo preciso por bandas**.
Sem novas tabelas/entity types.

### 4.4 Schema de saída

`vehicle_aging_finding_v2` (novo registry; v1 mantido por histórico): substitui
`aging_bucket` por `signals: string[]`, `finding_type` default
`floor_plan_band_escalation`; mantém vehicle_id, severity, days_in_stock,
recommended_action, estimated_exposure, evidence, confidence, rationale.
Ações revisáveis: `monitor | markdown | transfer | prioritize_sale |
wholesale_auction` (inalteradas).

## 5. Critérios de aceite

- AC1: nenhum finding é disparado apenas por `days_in_stock` ≥ 90.
- AC2: um veículo a ≤7 dias de cruzar de banda gera `floor_plan_band_escalation`
  com exposição = aumento do carry mensal.
- AC3: fim da carência dentro da janela gera `floor_plan_band_escalation` ≥ high.
- AC4: unidade com floor plan acumulado consumindo >50% da margem (ou negativa em
  30d) gera `margin_erosion`.
- AC5: novo com model_year < ano corrente e em estoque >45d gera
  `carryover_model_year`.
- AC6: veículo "velho mas saudável" (margem ampla, banda estável, MY corrente)
  **não** gera finding (controle).
- AC7: severidade/tipo/exposição são determinísticos (independem do LLM); o LLM
  só recomenda ação e justifica; `auto_apply=false`.
- AC8: dedupe por fingerprint e supersede de findings fora de escopo seguem
  funcionando.

## 6. Fora de escopo

- Mudar a curva `floor_plan_cost` da view (`v_dia_vehicle_current`).
- Renomear o agente/workflow ou o `agent_key`.
- Integração ao vivo com as financeiras / `CarenciaFloorPlan` real do ERP (a
  curva é configurável por tenant via `thresholds.floor_plan`, com defaults
  ancorados no modelo do ERP).
