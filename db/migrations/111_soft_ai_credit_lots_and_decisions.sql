-- =====================================================================
-- Soft AI - 111: Shaheer's credit decisions (9 Oct 2026) + Activity from the backend
--
-- 1. Monthly credits carry over to the next month and EXPIRE 1 YEAR after
--    they were given. Bought, transferred and admin credits never expire.
--    To know which credits are left from which month, every credit added is
--    kept as a "lot" (credit_lots). Spending always uses the lot that expires
--    first (monthly credits, oldest first), then the others (oldest first).
--    Lots are created and used up automatically by a trigger on the ledger,
--    so every existing function (buy, allowance, usage, transfer, admin) keeps
--    working unchanged; expired lots are removed (ledger entry "expiry" +
--    Activity) whenever the wallet is used.
-- 2. Packs: 1,000 credits = $25, 2,000 = $50, 3,000 = $75 (placeholder packs off).
-- 3. Monthly credits per plan: Free Trial 50, Pro 100, White Label 200.
-- 4. Action Activity entries are written by the backend (the ERP's
--    activity_events table now needs a permission to write from the browser).
--
-- Safe to re-run.
-- =====================================================================

-- ---------- 1. credit lots ----------

CREATE TABLE IF NOT EXISTS soft_ai.credit_lots (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,          -- ledger entry type that added it (or 'legacy')
  amount           NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  remaining        NUMERIC(18,4) NOT NULL CHECK (remaining >= 0),
  expires_at       TIMESTAMPTZ,            -- NULL = never
  ledger_id        BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_lots_open ON soft_ai.credit_lots (organization_id, expires_at NULLS LAST, id) WHERE remaining > 0;

ALTER TABLE soft_ai.credit_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON soft_ai.credit_lots FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_read ON soft_ai.credit_lots;
CREATE POLICY service_read ON soft_ai.credit_lots FOR SELECT TO soft_ai_service USING (true);
GRANT SELECT ON soft_ai.credit_lots TO soft_ai_service;

-- How long monthly credits stay usable (Shaheer, 9 Oct 2026).
CREATE OR REPLACE FUNCTION soft_ai._allowance_lifetime()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT interval '1 year' $$;

-- Use up credits from the lots: soonest-expiring first, then oldest.
CREATE OR REPLACE FUNCTION soft_ai._consume_lots(p_org UUID, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  lot  RECORD;
  left_to_take NUMERIC := p_amount;
  take NUMERIC;
BEGIN
  FOR lot IN
    SELECT id, remaining FROM soft_ai.credit_lots
     WHERE organization_id = p_org AND remaining > 0
     ORDER BY expires_at NULLS LAST, id
     FOR UPDATE
  LOOP
    EXIT WHEN left_to_take <= 0;
    take := LEAST(lot.remaining, left_to_take);
    UPDATE soft_ai.credit_lots SET remaining = remaining - take WHERE id = lot.id;
    left_to_take := left_to_take - take;
  END LOOP;
  IF left_to_take > 0 THEN
    -- Should never happen (lots always add up to the balance); the ledger stays the truth.
    RAISE WARNING 'credit lots short by % for organization %', left_to_take, p_org;
  END IF;
END;
$$;

-- Every ledger entry keeps the lots in step: + creates a lot, - uses lots up.
-- (Expiry entries written by _expire_lots carry the lot id; that lot is already empty.)
CREATE OR REPLACE FUNCTION soft_ai.ledger_track_lots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  IF NEW.amount > 0 THEN
    INSERT INTO soft_ai.credit_lots (organization_id, source, amount, remaining, expires_at, ledger_id, created_at)
    VALUES (NEW.organization_id, NEW.entry_type, NEW.amount, NEW.amount,
            CASE WHEN NEW.entry_type = 'allowance' THEN NEW.created_at + soft_ai._allowance_lifetime() END,
            NEW.id, NEW.created_at);
  ELSIF NOT (NEW.entry_type = 'expiry' AND NEW.reference ? 'lot_id') THEN
    PERFORM soft_ai._consume_lots(NEW.organization_id, -NEW.amount);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_track_lots ON soft_ai.ledger;
CREATE TRIGGER trg_ledger_track_lots AFTER INSERT ON soft_ai.ledger
  FOR EACH ROW EXECUTE FUNCTION soft_ai.ledger_track_lots();

-- Credits that existed before lots: one lot that never expires.
INSERT INTO soft_ai.credit_lots (organization_id, source, amount, remaining, expires_at)
SELECT w.organization_id, 'legacy', w.balance, w.balance, NULL
  FROM soft_ai.wallets w
 WHERE w.balance > 0
   AND NOT EXISTS (SELECT 1 FROM soft_ai.credit_lots l WHERE l.organization_id = w.organization_id);

-- Remove what is left of expired monthly credits (called with the wallet locked).
CREATE OR REPLACE FUNCTION soft_ai._expire_lots(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  lot       RECORD;
  v_balance NUMERIC;
  v_take    NUMERIC;
BEGIN
  FOR lot IN
    SELECT id, remaining, created_at FROM soft_ai.credit_lots
     WHERE organization_id = p_org AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY id
     FOR UPDATE
  LOOP
    SELECT balance INTO v_balance FROM soft_ai.wallets WHERE organization_id = p_org;
    v_take := LEAST(lot.remaining, COALESCE(v_balance, 0));
    UPDATE soft_ai.credit_lots SET remaining = 0 WHERE id = lot.id;
    IF v_take > 0 THEN
      UPDATE soft_ai.wallets SET balance = balance - v_take WHERE organization_id = p_org RETURNING balance INTO v_balance;
      INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after, reason, reference)
      VALUES (p_org, 'expiry', -v_take, v_balance, 'Monthly credits expired after 1 year',
              jsonb_build_object('lot_id', lot.id, 'granted_at', lot.created_at));
      PERFORM soft_ai._log_credit_activity(p_org, 'credits.expiry',
        format('Soft AI: %s unused monthly credits from %s expired', round(v_take, 2), to_char(lot.created_at, 'Mon YYYY')),
        NULL, jsonb_build_object('lot_id', lot.id));
    END IF;
  END LOOP;
END;
$$;

-- _lock_wallet (migration 101) + expire old monthly credits.
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
   WHERE organization_id = p_org;

  PERFORM soft_ai._expire_lots(p_org);

  SELECT * INTO w FROM soft_ai.wallets WHERE organization_id = p_org;
  RETURN w;
END;
$$;

-- Removes expired monthly credits now (the Credits screen calls it before showing the balance).
CREATE OR REPLACE FUNCTION soft_ai.refresh_wallet(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM soft_ai.credit_lots
              WHERE organization_id = p_org AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()) THEN
    PERFORM soft_ai._lock_wallet(p_org);
  END IF;
END;
$$;

-- Health check: lots must add up to the wallet balance (should return nothing).
CREATE OR REPLACE FUNCTION soft_ai.check_lot_integrity()
RETURNS TABLE (organization_id UUID, wallet_balance NUMERIC, lots_remaining NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  SELECT w.organization_id, w.balance, COALESCE(SUM(l.remaining), 0)
    FROM soft_ai.wallets w
    LEFT JOIN soft_ai.credit_lots l ON l.organization_id = w.organization_id
   GROUP BY w.organization_id, w.balance
  HAVING w.balance <> COALESCE(SUM(l.remaining), 0);
$$;

-- credit_status (migration 110) + credits expiring in the next 30 days.
CREATE OR REPLACE FUNCTION soft_ai.credit_status(p_org UUID, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_balance   NUMERIC := 0;
  v_reserved  NUMERIC := 0;
  v_available NUMERIC;
  v_month     NUMERIC := soft_ai._month_used(p_org);
  v_day       NUMERIC := soft_ai._user_day_used(p_org, p_user);
  v_expiring  NUMERIC;
  v_next_exp  TIMESTAMPTZ;
  s           soft_ai.org_credit_settings;
  w           TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT balance, reserved INTO v_balance, v_reserved FROM soft_ai.wallets WHERE organization_id = p_org;
  v_balance := COALESCE(v_balance, 0); v_reserved := COALESCE(v_reserved, 0);
  v_available := GREATEST(v_balance - v_reserved, 0);
  SELECT * INTO s FROM soft_ai.org_credit_settings WHERE organization_id = p_org;
  SELECT COALESCE(SUM(remaining), 0), MIN(expires_at) INTO v_expiring, v_next_exp
    FROM soft_ai.credit_lots
   WHERE organization_id = p_org AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() + interval '30 days';

  IF v_available <= 0 THEN
    w := array_append(w, 'empty');
  ELSIF v_month > 0 AND v_month >= 0.8 * (v_month + v_available) THEN
    w := array_append(w, 'used_80');
  END IF;
  IF s.monthly_limit IS NOT NULL THEN
    IF v_month >= s.monthly_limit THEN w := array_append(w, 'limit_100');
    ELSIF v_month >= 0.8 * s.monthly_limit THEN w := array_append(w, 'limit_80'); END IF;
  END IF;
  IF s.user_daily_limit IS NOT NULL THEN
    IF v_day >= s.user_daily_limit THEN w := array_append(w, 'user_limit_100');
    ELSIF v_day >= 0.8 * s.user_daily_limit THEN w := array_append(w, 'user_limit_80'); END IF;
  END IF;

  RETURN jsonb_build_object(
    'balance', round(v_balance, 4)::text,
    'reserved', round(v_reserved, 4)::text,
    'available', round(v_available, 4)::text,
    'month_used', round(v_month, 4)::text,
    'monthly_allowance', round(soft_ai._monthly_allowance(p_org), 4)::text,
    'monthly_limit', CASE WHEN s.monthly_limit IS NULL THEN NULL ELSE round(s.monthly_limit, 4)::text END,
    'user_day_used', round(v_day, 4)::text,
    'user_daily_limit', CASE WHEN s.user_daily_limit IS NULL THEN NULL ELSE round(s.user_daily_limit, 4)::text END,
    'expiring_30d', round(v_expiring, 4)::text,
    'next_expiry', v_next_exp,
    'warnings', to_jsonb(w));
END;
$$;

-- ---------- 2. packs (Shaheer, 9 Oct 2026) ----------

INSERT INTO soft_ai.credit_packs (id, name, credits, price_cents, currency, is_active, sort_order) VALUES
  ('pack_1000', '1,000 credits', 1000, 2500, 'usd', true, 1),
  ('pack_2000', '2,000 credits', 2000, 5000, 'usd', true, 2),
  ('pack_3000', '3,000 credits', 3000, 7500, 'usd', true, 3)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, credits = EXCLUDED.credits, price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();
-- Earlier local placeholder packs: no longer for sale (kept for purchase history).
UPDATE soft_ai.credit_packs SET is_active = false, updated_at = now()
 WHERE id NOT IN ('pack_1000', 'pack_2000', 'pack_3000') AND id NOT LIKE 'test\_%' AND is_active;

-- ---------- 3. monthly credits per plan (Shaheer, 9 Oct 2026) ----------

INSERT INTO soft_ai.plan_allowances (plan_slug, monthly_credits) VALUES
  ('trial', 50), ('pro', 100), ('white_label', 200)
ON CONFLICT (plan_slug) DO UPDATE SET monthly_credits = EXCLUDED.monthly_credits, updated_at = now();

-- ---------- 4. action Activity entries, written by the backend ----------

CREATE OR REPLACE FUNCTION soft_ai.log_action_activity(
  p_org UUID, p_actor UUID, p_event_type TEXT, p_description TEXT,
  p_entity_type TEXT, p_entity_id UUID, p_action_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  IF p_event_type !~ '^ai\.action\.[a-z_]+(\.undo)?$' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'bad event type';
  END IF;
  -- Only for actions of this organization (the backend passes its own saved action).
  IF NOT EXISTS (SELECT 1 FROM soft_ai.actions WHERE id = p_action_id AND organization_id = p_org) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'unknown action';
  END IF;
  INSERT INTO public.activity_events (organization_id, event_type, category, entity_type, entity_id, actor_id, description, meta)
  VALUES (p_org, p_event_type, 'ai', p_entity_type, p_entity_id, p_actor, left(p_description, 500),
          jsonb_build_object('source', 'soft_ai', 'action_id', p_action_id));
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'soft_ai.check_lot_integrity()', 'soft_ai.credit_status(uuid, uuid)', 'soft_ai.refresh_wallet(uuid)',
    'soft_ai.log_action_activity(uuid, uuid, text, text, text, uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO soft_ai_service', f);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION soft_ai._consume_lots(uuid, numeric), soft_ai._expire_lots(uuid) FROM PUBLIC;
END $$;
