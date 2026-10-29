-- =====================================================================
-- Soft AI - ALL database changes in one file (migrations 100 to 114).
-- For the Supabase SQL editor: paste everything, press Run once.
--
-- * Take a backup first (Database -> Backups).
-- * The ERP migrations up to 071 must already be applied.
-- * Only creates things in the private "soft_ai" schema (+ the soft_ai_service role);
--   ERP tables are not changed.
-- * Everything runs in ONE transaction: if anything fails, nothing is changed.
-- * Safe to run again later (for example after an update).
-- * After this, set the service role password (see DEPLOY_RAILWAY.md step 2).
-- =====================================================================
BEGIN;

-- ######################## 100_soft_ai_foundation.sql ########################

-- =====================================================================
-- Soft AI - 100: foundation
-- Creates the private "soft_ai" schema and the service role.
--
-- Safety design:
--   * Everything Soft AI stores lives in its own schema, "soft_ai".
--     It is NOT exposed through the Supabase API (only "public" is), so a
--     browser can never read or write it, even with a valid login.
--   * anon / authenticated get no access at all.
--   * The backend connects as "soft_ai_service". That role can read the
--     tables but can only CHANGE credits through the functions in 101.
--   * Nothing in "public" (the ERP's own tables) is changed by this file.
--
-- Safe to re-run.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS soft_ai;

-- vector type for the knowledge base (Supabase installs extensions in "extensions")
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Service role used by the Soft AI backend.
-- NOLOGIN on purpose: no password is stored in this file. When the backend is
-- deployed, the database owner enables login and sets a password by hand:
--   ALTER ROLE soft_ai_service LOGIN PASSWORD '<strong password>';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soft_ai_service') THEN
    CREATE ROLE soft_ai_service NOLOGIN;
  END IF;
END $$;

-- Lock the schema down: nobody except the owner and the service role.
REVOKE ALL ON SCHEMA soft_ai FROM PUBLIC;
REVOKE ALL ON SCHEMA soft_ai FROM anon, authenticated;
GRANT USAGE ON SCHEMA soft_ai TO soft_ai_service;
GRANT USAGE ON SCHEMA extensions TO soft_ai_service;

-- Functions in PostgreSQL are executable by PUBLIC by default. Turn that off
-- for every function created in this schema from now on.
ALTER DEFAULT PRIVILEGES IN SCHEMA soft_ai REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The service role gets NO direct access to the ERP's tables.
-- To check who a user is inside an organization, the backend calls
-- soft_ai.member_context() below, which reads only what it needs.

-- Who is this user in this organization? Mirrors the ERP's own server check
-- (src/lib/security/api-auth.ts -> requireOrgPermissionApi):
--   * must be an active member
--   * owners (is_owner or role "company_owner") have every permission
--   * everyone else has the "module.action" permissions of their role
-- Returns no row if the user is not an active member of an active organization.
-- Requires ERP migration 055 (organizations.parent_organization_id).
CREATE OR REPLACE FUNCTION soft_ai.member_context(p_org UUID, p_user UUID)
RETURNS TABLE (
  organization_id        UUID,
  user_id                UUID,
  is_owner               BOOLEAN,
  role_slug              TEXT,
  permissions            TEXT[],
  parent_organization_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    om.organization_id,
    om.user_id,
    (om.is_owner OR r.slug = 'company_owner') AS is_owner,
    r.slug,
    COALESCE(
      ARRAY(
        SELECT p.module || '.' || p.action
          FROM public.role_permissions rp
          JOIN public.permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = om.role_id
         ORDER BY 1
      ),
      ARRAY[]::TEXT[]
    ),
    o.parent_organization_id
  FROM public.organization_members om
  JOIN public.organizations o ON o.id = om.organization_id
  LEFT JOIN public.roles r ON r.id = om.role_id
  WHERE om.organization_id = p_org
    AND om.user_id = p_user
    AND om.is_active = true
    AND o.is_active = true
    AND o.deleted_at IS NULL;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.member_context(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.member_context(UUID, UUID) TO soft_ai_service;

-- Shared helper: keep updated_at fresh.
CREATE OR REPLACE FUNCTION soft_ai.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ######################## 101_soft_ai_credits.sql ########################

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


-- ######################## 102_soft_ai_chat_and_actions.sql ########################

-- =====================================================================
-- Soft AI - 102: chat history and action log
--
--   conversations  one row per chat (shown in the chat list on the left)
--   messages       every message in a chat, with model, tokens and credits
--   actions        every action Soft AI proposed or ran, with its result
--                  and the data needed to undo it
--
-- Integrity: a message or action must belong to a conversation of the SAME
-- organization and the SAME user (composite foreign keys), so data from two
-- organizations can never be mixed, even by a bug in our code.
--
-- Deleting a chat is a soft delete (deleted_at). How long deleted and old
-- chats are kept is an open question for Shaheer (retention policy).
--
-- Safe to re-run.
-- =====================================================================

-- ---------- conversations ----------

CREATE TABLE IF NOT EXISTS soft_ai.conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT 'New chat' CHECK (length(title) <= 200),
  is_pinned        BOOLEAN NOT NULL DEFAULT false,
  archived_at      TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  message_count    INTEGER NOT NULL DEFAULT 0,
  credits_used     NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, user_id)          -- target for composite FKs
);

-- The chat list query: "my chats in this organization, newest first".
CREATE INDEX IF NOT EXISTS idx_conversations_user_list
  ON soft_ai.conversations (organization_id, user_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_conversations_touch ON soft_ai.conversations;
CREATE TRIGGER trg_conversations_touch BEFORE UPDATE ON soft_ai.conversations
  FOR EACH ROW EXECUTE FUNCTION soft_ai.touch_updated_at();

-- ---------- messages ----------

CREATE TABLE IF NOT EXISTS soft_ai.messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL,
  organization_id  UUID NOT NULL,
  user_id          UUID NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content          TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 100000),
  status           TEXT NOT NULL DEFAULT 'complete'
                   CHECK (status IN ('streaming', 'complete', 'stopped', 'error')),
  error_code       TEXT,
  model            TEXT,                         -- null for rules/cache answers
  answered_by      TEXT CHECK (answered_by IN ('rules', 'cache', 'model')),
  input_tokens     INTEGER CHECK (input_tokens >= 0),
  output_tokens    INTEGER CHECK (output_tokens >= 0),
  credits_charged  NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  latency_ms       INTEGER CHECK (latency_ms >= 0),
  page_context     JSONB NOT NULL DEFAULT '{}',  -- which ERP page the user was on
  tool_calls       JSONB NOT NULL DEFAULT '[]',  -- what the model asked to do
  sources          JSONB NOT NULL DEFAULT '[]',  -- knowledge pages used for the answer
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, organization_id, user_id)
    REFERENCES soft_ai.conversations (id, organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON soft_ai.messages (conversation_id, created_at);
-- For usage reports in the admin panel.
CREATE INDEX IF NOT EXISTS idx_messages_org_created
  ON soft_ai.messages (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_messages_touch ON soft_ai.messages;
CREATE TRIGGER trg_messages_touch BEFORE UPDATE ON soft_ai.messages
  FOR EACH ROW EXECUTE FUNCTION soft_ai.touch_updated_at();

-- Keep the chat list fields (count, credits, last activity) correct.
CREATE OR REPLACE FUNCTION soft_ai.messages_update_conversation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE soft_ai.conversations
       SET message_count   = message_count + 1,
           credits_used    = credits_used + NEW.credits_charged,
           last_message_at = NEW.created_at
     WHERE id = NEW.conversation_id;
  ELSIF NEW.credits_charged <> OLD.credits_charged THEN
    UPDATE soft_ai.conversations
       SET credits_used = credits_used + (NEW.credits_charged - OLD.credits_charged)
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_update_conversation ON soft_ai.messages;
CREATE TRIGGER trg_messages_update_conversation AFTER INSERT OR UPDATE OF credits_charged
  ON soft_ai.messages FOR EACH ROW EXECUTE FUNCTION soft_ai.messages_update_conversation();

-- ---------- actions ----------

CREATE TABLE IF NOT EXISTS soft_ai.actions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        UUID NOT NULL,
  organization_id        UUID NOT NULL,
  user_id                UUID NOT NULL,
  message_id             UUID REFERENCES soft_ai.messages(id) ON DELETE SET NULL,
  action_name            TEXT NOT NULL,            -- registry name, e.g. create_invoice
  registry_version       TEXT,                     -- which registry release defined it
  params                 JSONB NOT NULL DEFAULT '{}',
  risk_level             TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  confirmation_required  BOOLEAN NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                           'proposed', 'confirmed', 'executed', 'failed',
                           'cancelled', 'expired', 'undone')),
  result                 JSONB,                    -- record ids created / changed
  undo_data              JSONB,                    -- what is needed to reverse it
  undo_until             TIMESTAMPTZ,              -- undo button disappears after this
  error_message          TEXT,
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  confirmed_at           TIMESTAMPTZ,
  executed_at            TIMESTAMPTZ,
  undone_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, organization_id, user_id)
    REFERENCES soft_ai.conversations (id, organization_id, user_id) ON DELETE CASCADE,
  -- High risk actions always need confirmation.
  CHECK (risk_level <> 'high' OR confirmation_required)
);

