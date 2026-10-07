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
