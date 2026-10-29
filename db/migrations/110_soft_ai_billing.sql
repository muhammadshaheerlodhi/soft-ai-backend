-- =====================================================================
-- Soft AI - 110: buying credits, monthly allowance, limits, warnings,
-- admin views (step 9)
--
--   credit_packs          what users can buy (admin-set; prices are Shaheer's decision)
--   credit_purchases      every Stripe checkout we started; credits are added ONLY
--                         when Stripe confirms payment (signed webhook), once
--   plan_allowances       monthly credits included in each ERP plan (subscription_plans.slug)
--   org_credit_settings   per organization: allowance override, monthly cap,
--                         daily cap per user (set by platform admins)
--
-- The hard stop at zero (migration 101) stays; reserve_credits() now also
-- enforces the monthly cap and the per-user daily cap.
-- Every credit change made here is also written to the ERP's Activity feed
-- (public.activity_events, category 'credits').
--
-- Safe to re-run.
-- =====================================================================

-- ---------- tables ----------

CREATE TABLE IF NOT EXISTS soft_ai.credit_packs (
  id           TEXT PRIMARY KEY,                 -- e.g. 'pack_1000'
  name         TEXT NOT NULL,
  credits      NUMERIC(18,4) NOT NULL CHECK (credits > 0),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS soft_ai.credit_purchases (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id            UUID,                       -- who bought (no FK: history survives)
  pack_id            TEXT NOT NULL REFERENCES soft_ai.credit_packs(id),
  credits            NUMERIC(18,4) NOT NULL CHECK (credits > 0),   -- fixed at checkout time
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  currency           TEXT NOT NULL,
  stripe_session_id  TEXT UNIQUE,
  stripe_payment_intent TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  ledger_id          BIGINT,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_org ON soft_ai.credit_purchases (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS soft_ai.plan_allowances (
  plan_slug        TEXT PRIMARY KEY,             -- public.subscription_plans.slug (e.g. 'trial', 'pro')
  monthly_credits  NUMERIC(18,4) NOT NULL CHECK (monthly_credits >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID
);

CREATE TABLE IF NOT EXISTS soft_ai.org_credit_settings (
  organization_id          UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  monthly_allowance        NUMERIC(18,4) CHECK (monthly_allowance >= 0),  -- NULL = plan's allowance
  monthly_limit            NUMERIC(18,4) CHECK (monthly_limit >= 0),      -- NULL = no cap
  user_daily_limit         NUMERIC(18,4) CHECK (user_daily_limit >= 0),   -- NULL = no cap
  note                     TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               UUID
);

-- What Google charges us (USD per 1M tokens), for "model cost vs revenue" in the admin panel.
ALTER TABLE soft_ai.model_rates ADD COLUMN IF NOT EXISTS provider_input_usd_per_1m  NUMERIC(18,6);
ALTER TABLE soft_ai.model_rates ADD COLUMN IF NOT EXISTS provider_output_usd_per_1m NUMERIC(18,6);

ALTER TABLE soft_ai.credit_packs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.credit_purchases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.plan_allowances     ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.org_credit_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON soft_ai.credit_packs, soft_ai.credit_purchases, soft_ai.plan_allowances, soft_ai.org_credit_settings
  FROM PUBLIC, anon, authenticated;
-- The backend reads these; every change goes through the functions below.
DROP POLICY IF EXISTS service_read ON soft_ai.credit_packs;
CREATE POLICY service_read ON soft_ai.credit_packs        FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_read ON soft_ai.credit_purchases;
CREATE POLICY service_read ON soft_ai.credit_purchases    FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_read ON soft_ai.plan_allowances;
CREATE POLICY service_read ON soft_ai.plan_allowances     FOR SELECT TO soft_ai_service USING (true);
DROP POLICY IF EXISTS service_read ON soft_ai.org_credit_settings;
CREATE POLICY service_read ON soft_ai.org_credit_settings FOR SELECT TO soft_ai_service USING (true);
GRANT SELECT ON soft_ai.credit_packs, soft_ai.credit_purchases, soft_ai.plan_allowances, soft_ai.org_credit_settings
  TO soft_ai_service;

-- ---------- Activity feed (ERP) ----------

-- Writes one 'credits' entry to the ERP's Activity page of that organization.
-- Only this category, only from our own functions (not granted to the backend).
CREATE OR REPLACE FUNCTION soft_ai._log_credit_activity(
  p_org UUID, p_type TEXT, p_description TEXT, p_actor UUID, p_meta JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.activity_events (organization_id, event_type, category, actor_id, description, meta)
  VALUES (p_org, p_type, 'credits', p_actor, left(p_description, 500),
          COALESCE(p_meta, '{}') || jsonb_build_object('source', 'soft_ai'));
EXCEPTION WHEN others THEN
  -- The Activity feed must never block a credit change; the ledger is the real record.
  RAISE WARNING 'activity log failed: %', SQLERRM;
END;
$$;
REVOKE EXECUTE ON FUNCTION soft_ai._log_credit_activity(UUID, TEXT, TEXT, UUID, JSONB) FROM PUBLIC;

-- ---------- usage this month / today ----------

-- Credits spent this calendar month (UTC), plus what is on hold right now.
CREATE OR REPLACE FUNCTION soft_ai._month_used(p_org UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  SELECT COALESCE((SELECT -SUM(amount) FROM soft_ai.ledger
                    WHERE organization_id = p_org AND entry_type = 'usage'
                      AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)
       + COALESCE((SELECT SUM(amount) FROM soft_ai.reservations
                    WHERE organization_id = p_org AND status = 'held' AND expires_at >= now()), 0);
$$;

CREATE OR REPLACE FUNCTION soft_ai._user_day_used(p_org UUID, p_user UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  SELECT COALESCE((SELECT -SUM(amount) FROM soft_ai.ledger
                    WHERE organization_id = p_org AND entry_type = 'usage' AND actor_user_id = p_user
                      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)
       + COALESCE((SELECT SUM(amount) FROM soft_ai.reservations
                    WHERE organization_id = p_org AND user_id = p_user AND status = 'held' AND expires_at >= now()), 0);
$$;

-- ---------- monthly allowance ----------

-- Monthly credits for an organization: its override, else its plan's allowance.
CREATE OR REPLACE FUNCTION soft_ai._monthly_allowance(p_org UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT monthly_allowance FROM soft_ai.org_credit_settings WHERE organization_id = p_org),
    (SELECT pa.monthly_credits
       FROM public.organization_subscriptions s
       JOIN soft_ai.plan_allowances pa ON pa.plan_slug = s.plan_slug
      WHERE s.organization_id = p_org AND s.status IN ('active', 'trial', 'trialing')
      ORDER BY s.updated_at DESC NULLS LAST LIMIT 1),
    0);
$$;

-- Adds this month's allowance once (called before AI requests and by the
-- credits screen; safe to call any number of times). Unused allowance is
-- kept (rollover) until Shaheer decides otherwise.
CREATE OR REPLACE FUNCTION soft_ai.grant_monthly_allowance(p_org UUID)
RETURNS NUMERIC            -- credits added now (0 if already done or none)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_month  TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_amount NUMERIC := soft_ai._monthly_allowance(p_org);
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN 0;
  END IF;
  IF EXISTS (SELECT 1 FROM soft_ai.ledger WHERE organization_id = p_org AND idempotency_key = 'allowance:' || v_month) THEN
    RETURN 0;
  END IF;
  PERFORM soft_ai.add_credits(p_org, v_amount, 'allowance', 'allowance:' || v_month, NULL,
                              'Monthly allowance ' || v_month, jsonb_build_object('month', v_month));
  PERFORM soft_ai._log_credit_activity(p_org, 'credits.allowance',
    format('Soft AI: %s monthly credits added (%s)', round(v_amount, 2), v_month), NULL, jsonb_build_object('month', v_month));
  RETURN v_amount;
EXCEPTION WHEN unique_violation THEN
  RETURN 0;  -- two requests at the same moment: the other one added it
END;
$$;

-- ---------- limits: enforced when credits are put on hold ----------

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
  s      soft_ai.org_credit_settings;
  res_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'reserve amount must be positive';
  END IF;
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '1 hour' THEN
    RAISE EXCEPTION 'reservation ttl must be between 0 and 1 hour';
  END IF;

  w := soft_ai._lock_wallet(p_org);   -- also serializes concurrent requests of this organization

  IF w.balance - w.reserved < p_amount THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001',
      DETAIL = format('available %s, needed %s', w.balance - w.reserved, p_amount);
  END IF;

  SELECT * INTO s FROM soft_ai.org_credit_settings WHERE organization_id = p_org;
  IF s.monthly_limit IS NOT NULL AND soft_ai._month_used(p_org) + p_amount > s.monthly_limit THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = 'P0001', DETAIL = 'monthly';
  END IF;
  IF s.user_daily_limit IS NOT NULL AND p_user_id IS NOT NULL
     AND soft_ai._user_day_used(p_org, p_user_id) + p_amount > s.user_daily_limit THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = 'P0001', DETAIL = 'user_daily';
  END IF;

  UPDATE soft_ai.wallets SET reserved = reserved + p_amount WHERE organization_id = p_org;

  INSERT INTO soft_ai.reservations (organization_id, user_id, amount, expires_at)
  VALUES (p_org, p_user_id, p_amount, now() + p_ttl)
  RETURNING id INTO res_id;

  RETURN res_id;
END;
$$;

-- ---------- what the credits screen shows ----------

-- Balance, this month's usage, limits and warnings for one user of an organization.
-- Warnings: 'used_80' (80% of this month's credits used), 'empty' (nothing left),
-- 'limit_80' / 'limit_100' (monthly cap), 'user_limit_80' / 'user_limit_100' (daily cap).
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
  s           soft_ai.org_credit_settings;
  w           TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT balance, reserved INTO v_balance, v_reserved FROM soft_ai.wallets WHERE organization_id = p_org;
  v_balance := COALESCE(v_balance, 0); v_reserved := COALESCE(v_reserved, 0);
  v_available := GREATEST(v_balance - v_reserved, 0);
  SELECT * INTO s FROM soft_ai.org_credit_settings WHERE organization_id = p_org;

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
    'warnings', to_jsonb(w));
END;
$$;

-- ---------- buying credits (Stripe) ----------

-- Called by the backend after Stripe created the checkout page.
CREATE OR REPLACE FUNCTION soft_ai.start_credit_purchase(
  p_org UUID, p_user UUID, p_pack_id TEXT, p_stripe_session_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  p  soft_ai.credit_packs;
  id UUID;
BEGIN
  SELECT * INTO p FROM soft_ai.credit_packs WHERE credit_packs.id = p_pack_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'unknown credit pack';
  END IF;
  INSERT INTO soft_ai.credit_purchases (organization_id, user_id, pack_id, credits, amount_cents, currency, stripe_session_id)
  VALUES (p_org, p_user, p.id, p.credits, p.price_cents, p.currency, p_stripe_session_id)
  RETURNING credit_purchases.id INTO id;
  RETURN id;
END;
$$;

-- Called by the backend when Stripe's SIGNED webhook says the checkout was paid.
-- Adds the credits recorded at checkout time (never an amount from the request),
-- only if the paid amount and currency match, and only once per checkout.
CREATE OR REPLACE FUNCTION soft_ai.complete_credit_purchase(
  p_stripe_session_id TEXT,
  p_amount_total      INTEGER,
  p_currency          TEXT,
  p_payment_intent    TEXT,
  p_event_id          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  pur      soft_ai.credit_purchases;
  v_ledger BIGINT;
BEGIN
  SELECT * INTO pur FROM soft_ai.credit_purchases WHERE stripe_session_id = p_stripe_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'unknown_session');
  END IF;
  IF pur.status = 'paid' THEN
    RETURN jsonb_build_object('result', 'already_paid', 'organization_id', pur.organization_id);
  END IF;
  IF p_amount_total IS DISTINCT FROM pur.amount_cents OR lower(p_currency) IS DISTINCT FROM pur.currency THEN
    UPDATE soft_ai.credit_purchases
       SET status = 'failed', failure_reason = format('paid %s %s, expected %s %s', p_amount_total, p_currency, pur.amount_cents, pur.currency)
     WHERE id = pur.id;
    RETURN jsonb_build_object('result', 'amount_mismatch', 'organization_id', pur.organization_id);
  END IF;

  v_ledger := soft_ai.add_credits(pur.organization_id, pur.credits, 'purchase', 'stripe:' || p_stripe_session_id,
                                  pur.user_id, NULL,
                                  jsonb_build_object('stripe_session_id', p_stripe_session_id, 'stripe_event_id', p_event_id,
                                                     'pack_id', pur.pack_id, 'amount_cents', pur.amount_cents, 'currency', pur.currency));
  UPDATE soft_ai.credit_purchases
     SET status = 'paid', paid_at = now(), ledger_id = v_ledger, stripe_payment_intent = p_payment_intent
   WHERE id = pur.id;
  PERFORM soft_ai._log_credit_activity(pur.organization_id, 'credits.purchase',
    format('Soft AI: %s credits bought (%s %s)', round(pur.credits, 2), to_char(pur.amount_cents / 100.0, 'FM999999990.00'), upper(pur.currency)),
    pur.user_id, jsonb_build_object('purchase_id', pur.id));
  RETURN jsonb_build_object('result', 'paid', 'organization_id', pur.organization_id, 'credits', pur.credits::text);
END;
$$;

CREATE OR REPLACE FUNCTION soft_ai.expire_credit_purchase(p_stripe_session_id TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  UPDATE soft_ai.credit_purchases SET status = 'expired'
   WHERE stripe_session_id = p_stripe_session_id AND status = 'pending';
$$;

-- ---------- agency -> sub-account transfer, logged in both Activity feeds ----------

CREATE OR REPLACE FUNCTION soft_ai.transfer_credits_logged(
  p_from_org UUID, p_to_org UUID, p_amount NUMERIC, p_actor_user_id UUID, p_idempotency_key TEXT, p_reason TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_id      BIGINT;
  v_from    TEXT;
  v_to      TEXT;
  v_new     BOOLEAN;
BEGIN
  v_new := NOT EXISTS (SELECT 1 FROM soft_ai.ledger WHERE organization_id = p_to_org AND idempotency_key = p_idempotency_key);
  v_id := soft_ai.transfer_credits(p_from_org, p_to_org, p_amount, p_actor_user_id, p_idempotency_key, p_reason);
  IF v_new THEN
    SELECT name INTO v_from FROM public.organizations WHERE id = p_from_org;
    SELECT name INTO v_to FROM public.organizations WHERE id = p_to_org;
    PERFORM soft_ai._log_credit_activity(p_from_org, 'credits.transfer_out',
      format('Soft AI: %s credits sent to %s', round(p_amount, 2), v_to), p_actor_user_id, jsonb_build_object('to', p_to_org));
    PERFORM soft_ai._log_credit_activity(p_to_org, 'credits.transfer_in',
      format('Soft AI: %s credits received from %s', round(p_amount, 2), v_from), p_actor_user_id, jsonb_build_object('from', p_from_org));
  END IF;
  RETURN v_id;
END;
$$;

-- Sub-accounts of an agency with their balances (only for the agency's owners/admins).
CREATE OR REPLACE FUNCTION soft_ai.sub_account_balances(p_org UUID, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM soft_ai.member_context(p_org, p_user) mc WHERE mc.is_owner) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name,
                                        'available', round(COALESCE(w.balance - w.reserved, 0), 4)::text,
                                        'month_used', round(soft_ai._month_used(o.id), 4)::text) ORDER BY o.name)
      FROM public.organizations o
      LEFT JOIN soft_ai.wallets w ON w.organization_id = o.id
     WHERE o.parent_organization_id = p_org AND o.deleted_at IS NULL), '[]');
END;
$$;
REVOKE EXECUTE ON FUNCTION soft_ai.sub_account_balances(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.sub_account_balances(UUID, UUID) TO soft_ai_service;

-- ---------- platform admins (the ERP's own list) ----------

-- The user's platform-admin role ('owner', 'super_admin', 'billing_manager',
-- 'support') or NULL. Same sources as the ERP (public.platform_admins, owner
-- e-mail in system_settings); e-mail matches only count for a CONFIRMED e-mail.
CREATE OR REPLACE FUNCTION soft_ai.platform_admin_role(p_user UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    SELECT id, lower(email) AS email FROM auth.users WHERE id = p_user AND email_confirmed_at IS NOT NULL
  )
  SELECT COALESCE(
    (SELECT 'owner' FROM u, public.system_settings s
      WHERE s.key = 'owner_email' AND lower(trim(s.value)) = u.email LIMIT 1),
    (SELECT pa.role FROM public.platform_admins pa
      WHERE pa.is_active AND (pa.user_id = p_user OR lower(pa.email) = (SELECT email FROM u))
      ORDER BY CASE pa.role WHEN 'owner' THEN 1 WHEN 'super_admin' THEN 2 WHEN 'billing_manager' THEN 3 ELSE 4 END
      LIMIT 1));
$$;

-- E-mail of a confirmed user (the backend checks it against PLATFORM_OWNER_EMAIL).
CREATE OR REPLACE FUNCTION soft_ai.confirmed_email(p_user UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT lower(email) FROM auth.users WHERE id = p_user AND email_confirmed_at IS NOT NULL;
$$;

-- ---------- admin views and changes (backend checks the admin role first) ----------

CREATE OR REPLACE FUNCTION soft_ai.admin_organizations(p_search TEXT, p_limit INTEGER, p_offset INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.organizations o
               WHERE o.deleted_at IS NULL AND (p_search IS NULL OR o.name ILIKE soft_ai._like(p_search))),
    'organizations', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT o.id, o.name, o.parent_organization_id AS parent_id, po.name AS parent_name,
               (SELECT s.plan_slug FROM public.organization_subscriptions s WHERE s.organization_id = o.id
                 ORDER BY s.updated_at DESC NULLS LAST LIMIT 1) AS plan,
               COALESCE(w.balance, 0)::text AS balance,
               COALESCE(w.reserved, 0)::text AS reserved,
               round(soft_ai._month_used(o.id), 4)::text AS month_used,
               round(soft_ai._monthly_allowance(o.id), 4)::text AS monthly_allowance,
               cs.monthly_limit::text AS monthly_limit,
               cs.user_daily_limit::text AS user_daily_limit,
               cs.monthly_allowance::text AS allowance_override
          FROM public.organizations o
          LEFT JOIN public.organizations po ON po.id = o.parent_organization_id
          LEFT JOIN soft_ai.wallets w ON w.organization_id = o.id
          LEFT JOIN soft_ai.org_credit_settings cs ON cs.organization_id = o.id
         WHERE o.deleted_at IS NULL AND (p_search IS NULL OR o.name ILIKE soft_ai._like(p_search))
         ORDER BY soft_ai._month_used(o.id) DESC, o.name
         LIMIT LEAST(GREATEST(p_limit, 1), 100) OFFSET GREATEST(p_offset, 0)
      ) r), '[]'));
$$;

-- One organization: recent ledger and this month's top users.
CREATE OR REPLACE FUNCTION soft_ai.admin_organization_detail(p_org UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'organization', (SELECT jsonb_build_object('id', o.id, 'name', o.name) FROM public.organizations o WHERE o.id = p_org),
    'ledger', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT l.id, l.entry_type, l.amount::text, l.balance_after::text, l.reason, l.created_at,
               (SELECT lower(email) FROM auth.users WHERE id = l.actor_user_id) AS actor
          FROM soft_ai.ledger l
         WHERE l.organization_id = p_org AND l.entry_type <> 'usage'
         ORDER BY l.created_at DESC LIMIT 50) r), '[]'),
    'top_users', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT (SELECT lower(email) FROM auth.users WHERE id = l.actor_user_id) AS user_email,
               round(-SUM(l.amount), 4)::text AS credits, count(*) AS requests
          FROM soft_ai.ledger l
         WHERE l.organization_id = p_org AND l.entry_type = 'usage'
           AND l.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         GROUP BY l.actor_user_id ORDER BY SUM(l.amount) ASC LIMIT 10) r), '[]'));
