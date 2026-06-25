# Spec #43: Portal — Morning Brief do Dono: visão por marca → lojas → ações do agente

## Overview

Implementar a tela de Morning Brief que abre quando o agente DIA envia a mensagem matinal ao dono da concessionária (deep-link de WhatsApp/notificação). A tela exibe a venda e estoque **do dia anterior** em 3 níveis navegáveis: (1) totais por marca com 5 setores de negócio, (2) drill para as lojas de cada marca com destaque de Floor Plan em risco, (3) ações preparadas pelos agentes para o dono confirmar ou descartar. Responsiva para mobile e desktop.

## Problema / Contexto

Após o agente DIA executar seu ciclo matinal, ele envia uma notificação breve ao dono ("Bom dia, Carlos! Ontem: 259k… FP <7d: 8 un"). Ao tocar em "Ver Morning Brief", o dono cai nesta visão — seu principal canal de entrada para atuações corretivas do dia. 

A visão consolida dados do **dia anterior** (calculados on-the-fly nas views) agrupados por **marca e loja**, mostrando unidades/receita/margem de **Novos, Usados, Peças, Assistência Técnica (AT/Oficina) e Floor Plan**, além de uma seção de ações (findings) já priorizadas pelo agente. A tela nasce completa em ambas plataformas (mobile cards empilhados, desktop cockpit tabela+rail) mas com "—" em setores sem seed (Peças/Oficina enquanto não semeados).

**Dados disponíveis hoje:**
- Veículos novos/usados soldos: `v_dia_sales_summary` (unidades, receita, margem por marca/loja)
- Floor plan em estoque: `v_dia_inventory_summary` + `v_dia_vehicle_current` (dias em estoque, custo)
- Ações do agente / findings: `getFindings` / `decideFinding` em `agentsApi.ts` (status, aprovação/rejeição)
- Empresas por marca: `v_dia_company_current` (brand_id, brand_name)

**Falta criar no backend:**
- Agregação `v_dia_owner_brief_by_brand`: uma linha por marca com todos os 5 setores (novos/usados/peças/AT/FP com unidades+valores+margem) + variante por loja
- Métrica **FP em risco <7d**: proxy por `days_in_stock` (sem data real de vencimento floor plan nesta fase)

## Critérios de Aceite

- [ ] A tela Morning Brief exibe **total por marca** com as 5 células de setor (Novos, Usados, Peças, AT, FP) + card **Grupo Total** somando marcas, com dados **do dia anterior**.
- [ ] Ao tocar numa marca, faz **drill para as lojas** daquela marca, mostrando as mesmas 5 células por loja, com destaque **Floor Plan <7d** em vermelho quando há unidades em risco e neutro quando zero.
- [ ] Marcas vêm das **empresas agrupadas por `brand_name`**; empresas sem marca aparecem em um bloco "Sem marca".
- [ ] Setores sem dado (Peças/Oficina enquanto não semeados) renderizam **"—"** nas células, sem quebrar o layout.
- [ ] A seção final **"DIA preparou estas ações"** lista os findings pendentes; tocar em **Confirmar** registra a decisão (approve) e **Dispensar** rejeita, refletindo no estado da UI (cor/status).
- [ ] A tela responde a **mobile** (cards empilhados, conforme protótipo v7 mobile) e **desktop** (layout cockpit tabela+rail, conforme protótipo v7 desktop), sem regressões em nenhuma.
- [ ] Existe **um ponto de entrada abrível** (deep-link) que abre a Morning Brief diretamente (entrada do WhatsApp/notificação do agente leva a esta visão).

## Não-Goals

- **% de meta** (verde/vermelho) — exibir apenas valores absolutos nesta fase; tabela de metas é follow-up.
- **Snapshot diário agendado** — "ontem" é calculado on-the-fly (data anterior ao dia corrente) nas views.
- **Seed de peças/oficina** — entram quando as entidades forem criadas; aqui garantimos só o "—".
- **Data real de vencimento floor plan** — fase 1 usa proxy por aging; maturity date é follow-up.
- **Envio efetivo de mensagens** (WhatsApp/e-mail ao confirmar) — registramos a decisão via `decideFinding`; integração com o envio é fase posterior.

## Out-of-Scope

- Geração nova das ações pelos agentes (Temporal) — consumimos a fila de findings existente (`getFindings`/`decideFinding`).
- Chat "Perguntar ao DIA" no protótipo — marcado como Fase 2.
- Integração com menu real via `SP_PortalDMS_Menu` (GeneXus) — usamos MOCK_MENU local.

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
