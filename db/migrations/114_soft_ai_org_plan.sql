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
