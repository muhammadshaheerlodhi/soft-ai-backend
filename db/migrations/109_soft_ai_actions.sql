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
