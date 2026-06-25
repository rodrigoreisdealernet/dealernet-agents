# ADR-0023: User role model, profiles table, and demo credential seeding

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Factory Architect

## Context

GoTrue is running and one placeholder user (`demo@wynne-rental.dev`) existed, but there was
no role/permission model, no way to create additional users from the app, no user profile
surfaced in the UI, and no documented demo credentials. The RLS migration (20260606) gated
writes to `service_role` only; authenticated users had read-only access with no way to
distinguish their capabilities.

The accepted tenant-scoping ADR-0019 defers Postgres RLS to core entity tables but explicitly
calls for role-gated writes once auth lands. This ADR records how that is done.

## Decision

### 1. Role enum — four named roles stored in `app_metadata`

Define a Postgres `app_role` enum and use GoTrue's `app_metadata.role` field as the canonical
role claim. GoTrue embeds `app_metadata` verbatim in the issued JWT, so the frontend reads the
role from `user.app_metadata.role` without an extra round-trip.

| Role | Capability |
|------|-----------|
| `admin` | Full read/write on all tables; can manage user profiles |
| `branch_manager` | Full read/write on core entity/operational tables |
| `field_operator` | Read + insert on operational records (inspections, check-ins) |
| `read_only` | Read-only access for authenticated sessions |

### 2. Profiles table — display name, role, tenant surfaced for UI queries

A `public.profiles` table (keyed on `auth.users.id`) carries `display_name`, `role`, and
`tenant`. This gives the UI a single PostgREST-accessible row to display "who is logged in"
without decoding the raw JWT.

A `SECURITY DEFINER` trigger (`handle_new_user`) on `auth.users` INSERT + UPDATE keeps the
profiles table in sync with `app_metadata` automatically.

### 3. Helper SQL functions

- `get_my_role() → app_role` — reads `auth.jwt() -> 'app_metadata' ->> 'role'`; used in
  RLS policy `USING` clauses.
- `get_my_tenant() → text` — same source; used for future tenant-scoped RLS.

### 4. RLS policies — role-gated authenticated writes on core entity tables

`authenticated_*` policies provide role-aware authenticated access, and anon read is removed for
core business tables:

| Policy | Tables | Condition |
|--------|--------|-----------|
| `authenticated_read` | all core entity tables | `TO authenticated USING (true)` |
| `authenticated_manager_write` | all core entity tables | role IN (`admin`, `branch_manager`) |
| `authenticated_field_insert` | `entities`, `entity_versions`, `entity_facts` | role IN (`admin`, `branch_manager`, `field_operator`) |

`service_role_write` remains in place for service-role automation paths.

### 5. Demo credential seeding via `scripts/seed-demo-users.sh`

A shell script seeds four demo users into `auth.users` via `pgcrypto`-hashed passwords. The
script consumes passwords from environment variables only — passwords are never committed in
plain text. The script is idempotent (ON CONFLICT DO UPDATE). Demo accounts:

| Email | Role |
|-------|------|
| `admin@wynne-rental.dev` | `admin` |
| `manager@wynne-rental.dev` | `branch_manager` |
| `operator@wynne-rental.dev` | `field_operator` |
| `readonly@wynne-rental.dev` | `read_only` |

The legacy `demo@wynne-rental.dev` account is promoted to `admin`.

Credentials are stored using the secrets workflow (#125) — specifically as
`DEMO_ADMIN_PASS` and `DEMO_OPERATOR_PASS` secrets in the environment's secret store.

### 6. Frontend auth layer

- `AuthProvider` wraps the app; subscribes to GoTrue auth state changes via
  `supabase.auth.onAuthStateChange`.
- `useAuth()` hook exposes `{ session, profile, isLoading, signIn, signOut }`.
- Profile is derived from `user.app_metadata` (role, tenant) and `user.user_metadata`
  (display_name) without a separate DB fetch on the hot path.
- The app shell header shows: display name, role badge, sign-out button (authenticated) or
  a sign-in dialog trigger (unauthenticated).
- Helper functions `canWrite(role)` and `canOperate(role)` gate UI actions client-side;
  server-side RLS is the authoritative enforcement point.

## Consequences

- **Role claim propagation:** the JWT claim is set at sign-in time from `app_metadata`. If an
  admin updates a user's role via the DB, the user must sign out and back in for the new claim
  to be reflected in their token.
- **Profile sync:** the trigger keeps profiles in sync on INSERT/UPDATE to `auth.users`; direct
  DB edits to `app_metadata` outside GoTrue bypass the trigger; run `seed-demo-users.sh` to
  re-sync.
- **Tenant isolation:** `get_my_tenant()` is available for future RLS policies; per ADR-0019,
  tenant scoping on core entity tables is deferred. The anon-lockdown change is a separate,
  interim hardening step; tenant-claim-scoped RLS remains tracked as required follow-up in #120.
- **No admin UI yet:** user/role management from the UI is out of scope for this story; it is
  tracked as a follow-up under epic #130.

## Alternatives considered

- **`user_roles` join table instead of `app_metadata`** — rejected for MVP: the JWT claim is
  the authoritative source for RLS; a join table would require a DB fetch on every policy
  evaluation or a custom token hook. The profiles table still gives the UI a queryable row.
- **Custom JWT hook to inject role** — available in Supabase Pro / Edge Functions; deferred
  until needed because `app_metadata` is already embedded by GoTrue in the OSS stack.
- **Immediate RLS on dimension tables** — these are small, static tables; read-only via anon is
  acceptable; write access via `service_role` (migrations / seed) is sufficient for now.

## Evidence

- `supabase/migrations/20260607120000_user_roles_profiles.sql`
- `scripts/seed-demo-users.sh`
- `frontend/src/auth/AuthContext.tsx`, `frontend/src/auth/types.ts`, `frontend/src/auth/LoginDialog.tsx`
- `frontend/src/routes/__root.tsx` (Header auth slot)
- Related: ADR-0017 (anon client), ADR-0019 (tenant/RLS deferred), issues #120, #124, #125, #130
