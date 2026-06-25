# Spec — Issue #6: Usuários — gestão + CRUD (profiles/roles)

## Overview
Add a user-management admin screen for the DIA rental pilot, letting an admin create users, edit their display name and role, and deactivate them — without deleting their data. It reuses the existing `auth.users` + `public.profiles` + `app_role` model, adds an `is_active` flag, and introduces the project's first Edge Function (`admin-create-user`) for privileged user creation.

## Problem / Context
The pilot needs to manage its operators (owners, managers, field staff) but has no UI for it. Users live in GoTrue (`auth.users`) plus `public.profiles` (`supabase/migrations/20260607120000_user_roles_profiles.sql`), which already carries `display_name`, `role` (enum `admin | branch_manager | field_operator | read_only`), `tenant`, RLS policies (`profiles_select_own`, `profiles_select_admin`, `profiles_update_own` with no role escalation, `profiles_admin_all`), and the `get_my_role()` helper. Creating a user requires the Supabase admin API (service_role), which the browser client must never hold — so creation must run server-side in an Edge Function (`supabase/functions/` is currently empty), in the spirit of `scripts/seed-demo-users.sh`. Name/role edits reuse the existing UPDATE policies. There is currently no way to deactivate a user short of deletion, and the nav menu (`MOCK_MENU` in `frontend-portal/src/portal/lib/portalApi.ts`) has no role-based visibility.

## Acceptance Criteria
- [ ] **Deactivation flag.** A `profiles.is_active` boolean column exists, is `NOT NULL` and defaults to `true`; the migration applies cleanly and existing rows become `is_active = true`, with all current RLS policies on `profiles` still functioning unchanged.
- [ ] **Admin can create a user.** When an admin invokes user creation from the admin screen, a new auth user is created and a matching `profiles` row appears with the chosen `display_name`, `role`, and `tenant`.
- [ ] **Only admins can create users.** When a non-admin (e.g. `branch_manager`, `field_operator`, or `read_only`) attempts the create operation, it is rejected with an authorization error and no user is created.
- [ ] **Admin can manage users from the screen.** Logged in as admin, the user-management screen lists users showing `display_name`, `role`, `tenant`, and `is_active`, and allows editing a user's name and role and deactivating a user (`is_active = false`); each action is reflected in `profiles`.
- [ ] **Non-admins cannot escalate or alter others.** A non-admin user cannot create another user nor change any other user's role; such attempts fail at the database/function level even if the UI is bypassed.
- [ ] **Read-only sees no write controls.** Logged in as `read_only`, the user-management nav item and/or screen does not offer create, edit, or deactivate actions, and no write succeeds.
- [ ] **Demo users guaranteed after setup.** After running the demo setup, at least one `admin` user and at least one `branch_manager` user exist in `profiles` (reusing/extending `scripts/seed-demo-users.sh`).

## Non-Goals
- No new permission model: only the four existing roles (`admin`, `branch_manager`, `field_operator`, `read_only`) are used.
- No hard-delete of users; deactivation is done via `is_active = false` only.
- No changes to how roles are read from the JWT or to the existing `get_my_role()` / `get_my_tenant()` helpers beyond reusing them.

## Out-of-Scope
- SSO and production email-invite flows (creation here is direct, for the demo).
- Granular permissions beyond the four existing roles.
- Linking users to a specific store/company (user ↔ loja/empresa).

---

**This spec is a DRAFT and requires human approval before any code is written.**
