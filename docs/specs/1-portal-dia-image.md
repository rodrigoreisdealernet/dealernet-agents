# Spec — Issue #1: Imagem do Portal (DIA — Dealernet Intelligence Agents)

> **STATUS: DRAFT** — aguarda aprovação humana (gate #1 do /ship-issue) antes de qualquer código.

## Overview

O Portal DMS hoje exibe a marca "DMS — Dealernet" em vários pontos da interface (título HTML, logos e nome dinâmico do portal). Esta mudança rebrandeia o Portal para exibir "DIA — Dealernet Intelligence Agents" em todos os pontos de branding visíveis ao usuário: título HTML, texto do nome do portal e badges da sidebar, além de adicionar um asset de imagem com o nome do produto DIA.

## Problem / Context

A issue #1 pede a criação de uma imagem com o nome do projeto **DIA - Dealernet Intelligence Agents** e a sua troca no Portal. Hoje o Portal usa:

- Título HTML estático: "Portal DMS — Dealernet"
- Nome dinâmico do portal (config): default "Dealernet Portal"
- Logos em 3 pontos: tela de Login, header da Sidebar (expandida e recolhida) e header do Drawer
- Badge da sidebar recolhida: texto "DMS"

## Acceptance Criteria

- [ ] O título HTML em `frontend-portal/index.html` exibe a marca DIA (ex.: "Portal DIA — Dealernet Intelligence Agents")
- [ ] O nome do portal no `TopBar.tsx` exibe "DIA" / "Portal DIA" (em vez de "Dealernet Portal")
- [ ] O badge da sidebar recolhida em `Sidebar.tsx` exibe "DIA" em vez de "DMS"
- [ ] O default `portalName` no mock (`portalApi.ts`) e o fallback da API real (`portalApiReal.ts`) refletem o nome do produto DIA
- [ ] Um novo asset de imagem (PNG ou SVG) com "DIA — Dealernet Intelligence Agents" é adicionado a `frontend-portal/public/` e referenciado nos pontos de logo
- [ ] Todos os rótulos/tooltips visíveis que dizem "Portal DMS" ou referenciam "DMS" foram identificados e atualizados para DIA

## Non-Goals

- Substituir a marca/ícone gráfico da Dealernet — muda apenas o nome/título do produto
- Atualizar documentação ou comentários internos além do código do Portal
- Criar variantes de idioma ou branding regional

## Out-of-scope

- Construir um novo design system ou refazer o design do Portal
- Logos animados ou variantes complexas de asset
- Atualizar branding de componentes de terceiros ou dependências externas

## Pontos de troca mapeados (apêndice da investigação)

| Local | Arquivo | Linha | Valor atual | Tipo |
|-------|---------|-------|-------------|------|
| Título HTML | `frontend-portal/index.html` | 7 | "Portal DMS — Dealernet" | texto estático |
| Favicon | `frontend-portal/index.html` | 5 | `/vite.svg` | referência |
| Logo do Login | `src/portal/components/Login.tsx` | 47 | `/Dealernet_Logo35anos.png` | img src |
| Sidebar expandida | `src/portal/components/Sidebar.tsx` | 215 | `/DMS_DealernetMultiSolutions.png` | img src |
| Badge sidebar recolhida | `src/portal/components/Sidebar.tsx` | 210-212 | "DMS" | texto |
| Header do Drawer | `src/portal/components/Sidebar.tsx` | 172 | `/DMS_DealernetMultiSolutions.png` | img src |
| Nome no TopBar (dinâmico) | `src/portal/components/TopBar.tsx` | 60 | `config?.portalName` (→ "Dealernet Portal") | config |
| Config mock | `src/portal/lib/portalApi.ts` | 53 | "Dealernet Portal" | string default |
| Fallback config API | `src/portal/lib/portalApiReal.ts` | 908 | "Dealernet Portal" | fallback default |

## Perguntas para o aprovador (gate humano)

1. Nome/tagline exato a usar: "DIA", "Portal DIA" ou "DIA — Dealernet Intelligence Agents"?
2. O asset de imagem novo deve ser gerado (PNG/SVG) ou reaproveitamos um logo existente com texto sobreposto?
3. Outros frontends (ex.: `frontend/`) também precisam do mesmo rebrand, ou só o `frontend-portal`?
