# Morning Brief — A página perfeita (3 propostas)

> Só temos a oportunidade de apresentar **uma** página deste sistema. Ela precisa
> comunicar, em segundos, o **conceito agêntico** do DIA: agentes autônomos que
> trabalham de madrugada, varrem os dados da concessionária, **raciocinam** sobre o
> que importa e **propõem ações** que o dono aprova com um toque (human-in-the-loop).

Este diretório contém 3 mockups HTML auto-contidos (abra direto no navegador) que
exploram direções distintas para essa página. Foram pensados com o método
**AI-DLC (Inception leve)** descrito abaixo.

## AI-DLC · Inception

### Intent
Transformar o `MorningBrief` atual (resumo do dia anterior + fila de findings) na
**vitrine do conceito agêntico** — a tela que faz o dono entender, sem explicação,
que "o sistema trabalhou por mim enquanto eu dormia".

### Requisitos
- **Funcional**
  - Mostrar o resultado do dia anterior (por marca/loja, 5 setores: Novos, Usados,
    Peças, AT, Floor Plan) — dados reais de `v_dia_owner_brief_by_brand/_by_store`.
  - Destacar as **ações preparadas pelos agentes** (findings pendentes) com
    Confirmar/Dispensar de 1 toque — `getFindings` / `decideFinding`.
  - Tornar visível **quem** (agente) achou, **o quê**, **quanto** (R$ em jogo),
    **qual a confiança** e **por quê** (rationale) — o que gera confiança.
- **Não-funcional**
  - Legível em 5 segundos; hierarquia "dinheiro em risco → ação → contexto".
  - Acessível (semântica, teclado, contraste), responsivo (mobile→desktop).
  - Identidade visual alinhada às apresentações (`docs/presentations/`, brand `#1f63e8`).

### Os 4 agentes reais do DIA
| Agente | Vigia | Ação típica |
|---|---|---|
| Analista de estoque parado | Floor Plan / margem / model year | Baixar preço, transferir, leilão |
| Priorizador de cobranças | Contas a receber | Priorizar cobrança, renegociar |
| Consultor de estoque de peças | Estoque de peças vs. demanda | Repor antes da ruptura |
| Resgate de orçamentos de serviço | Orçamentos de oficina parados | Reengajar cliente, desconto |

## As 3 propostas

| Arquivo | Conceito | Aposta central | Quando ganha |
|---|---|---|---|
| `proposal-a-briefing.html` | **O Briefing** — narrativo/conversacional | DIA "fala" com o dono: o que os agentes fizeram à noite + pilha de ações | Encanta na 1ª impressão; vende o "trabalhou por mim" |
| `proposal-b-cockpit.html` | **O Cockpit** — executivo/denso | KPIs do grupo + tabela marca/loja + rail de ações dos agentes lado a lado | Dono que quer controle e visão BI do grupo |
| `proposal-c-mesa-decisoes.html` | **A Mesa de Decisões** — agente-cêntrico | 4 agentes como um time; cada um expõe achado, confiança, R$ e o "por quê" | Vende explicitamente o **multi-agente** e a confiança/explicabilidade |

Todos são protótipos visuais com **dados ilustrativos** (Grupo Bandeirantes;
Toyota/VW/Hyundai/Chevrolet). Nenhuma integração de backend — servem para decidir a
direção antes de levar ao `frontend-portal`.

### Como abrir
```bash
# qualquer um dos arquivos, direto no navegador
xdg-open docs/proposals/morning-brief/proposal-a-briefing.html
```
