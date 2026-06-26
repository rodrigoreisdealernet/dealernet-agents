# AI-DLC State — Agentes DIA: transparência + preditividade

**Iniciativa:** Tornar os 4 agentes DIA transparentes (missão visível, próxima execução
real, prévia de decisão, histórico/observabilidade) e **preditivos** (horizonte/lead-time:
"vai estourar em N dias", não só estado atual).

**Workspace:** Brownfield (codebase existente — `temporal/`, `frontend-portal/`, `supabase/`).
**Escopo aprovado pelo usuário (@rodrigoreisdealernet):**
- Profundidade: **B** — transparência/robustez **+** tornar agentes preditivos.
- Abrangência: **os 4 agentes DIA** (`vehicle-aging-analyst`, `collections-prioritizer`,
  `parts-inventory-advisor`, `service-estimate-rescue`).
- Superfícies: card de missão, próxima execução real, prévia de aceitar/recusar, histórico de execuções.
- Gate: **spec-first** — produzir requisitos/spec e PARAR para aprovação humana antes de construir.

## Stages

| Fase | Stage | Status |
|------|-------|--------|
| Inception | Workspace Detection | ✅ done (brownfield) |
| Inception | Requirements Analysis | ✅ done — `inception/requirements/requirements.md` |
| Inception | Design / Spec | ✅ done — `inception/requirements/design-spec.md` |
| **GATE** | **Aprovação humana da spec** | ⏳ **AGUARDANDO @rodrigoreisdealernet** |
| Construction | Code Generation (por agente) | ⛔ bloqueado até aprovação |
| Construction | Build & Test | ⛔ bloqueado até aprovação |

## Extension Configuration
| Extension | Enabled | Nota |
|-----------|---------|------|
| (nenhuma opt-in detectada como aplicável) | — | Reavaliar na construção (security-baseline se aplicável a endpoints novos). |

## Próximo passo
Aguardando o usuário **aprovar / pedir mudanças** na spec. Nada será codado antes disso.

## Backlog de construção (issues criadas)
| Unidade | Issue | Título | Depende de |
|---|---|---|---|
| U1 | #124 | próxima execução real (next_run do cron) | — (fundação) |
| U2 | #125 | ficha de missão (catálogo estático) | #124 |
| U3 | #126 | prévia de decisão (decision_preview) | #124, #125 |
| U4 | #127 | preditividade (horizonte/days_to_breach) | #126 |
| U5 | #128 | histórico de execuções (view) | #124, #125 |

Ordem de execução recomendada: 124 → 125 → 126 → 127 → 128.
Método recomendado: `/ship-issue` sequencial (arquivos de frontend muito compartilhados ⇒ serial é mais limpo que worktrees paralelos).
