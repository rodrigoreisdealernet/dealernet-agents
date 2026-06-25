-- Contract tests: seed executable DO $$ block role-claim context.
--
-- seed.sql wraps all writes in DO $$ blocks that call
--   PERFORM set_config('request.jwt.claim.role', 'service_role', true);
-- at the top of each block.  The three hardened write RPCs
-- (create_entity_with_version, rental_upsert_entity_current_state,
-- rental_upsert_relationship) read that GUC at call time.
--
-- These tests verify the specific invariants required by the hardening
-- introduced for PR #2206:
--
--   A. DO block with inner set_config only (no outer SET LOCAL):
--      The role claim is set INSIDE the DO block; the block is self-contained
--      and does not depend on any broader transaction setup.
--      All three write RPCs must succeed.
--
--   B. DO block with no claim set (neither outer SET LOCAL nor inner set_config):
--      The write-RPC guard fires with SQLSTATE 42501 inside the DO block.
--      This validates the negative path is enforced at execution time.
--
--   C. Outer SET LOCAL + inner set_config (exact seed.sql layout):
--      seed.sql opens each transaction with
--        set local request.jwt.claim.role = 'service_role';
--      and each DO block also calls
--        PERFORM set_config('request.jwt.claim.role', 'service_role', true);
--      Both claim paths are active; write RPCs must succeed.
--
--   D. Outer SET LOCAL visible inside a subsequent DO block:
--      PostgreSQL propagates a transaction-level SET LOCAL into nested DO
--      block scope. A DO block without its own inner set_config call can
--      still write when the outer SET LOCAL is present.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- A + B  — inner-only set_config and no-claim guard, in a single block that
--          resets the GUC between sub-tests using set_config.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_entity_id   uuid;
  v_version_num int;
  v_eid_a       uuid;
  v_eid_b       uuid;
  v_rel_id      uuid;
  v_caught      bool;
begin
  -- ── A: inner set_config only — no outer SET LOCAL ────────────────────────
  -- Explicitly clear both claim paths so there is no residual outer claim.
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  -- Set the role claim INSIDE the block, as seed.sql does on every DO block.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- rental_upsert_entity_current_state
  select entity_id into v_entity_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_data             => '{"name":"Seed Bootstrap Contract A","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-contract-test-a'
  );
  if v_entity_id is null then
    raise exception
      'FAIL A1: rental_upsert_entity_current_state returned null inside DO block '
      'with inner set_config — seed self-contained block pattern broken';
  end if;

  -- create_entity_with_version
  select entity_id, version_number into v_eid_a, v_version_num
  from create_entity_with_version(
    p_entity_type      => 'branch',
    p_data             => '{"name":"Seed Bootstrap Branch A","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-branch-test-a'
  );
  if v_eid_a is null then
    raise exception
      'FAIL A2: create_entity_with_version returned null inside DO block '
      'with inner set_config — seed self-contained block pattern broken';
  end if;

  -- rental_upsert_relationship — use company_has_region (company → region)
  select entity_id into v_eid_b
  from rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_data             => '{"name":"Seed Bootstrap Region A","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-region-test-a'
  );
  v_rel_id := rental_upsert_relationship('company_has_region', v_entity_id, v_eid_b);
  if v_rel_id is null then
    raise exception
      'FAIL A3: rental_upsert_relationship returned null inside DO block '
      'with inner set_config — seed self-contained block pattern broken';
  end if;

  raise notice 'PASS A: DO-block inner set_config enables all three write RPCs (seed self-contained block pattern)';

  -- ── B: no claim set — guard must block ───────────────────────────────────
  -- Clear both claim paths to simulate a DO block that forgot its set_config.
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  v_caught := false;
  begin
    select entity_id into v_entity_id
    from rental_upsert_entity_current_state(
      p_entity_type      => 'company',
      p_data             => '{"name":"Seed Bootstrap Contract B","tenant":"default"}'::jsonb,
      p_source_record_id => 'seed-block-contract-test-b'
    );
    raise exception
      'FAIL B: rental_upsert_entity_current_state succeeded with no role claim '
      'inside DO block — write-RPC guard not enforced';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL B: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception
      'FAIL B: write-RPC guard did not block (42501) when no role claim is set '
      'inside DO block';
  end if;

  raise notice 'PASS B: write-RPC guard correctly blocks (42501) — no role claim inside DO block';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C: outer SET LOCAL + inner set_config — the exact seed.sql layout.
--    seed.sql opens with `set local request.jwt.claim.role = 'service_role'`
--    and each DO block repeats `PERFORM set_config(...)`.
-- ─────────────────────────────────────────────────────────────────────────────
set local request.jwt.claim.role = 'service_role';

do $$
declare
  v_entity_id uuid;
  v_eid_c     uuid;
  v_rel_id    uuid;
begin
  -- Repeat the inner set_config exactly as seed.sql does.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- rental_upsert_entity_current_state
  select entity_id into v_entity_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_data             => '{"name":"Seed Bootstrap Contract C","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-contract-test-c'
  );
  if v_entity_id is null then
    raise exception
      'FAIL C1: rental_upsert_entity_current_state returned null — '
      'seed.sql layout (outer SET LOCAL + inner set_config) broken';
  end if;

  -- rental_upsert_relationship — use company_has_region (company → region)
  select entity_id into v_eid_c
  from rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_data             => '{"name":"Seed Bootstrap Region C","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-region-test-c'
  );
  v_rel_id := rental_upsert_relationship('company_has_region', v_entity_id, v_eid_c);
  if v_rel_id is null then
    raise exception
      'FAIL C2: rental_upsert_relationship returned null — '
      'seed.sql layout (outer SET LOCAL + inner set_config) broken';
  end if;

  raise notice 'PASS C: outer SET LOCAL + inner set_config (seed.sql layout) enables write RPCs';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D: outer SET LOCAL visible inside DO block — no inner set_config needed.
--    The SET LOCAL from test C is still active (same transaction), so this
--    DO block can write without its own set_config call.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_entity_id uuid;
begin
  -- No inner set_config — relying solely on the outer SET LOCAL.
  select entity_id into v_entity_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_data             => '{"name":"Seed Bootstrap Contract D","tenant":"default"}'::jsonb,
    p_source_record_id => 'seed-block-contract-test-d'
  );
  if v_entity_id is null then
    raise exception
      'FAIL D: rental_upsert_entity_current_state returned null inside DO block '
      'with only outer SET LOCAL — PostgreSQL GUC transaction-scope regression';
  end if;

  raise notice 'PASS D: outer SET LOCAL is visible inside DO block — transaction-scope GUC propagates correctly';
end;
$$;

rollback;