CREATE INDEX IF NOT EXISTS idx_actions_conversation ON soft_ai.actions (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_org_created  ON soft_ai.actions (organization_id, created_at DESC);

-- Only allowed status changes, so an action can never run without the
-- confirmation it needs, and a finished action can never be "re-opened".
CREATE OR REPLACE FUNCTION soft_ai.actions_check_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  NEW.updated_at := now();

  -- These never change after creation.
  IF NEW.action_name <> OLD.action_name OR NEW.params <> OLD.params
     OR NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id
     OR NEW.risk_level <> OLD.risk_level
     OR NEW.confirmation_required <> OLD.confirmation_required THEN
    RAISE EXCEPTION 'action details cannot be changed after it is proposed';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  ok := CASE OLD.status
    WHEN 'proposed'  THEN NEW.status IN ('confirmed', 'cancelled', 'expired')
                          OR (NEW.status IN ('executed', 'failed') AND NOT OLD.confirmation_required)
    WHEN 'confirmed' THEN NEW.status IN ('executed', 'failed', 'expired')
    WHEN 'executed'  THEN NEW.status = 'undone'
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'invalid action status change: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'confirmed' AND now() > OLD.expires_at THEN
    RAISE EXCEPTION 'action expired, please ask again';
  END IF;
  IF NEW.status = 'undone' AND (OLD.undo_until IS NULL OR now() > OLD.undo_until) THEN
    RAISE EXCEPTION 'this action can no longer be undone';
  END IF;

  IF NEW.status = 'confirmed' THEN NEW.confirmed_at := now(); END IF;
  IF NEW.status IN ('executed', 'failed') THEN NEW.executed_at := now(); END IF;
  IF NEW.status = 'undone' THEN NEW.undone_at := now(); END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actions_transition ON soft_ai.actions;
CREATE TRIGGER trg_actions_transition BEFORE UPDATE ON soft_ai.actions
  FOR EACH ROW EXECUTE FUNCTION soft_ai.actions_check_transition();

-- ---------- permissions ----------

ALTER TABLE soft_ai.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.actions       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_all ON soft_ai.conversations;
CREATE POLICY service_all ON soft_ai.conversations FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.messages;
CREATE POLICY service_all ON soft_ai.messages      FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.actions;
CREATE POLICY service_all ON soft_ai.actions       FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);

REVOKE ALL ON soft_ai.conversations, soft_ai.messages, soft_ai.actions FROM PUBLIC, anon, authenticated;
-- No DELETE for the backend: chats are soft-deleted; purging is a separate,
-- reviewed job once the retention policy is agreed.
GRANT SELECT, INSERT, UPDATE ON soft_ai.conversations, soft_ai.messages, soft_ai.actions
  TO soft_ai_service;


-- ######################## 103_soft_ai_knowledge.sql ########################

