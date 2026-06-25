-- ---------------------------------------------------------------------------
-- Credit-change proposal: widen status lifecycle beyond 'draft'
--
-- The original migration (20260609000000_ops_credit_proposal.sql) constrained
-- status to 'draft' only. This additive follow-up widens the allowed values
-- so that approved proposals can drive customer_credit_limit fact updates via
-- a durable workflow step (required by the CRM auto-population story per
-- docs/specs/customer-management-rental-crm.md §6.3).
--
-- Rollback:
--   alter table public.credit_change_proposal
--     drop constraint if exists credit_change_proposal_status_chk;
--   alter table public.credit_change_proposal
--     add constraint credit_change_proposal_status_chk
--     check (status = 'draft');
-- ---------------------------------------------------------------------------

alter table public.credit_change_proposal
  drop constraint if exists credit_change_proposal_status_chk;

alter table public.credit_change_proposal
  add constraint credit_change_proposal_status_chk
  check (status in (
    'draft',          -- initial state; author editing
    'pending_review', -- submitted to approver queue
    'approved',       -- credit manager approved the change
    'rejected',       -- credit manager rejected the change
    'applied',        -- credit limit fact updated; proposal consumed
    'withdrawn'       -- withdrawn by author before approval
  ));
