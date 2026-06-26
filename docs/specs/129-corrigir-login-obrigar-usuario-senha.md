# Spec — Issue #129: Corrigir login (obrigar usuário/senha) e seletor de idioma (apenas bandeira)

## Overview
Two small UX fixes in the DMS Portal (`frontend-portal/`). First, the login form must block submission when the username or password fields are empty. Second, the language switcher in the top bar must display only the current language's flag — removing the leading languages icon and the trailing locale code.

## Problem / Context
- **Login validation is bypassed.** The username and password inputs already carry the `required` attribute, but the `<motion.form>` (Login.tsx, line 116) sets `noValidate`, which disables the browser's native validation. As a result, a user can submit the login form with empty fields. Because the demo login ignores credentials, there is no server-side gate either, so empty submissions slip through.
- **Language switcher is cluttered.** The switcher trigger in the top bar (TopBar.tsx, lines 186–188) renders three elements: a `<Languages>` icon, the current `<LocaleFlag />`, and a `<span>` with the locale code (`pt-BR` / `en-US`). The desired UX is a single, clean flag-only trigger. The dropdown list itself (flag + language name) already works correctly and should remain unchanged.

These were confirmed against the current code in the worktree; the file paths and line references in the issue are accurate.

## Acceptance Criteria
- [ ] Submitting the login form with an empty username and/or empty password is blocked on the client, and the user sees a "required field" feedback indication.
- [ ] When both username and password are filled, the login flow proceeds normally (as it does today).
- [ ] The language switcher trigger in the top bar displays **only** the current language flag — no leading icon and no `pt-BR` / `en-US` text.
- [ ] The language dropdown menu still opens and lets the user switch languages, showing each option as flag + language name.
- [ ] `cd frontend-portal && npm run build && npm test` completes successfully.

## Non-Goals
- Does not add or change backend/server-side credential validation (the demo login still ignores the entered credentials).
- Does not change the visual styling, theme, or layout of the login form beyond enforcing required-field validation.
- Does not alter the contents or behavior of the language dropdown list itself (flag + language name remain).

## Out-of-Scope
- Any other forms or validation flows outside the Portal login screen.
- The theme switcher, accent/color selector, or other TopBar controls.
- Internationalization copy changes or adding new supported locales.
