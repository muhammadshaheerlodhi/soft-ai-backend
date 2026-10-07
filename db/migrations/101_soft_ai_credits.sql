-- =====================================================================
-- Soft AI - 101: credit wallet and ledger
--
-- How credits work:
--   wallets       one row per organization: balance + credits on hold
--   ledger        every change ever made to a balance (append-only)
--   reservations  credits put "on hold" before an AI call, then settled
--
-- Flow for one AI request:
--   1. reserve_credits()  -> puts an estimated amount on hold
--                            (fails with 'insufficient_credits' if not enough)
--   2. call the AI model
--   3. settle_reservation() -> charges the real amount, releases the hold
--      or release_reservation() if the call failed (nothing charged)
--
-- Rules enforced by the database itself (not only by our code):
--   * balance can never go below zero
--   * the ledger cannot be edited or deleted
--   * the same payment / grant (idempotency key) is never counted twice
--   * the backend role cannot UPDATE balances directly; only these
--     functions can (they run as the table owner: SECURITY DEFINER)
--
-- Every sub-account is its own organization, so it has its own wallet.
-- (Transfers between agency and sub-account: waiting for Shaheer's answer.)
--
-- Safe to re-run.
-- =====================================================================

-- ---------- tables ----------

CREATE TABLE IF NOT EXISTS soft_ai.wallets (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  balance         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved        NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_wallets_touch ON soft_ai.wallets;
CREATE TRIGGER trg_wallets_touch BEFORE UPDATE ON soft_ai.wallets
  FOR EACH ROW EXECUTE FUNCTION soft_ai.touch_updated_at();

CREATE TABLE IF NOT EXISTS soft_ai.reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount          NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'held'
                  CHECK (status IN ('held', 'settled', 'released', 'expired')),
  charged_amount  NUMERIC(18,4),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reservations_org_held
  ON soft_ai.reservations (organization_id, expires_at) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS soft_ai.ledger (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_type       TEXT NOT NULL CHECK (entry_type IN (
                     'trial',         -- free trial credits
                     'purchase',      -- bought (Stripe or manual payment)
                     'allowance',     -- monthly plan allowance
                     'admin_adjust',  -- added or removed by an admin, with a reason
                     'usage',         -- spent on an AI request
                     'transfer_in',   -- reserved for agency -> sub-account transfers
                     'transfer_out',
                     'expiry'         -- unused credits removed (if rollover is off)
                   )),
  amount           NUMERIC(18,4) NOT NULL CHECK (amount <> 0),  -- + adds, - spends
  balance_after    NUMERIC(18,4) NOT NULL CHECK (balance_after >= 0),
  idempotency_key  TEXT,          -- e.g. Stripe event id; makes retries safe
  reservation_id   UUID REFERENCES soft_ai.reservations(id) ON DELETE SET NULL,
  actor_user_id    UUID,          -- who caused it (admin, buyer, user); no FK so history survives
  reason           TEXT,
  reference        JSONB NOT NULL DEFAULT '{}',  -- message id, model, tokens, stripe ids...
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_org_idempotency
  ON soft_ai.ledger (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_reservation_usage
  ON soft_ai.ledger (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_org_created
  ON soft_ai.ledger (organization_id, created_at DESC);

-- Admin-set price list: how many credits 1,000 tokens cost, per model.
-- A new row with a later effective_from changes the price without touching history.
CREATE TABLE IF NOT EXISTS soft_ai.model_rates (
  model                  TEXT NOT NULL,
  input_credits_per_1k   NUMERIC(18,6) NOT NULL CHECK (input_credits_per_1k >= 0),
  output_credits_per_1k  NUMERIC(18,6) NOT NULL CHECK (output_credits_per_1k >= 0),
  effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID,
  PRIMARY KEY (model, effective_from)
);

-- ---------- ledger is append-only ----------

CREATE OR REPLACE FUNCTION soft_ai.ledger_block_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  -- Allowed only when the whole organization was deleted (ON DELETE CASCADE,
  -- which can also null reservation_id first), so the ERP's own
  -- "delete organization" keeps working. Anything else is blocked.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.organization_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'soft_ai.ledger is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_append_only ON soft_ai.ledger;
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON soft_ai.ledger
  FOR EACH ROW EXECUTE FUNCTION soft_ai.ledger_block_changes();

-- ---------- internal helper ----------

-- Lock (and create if missing) the wallet row. Always lock the wallet FIRST,
-- then reservations, so two requests can never deadlock each other.
CREATE OR REPLACE FUNCTION soft_ai._lock_wallet(p_org UUID)
RETURNS soft_ai.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  w soft_ai.wallets;
BEGIN
  INSERT INTO soft_ai.wallets (organization_id) VALUES (p_org)
  ON CONFLICT (organization_id) DO NOTHING;

  SELECT * INTO w FROM soft_ai.wallets WHERE organization_id = p_org FOR UPDATE;

  -- Release holds that timed out (for example the backend crashed mid-call).
  WITH expired AS (
    UPDATE soft_ai.reservations
       SET status = 'expired', closed_at = now()
     WHERE organization_id = p_org AND status = 'held' AND expires_at < now()
    RETURNING amount
  )
  SELECT w.reserved - COALESCE(SUM(amount), 0) INTO w.reserved FROM expired;

  UPDATE soft_ai.wallets SET reserved = GREATEST(w.reserved, 0)
   WHERE organization_id = p_org
  RETURNING * INTO w;

  RETURN w;
END;
$$;

-- ---------- public functions (called by the backend) ----------

-- Add or remove credits (purchase, trial, allowance, admin adjustment).
-- Returns the ledger id. Calling again with the same idempotency key returns
-- the first ledger id and changes nothing.
CREATE OR REPLACE FUNCTION soft_ai.add_credits(
  p_org             UUID,
  p_amount          NUMERIC,
  p_entry_type      TEXT,
  p_idempotency_key TEXT,
  p_actor_user_id   UUID DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_reference       JSONB DEFAULT '{}'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  w        soft_ai.wallets;
  existing BIGINT;
  new_id   BIGINT;
BEGIN
  IF p_entry_type NOT IN ('trial', 'purchase', 'allowance', 'admin_adjust', 'expiry') THEN
    RAISE EXCEPTION 'invalid entry type for add_credits: %', p_entry_type;
  END IF;
  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'amount must not be zero';
  END IF;
  IF p_amount < 0 AND p_entry_type NOT IN ('admin_adjust', 'expiry') THEN
    RAISE EXCEPTION 'only admin_adjust or expiry may remove credits';
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  IF p_entry_type = 'admin_adjust' AND (p_reason IS NULL OR length(trim(p_reason)) = 0) THEN
    RAISE EXCEPTION 'a reason is required for admin adjustments';
  END IF;

  w := soft_ai._lock_wallet(p_org);

  -- Retry of the same event: return the original entry, do nothing else.
  SELECT id INTO existing FROM soft_ai.ledger
   WHERE organization_id = p_org AND idempotency_key = p_idempotency_key;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;

  IF w.balance + p_amount < 0 THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001',
      DETAIL = format('balance %s, change %s', w.balance, p_amount);
  END IF;

  UPDATE soft_ai.wallets SET balance = balance + p_amount
   WHERE organization_id = p_org RETURNING * INTO w;

  INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after,
                              idempotency_key, actor_user_id, reason, reference)
  VALUES (p_org, p_entry_type, p_amount, w.balance,
          p_idempotency_key, p_actor_user_id, p_reason, COALESCE(p_reference, '{}'))
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Put credits on hold before an AI call. Raises 'insufficient_credits' if the
-- available balance (balance - reserved) is too small. This is the hard stop.
CREATE OR REPLACE FUNCTION soft_ai.reserve_credits(
  p_org     UUID,
  p_user_id UUID,
  p_amount  NUMERIC,
  p_ttl     INTERVAL DEFAULT interval '5 minutes'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  w      soft_ai.wallets;
  res_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'reserve amount must be positive';
  END IF;
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '1 hour' THEN
    RAISE EXCEPTION 'reservation ttl must be between 0 and 1 hour';
  END IF;

  w := soft_ai._lock_wallet(p_org);

  IF w.balance - w.reserved < p_amount THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001',
      DETAIL = format('available %s, needed %s', w.balance - w.reserved, p_amount);
  END IF;

  UPDATE soft_ai.wallets SET reserved = reserved + p_amount WHERE organization_id = p_org;

  INSERT INTO soft_ai.reservations (organization_id, user_id, amount, expires_at)
  VALUES (p_org, p_user_id, p_amount, now() + p_ttl)
  RETURNING id INTO res_id;

  RETURN res_id;
END;
$$;

-- Charge the real cost of a finished AI call and release the hold.
-- If the real cost is higher than the balance, we charge what is left (the
-- balance never goes negative) and record the shortfall in reference.
-- Calling it twice for the same reservation charges only once.
CREATE OR REPLACE FUNCTION soft_ai.settle_reservation(
  p_reservation_id UUID,
  p_actual_amount  NUMERIC,
  p_reference      JSONB DEFAULT '{}'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_org    UUID;
  w        soft_ai.wallets;
  r        soft_ai.reservations;
  v_charge NUMERIC(18,4);
  existing BIGINT;
  new_id   BIGINT;
BEGIN
  IF p_actual_amount IS NULL OR p_actual_amount < 0 THEN
    RAISE EXCEPTION 'actual amount must be zero or more';
  END IF;

  SELECT organization_id INTO v_org FROM soft_ai.reservations WHERE id = p_reservation_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;

  w := soft_ai._lock_wallet(v_org);                       -- wallet first
  SELECT * INTO r FROM soft_ai.reservations WHERE id = p_reservation_id FOR UPDATE;

  IF r.status = 'settled' THEN                            -- retry: do nothing
    SELECT id INTO existing FROM soft_ai.ledger WHERE reservation_id = r.id;
    RETURN existing;
  END IF;
  IF r.status = 'released' THEN
    RAISE EXCEPTION 'reservation was released, cannot settle';
  END IF;

  -- Hold still active: give it back before charging the real amount.
  -- (If it expired, _lock_wallet already gave it back.)
  IF r.status = 'held' THEN
    UPDATE soft_ai.wallets SET reserved = GREATEST(reserved - r.amount, 0)
     WHERE organization_id = v_org RETURNING * INTO w;
  END IF;

  v_charge := LEAST(round(p_actual_amount, 4), w.balance);

  UPDATE soft_ai.reservations
     SET status = 'settled', charged_amount = v_charge, closed_at = now()
   WHERE id = r.id;

  IF v_charge = 0 THEN
    RETURN NULL;  -- nothing to charge (e.g. answered from cache); no ledger row
  END IF;

  UPDATE soft_ai.wallets SET balance = balance - v_charge
   WHERE organization_id = v_org RETURNING * INTO w;

  INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after,
                              reservation_id, actor_user_id, reference)
  VALUES (v_org, 'usage', -v_charge, w.balance, r.id, r.user_id,
          COALESCE(p_reference, '{}') || jsonb_build_object(
            'requested', round(p_actual_amount, 4),
            'shortfall', round(p_actual_amount, 4) - v_charge))
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Cancel a hold without charging (the AI call failed or was cancelled).
CREATE OR REPLACE FUNCTION soft_ai.release_reservation(p_reservation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_org UUID;
  r     soft_ai.reservations;
BEGIN
  SELECT organization_id INTO v_org FROM soft_ai.reservations WHERE id = p_reservation_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;

  PERFORM soft_ai._lock_wallet(v_org);
  SELECT * INTO r FROM soft_ai.reservations WHERE id = p_reservation_id FOR UPDATE;

  IF r.status <> 'held' THEN
    RETURN;  -- already settled, released or expired: nothing to do
  END IF;

  UPDATE soft_ai.wallets SET reserved = GREATEST(reserved - r.amount, 0)
   WHERE organization_id = v_org;
  UPDATE soft_ai.reservations SET status = 'released', closed_at = now()
   WHERE id = r.id;
END;
$$;

-- Read-only health check: does the wallet balance equal the sum of its ledger?
-- Returns organizations where it does not (should always return nothing).
CREATE OR REPLACE FUNCTION soft_ai.check_wallet_integrity()
RETURNS TABLE (organization_id UUID, wallet_balance NUMERIC, ledger_sum NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT w.organization_id, w.balance, COALESCE(SUM(l.amount), 0)
    FROM soft_ai.wallets w
    LEFT JOIN soft_ai.ledger l ON l.organization_id = w.organization_id
   GROUP BY w.organization_id, w.balance
  HAVING w.balance <> COALESCE(SUM(l.amount), 0);
$$;

-- ---------- permissions ----------

ALTER TABLE soft_ai.wallets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.model_rates  ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated = no access for browsers (and they have no
-- schema access anyway). The service role reads through these policies:
DROP POLICY IF EXISTS service_read ON soft_ai.wallets;
CREATE POLICY service_read ON soft_ai.wallets      FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_read ON soft_ai.reservations;
CREATE POLICY service_read ON soft_ai.reservations FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_read ON soft_ai.ledger;
CREATE POLICY service_read ON soft_ai.ledger       FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_all ON soft_ai.model_rates;
CREATE POLICY service_all ON soft_ai.model_rates   FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);

REVOKE ALL ON soft_ai.wallets, soft_ai.reservations, soft_ai.ledger, soft_ai.model_rates
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON soft_ai.wallets, soft_ai.reservations, soft_ai.ledger TO soft_ai_service;
GRANT SELECT, INSERT ON soft_ai.model_rates TO soft_ai_service;   -- prices: add new rows, never edit old

REVOKE EXECUTE ON FUNCTION soft_ai._lock_wallet(UUID) FROM PUBLIC;   -- internal only
REVOKE EXECUTE ON FUNCTION
  soft_ai.add_credits(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB),
  soft_ai.reserve_credits(UUID, UUID, NUMERIC, INTERVAL),
  soft_ai.settle_reservation(UUID, NUMERIC, JSONB),
  soft_ai.release_reservation(UUID),
  soft_ai.check_wallet_integrity()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  soft_ai.add_credits(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB),
  soft_ai.reserve_credits(UUID, UUID, NUMERIC, INTERVAL),
  soft_ai.settle_reservation(UUID, NUMERIC, JSONB),
  soft_ai.release_reservation(UUID),
  soft_ai.check_wallet_integrity()
  TO soft_ai_service;
