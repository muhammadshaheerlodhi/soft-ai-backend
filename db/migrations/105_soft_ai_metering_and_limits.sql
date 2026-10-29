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
--    of the backend (the host can run more than one).
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
