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
