# Escopo — Menu por Solução + Bridge SSO + URL dinâmica (DMS)

Status: EM DEFINIÇÃO (2026-06-15). Fecha o desenho ponta-a-ponta antes de tornar a
URL da Bridge dinâmica (hoje fixa em '/DealerNetWF/').

## 1. Conceito central: tudo gira em torno do TipoProduto (SolucaoDMS)

O menu do PortalDMS tem, no 1º nível, **uma SOLUÇÃO do DMS por nó** (Dealernet WF,
Hub Integration, Fast Service, Fast Rental…). Cada solução = um registro na TRN
**SolucaoDMS**, identificado por `SolucaoDMS_TipoProduto` (domínio PacoteProduto:
DWF, DHI, DNWA, FASTRENTAL, FASTREPORT, FANDI, MONITORNFE, DWIN…).

A SolucaoDMS guarda as 2 URLs base por solução:
- `SolucaoDMS_UrlBase`    → telas GX18/EV2 legadas (.aspx) — ex. `http://.../DealerNetWF/`
- `SolucaoDMS_UrlBaseSpa` → telas React/IA (SPA)          — ex. `http://localhost:5175/`

➡️ **Nada de URL fixa.** Toda URL (Bridge .aspx ou SPA) é montada a partir destes
campos, por solução e por ambiente.

## 2. Fluxo do menu (já existe, formato definido)

`API_Portal_Menu` → `SDT_PortalMenu[]`, 1 entrada por produto:
```
{ produto: 'DHI', label: 'Hub Integration', menuJson: '<árvore SpMenuNode>' }
```
O front (`buildMenuTree`/`spNodeToItem`/`specFromLink` em portalApiReal.ts) monta a
árvore. HOJE o `link` do nó decide o tipo de janela (http→iframe-external; .aspx/rota
→ iframe-aspx). **PENDÊNCIA**: o nó precisa carregar também o `TipoProduto` (do pai)
para o front saber qual SolucaoDMS usar ao abrir.

## 3. O que falta definir/fechar (ESCOPO)

### 3.1 Menu carrega TipoProduto por item
- O `SpMenuNode` (ou o agrupador produto) deve propagar o `TipoProduto` até a folha.
- `specFromLink` passa a receber o tipoProduto e decidir:
  - tela SPA (React) → `kind:'iframe-aspx'`, src = `UrlBaseSpa + '?tela=' + link + '&token=…'`
  - tela legada      → Bridge: `UrlBase + 'bridge.aspx?token=…&tela=' + link`

### 3.2 PRC_Portal_AbrirTelaEV2 — URL dinâmica por SolucaoDMS
Trocar a montagem fixa por:
```
For each SolucaoDMS where SolucaoDMS_TipoProduto = &tipoProduto
    &urlBase    = SolucaoDMS_UrlBase       // legado
    &urlBaseSpa = SolucaoDMS_UrlBaseSpa    // SPA
EndFor
// legado: &url = &urlBase.Trim('/') + '/bridge.aspx?token=' + &token + '&tela=' + &tela
// SPA:    o front monta &urlBaseSpa + '?tela=' + &tela + '&token=' + &token
```
- Assinatura: trocar `&engine` por `&tipoProduto` (Character(10), = SolucaoDMS PK)
  OU manter `&engine` e mapear engine→TipoProduto dentro do PRC. (DECISÃO: usar
  TipoProduto direto, alinhado ao menu.)

### 3.3 Bridge SSO (sessão) — JÁ FEITO no pacote PortalBridgeValidar
- `/bridge/abrir`  → gera token (TRN Sessao). ✅
- `/bridge/validar`→ PRC_Portal_ValidarToken: lê token, monta Context, SetWWPContext. ✅
- Front: bridgeAuth.ts (DHI) + SandboxedFrame (token p/ SPA próprio). ✅
- **Ajuste pendente**: a URL gerada pelo `abrir` deve vir da SolucaoDMS (3.2).

### 3.4 EV2 — mesma lógica de Context a partir do canônico
- bridge.aspx (EV2) lê o token → TRN Sessao → monta WWPContext nativo EV2 a partir do
  mínimo canônico (Usuario Cod/Ident/Nome + Empresa Cod/Nome). Espelha o ValidarToken.

## 4. Matriz de tipos de tela (por solução)

| Solução (TipoProduto) | UrlBase (legado)        | UrlBaseSpa (React)        | Abertura no portal |
|-----------------------|-------------------------|---------------------------|--------------------|
| DWF (EV2)             | …/DealerNetWF/          | —                         | Bridge .aspx + token |
| DHI (Hub Integration) | …/DealernetWFNetCore/?  | http://localhost:5175/    | SPA ?tela=+token |
| DNWA (Fast Service)   | …                       | …                         | a definir |
| FASTRENTAL            | …                       | …                         | a definir |

➡️ **Fechar**: quais soluções abrem como SPA, quais como legado, e preencher as URLs
base reais (dev e produção) na TRN SolucaoDMS.

## 5. Ordem de execução proposta

1. **Fechar a matriz §4** (quais soluções, quais URLs base dev/prod).
2. **Menu**: garantir TipoProduto por item (API_Portal_Menu + buildMenuTree).
3. **AbrirTelaEV2**: URL dinâmica por SolucaoDMS (§3.2).
4. **Importar** o ajuste pela IDE + Build.
5. **Testar**: portal → abrir tela DHI → token → validar → sessão → dados.
6. **EV2**: replicar o Context canônico no bridge.aspx (§3.4).

## Pendências abertas (preencher com o cliente/time)
- [ ] URLs base reais por solução (dev + produção) na TRN SolucaoDMS.
- [ ] Quais soluções são SPA vs legado.
- [ ] Confirmar que o menu (API_Portal_Menu) já entrega TipoProduto por nó.
