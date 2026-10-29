-- =====================================================================
-- Soft AI - 104: agency -> sub-account credit transfers
--
-- Shaheer's decision (7 Oct 2026): every organization (agency or sub-account)
-- has its OWN wallet. Credits can come from:
--   1. buying them                  -> add_credits(..., 'purchase', ...)
--   2. the agency giving them        -> transfer_credits() below
--   3. the platform admin dashboard  -> add_credits(..., 'admin_adjust', ...)
--
-- Rules enforced here:
--   * only from an agency to ITS OWN sub-account (organizations.parent_organization_id)
--   * only the agency owner may transfer (checked again here, not only in the backend)
--   * the agency must have enough AVAILABLE credits (balance minus holds)
--   * both ledger entries are written together, or neither
--   * a retried request (same idempotency key) does not transfer twice
--
-- Safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION soft_ai.transfer_credits(
  p_from_org        UUID,
  p_to_org          UUID,
  p_amount          NUMERIC,
  p_actor_user_id   UUID,
  p_idempotency_key TEXT,
  p_reason          TEXT DEFAULT NULL
)
RETURNS BIGINT          -- ledger id of the 'transfer_in' entry
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  w_from   soft_ai.wallets;
  w_to     soft_ai.wallets;
  existing BIGINT;
  in_id    BIGINT;
  v_amount NUMERIC(18,4);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'transfer amount must be positive';
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  IF p_from_org = p_to_org THEN
    RAISE EXCEPTION 'cannot transfer to the same organization';
  END IF;
  v_amount := round(p_amount, 4);

  -- The receiver must be a sub-account of the sender.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_to_org AND o.parent_organization_id = p_from_org
       AND o.is_active = true AND o.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not_a_sub_account' USING ERRCODE = 'P0001',
      DETAIL = 'credits can only go from an agency to its own sub-account';
  END IF;

  -- Only the agency owner may give credits away.
  IF NOT EXISTS (
    SELECT 1 FROM soft_ai.member_context(p_from_org, p_actor_user_id) mc WHERE mc.is_owner
  ) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'P0001',
      DETAIL = 'only the agency owner can transfer credits';
  END IF;

  -- Lock both wallets in a fixed order (smaller id first) so two transfers
  -- running at the same time can never deadlock.
  IF p_from_org < p_to_org THEN
    w_from := soft_ai._lock_wallet(p_from_org);
    w_to   := soft_ai._lock_wallet(p_to_org);
  ELSE
    w_to   := soft_ai._lock_wallet(p_to_org);
    w_from := soft_ai._lock_wallet(p_from_org);
  END IF;

  -- Retry of the same request: return the original entry, do nothing.
  SELECT id INTO existing FROM soft_ai.ledger
   WHERE organization_id = p_to_org AND idempotency_key = p_idempotency_key;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;

  IF w_from.balance - w_from.reserved < v_amount THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001',
      DETAIL = format('available %s, needed %s', w_from.balance - w_from.reserved, v_amount);
  END IF;

  UPDATE soft_ai.wallets SET balance = balance - v_amount
   WHERE organization_id = p_from_org RETURNING * INTO w_from;
  UPDATE soft_ai.wallets SET balance = balance + v_amount
   WHERE organization_id = p_to_org RETURNING * INTO w_to;

  INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after,
                              idempotency_key, actor_user_id, reason, reference)
  VALUES (p_from_org, 'transfer_out', -v_amount, w_from.balance,
          p_idempotency_key, p_actor_user_id, p_reason,
          jsonb_build_object('to_organization_id', p_to_org));

  INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after,
                              idempotency_key, actor_user_id, reason, reference)
  VALUES (p_to_org, 'transfer_in', v_amount, w_to.balance,
          p_idempotency_key, p_actor_user_id, p_reason,
          jsonb_build_object('from_organization_id', p_from_org))
  RETURNING id INTO in_id;

  RETURN in_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.transfer_credits(UUID, UUID, NUMERIC, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.transfer_credits(UUID, UUID, NUMERIC, UUID, TEXT, TEXT) TO soft_ai_service;
