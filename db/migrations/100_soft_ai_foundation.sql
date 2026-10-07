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
