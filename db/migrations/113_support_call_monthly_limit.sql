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
