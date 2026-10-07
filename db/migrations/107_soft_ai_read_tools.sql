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