$$;

-- Platform totals for a period: credits used, provider cost (tokens x Google price),
-- credits sold and money received, per model and top organizations.
CREATE OR REPLACE FUNCTION soft_ai.admin_summary(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  WITH usage AS (
    SELECT l.organization_id, -l.amount AS credits,
           l.reference->>'model' AS model,
           COALESCE((l.reference->>'input_tokens')::numeric, 0) AS input_tokens,
           COALESCE((l.reference->>'output_tokens')::numeric, 0) AS output_tokens
      FROM soft_ai.ledger l
     WHERE l.entry_type = 'usage' AND l.created_at >= p_from AND l.created_at < p_to
  ), priced AS (
    SELECT u.*,
           (SELECT (u.input_tokens * mr.provider_input_usd_per_1m + u.output_tokens * mr.provider_output_usd_per_1m) / 1000000
              FROM soft_ai.model_rates mr WHERE mr.model = u.model AND mr.effective_from <= p_to
             ORDER BY mr.effective_from DESC LIMIT 1) AS cost_usd
      FROM usage u
  )
  SELECT jsonb_build_object(
    'credits_used', COALESCE((SELECT round(SUM(credits), 4) FROM priced), 0)::text,
    'requests', (SELECT count(*) FROM priced),
    'provider_cost_usd', COALESCE((SELECT round(SUM(cost_usd), 4) FROM priced), 0)::text,
    'cost_unknown_requests', (SELECT count(*) FROM priced WHERE cost_usd IS NULL),
    'by_model', COALESCE((SELECT jsonb_agg(m) FROM (
        SELECT model, count(*) AS requests, round(SUM(credits), 4)::text AS credits,
               SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
               round(SUM(cost_usd), 4)::text AS cost_usd
          FROM priced GROUP BY model ORDER BY SUM(credits) DESC) m), '[]'),
    'top_organizations', COALESCE((SELECT jsonb_agg(t) FROM (
        SELECT p.organization_id AS id, o.name, round(SUM(p.credits), 4)::text AS credits, count(*) AS requests
          FROM priced p JOIN public.organizations o ON o.id = p.organization_id
         GROUP BY p.organization_id, o.name ORDER BY SUM(p.credits) DESC LIMIT 10) t), '[]'),
    'sales', COALESCE((SELECT jsonb_agg(s) FROM (
        SELECT currency, count(*) AS purchases, round(SUM(credits), 4)::text AS credits,
               to_char(SUM(amount_cents) / 100.0, 'FM9999999990.00') AS amount
          FROM soft_ai.credit_purchases
         WHERE status = 'paid' AND paid_at >= p_from AND paid_at < p_to
         GROUP BY currency) s), '[]'));
$$;

-- Admin adds or removes credits (reason required; logged with the admin's id).
CREATE OR REPLACE FUNCTION soft_ai.admin_adjust_credits(
  p_org UUID, p_amount NUMERIC, p_reason TEXT, p_admin UUID, p_idempotency_key TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_id  BIGINT;
  v_new BOOLEAN;
BEGIN
  v_new := NOT EXISTS (SELECT 1 FROM soft_ai.ledger WHERE organization_id = p_org AND idempotency_key = p_idempotency_key);
  v_id := soft_ai.add_credits(p_org, p_amount, 'admin_adjust', p_idempotency_key, p_admin, p_reason, '{}');
  IF v_new THEN
    PERFORM soft_ai._log_credit_activity(p_org, 'credits.admin_adjust',
      format('Soft AI: %s%s credits by platform admin (%s)', CASE WHEN p_amount > 0 THEN '+' ELSE '' END, round(p_amount, 2), p_reason),
      p_admin, jsonb_build_object('ledger_id', v_id));
  END IF;
  RETURN v_id;
END;
$$;

-- Admin sets an organization's allowance override and caps (NULL = none / plan default).
CREATE OR REPLACE FUNCTION soft_ai.admin_set_org_settings(
  p_org UUID, p_monthly_allowance NUMERIC, p_monthly_limit NUMERIC, p_user_daily_limit NUMERIC, p_note TEXT, p_admin UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'organization not found';
  END IF;
  INSERT INTO soft_ai.org_credit_settings (organization_id, monthly_allowance, monthly_limit, user_daily_limit, note, updated_by, updated_at)
  VALUES (p_org, p_monthly_allowance, p_monthly_limit, p_user_daily_limit, p_note, p_admin, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    monthly_allowance = EXCLUDED.monthly_allowance, monthly_limit = EXCLUDED.monthly_limit,
    user_daily_limit = EXCLUDED.user_daily_limit, note = EXCLUDED.note,
    updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM soft_ai._log_credit_activity(p_org, 'credits.settings',
    format('Soft AI credit settings changed: allowance %s, monthly cap %s, daily cap per user %s',
           COALESCE(round(p_monthly_allowance, 2)::text, 'plan default'), COALESCE(round(p_monthly_limit, 2)::text, 'none'),
           COALESCE(round(p_user_daily_limit, 2)::text, 'none')), p_admin, '{}');
END;
$$;

CREATE OR REPLACE FUNCTION soft_ai.admin_set_pack(
  p_id TEXT, p_name TEXT, p_credits NUMERIC, p_price_cents INTEGER, p_currency TEXT, p_active BOOLEAN, p_sort INTEGER
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  INSERT INTO soft_ai.credit_packs (id, name, credits, price_cents, currency, is_active, sort_order)
  VALUES (p_id, p_name, p_credits, p_price_cents, lower(p_currency), p_active, p_sort)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, credits = EXCLUDED.credits, price_cents = EXCLUDED.price_cents,
    currency = EXCLUDED.currency, is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order, updated_at = now();
$$;

CREATE OR REPLACE FUNCTION soft_ai.admin_set_plan_allowance(p_plan_slug TEXT, p_monthly_credits NUMERIC, p_admin UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  INSERT INTO soft_ai.plan_allowances (plan_slug, monthly_credits, updated_by) VALUES (p_plan_slug, p_monthly_credits, p_admin)
  ON CONFLICT (plan_slug) DO UPDATE SET monthly_credits = EXCLUDED.monthly_credits, updated_by = EXCLUDED.updated_by, updated_at = now();
$$;

-- Plans of the ERP with their Soft AI allowance (for the admin panel).
CREATE OR REPLACE FUNCTION soft_ai.admin_plans()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(r ORDER BY r.sort_order, r.slug), '[]') FROM (
    SELECT sp.slug, sp.name, sp.sort_order, sp.is_active, COALESCE(pa.monthly_credits, 0)::text AS monthly_credits
      FROM public.subscription_plans sp
      LEFT JOIN soft_ai.plan_allowances pa ON pa.plan_slug = sp.slug) r;
$$;

-- ---------- permissions ----------

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'soft_ai._month_used(uuid)', 'soft_ai._user_day_used(uuid, uuid)', 'soft_ai._monthly_allowance(uuid)',
    'soft_ai.grant_monthly_allowance(uuid)', 'soft_ai.credit_status(uuid, uuid)',
    'soft_ai.start_credit_purchase(uuid, uuid, text, text)',
    'soft_ai.complete_credit_purchase(text, integer, text, text, text)', 'soft_ai.expire_credit_purchase(text)',
    'soft_ai.transfer_credits_logged(uuid, uuid, numeric, uuid, text, text)',
    'soft_ai.platform_admin_role(uuid)', 'soft_ai.confirmed_email(uuid)',
    'soft_ai.admin_organizations(text, integer, integer)', 'soft_ai.admin_organization_detail(uuid)',
    'soft_ai.admin_summary(timestamptz, timestamptz)', 'soft_ai.admin_adjust_credits(uuid, numeric, text, uuid, text)',
    'soft_ai.admin_set_org_settings(uuid, numeric, numeric, numeric, text, uuid)',
    'soft_ai.admin_set_pack(text, text, numeric, integer, text, boolean, integer)',
    'soft_ai.admin_set_plan_allowance(text, numeric, uuid)', 'soft_ai.admin_plans()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO soft_ai_service', f);
  END LOOP;
END $$;