-- =====================================================================
-- Soft AI - 103: knowledge base (for RAG)
--
--   knowledge_releases  one row per ERP release that was indexed
--   knowledge_chunks    small pieces of docs/guides with their embedding
--
-- organization_id NULL = platform knowledge for everyone (guides, FAQs).
-- organization_id set   = knowledge only for that organization (later use,
--                         e.g. white-label partners' own docs).
--
-- Only ONE release is "active" at a time. The release pipeline builds a new
-- release in the background, then switches it to active in one step, so users
-- never see a half-indexed knowledge base. Old releases are kept for rollback.
--
-- Embedding size: 768 numbers per chunk. Gemini's embedding model can return
-- this size (to be re-confirmed against Google's docs when we build step 6;
-- changing it later needs a small migration and a re-index).
--
-- Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS soft_ai.knowledge_releases (
  version      TEXT PRIMARY KEY,                -- e.g. git commit or release tag
  status       TEXT NOT NULL DEFAULT 'building'
               CHECK (status IN ('building', 'active', 'retired', 'failed')),
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

-- At most one active release.
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_one_active
  ON soft_ai.knowledge_releases ((true)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS soft_ai.knowledge_chunks (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_version  TEXT NOT NULL REFERENCES soft_ai.knowledge_releases(version) ON DELETE CASCADE,
  organization_id  UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_type      TEXT NOT NULL CHECK (source_type IN (
                     'module_guide', 'doc', 'faq', 'release_note',
                     'api_schema', 'action_registry', 'page_map')),
  source_ref       TEXT NOT NULL,               -- e.g. route "/sales/invoices" or file path
  title            TEXT NOT NULL,
  content          TEXT NOT NULL CHECK (length(content) <= 20000),
  content_hash     TEXT NOT NULL,               -- unchanged text is not re-embedded
  url_path         TEXT,                        -- link shown to the user
  embedding        extensions.vector(768) NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (release_version, source_ref, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_release
  ON soft_ai.knowledge_chunks (release_version, organization_id);
-- Fast similarity search (cosine distance).
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON soft_ai.knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);

-- Search the ACTIVE release: platform knowledge + this organization's own.
CREATE OR REPLACE FUNCTION soft_ai.match_knowledge(
  p_query_embedding extensions.vector(768),
  p_org             UUID,
  p_match_count     INTEGER DEFAULT 6
)
RETURNS TABLE (
  id          BIGINT,
  title       TEXT,
  content     TEXT,
  url_path    TEXT,
  source_type TEXT,
  similarity  DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, extensions, pg_temp
AS $$
  SELECT c.id, c.title, c.content, c.url_path, c.source_type,
         1 - (c.embedding <=> p_query_embedding) AS similarity
    FROM soft_ai.knowledge_chunks c
    JOIN soft_ai.knowledge_releases r ON r.version = c.release_version AND r.status = 'active'
   WHERE c.organization_id IS NULL OR c.organization_id = p_org
   ORDER BY c.embedding <=> p_query_embedding
   LIMIT LEAST(GREATEST(p_match_count, 1), 20);
$$;

-- ---------- permissions ----------

ALTER TABLE soft_ai.knowledge_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.knowledge_chunks   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_all ON soft_ai.knowledge_releases;
CREATE POLICY service_all ON soft_ai.knowledge_releases FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.knowledge_chunks;
CREATE POLICY service_all ON soft_ai.knowledge_chunks   FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);

REVOKE ALL ON soft_ai.knowledge_releases, soft_ai.knowledge_chunks FROM PUBLIC, anon, authenticated;
-- The release pipeline (running as the service role) writes new releases and
-- may delete old chunks when retiring releases.
GRANT SELECT, INSERT, UPDATE, DELETE ON soft_ai.knowledge_releases, soft_ai.knowledge_chunks
  TO soft_ai_service;

REVOKE EXECUTE ON FUNCTION soft_ai.match_knowledge(extensions.vector, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.match_knowledge(extensions.vector, UUID, INTEGER) TO soft_ai_service;


-- ######################## 104_soft_ai_credit_transfers.sql ########################

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


-- ######################## 105_soft_ai_metering_and_limits.sql ########################

-- =====================================================================
-- Soft AI - 105: pricing (tokens -> credits) and request limits
--
-- 1. compute_cost(model, input_tokens, output_tokens)
--    Uses the admin-set price list (soft_ai.model_rates). Exact decimal maths,
--    rounded UP to 4 decimals so we never undercharge by rounding.
--    If a model has NO price, it raises 'no_rate_for_model': the AI refuses to
--    run rather than giving answers away for free by mistake (fail closed).
--
-- 2. hit_rate_limits(buckets, windows, maxes)
--    Counts requests per "bucket" (e.g. one user, one organization) in fixed
--    time windows. Stored in the database so the limit is shared by every copy
--    of the backend (Railway can run more than one).
--
-- Safe to re-run.
-- =====================================================================

-- ---------- pricing ----------

CREATE OR REPLACE FUNCTION soft_ai.compute_cost(
  p_model         TEXT,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER,
  p_at            TIMESTAMPTZ DEFAULT now()
)
RETURNS NUMERIC(18,4)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  r soft_ai.model_rates;
BEGIN
  IF p_input_tokens IS NULL OR p_input_tokens < 0 OR p_output_tokens IS NULL OR p_output_tokens < 0 THEN
    RAISE EXCEPTION 'token counts must be zero or more';
  END IF;

  SELECT * INTO r FROM soft_ai.model_rates
   WHERE model = p_model AND effective_from <= p_at
   ORDER BY effective_from DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_rate_for_model' USING ERRCODE = 'P0001',
      DETAIL = format('no price set for model %s', p_model);
  END IF;

  -- cost = (input * input_rate + output * output_rate) / 1000, rounded UP to 0.0001
  -- (PostgreSQL does not apply a function's declared return precision by
  --  itself, so the result is cast explicitly.)
  RETURN (ceil(
    (p_input_tokens::numeric * r.input_credits_per_1k
     + p_output_tokens::numeric * r.output_credits_per_1k) / 1000 * 10000
  ) / 10000)::numeric(18,4);
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.compute_cost(TEXT, INTEGER, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.compute_cost(TEXT, INTEGER, INTEGER, TIMESTAMPTZ) TO soft_ai_service;

-- ---------- request limits ----------

CREATE TABLE IF NOT EXISTS soft_ai.rate_limit_counters (
  bucket        TEXT NOT NULL,          -- e.g. "user:<org>:<user>:60"
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON soft_ai.rate_limit_counters (window_start);

ALTER TABLE soft_ai.rate_limit_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON soft_ai.rate_limit_counters FROM PUBLIC, anon, authenticated, soft_ai_service;
-- The backend uses only the functions below, never the table directly.

-- Counts one request in each bucket and says whether ALL limits are still OK.
-- Returns the first limit that was exceeded (if any) and how long to wait.
CREATE OR REPLACE FUNCTION soft_ai.hit_rate_limits(
  p_buckets TEXT[],
  p_windows INTEGER[],   -- window length in seconds, same order as buckets
  p_maxes   INTEGER[]    -- allowed requests per window, same order
)
RETURNS TABLE (allowed BOOLEAN, limited_bucket TEXT, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  i        INTEGER;
  v_now    TIMESTAMPTZ := clock_timestamp();
  v_start  TIMESTAMPTZ;
  v_hits   INTEGER;
BEGIN
  IF p_buckets IS NULL OR array_length(p_buckets, 1) IS NULL
     OR array_length(p_buckets, 1) <> array_length(p_windows, 1)
     OR array_length(p_buckets, 1) <> array_length(p_maxes, 1) THEN
    RAISE EXCEPTION 'buckets, windows and maxes must have the same length';
  END IF;

  FOR i IN 1 .. array_length(p_buckets, 1) LOOP
    IF p_windows[i] < 1 OR p_windows[i] > 86400 OR p_maxes[i] < 1 THEN
      RAISE EXCEPTION 'invalid limit for bucket %', p_buckets[i];
    END IF;

    v_start := to_timestamp(floor(extract(epoch FROM v_now) / p_windows[i]) * p_windows[i]);

    INSERT INTO soft_ai.rate_limit_counters AS c (bucket, window_start, hits)
    VALUES (p_buckets[i], v_start, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = c.hits + 1
    RETURNING c.hits INTO v_hits;

    IF v_hits > p_maxes[i] THEN
      allowed := false;
      limited_bucket := p_buckets[i];
      retry_after_seconds := GREATEST(1, ceil(extract(epoch FROM (v_start + make_interval(secs => p_windows[i]) - v_now)))::INTEGER);
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;

  allowed := true;
  limited_bucket := NULL;
  retry_after_seconds := 0;
  RETURN NEXT;
END;
$$;

-- Housekeeping: remove old counters. Run daily (scheduled job later).
CREATE OR REPLACE FUNCTION soft_ai.cleanup_rate_limits(p_older_than INTERVAL DEFAULT interval '2 days')
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  WITH d AS (
    DELETE FROM soft_ai.rate_limit_counters WHERE window_start < now() - p_older_than RETURNING 1
  )
  SELECT count(*)::INTEGER FROM d;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.hit_rate_limits(TEXT[], INTEGER[], INTEGER[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soft_ai.cleanup_rate_limits(INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.hit_rate_limits(TEXT[], INTEGER[], INTEGER[]) TO soft_ai_service;
GRANT EXECUTE ON FUNCTION soft_ai.cleanup_rate_limits(INTERVAL) TO soft_ai_service;


-- ######################## 106_soft_ai_knowledge_release_and_cache.sql ########################

-- =====================================================================
-- Soft AI - 106: switching knowledge releases + answer cache
--
-- 1. activate_knowledge_release(version)
--    The release pipeline builds a new release in the background ("building"),
--    then calls this to switch it on. The switch happens in ONE transaction:
--    users see either the old knowledge or the new one, never a mix.
--    The previous active release becomes "retired"; only the newest 3 retired
--    releases keep their chunks (for rollback), older ones are removed.
--
-- 2. answer_cache
--    A repeated, stand-alone question in the SAME organization can be answered
--    from cache (free, instant). Never shared between organizations. Only used
--    for answers that did not use company data, and tied to the knowledge
--    release, so a new ERP release automatically stops old answers.
--
-- Safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION soft_ai.activate_knowledge_release(p_version TEXT)
RETURNS INTEGER   -- number of chunks in the activated release
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_count  INTEGER;
BEGIN
  -- Lock the releases table so two pipelines cannot switch at the same time.
  LOCK TABLE soft_ai.knowledge_releases IN SHARE ROW EXCLUSIVE MODE;

  SELECT status INTO v_status FROM soft_ai.knowledge_releases WHERE version = p_version;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'release % not found', p_version;
  END IF;
  IF v_status = 'active' THEN
    RETURN (SELECT chunk_count FROM soft_ai.knowledge_releases WHERE version = p_version);
  END IF;
  IF v_status <> 'building' THEN
    RAISE EXCEPTION 'release % is %, only a building release can be activated', p_version, v_status;
  END IF;

  SELECT count(*) INTO v_count FROM soft_ai.knowledge_chunks WHERE release_version = p_version;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'release % has no knowledge chunks; refusing to activate an empty release', p_version;
  END IF;

  UPDATE soft_ai.knowledge_releases SET status = 'retired' WHERE status = 'active';
  UPDATE soft_ai.knowledge_releases
     SET status = 'active', activated_at = now(), chunk_count = v_count
   WHERE version = p_version;

  -- Keep the 3 newest retired releases for rollback; drop older ones (chunks cascade).
  DELETE FROM soft_ai.knowledge_releases
   WHERE version IN (
     SELECT version FROM soft_ai.knowledge_releases
      WHERE status IN ('retired', 'failed')
      ORDER BY created_at DESC
      OFFSET 3
   );

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.activate_knowledge_release(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.activate_knowledge_release(TEXT) TO soft_ai_service;

-- ---------- answer cache ----------

CREATE TABLE IF NOT EXISTS soft_ai.answer_cache (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  question_hash    TEXT NOT NULL,          -- hash of the normalized question
  release_version  TEXT NOT NULL,          -- knowledge release the answer was based on
  model            TEXT NOT NULL,
  answer           TEXT NOT NULL CHECK (length(answer) <= 100000),
  sources          JSONB NOT NULL DEFAULT '[]',
  hits             INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, question_hash, release_version, model)
);

CREATE INDEX IF NOT EXISTS idx_answer_cache_expires ON soft_ai.answer_cache (expires_at);

ALTER TABLE soft_ai.answer_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_all ON soft_ai.answer_cache;
CREATE POLICY service_all ON soft_ai.answer_cache FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
REVOKE ALL ON soft_ai.answer_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON soft_ai.answer_cache TO soft_ai_service;


-- ######################## 107_soft_ai_read_tools.sql ########################

-- =====================================================================
-- Soft AI - 107: read-only data tools (step 7)
--
-- Each "tool" answers one kind of company-data question. The AI never writes
-- SQL; it can only ask our backend to run one of these functions.
--
-- Every tool function:
--   * FIRST checks that the user is an active member of the organization AND
--     has the ERP permission for that data (e.g. sales.view), exactly like the
--     ERP's own server check - inside the database, so even a bug in our
--     backend cannot skip it. (The ERP's RLS only checks membership.)
--   * reads ONLY rows of that organization (explicit organization filter)
--   * is READ-ONLY (no insert/update/delete anywhere)
--   * returns small JSON: totals and at most 20 rows, only the fields needed
--   * uses the organization's own currency and time zone ("today")
--
-- Business rules copied from the ERP (Oct 2026 code):
--   * posted / real invoices: status sent, partially_paid, overdue (paid = settled);
--     draft invoices are NOT receivables yet (reported separately)
--   * overdue = balance_due > 0 and due_date before today (the ERP does not always
--     set status 'overdue' itself)
--   * cash & bank has TWO sources in the ERP, and they can disagree, so the tool
--     returns both, clearly labelled, and never mixes currencies:
--       ledger: posted journal lines on asset accounts whose code starts with 111 or
--               whose name contains cash / bank (the dashboard "Cash & Bank" card uses
--               code 111% or name cash/bank; we keep only ASSET accounts so an expense
--               account like "Bank Charges" is not counted) - company currency
--       bank accounts: public.bank_accounts.current_balance, each in its own currency
--               (what the Bank Accounts page shows), totals per currency
--     (Found in live testing with the ERP's demo data: ledger 450,000 USD vs bank
--      accounts 3,370,000 PKR. A first version added PKR into a "USD" total - fixed.)
--
-- Depends on ERP tables: organizations, invoices, customers, payments,
-- vendor_bills, vendors, accounts, journal_entries, journal_entry_lines,
-- products, product_stock, employees, attendance, leave_requests, expenses.
-- If Shaheer renames a column, these functions fail loudly (tests catch it).
--
-- Safe to re-run.
-- =====================================================================

-- ---------- shared helpers ----------

-- Checks access and returns the organization's currency and "today".
CREATE OR REPLACE FUNCTION soft_ai._tool_context(p_org UUID, p_user UUID, p_any_permission TEXT[])
RETURNS TABLE (currency TEXT, today DATE)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  mc   RECORD;
  v_tz TEXT;
BEGIN
  SELECT * INTO mc FROM soft_ai.member_context(p_org, p_user);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001', DETAIL = 'not an active member of this organization';
  END IF;
  IF NOT (mc.is_owner OR mc.permissions && p_any_permission) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001',
      DETAIL = format('needs one of: %s', array_to_string(p_any_permission, ', '));
  END IF;

  SELECT COALESCE(o.currency_code, 'USD'), COALESCE(o.timezone, 'UTC')
    INTO currency, v_tz
    FROM public.organizations o WHERE o.id = p_org;

  BEGIN
    today := (now() AT TIME ZONE v_tz)::date;
  EXCEPTION WHEN others THEN
    today := (now() AT TIME ZONE 'UTC')::date;  -- unknown time zone name: fall back to UTC
  END;
  RETURN NEXT;
END;
$$;

-- Turns a period name into a date range (inclusive).
CREATE OR REPLACE FUNCTION soft_ai._period(p_period TEXT, p_today DATE, p_from TEXT, p_to TEXT)
RETURNS TABLE (from_date DATE, to_date DATE)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  CASE COALESCE(p_period, 'this_month')
    WHEN 'today'        THEN from_date := p_today; to_date := p_today;
    WHEN 'yesterday'    THEN from_date := p_today - 1; to_date := p_today - 1;
    WHEN 'this_week'    THEN from_date := date_trunc('week', p_today)::date; to_date := p_today;
    WHEN 'last_7_days'  THEN from_date := p_today - 6; to_date := p_today;
    WHEN 'this_month'   THEN from_date := date_trunc('month', p_today)::date; to_date := p_today;
    WHEN 'last_month'   THEN from_date := (date_trunc('month', p_today) - interval '1 month')::date;
                             to_date := (date_trunc('month', p_today) - interval '1 day')::date;
    WHEN 'last_30_days' THEN from_date := p_today - 29; to_date := p_today;
    WHEN 'this_quarter' THEN from_date := date_trunc('quarter', p_today)::date; to_date := p_today;
    WHEN 'this_year'    THEN from_date := date_trunc('year', p_today)::date; to_date := p_today;
    WHEN 'last_year'    THEN from_date := (date_trunc('year', p_today) - interval '1 year')::date;
                             to_date := (date_trunc('year', p_today) - interval '1 day')::date;
    WHEN 'custom' THEN
      BEGIN
        from_date := p_from::date;
        to_date := p_to::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'custom period needs from and to dates (YYYY-MM-DD)';
      END;
      IF from_date IS NULL OR to_date IS NULL OR from_date > to_date OR to_date - from_date > 366 * 3 THEN
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'custom period must be a valid range of at most 3 years';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = format('unknown period %s', p_period);
  END CASE;
  RETURN NEXT;
END;
$$;

-- Makes user text safe inside ILIKE (so % and _ are searched literally).
CREATE OR REPLACE FUNCTION soft_ai._like(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '%' || replace(replace(replace(left(trim(p_text), 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

CREATE OR REPLACE FUNCTION soft_ai._limit(p_args JSONB, p_default INTEGER, p_max INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT LEAST(GREATEST(COALESCE((p_args->>'limit')::INTEGER, p_default), 1), p_max);
$$;

-- ---------- 1. receivables summary (sales.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_receivables_summary(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx RECORD;
  r   JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['sales.view']);

  WITH inv AS (
    SELECT status, balance_due, total_amount, due_date,
           (status IN ('sent', 'partially_paid', 'overdue') AND balance_due > 0) AS is_open,
           GREATEST(ctx.today - due_date, 0) AS days_overdue
      FROM public.invoices
     WHERE organization_id = p_org AND deleted_at IS NULL
  )
  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'as_of', ctx.today,
    'open_invoices', count(*) FILTER (WHERE is_open),
    'open_balance', COALESCE(sum(balance_due) FILTER (WHERE is_open), 0),
    'overdue_invoices', count(*) FILTER (WHERE is_open AND due_date < ctx.today),
    'overdue_balance', COALESCE(sum(balance_due) FILTER (WHERE is_open AND due_date < ctx.today), 0),
    'aging_balance', jsonb_build_object(
      'not_yet_due', COALESCE(sum(balance_due) FILTER (WHERE is_open AND (due_date IS NULL OR due_date >= ctx.today)), 0),
      'overdue_1_30', COALESCE(sum(balance_due) FILTER (WHERE is_open AND days_overdue BETWEEN 1 AND 30), 0),
      'overdue_31_60', COALESCE(sum(balance_due) FILTER (WHERE is_open AND days_overdue BETWEEN 31 AND 60), 0),
      'overdue_61_90', COALESCE(sum(balance_due) FILTER (WHERE is_open AND days_overdue BETWEEN 61 AND 90), 0),
      'overdue_over_90', COALESCE(sum(balance_due) FILTER (WHERE is_open AND days_overdue > 90), 0)
    ),
    'draft_invoices', count(*) FILTER (WHERE status = 'draft'),
    'draft_total', COALESCE(sum(total_amount) FILTER (WHERE status = 'draft'), 0),
    'note', 'Draft invoices are not posted yet, so they are not counted as money owed.'
  ) INTO r
  FROM inv;
  RETURN r;
END;
$$;

-- ---------- 2. unpaid invoices list (sales.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_list_unpaid_invoices(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx        RECORD;
  v_customer TEXT := NULLIF(trim(p_args->>'customer'), '');
  v_overdue  BOOLEAN := COALESCE((p_args->>'overdue_only')::BOOLEAN, false);
  v_min_days INTEGER := GREATEST(COALESCE((p_args->>'min_days_overdue')::INTEGER, 0), 0);
  v_sort     TEXT := COALESCE(p_args->>'sort', 'oldest_due');
  v_limit    INTEGER := soft_ai._limit(p_args, 10, 20);
  r          JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['sales.view']);
  IF v_sort NOT IN ('oldest_due', 'largest') THEN v_sort := 'oldest_due'; END IF;

  WITH matching AS (
    SELECT i.invoice_number, c.name AS customer, i.invoice_date, i.due_date, i.status,
           i.total_amount, i.balance_due, GREATEST(ctx.today - i.due_date, 0) AS days_overdue
      FROM public.invoices i
      LEFT JOIN public.customers c ON c.id = i.customer_id AND c.organization_id = p_org
     WHERE i.organization_id = p_org AND i.deleted_at IS NULL
       AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.balance_due > 0
       AND (v_customer IS NULL OR c.name ILIKE soft_ai._like(v_customer))
       AND (NOT v_overdue OR i.due_date < ctx.today)
       AND (v_min_days = 0 OR GREATEST(ctx.today - i.due_date, 0) >= v_min_days)
  ), shown AS (
    SELECT * FROM matching
     ORDER BY CASE WHEN v_sort = 'largest' THEN -balance_due END, due_date NULLS LAST, invoice_number
     LIMIT v_limit
  )
  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'as_of', ctx.today,
    'matching_count', (SELECT count(*) FROM matching),
    'matching_balance', (SELECT COALESCE(sum(balance_due), 0) FROM matching),
    'shown', (SELECT count(*) FROM shown),
    'invoices', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM shown s), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END;
$$;

-- ---------- 3. sales in a period (sales.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_sales_summary(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx RECORD;
  per RECORD;
  r   JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['sales.view']);
  SELECT * INTO per FROM soft_ai._period(p_args->>'period', ctx.today, p_args->>'from', p_args->>'to');

  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'period', jsonb_build_object('from', per.from_date, 'to', per.to_date),
    'invoices_count', (SELECT count(*) FROM public.invoices
                        WHERE organization_id = p_org AND deleted_at IS NULL
                          AND status NOT IN ('draft', 'cancelled')
                          AND invoice_date BETWEEN per.from_date AND per.to_date),
    'invoiced_total', (SELECT COALESCE(sum(total_amount), 0) FROM public.invoices
                        WHERE organization_id = p_org AND deleted_at IS NULL
                          AND status NOT IN ('draft', 'cancelled')
                          AND invoice_date BETWEEN per.from_date AND per.to_date),
    'tax_total', (SELECT COALESCE(sum(tax_amount), 0) FROM public.invoices
                   WHERE organization_id = p_org AND deleted_at IS NULL
                     AND status NOT IN ('draft', 'cancelled')
                     AND invoice_date BETWEEN per.from_date AND per.to_date),
    'payments_received', (SELECT COALESCE(sum(amount), 0) FROM public.payments
                           WHERE organization_id = p_org AND deleted_at IS NULL AND status = 'completed'
                             AND payment_date BETWEEN per.from_date AND per.to_date),
    'top_customers', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT c.name AS customer, sum(i.total_amount) AS invoiced
          FROM public.invoices i
          JOIN public.customers c ON c.id = i.customer_id AND c.organization_id = p_org
         WHERE i.organization_id = p_org AND i.deleted_at IS NULL
           AND i.status NOT IN ('draft', 'cancelled')
           AND i.invoice_date BETWEEN per.from_date AND per.to_date
         GROUP BY c.name ORDER BY sum(i.total_amount) DESC LIMIT 5
      ) t), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END;
$$;

-- ---------- 4. find customers (crm.view or sales.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_find_customers(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx     RECORD;
  v_query TEXT := NULLIF(trim(p_args->>'query'), '');
  v_limit INTEGER := soft_ai._limit(p_args, 5, 10);
  r       JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['crm.view', 'sales.view']);
  IF v_query IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'query is required';
  END IF;

  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'customers', COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  ) INTO r
  FROM (
    SELECT c.customer_number, c.name, c.phone, c.email, c.is_active,
           (SELECT COALESCE(sum(i.balance_due), 0) FROM public.invoices i
             WHERE i.organization_id = p_org AND i.customer_id = c.id AND i.deleted_at IS NULL
               AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.balance_due > 0) AS open_balance
      FROM public.customers c
     WHERE c.organization_id = p_org AND c.deleted_at IS NULL
       AND (c.name ILIKE soft_ai._like(v_query) OR c.customer_number ILIKE soft_ai._like(v_query))
     ORDER BY c.name
     LIMIT v_limit
  ) t;
  RETURN r;
END;
$$;

-- ---------- 5. payables summary (purchases.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_payables_summary(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx RECORD;
  r   JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['purchases.view']);

  WITH b AS (
    SELECT b.bill_number, v.name AS vendor, b.due_date, b.balance_due,
           (b.status IN ('sent', 'partially_paid', 'overdue') AND b.balance_due > 0) AS is_open
      FROM public.vendor_bills b
      LEFT JOIN public.vendors v ON v.id = b.vendor_id AND v.organization_id = p_org
     WHERE b.organization_id = p_org AND b.deleted_at IS NULL
  )
  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'as_of', ctx.today,
    'open_bills', count(*) FILTER (WHERE is_open),
    'open_balance', COALESCE(sum(balance_due) FILTER (WHERE is_open), 0),
    'overdue_bills', count(*) FILTER (WHERE is_open AND due_date < ctx.today),
    'overdue_balance', COALESCE(sum(balance_due) FILTER (WHERE is_open AND due_date < ctx.today), 0),
    'due_next_7_days', COALESCE(sum(balance_due) FILTER (WHERE is_open AND due_date BETWEEN ctx.today AND ctx.today + 7), 0),
    'top_vendors_owed', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT vendor, sum(balance_due) AS owed FROM b WHERE is_open
         GROUP BY vendor ORDER BY sum(balance_due) DESC LIMIT 5) t), '[]'::jsonb)
  ) INTO r
  FROM b;
  RETURN r;
END;
$$;

-- ---------- 6. cash and bank balances (accounting.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_cash_and_bank(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx RECORD;
  r   JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['accounting.view']);

  WITH ledger AS (
    -- Ledger view (company currency): asset accounts for cash and bank.
    SELECT a.code, a.name,
           COALESCE((SELECT sum(l.debit - l.credit)
                       FROM public.journal_entry_lines l
                       JOIN public.journal_entries e ON e.id = l.journal_entry_id
                      WHERE l.organization_id = p_org AND l.account_id = a.id
                        AND e.organization_id = p_org AND e.status = 'posted' AND e.deleted_at IS NULL), 0) AS balance
      FROM public.accounts a
     WHERE a.organization_id = p_org AND a.deleted_at IS NULL AND a.is_active
       AND (a.code LIKE '111%' OR (a.account_type = 'asset' AND (a.name ILIKE '%cash%' OR a.name ILIKE '%bank%')))
  ), banks AS (
    -- Bank Accounts page view: each in its own currency; only the last 4 digits of the number.
    SELECT b.name, b.bank_name, right(COALESCE(b.account_number, ''), 4) AS account_last4,
           COALESCE(b.currency_code, ctx.currency) AS currency, COALESCE(b.current_balance, 0) AS balance
      FROM public.bank_accounts b
     WHERE b.organization_id = p_org AND b.deleted_at IS NULL AND b.is_active
  )
  SELECT jsonb_build_object(
    'company_currency', ctx.currency,
    'as_of', ctx.today,
    'ledger_total', (SELECT COALESCE(sum(balance), 0) FROM ledger),
    'ledger_accounts', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.code) FROM ledger x), '[]'::jsonb),
    'bank_accounts', COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.name) FROM banks y), '[]'::jsonb),
    'bank_totals_by_currency', COALESCE((
      SELECT jsonb_object_agg(currency, total) FROM (SELECT currency, sum(balance) AS total FROM banks GROUP BY currency) t), '{}'::jsonb),
    'note', 'Two sources: (1) the ledger - posted journal entries, in the company currency, like the dashboard Cash & Bank card; (2) the Bank Accounts page - each account in its own currency. They can differ when bank activity is not fully posted. Amounts in different currencies must never be added together.'
  ) INTO r;
  RETURN r;
END;
$$;

-- ---------- 7. stock levels (inventory.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_stock_levels(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx      RECORD;
  v_query  TEXT := NULLIF(trim(p_args->>'product'), '');
  v_low    BOOLEAN := COALESCE((p_args->>'low_stock_only')::BOOLEAN, false);
  v_limit  INTEGER := soft_ai._limit(p_args, 10, 20);
  r        JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['inventory.view']);

  WITH lv AS (
    SELECT p.sku, p.name, p.unit_of_measure AS unit, COALESCE(p.reorder_level, 0) AS reorder_level,
           COALESCE(sum(s.quantity_on_hand), 0) AS on_hand,
           COALESCE(sum(s.quantity_reserved), 0) AS reserved
      FROM public.products p
      LEFT JOIN public.product_stock s ON s.product_id = p.id AND s.organization_id = p_org
     WHERE p.organization_id = p_org AND p.deleted_at IS NULL AND p.is_active AND p.track_inventory
       AND (v_query IS NULL OR p.name ILIKE soft_ai._like(v_query) OR p.sku ILIKE soft_ai._like(v_query))
     GROUP BY p.id, p.sku, p.name, p.unit_of_measure, p.reorder_level
  ), marked AS (
    SELECT *, on_hand - reserved AS available,
           (reorder_level > 0 AND on_hand - reserved <= reorder_level) AS is_low
      FROM lv
  ), shown AS (
    SELECT * FROM marked WHERE (NOT v_low OR is_low)
     ORDER BY is_low DESC, available, name LIMIT v_limit
  )
  SELECT jsonb_build_object(
    'as_of', ctx.today,
    'products_matching', (SELECT count(*) FROM marked WHERE (NOT v_low OR is_low)),
    'low_stock_count', (SELECT count(*) FROM marked WHERE is_low),
    'shown', (SELECT count(*) FROM shown),
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM shown s), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END;
$$;

-- ---------- 8. HR today (hr.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_hr_today(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx    RECORD;
  v_date DATE;
  r      JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['hr.view']);
  BEGIN
    v_date := COALESCE(NULLIF(p_args->>'date', '')::DATE, ctx.today);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = 'date must be YYYY-MM-DD';
  END;

  SELECT jsonb_build_object(
    'date', v_date,
    'active_employees', (SELECT count(*) FROM public.employees
                          WHERE organization_id = p_org AND deleted_at IS NULL AND status IN ('active', 'on_leave')),
    'attendance', COALESCE((
      SELECT jsonb_object_agg(status, n) FROM (
        SELECT a.status::text AS status, count(*) AS n FROM public.attendance a
         WHERE a.organization_id = p_org AND a.attendance_date = v_date AND a.deleted_at IS NULL
         GROUP BY a.status) t), '{}'::jsonb),
    'attendance_note', 'Employees with no attendance record for the day are not counted.',
    'on_leave', COALESCE((
      SELECT jsonb_agg(t ORDER BY t.name) FROM (
        SELECT e.first_name || ' ' || e.last_name AS name, l.start_date, l.end_date
          FROM public.leave_requests l
          JOIN public.employees e ON e.id = l.employee_id AND e.organization_id = p_org
         WHERE l.organization_id = p_org AND l.status = 'approved'
           AND v_date BETWEEN l.start_date AND l.end_date
         LIMIT 20) t), '[]'::jsonb),
    'pending_leave_requests', (SELECT count(*) FROM public.leave_requests
                                WHERE organization_id = p_org AND status = 'pending')
  ) INTO r;
  RETURN r;
END;
$$;

-- ---------- 9. expenses in a period (accounting.view) ----------

CREATE OR REPLACE FUNCTION soft_ai.tool_expenses_summary(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ctx RECORD;
  per RECORD;
  r   JSONB;
BEGIN
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, ARRAY['accounting.view']);
  SELECT * INTO per FROM soft_ai._period(p_args->>'period', ctx.today, p_args->>'from', p_args->>'to');

  WITH ex AS (
    SELECT COALESCE(NULLIF(trim(category), ''), 'Uncategorized') AS category, status,
           COALESCE(total_amount, amount) AS amount
      FROM public.expenses
     WHERE organization_id = p_org AND deleted_at IS NULL
       AND expense_date BETWEEN per.from_date AND per.to_date
  )
  SELECT jsonb_build_object(
    'currency', ctx.currency,
    'period', jsonb_build_object('from', per.from_date, 'to', per.to_date),
    'approved_total', COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0),
    'approved_count', count(*) FILTER (WHERE status = 'approved'),
    'pending_total', COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0),
    'pending_count', count(*) FILTER (WHERE status = 'pending'),
    'by_category', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT category, sum(amount) AS total FROM ex WHERE status = 'approved'
         GROUP BY category ORDER BY sum(amount) DESC LIMIT 5) t), '[]'::jsonb)
  ) INTO r
  FROM ex;
  RETURN r;
END;
$$;

-- ---------- permissions ----------

REVOKE EXECUTE ON FUNCTION soft_ai._tool_context(UUID, UUID, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soft_ai._period(TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soft_ai._like(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION soft_ai._limit(JSONB, INTEGER, INTEGER) FROM PUBLIC;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'tool_receivables_summary', 'tool_list_unpaid_invoices', 'tool_sales_summary', 'tool_find_customers',
    'tool_payables_summary', 'tool_cash_and_bank', 'tool_stock_levels', 'tool_hr_today', 'tool_expenses_summary'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION soft_ai.%I(UUID, UUID, JSONB) FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION soft_ai.%I(UUID, UUID, JSONB) TO soft_ai_service', f);
  END LOOP;
END $$;


-- ######################## 108_soft_ai_member_permissions.sql ########################

-- =====================================================================
-- Soft AI - 108: role check matches the ERP exactly
--
-- Found on 8 Oct 2026 while syncing with Shaheer's latest code: the ERP's
-- server check (src/lib/security/api-auth.ts -> requireOrgPermissionApi) is
--   1. owner (is_owner) or role slug "company_owner" or "admin" -> everything
--   2. else, if the role has a non-empty permission_matrix (roles column, ERP
--      migration 056), e.g. {"sales": ["view","create"], "crm": ["*"]}:
--      allowed if the module's list has the action or "*"
--   3. else the old role_permissions table ("module.action" rows)
--   4. no role -> nothing
-- member_context (migration 100) only did 1 (without "admin") and 3, so
-- admins and matrix roles were wrongly REFUSED (never wrongly allowed).
--
-- Permissions are returned as "module.action" strings; "module.*" means every
-- action of that module. Checks must use soft_ai.permission_allows().
--
-- Safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION soft_ai.member_context(p_org UUID, p_user UUID)
RETURNS TABLE (
  organization_id        UUID,
  user_id                UUID,
  is_owner               BOOLEAN,   -- "full access": owner, company_owner or admin
  role_slug              TEXT,
  permissions            TEXT[],
  parent_organization_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    om.organization_id,
    om.user_id,
    (COALESCE(om.is_owner, false) OR COALESCE(r.slug IN ('company_owner', 'admin'), false)) AS is_owner,
    r.slug,
    CASE
      WHEN om.role_id IS NULL THEN ARRAY[]::TEXT[]
      WHEN jsonb_typeof(r.permission_matrix) = 'object' AND r.permission_matrix <> '{}'::jsonb THEN
        COALESCE(ARRAY(
          SELECT DISTINCT m.key || '.' || a.value
            FROM jsonb_each(r.permission_matrix) m
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(m.value) = 'array' THEN m.value ELSE '[]'::jsonb END) a
           WHERE a.value <> ''
           ORDER BY 1
        ), ARRAY[]::TEXT[])
      ELSE
        COALESCE(ARRAY(
          SELECT p.module || '.' || p.action
            FROM public.role_permissions rp
            JOIN public.permissions p ON p.id = rp.permission_id
           WHERE rp.role_id = om.role_id
           ORDER BY 1
        ), ARRAY[]::TEXT[])
    END,
    o.parent_organization_id
  FROM public.organization_members om
  JOIN public.organizations o ON o.id = om.organization_id
  LEFT JOIN public.roles r ON r.id = om.role_id
  WHERE om.organization_id = p_org
    AND om.user_id = p_user
    AND om.is_active = true
    AND o.is_active = true
    AND o.deleted_at IS NULL;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.member_context(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.member_context(UUID, UUID) TO soft_ai_service;

-- Does this permission list allow ANY of the wanted "module.action" keys?
-- ("module.*" allows every action of that module.)
CREATE OR REPLACE FUNCTION soft_ai.permission_allows(p_have TEXT[], p_wanted TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM unnest(p_wanted) w
     WHERE w = ANY(p_have) OR (split_part(w, '.', 1) || '.*') = ANY(p_have)
  );
$$;

-- Data tools (migration 107): same check, now with "module.*".
CREATE OR REPLACE FUNCTION soft_ai._tool_context(p_org UUID, p_user UUID, p_any_permission TEXT[])
RETURNS TABLE (currency TEXT, today DATE)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  mc   RECORD;
  v_tz TEXT;
BEGIN
  SELECT * INTO mc FROM soft_ai.member_context(p_org, p_user);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001', DETAIL = 'not an active member of this organization';
  END IF;
  IF NOT (mc.is_owner OR soft_ai.permission_allows(mc.permissions, p_any_permission)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001',
      DETAIL = format('needs one of: %s', array_to_string(p_any_permission, ', '));
  END IF;

  SELECT COALESCE(o.currency_code, 'USD'), COALESCE(o.timezone, 'UTC')
    INTO currency, v_tz
    FROM public.organizations o WHERE o.id = p_org;

  BEGIN
    today := (now() AT TIME ZONE v_tz)::date;
  EXCEPTION WHEN others THEN
    today := (now() AT TIME ZONE 'UTC')::date;  -- unknown time zone name: fall back to UTC
  END;
  RETURN NEXT;
END;
$$;


-- ######################## 109_soft_ai_actions.sql ########################

-- =====================================================================
-- Soft AI - 109: actions (step 8)
--
-- How an action works (the AI never writes to the database):
--   1. The AI picks an action from the registry (e.g. create a draft invoice)
--      with the ids of the records it refers to (found with find_records).
--   2. The backend checks the role, checks every referenced record with
--      action_refs() (must exist, belong to THIS organization, not deleted),
--      and saves the action as "proposed" in soft_ai.actions with a preview.
--   3. The panel shows the preview. After the user confirms, the ERP's OWN
--      service function runs it in the user's browser session (the ERP's
--      numbering, posting, RLS and audit all apply as if the user did it).
--   4. The panel reports the new record id; the backend checks it with
--      record_state() before marking the action "executed". Undo the same way.
--
-- Functions here are read-only helpers for the backend role (soft_ai_service).
-- Safe to re-run.
-- =====================================================================

ALTER TABLE soft_ai.actions ADD COLUMN IF NOT EXISTS preview JSONB;   -- what the user was shown
CREATE INDEX IF NOT EXISTS idx_actions_message ON soft_ai.actions (message_id);

-- ---------- find_records: ids for the AI (read tool) ----------
-- Types and the permission each needs (any one of):
--   customer       crm.view, sales.view          vendor         purchases.view, accounting.view
--   product        inventory.view, sales.view, purchases.view
--   employee       hr.view                       leave_type     hr.view, hr.create
--   leave_request  hr.view                       lead           crm.view
--   expense_account / cash_account / bank_account   accounting.view, accounting.create
--   project        projects.view
CREATE OR REPLACE FUNCTION soft_ai.tool_find_records(p_org UUID, p_user UUID, p_args JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_type  TEXT := p_args->>'type';
  v_q     TEXT := NULLIF(trim(COALESCE(p_args->>'query', '')), '');
  v_like  TEXT;
  v_limit INTEGER := soft_ai._limit(p_args, 10, 20);
  v_perm  TEXT[];
  v_rows  JSONB;
  ctx     RECORD;
BEGIN
  v_perm := CASE v_type
    WHEN 'customer'        THEN ARRAY['crm.view', 'sales.view']
    WHEN 'vendor'          THEN ARRAY['purchases.view', 'accounting.view']
    WHEN 'product'         THEN ARRAY['inventory.view', 'sales.view', 'purchases.view']
    WHEN 'employee'        THEN ARRAY['hr.view']
    WHEN 'leave_type'      THEN ARRAY['hr.view', 'hr.create']
    WHEN 'leave_request'   THEN ARRAY['hr.view']
    WHEN 'lead'            THEN ARRAY['crm.view']
    WHEN 'expense_account' THEN ARRAY['accounting.view', 'accounting.create']
    WHEN 'cash_account'    THEN ARRAY['accounting.view', 'accounting.create']
    WHEN 'bank_account'    THEN ARRAY['accounting.view', 'accounting.create']
    WHEN 'project'         THEN ARRAY['projects.view']
  END;
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = format('unknown record type: %s', COALESCE(v_type, '(none)'));
  END IF;
  SELECT * INTO ctx FROM soft_ai._tool_context(p_org, p_user, v_perm);
  v_like := CASE WHEN v_q IS NULL THEN '%' ELSE soft_ai._like(v_q) END;

  IF v_type = 'customer' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'number', c.customer_number, 'email', c.email, 'phone', c.phone) r
        FROM public.customers c
       WHERE c.organization_id = p_org AND c.deleted_at IS NULL
         AND (c.name ILIKE v_like OR c.customer_number ILIKE v_like)
       ORDER BY c.name LIMIT v_limit) x;
  ELSIF v_type = 'vendor' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', v.id, 'name', v.name, 'number', v.vendor_number, 'email', v.email) r
        FROM public.vendors v
       WHERE v.organization_id = p_org AND v.deleted_at IS NULL
         AND (v.name ILIKE v_like OR v.vendor_number ILIKE v_like)
       ORDER BY v.name LIMIT v_limit) x;
  ELSIF v_type = 'product' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'selling_price', p.selling_price,
                                'cost_price', p.cost_price, 'unit', p.unit_of_measure, 'type', p.product_type) r
        FROM public.products p
       WHERE p.organization_id = p_org AND p.deleted_at IS NULL AND p.is_active
         AND (p.name ILIKE v_like OR p.sku ILIKE v_like)
       ORDER BY p.name LIMIT v_limit) x;
  ELSIF v_type = 'employee' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', e.id, 'name', trim(concat_ws(' ', e.first_name, e.last_name)),
                                'number', e.employee_number, 'status', e.status) r
        FROM public.employees e
       WHERE e.organization_id = p_org AND e.deleted_at IS NULL AND e.status <> 'terminated'
         AND (concat_ws(' ', e.first_name, e.last_name) ILIKE v_like OR e.employee_number ILIKE v_like)
       ORDER BY e.first_name, e.last_name LIMIT v_limit) x;
  ELSIF v_type = 'leave_type' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', t.id, 'name', t.name, 'code', t.code, 'is_paid', t.is_paid) r
        FROM public.leave_types t
       WHERE t.organization_id = p_org AND t.deleted_at IS NULL AND t.is_active
         AND (t.name ILIKE v_like OR t.code ILIKE v_like)
       ORDER BY t.name LIMIT v_limit) x;
  ELSIF v_type = 'leave_request' THEN
    -- Newest first; the query matches the employee's name. Optional status filter.
    SELECT COALESCE(jsonb_agg(r), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', l.id, 'employee', trim(concat_ws(' ', e.first_name, e.last_name)),
                                'leave_type', t.name, 'start_date', l.start_date, 'end_date', l.end_date,
                                'days', l.days, 'status', l.status, 'reason', left(l.reason, 200)) r
        FROM public.leave_requests l
        JOIN public.employees e ON e.id = l.employee_id
        LEFT JOIN public.leave_types t ON t.id = l.leave_type_id
       WHERE l.organization_id = p_org
         AND concat_ws(' ', e.first_name, e.last_name) ILIKE v_like
         AND (p_args->>'status' IS NULL OR l.status::text = p_args->>'status')
       ORDER BY l.created_at DESC LIMIT v_limit) x;
  ELSIF v_type = 'lead' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', l.id, 'name', l.contact_name, 'company', l.company_name,
                                'number', l.lead_number, 'status', l.status, 'email', l.email) r
        FROM public.leads l
       WHERE l.organization_id = p_org AND l.deleted_at IS NULL
         AND (l.contact_name ILIKE v_like OR l.company_name ILIKE v_like OR l.lead_number ILIKE v_like)
       ORDER BY l.contact_name LIMIT v_limit) x;
  ELSIF v_type IN ('expense_account', 'cash_account') THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'code'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name) r
        FROM public.accounts a
       WHERE a.organization_id = p_org AND a.deleted_at IS NULL AND COALESCE(a.is_active, true)
         AND (a.name ILIKE v_like OR a.code ILIKE v_like)
         AND CASE WHEN v_type = 'expense_account' THEN a.account_type = 'expense'
                  ELSE a.account_type = 'asset' AND (a.code LIKE '111%' OR a.name ILIKE '%cash%' OR a.name ILIKE '%bank%') END
       ORDER BY a.code LIMIT v_limit) x;
  ELSIF v_type = 'bank_account' THEN
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', b.id, 'name', b.name, 'bank', b.bank_name,
                                'account_last4', right(b.account_number, 4),
                                'currency', COALESCE(b.currency_code, ctx.currency)) r
        FROM public.bank_accounts b
       WHERE b.organization_id = p_org AND b.deleted_at IS NULL AND b.is_active
         AND (b.name ILIKE v_like OR b.bank_name ILIKE v_like)
       ORDER BY b.name LIMIT v_limit) x;
  ELSE -- project
    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]') INTO v_rows FROM (
      SELECT jsonb_build_object('id', p.id, 'name', p.name, 'number', p.project_number, 'status', p.status) r
        FROM public.projects p
       WHERE p.organization_id = p_org AND p.deleted_at IS NULL
         AND (p.name ILIKE v_like OR p.project_number ILIKE v_like)
       ORDER BY p.name LIMIT v_limit) x;
  END IF;

  RETURN jsonb_build_object('type', v_type, 'count', jsonb_array_length(v_rows), 'records', v_rows,
                            'note', 'Use the id values when proposing an action. Show names, not ids, to the user.');
