-- =====================================================================
-- LOCAL ONLY. Fixes for problems found in the ERP's own database code when
-- the local database is built from the ERP migration files. NOT part of
-- Soft AI's migrations, and never run on Shaheer's database. Shared with
-- Shaheer as a suggested fix.
--
-- 1. public.set_generic_document_number() (ERP migration 033)
--    Problem: the function refers to NEW.return_number, NEW.bill_number, ...
--    directly. PL/pgSQL checks that whole condition even for tables that do
--    not have the column, so on a database built from the migrations EVERY
--    insert into these tables fails with
--      record "new" has no field "return_number"
--    Affected: journal_entries, expenses, income_records, internal_requests,
--    purchase_requests, service_requests, stock_adjustments, stock_transfers,
--    work_orders (sales_returns works).
--    (Migration 033 already moved bills / goods receipts to their own triggers
--     for this reason.) Shaheer's live database probably has a different
--     version, since journal entries work there - to be confirmed by him.
--    Fix: read and set the column BY NAME (to_jsonb / jsonb_populate_record),
--    so the function works for any table. Same prefixes as the original.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_generic_document_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_type    TEXT := TG_ARGV[0];
  v_col     TEXT := TG_ARGV[1];
  v_prefix  TEXT;
  v_current TEXT;
BEGIN
  v_current := to_jsonb(NEW) ->> v_col;
  IF v_current IS NULL OR v_current = '' THEN
    v_prefix := CASE v_col
      WHEN 'return_number'     THEN 'RET'
      WHEN 'bill_number'       THEN 'BILL'
      WHEN 'receipt_number'    THEN 'GRN'
      WHEN 'transfer_number'   THEN 'TRF'
      WHEN 'adjustment_number' THEN 'ADJ'
      WHEN 'request_number'    THEN 'REQ'
      WHEN 'work_order_number' THEN 'WO'
      WHEN 'payroll_number'    THEN 'PRL'
      WHEN 'entry_number'      THEN 'JE'
      WHEN 'expense_number'    THEN 'EXP'
      WHEN 'project_number'    THEN 'PRJ'
      ELSE NULL
    END;
    IF v_prefix IS NOT NULL THEN
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object(v_col, public.generate_document_number(NEW.organization_id, v_type, v_prefix))
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
