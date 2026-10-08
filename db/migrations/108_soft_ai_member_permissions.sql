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
