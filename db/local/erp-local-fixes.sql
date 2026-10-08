-- =====================================================================
-- LOCAL ONLY. Fixes for problems found in the ERP's own code when the local
-- database is built from the ERP migration files. NOT part of Soft AI's
-- migrations, and never run on Shaheer's database. Reported to Shaheer.
--
-- 1. Sales documents cannot be saved (found 8 Oct 2026, step 8 live test)
--    The ERP's totals function (src/features/sales/utils/calculate-totals.ts
--    -> calculateDocumentTotals) returns net_charge_amount and
--    subtotal_after_discount, and document-service-base.ts inserts ALL of
--    them into the document table. No migration creates these two columns,
--    so creating an invoice, quotation or sales order fails with:
--      Could not find the 'net_charge_amount' column of 'invoices' in the schema cache
--    (Shaheer's live database may have them; to be confirmed by him.)
--    Fix used locally: add the two columns. Shaheer may prefer to stop
--    sending them instead (they can be calculated).
-- =====================================================================

ALTER TABLE public.invoices     ADD COLUMN IF NOT EXISTS net_charge_amount NUMERIC(15,2) DEFAULT 0,
                                ADD COLUMN IF NOT EXISTS subtotal_after_discount NUMERIC(15,2) DEFAULT 0;
ALTER TABLE public.quotations   ADD COLUMN IF NOT EXISTS net_charge_amount NUMERIC(15,2) DEFAULT 0,
                                ADD COLUMN IF NOT EXISTS subtotal_after_discount NUMERIC(15,2) DEFAULT 0;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS net_charge_amount NUMERIC(15,2) DEFAULT 0,
                                ADD COLUMN IF NOT EXISTS subtotal_after_discount NUMERIC(15,2) DEFAULT 0;

-- Let the local API (PostgREST) see the new columns.
NOTIFY pgrst, 'reload schema';
