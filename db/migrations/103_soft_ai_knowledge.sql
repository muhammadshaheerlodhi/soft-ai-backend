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