END;
$$;

-- ---------- action_refs: check the records an action refers to ----------
-- p_refs: [{"type": "customer", "id": "..."}, ...]
-- Returns {"customer:<id>": {"name": ..., ...}, ...} for the preview.
-- Raises invalid_argument if any record does not exist, is deleted, or belongs
-- to another organization (same message for all three: no information leaks).
CREATE OR REPLACE FUNCTION soft_ai.action_refs(p_org UUID, p_user UUID, p_refs JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  ref    JSONB;
  v_type TEXT;
  v_id   UUID;
  v_info JSONB;
  v_out  JSONB := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM soft_ai.member_context(p_org, p_user)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001', DETAIL = 'not an active member of this organization';
  END IF;

  FOR ref IN SELECT * FROM jsonb_array_elements(COALESCE(p_refs, '[]'))
  LOOP
    v_type := ref->>'type';
    BEGIN
      v_id := (ref->>'id')::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = format('%s id is not valid', v_type);
    END;
    v_info := NULL;

    CASE v_type
      WHEN 'customer' THEN
        SELECT jsonb_build_object('name', name, 'number', customer_number) INTO v_info
          FROM public.customers WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'vendor' THEN
        SELECT jsonb_build_object('name', name, 'number', vendor_number) INTO v_info
          FROM public.vendors WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'product' THEN
        SELECT jsonb_build_object('name', name, 'sku', sku, 'unit', unit_of_measure) INTO v_info
          FROM public.products WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'employee' THEN
        SELECT jsonb_build_object('name', trim(concat_ws(' ', first_name, last_name)), 'user_id', user_id) INTO v_info
          FROM public.employees WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'leave_type' THEN
        SELECT jsonb_build_object('name', name) INTO v_info
          FROM public.leave_types WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'leave_request' THEN
        SELECT jsonb_build_object('name', trim(concat_ws(' ', e.first_name, e.last_name)), 'leave_type', t.name,
                                  'start_date', l.start_date, 'end_date', l.end_date, 'days', l.days, 'status', l.status) INTO v_info
          FROM public.leave_requests l
          JOIN public.employees e ON e.id = l.employee_id
          LEFT JOIN public.leave_types t ON t.id = l.leave_type_id
         WHERE l.id = v_id AND l.organization_id = p_org;
      WHEN 'lead' THEN
        SELECT jsonb_build_object('name', contact_name, 'company', company_name, 'status', status) INTO v_info
          FROM public.leads WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'expense_account' THEN
        SELECT jsonb_build_object('name', code || ' ' || name) INTO v_info
          FROM public.accounts WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL AND account_type = 'expense';
      WHEN 'cash_account' THEN
        SELECT jsonb_build_object('name', code || ' ' || name) INTO v_info
          FROM public.accounts WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL AND account_type = 'asset';
      WHEN 'bank_account' THEN
        SELECT jsonb_build_object('name', name || ' (…' || right(COALESCE(account_number, ''), 4) || ')') INTO v_info
          FROM public.bank_accounts WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      WHEN 'project' THEN
        SELECT jsonb_build_object('name', name) INTO v_info
          FROM public.projects WHERE id = v_id AND organization_id = p_org AND deleted_at IS NULL;
      ELSE
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = format('unknown record type: %s', v_type);
    END CASE;

    IF v_info IS NULL THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001',
        DETAIL = format('%s not found (use find_records to get a valid id)', replace(v_type, '_', ' '));
    END IF;
    v_out := v_out || jsonb_build_object(v_type || ':' || v_id, v_info);
  END LOOP;
  RETURN v_out;
END;
$$;

-- ---------- record_state: did the action really happen? ----------
-- Used after the browser reports "done" (and after undo), so the action log
-- only says "executed" when the record really exists in THIS organization.
CREATE OR REPLACE FUNCTION soft_ai.record_state(p_org UUID, p_kind TEXT, p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v JSONB;
BEGIN
  CASE p_kind
    WHEN 'customer' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', customer_number, 'name', name) INTO v
        FROM public.customers WHERE id = p_id AND organization_id = p_org;
    WHEN 'lead' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', lead_number, 'name', contact_name, 'status', status) INTO v
        FROM public.leads WHERE id = p_id AND organization_id = p_org;
    WHEN 'invoice' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', invoice_number, 'status', status, 'total', total_amount::text) INTO v
        FROM public.invoices WHERE id = p_id AND organization_id = p_org;
    WHEN 'quotation' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', quotation_number, 'status', status, 'total', total_amount::text) INTO v
        FROM public.quotations WHERE id = p_id AND organization_id = p_org;
    WHEN 'purchase_order' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', order_number, 'status', status, 'total', total_amount::text) INTO v
        FROM public.purchase_orders WHERE id = p_id AND organization_id = p_org;
    WHEN 'expense' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', expense_number, 'status', status, 'total', total_amount::text) INTO v
        FROM public.expenses WHERE id = p_id AND organization_id = p_org;
    WHEN 'leave_request' THEN   -- no deleted_at column: undo is a real delete
      SELECT jsonb_build_object('deleted', false, 'status', status) INTO v
        FROM public.leave_requests WHERE id = p_id AND organization_id = p_org;
    WHEN 'task' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'name', title, 'status', status) INTO v
        FROM public.tasks WHERE id = p_id AND organization_id = p_org;
    WHEN 'product' THEN
      SELECT jsonb_build_object('deleted', deleted_at IS NOT NULL, 'number', sku, 'name', name) INTO v
        FROM public.products WHERE id = p_id AND organization_id = p_org;
    ELSE
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = 'P0001', DETAIL = format('unknown record kind: %s', p_kind);
  END CASE;
  RETURN COALESCE(jsonb_build_object('exists', true) || v, jsonb_build_object('exists', false));
END;
$$;

-- ---------- org_today: "today" and currency for the AI and previews ----------
-- The AI needs today's date to fill "date: today / next Friday" correctly,
-- in the organization's own time zone.
CREATE OR REPLACE FUNCTION soft_ai.org_today(p_org UUID)
RETURNS TABLE (today DATE, currency TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT COALESCE(o.currency_code, 'USD'), COALESCE(o.timezone, 'UTC') INTO currency, v_tz
    FROM public.organizations o WHERE o.id = p_org;
  BEGIN
    today := (now() AT TIME ZONE COALESCE(v_tz, 'UTC'))::date;
  EXCEPTION WHEN others THEN
    today := (now() AT TIME ZONE 'UTC')::date;
  END;
  currency := COALESCE(currency, 'USD');
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.tool_find_records(UUID, UUID, JSONB), soft_ai.action_refs(UUID, UUID, JSONB),
  soft_ai.record_state(UUID, TEXT, UUID), soft_ai.org_today(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.tool_find_records(UUID, UUID, JSONB), soft_ai.action_refs(UUID, UUID, JSONB),
  soft_ai.record_state(UUID, TEXT, UUID), soft_ai.org_today(UUID) TO soft_ai_service;


-- ######################## 110_soft_ai_billing.sql ########################

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


-- ######################## 111_soft_ai_credit_lots_and_decisions.sql ########################

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


-- ######################## 112_support_calls.sql ########################

-- =====================================================================
-- Soft AI - 112: "Talk to a person" support calls (Shaheer, 10 Oct 2026)
--
-- Not AI: a customer calls Softoras support from the browser (voice only).
--   * only organizations on the Pro or White Label plan (setting below)
--   * free for the customer (no credits)
--   * during support hours (Monday-Friday, 9:00-18:00 Asia/Karachi to start;
--     changeable in support_call_settings)
--   * every platform admin sees the call ringing; the first to answer gets it
--   * if nobody answers in time, the call is "missed" and the customer can ask
--     for a callback
-- Browser-to-browser now (Daily.co rooms); real phone numbers can be added later.
--
-- The backend is told about new / changed calls through NOTIFY so it can make
-- the admin panel ring at once.
--
-- Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS soft_ai.support_call_settings (
  id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),   -- one row only
  enabled         BOOLEAN NOT NULL DEFAULT true,
  allowed_plans   TEXT[] NOT NULL DEFAULT ARRAY['pro', 'white_label'],
  timezone        TEXT NOT NULL DEFAULT 'Asia/Karachi',
  work_days       INTEGER[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5],  -- ISO: 1 = Monday ... 7 = Sunday
  start_time      TIME NOT NULL DEFAULT '09:00',
  end_time        TIME NOT NULL DEFAULT '18:00',
  ring_seconds    INTEGER NOT NULL DEFAULT 60 CHECK (ring_seconds BETWEEN 15 AND 300),
  max_minutes     INTEGER NOT NULL DEFAULT 60 CHECK (max_minutes BETWEEN 5 AND 240),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID
);
INSERT INTO soft_ai.support_call_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS soft_ai.support_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  caller_user_id    UUID NOT NULL,
  plan_slug         TEXT,
  status            TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'answered', 'ended', 'missed', 'cancelled')),
  room_name         TEXT NOT NULL UNIQUE,
  room_url          TEXT,                         -- set once the voice room exists
  answered_by       UUID,
  page_path         TEXT,                         -- where the customer was in the ERP
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ring_until        TIMESTAMPTZ NOT NULL,
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  ended_by          TEXT CHECK (ended_by IN ('caller', 'agent', 'system')),
  duration_seconds  INTEGER GENERATED ALWAYS AS (
                      CASE WHEN answered_at IS NOT NULL AND ended_at IS NOT NULL
                           THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - answered_at))::INTEGER) END) STORED
);
ALTER TABLE soft_ai.support_calls ADD COLUMN IF NOT EXISTS room_url TEXT;
CREATE INDEX IF NOT EXISTS idx_support_calls_status ON soft_ai.support_calls (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_calls_org ON soft_ai.support_calls (organization_id, created_at DESC);
-- One open call per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_calls_open_per_user ON soft_ai.support_calls (caller_user_id)
  WHERE status IN ('ringing', 'answered');

-- Only allowed changes: ringing -> answered / missed / cancelled; answered -> ended.
CREATE OR REPLACE FUNCTION soft_ai.support_calls_check_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  ok := CASE OLD.status
          WHEN 'ringing'  THEN NEW.status IN ('answered', 'missed', 'cancelled')
          WHEN 'answered' THEN NEW.status = 'ended'
          ELSE false
        END;
  IF NOT ok THEN
    RAISE EXCEPTION 'invalid call status change: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'answered' THEN NEW.answered_at := now(); END IF;
  IF NEW.status IN ('ended', 'missed', 'cancelled') THEN NEW.ended_at := now(); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_support_calls_transition ON soft_ai.support_calls;
CREATE TRIGGER trg_support_calls_transition BEFORE UPDATE ON soft_ai.support_calls
  FOR EACH ROW EXECUTE FUNCTION soft_ai.support_calls_check_transition();

-- Tell the backend (LISTEN soft_ai_support_calls) about every new or changed call.
CREATE OR REPLACE FUNCTION soft_ai.support_calls_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  PERFORM pg_notify('soft_ai_support_calls', json_build_object('id', NEW.id, 'status', NEW.status)::text);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_support_calls_notify ON soft_ai.support_calls;
CREATE TRIGGER trg_support_calls_notify AFTER INSERT OR UPDATE OF status ON soft_ai.support_calls
  FOR EACH ROW EXECUTE FUNCTION soft_ai.support_calls_notify();

ALTER TABLE soft_ai.support_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.support_call_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON soft_ai.support_calls, soft_ai.support_call_settings FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_all ON soft_ai.support_calls;
CREATE POLICY service_all ON soft_ai.support_calls FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.support_call_settings;
CREATE POLICY service_all ON soft_ai.support_call_settings FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON soft_ai.support_calls TO soft_ai_service;
GRANT SELECT, UPDATE ON soft_ai.support_call_settings TO soft_ai_service;

-- May this organization call now? Returns {ok, reason, plan} (reason: disabled | plan | closed).
CREATE OR REPLACE FUNCTION soft_ai.support_call_eligibility(p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  s       soft_ai.support_call_settings;
  v_plan  TEXT;
  v_local TIMESTAMP;
BEGIN
  SELECT * INTO s FROM soft_ai.support_call_settings LIMIT 1;
  SELECT plan_slug INTO v_plan FROM public.organization_subscriptions
   WHERE organization_id = p_org AND status IN ('active', 'trial', 'trialing')
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF NOT COALESCE(s.enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'disabled', 'plan', v_plan);
  END IF;
  IF v_plan IS NULL OR NOT (v_plan = ANY (s.allowed_plans)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'plan', 'plan', v_plan);
  END IF;
  v_local := now() AT TIME ZONE s.timezone;
  IF NOT (EXTRACT(ISODOW FROM v_local)::INTEGER = ANY (s.work_days))
     OR v_local::TIME < s.start_time OR v_local::TIME >= s.end_time THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed', 'plan', v_plan,
      'hours', jsonb_build_object('days', s.work_days, 'start', to_char(s.start_time, 'HH24:MI'),
                                  'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone));
  END IF;
  RETURN jsonb_build_object('ok', true, 'plan', v_plan, 'ring_seconds', s.ring_seconds, 'max_minutes', s.max_minutes);
END;
$$;

-- Who is calling (for the admin popup and the call log): names, never more than needed.
CREATE OR REPLACE FUNCTION soft_ai.support_call_details(p_ids UUID[])
RETURNS TABLE (
  id UUID, status TEXT, organization_id UUID, organization_name TEXT, plan_slug TEXT,
  caller_name TEXT, caller_email TEXT, answered_by_email TEXT, page_path TEXT,
  created_at TIMESTAMPTZ, ring_until TIMESTAMPTZ, answered_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  ended_by TEXT, duration_seconds INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT c.id, c.status, c.organization_id, o.name, c.plan_slug,
         COALESCE(NULLIF(p.full_name, ''), split_part(u.email, '@', 1)), lower(u.email),
         (SELECT lower(a.email) FROM auth.users a WHERE a.id = c.answered_by),
         c.page_path, c.created_at, c.ring_until, c.answered_at, c.ended_at, c.ended_by, c.duration_seconds
    FROM soft_ai.support_calls c
    JOIN public.organizations o ON o.id = c.organization_id
    LEFT JOIN auth.users u ON u.id = c.caller_user_id
    LEFT JOIN public.profiles p ON p.id = c.caller_user_id
   WHERE c.id = ANY (p_ids)
   ORDER BY c.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.support_call_eligibility(UUID), soft_ai.support_call_details(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.support_call_eligibility(UUID), soft_ai.support_call_details(UUID[]) TO soft_ai_service;


-- ######################## 113_support_call_monthly_limit.sql ########################

-- =====================================================================
-- Soft AI - 113: monthly limit for "Talk to a person" calls (12 Oct 2026)
--
-- Daily.co gives 10,000 free participant-minutes per calendar month (UTC).
-- To make sure Softoras is never charged by accident, calls switch off for
-- the rest of the month once the usage reaches the limit (default 9,000:
-- the last 1,000 minutes are a buffer for calls still in progress, up to
-- ~8 full-length calls). Customers then get the callback form instead.
-- The limit is a setting (NULL = no limit, e.g. once Softoras is happy to pay).
--
-- How minutes are counted (same as Daily: per person in the room):
--   caller: from the moment the call starts ringing until it ends
--   admin:  from answering until it ends
-- Calls still open count up to now.
--
-- Safe to re-run.
-- =====================================================================

ALTER TABLE soft_ai.support_call_settings
  ADD COLUMN IF NOT EXISTS monthly_limit_minutes INTEGER DEFAULT 9000;
ALTER TABLE soft_ai.support_call_settings DROP CONSTRAINT IF EXISTS support_call_settings_monthly_limit_check;
ALTER TABLE soft_ai.support_call_settings
  ADD CONSTRAINT support_call_settings_monthly_limit_check
  CHECK (monthly_limit_minutes IS NULL OR monthly_limit_minutes BETWEEN 100 AND 10000000);

-- Participant-minutes used this calendar month (UTC), rounded up.
CREATE OR REPLACE FUNCTION soft_ai.support_call_minutes_this_month()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, pg_temp
AS $$
  SELECT COALESCE(CEIL(SUM(
           EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - created_at))
         + COALESCE(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - answered_at)), 0)
         ) / 60.0), 0)::INTEGER
    FROM soft_ai.support_calls
   WHERE room_url IS NOT NULL   -- a voice room was really created
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

-- Same as 112, plus reason 'limit' when this month's minutes are used up.
CREATE OR REPLACE FUNCTION soft_ai.support_call_eligibility(p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
DECLARE
  s       soft_ai.support_call_settings;
  v_plan  TEXT;
  v_local TIMESTAMP;
BEGIN
  SELECT * INTO s FROM soft_ai.support_call_settings LIMIT 1;
  SELECT plan_slug INTO v_plan FROM public.organization_subscriptions
   WHERE organization_id = p_org AND status IN ('active', 'trial', 'trialing')
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF NOT COALESCE(s.enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'disabled', 'plan', v_plan);
  END IF;
  IF v_plan IS NULL OR NOT (v_plan = ANY (s.allowed_plans)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'plan', 'plan', v_plan);
  END IF;
  v_local := now() AT TIME ZONE s.timezone;
  IF NOT (EXTRACT(ISODOW FROM v_local)::INTEGER = ANY (s.work_days))
     OR v_local::TIME < s.start_time OR v_local::TIME >= s.end_time THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed', 'plan', v_plan,
      'hours', jsonb_build_object('days', s.work_days, 'start', to_char(s.start_time, 'HH24:MI'),
                                  'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone));
  END IF;
  IF s.monthly_limit_minutes IS NOT NULL AND soft_ai.support_call_minutes_this_month() >= s.monthly_limit_minutes THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'limit', 'plan', v_plan);
  END IF;
  RETURN jsonb_build_object('ok', true, 'plan', v_plan, 'ring_seconds', s.ring_seconds, 'max_minutes', s.max_minutes);
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.support_call_minutes_this_month() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.support_call_minutes_this_month() TO soft_ai_service;


-- ######################## 114_soft_ai_org_plan.sql ########################

-- =====================================================================
-- Soft AI - 114: the organization's plan, for "Fast / Medium / High"
-- (Shaheer, 12 Oct 2026: High only on Pro and White Label).
--
-- The Soft AI service role cannot read public.organization_subscriptions
-- directly (least privilege); this returns only the plan name.
-- Same rule as support calls (112): the newest active / trial subscription.
--
-- Safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION soft_ai.org_plan(p_org UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = soft_ai, public, pg_temp
AS $$
  SELECT plan_slug FROM public.organization_subscriptions
   WHERE organization_id = p_org AND status IN ('active', 'trial', 'trialing')
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION soft_ai.org_plan(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_ai.org_plan(UUID) TO soft_ai_service;


COMMIT;
-- Done: Soft AI database is ready.
