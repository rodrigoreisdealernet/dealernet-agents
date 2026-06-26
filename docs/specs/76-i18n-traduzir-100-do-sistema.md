# Spec: i18n — Traduzir 100% do Sistema Conforme Idioma Selecionado

**Issue:** [#76](https://github.com/rodrigoreisdealernet/dealernet-agents/issues/76)
**Status:** DRAFT — awaiting human approval before implementation

## Overview

Complete the i18n implementation so that **all user-facing content** (UI labels, AI-generated rationale, chat responses, agent narratives) respects the language selected in the Portal (pt-BR or en-US), without requiring code changes or data re-generation.

## Problem / Context

The Portal has an i18n foundation (issue #58, closed): `use-intl` + `LocaleProvider`, cookie `portal_locale`, and message dictionaries. However, **three critical flows are not yet localized:**

1. **AI Chat (DIA)**: The portal_assistant.py system prompt is hardcoded to respond in Portuguese; the frontend does not send the user's selected locale, so the DIA always replies in PT regardless of language choice.

2. **Agent-Generated Content**: Rationale and Proposed Action text produced by Temporal agents (vehicle_aging_analyst, revrec_analyst, etc.) are generated in a fixed language; they appear in FindingDetail without respecting the portal's language setting.

3. **Residual Hardcoded Strings**: Some UI components still have hardcoded labels (JSX, aria-labels, titles, placeholders) instead of using `t()` from `use-intl`.

**Impact:** A user who switches the portal to English sees English UI but Portuguese chat responses and agent narratives — inconsistent experience.

## Acceptance Criteria

### 1. Locale Propagated to Backend
The frontend **includes the current locale** (from `useLocale()`) in the `AssistantChatContext` payload sent to `/api/ops/assistant/chat` and in any agent execution trigger. The ops-api accepts and forwards the locale to portal_assistant.py and agent workflows.

**Verification:** POST to `/api/ops/assistant/chat` includes `context.locale` field; tests confirm the field is passed through to the agent.

### 2. DIA Chat Responds in Selected Language
When the user selects **en-US** in the Portal and starts a chat, the DIA assistant responds in English. When switching to **pt-BR**, new chat turns respond in Portuguese. The system prompt in portal_assistant.py dynamically references the locale (e.g., "Responda em português" vs. "Reply in English") with a fallback to pt-BR.

**Verification:** Manual test — chat with portal set to en-US and pt-BR; confirm language of response changes. Automated test confirms system prompt contains locale-aware instruction.

### 3. Agent Rationale and Proposed Action Respect Locale
FindingDetail displays `data.rationale` and `data.proposed_action` in the language of the portal at the time of viewing. If findings are persisted in a fixed language, the frontend uses the portal's locale to determine display; for new findings, agents generate text in the target language specified at execution time.

**Verification:** Create a finding with portal set to en-US; rationale and proposed_action appear in English. Tests confirm locale is passed to agent workflows.

### 4. All UI Strings Use `t()` — No Hardcoded Text
Audit frontend-portal/src for any user-visible hardcoded strings (JSX text nodes, placeholders, titles, aria-labels, errors, toasts) outside of `t()` calls and migrate them to i18n dictionaries. Confirm **pt-BR.json and en-US.json have identical key sets** (no key in one without the other).

**Verification:** `npm run lint` passes; audit script confirms no new hardcoded strings; JSON keys are identical (line count and key names match).

### 5. Existing Contracts and Tests Pass
All existing Temporal workflow and activity contracts (e.g., vehicle_aging_contract, service_order_crud) remain compatible. Tests for ops-api and agents pass without modification. Frontend build and lint succeed.

**Verification:**
- `cd frontend-portal && npm run lint && npm run build && npm test`
- `python -m pytest temporal/tests/ -v`

### 6. Draft ONLY — Requires Human Approval
This spec is a draft. No implementation begins until a human (PM or tech lead) reviews and approves it on the GitHub issue.

## Non-Goals

- Support for third languages beyond pt-BR and en-US.
- Retranslation of findings already persisted in a fixed language (focus on new executions).
- Schema migrations or data re-versioning beyond additive changes.
- Translation of logs, internal component names, or technical documentation.

## Out of Scope

- Changes to message file format or loading mechanism (already proven in issue #58).
- Modifications to Supabase tenant/user table structure (use existing metadata if needed).
- Agent UI workflow re-design (rationale and action are already fields; display is unchanged).
- Internationalization of third-party integrations (Coupa, Samsara, etc.) outside of the Portal.

---

**DRAFT — Awaiting human approval before code implementation.**
