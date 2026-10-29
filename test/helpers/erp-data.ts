import { randomUUID } from "node:crypto";
import type { Sql } from "../../src/db/client.js";

/**
 * Realistic ERP records for testing the data tools, inserted into Shaheer's
 * real tables on the LOCAL database (his triggers run as normal: payments
 * update invoice balances, journal entries must balance to be posted).
 *
 * Every expected number in the tests is worked out by hand from this data
 * (see the comments), never computed with the same logic that is being tested.
 * Dates are relative to "today" in UTC (the test organizations use UTC).
 */
export function utcDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export async function seedErpData(admin: Sql, orgA: string, orgB: string): Promise<void> {
  await admin.begin(async (tx) => {
    const id = () => randomUUID();

    // ---------- customers ----------
    const ali = id(), bilal = id(), zed = id(), otherOrgCustomer = id();
    await tx`insert into public.customers (id, organization_id, name, phone, email) values
      (${ali}, ${orgA}, 'Ali Traders', '0300-1111111', 'ali@example.test'),
      (${bilal}, ${orgA}, 'Bilal & Co', null, null),
      (${zed}, ${orgA}, 'Zed_100% Ltd', null, null),
      (${otherOrgCustomer}, ${orgB}, 'Ali Traders (org B)', null, null)`;

    // ---------- invoices (orgA) ----------
    // I1 Ali   sent        1000  due -45 (45 days overdue)     dated -75
    // I2 Ali   sent 500 -> payment 200 -> partially_paid, balance 300, due +10, dated -5
    // I3 Bilal sent         700  due -10 (10 days overdue)     dated -40
    // I4 Bilal draft        250  (not a receivable)            dated -2
    // I5 Ali   sent 400 -> payment 400 -> paid, balance 0      dated -3
    // I6 Ali   cancelled    900  (ignored)                     dated -100
    // I7 Zed   sent         100  due +5 (not yet due)          dated -1
    // I8 Ali   sent        5000  DELETED (ignored)
    // orgB: one invoice 7777 (must never appear for orgA)
    const inv = (n: string, c: string, status: string, total: number, due: number, dated: number, deleted = false, org = orgA) => ({
      id: id(), org, n, c, status, total, due: utcDate(due), dated: utcDate(dated), deleted,
    });
    const rows = [
      inv("T-I1", ali, "sent", 1000, -45, -75),
      inv("T-I2", ali, "sent", 500, 10, -5),
      inv("T-I3", bilal, "sent", 700, -10, -40),
      inv("T-I4", bilal, "draft", 250, 30, -2),
      inv("T-I5", ali, "sent", 400, 20, -3),
      inv("T-I6", ali, "cancelled", 900, -100, -100),
      inv("T-I7", zed, "sent", 100, 5, -1),
      inv("T-I8", ali, "sent", 5000, -5, -5, true),
      inv("T-B1", otherOrgCustomer, "sent", 7777, -30, -30, false, orgB),
    ];
    for (const r of rows) {
      await tx`insert into public.invoices
        (id, organization_id, invoice_number, customer_id, status, invoice_date, due_date,
         subtotal, tax_amount, total_amount, paid_amount, balance_due, deleted_at)
        values (${r.id}, ${r.org}, ${r.n}, ${r.c}, ${r.status}, ${r.dated}, ${r.due},
                ${r.total}, 0, ${r.total}, 0, ${r.total}, ${r.deleted ? new Date() : null})`;
    }
    const byNumber = Object.fromEntries(rows.map((r) => [r.n, r.id]));
    // Payments (the ERP trigger updates the invoices): 200 on I2 (dated -2), 400 on I5 (dated -1)
    await tx`insert into public.payments (organization_id, invoice_id, customer_id, amount, payment_method, status, payment_date) values
      (${orgA}, ${byNumber["T-I2"]!}, ${ali}, 200, 'cash', 'completed', ${utcDate(-2)}),
      (${orgA}, ${byNumber["T-I5"]!}, ${ali}, 400, 'bank_transfer', 'completed', ${utcDate(-1)})`;

    // ---------- vendors and bills (orgA) ----------
    // B1 sent 800 due -3 (overdue); B2 sent 200 due +5 (due within 7 days); B3 draft 999; B4 paid (balance 0)
    const vendor = id();
    await tx`insert into public.vendors (id, organization_id, name) values (${vendor}, ${orgA}, 'Steel Supplier')`;
    await tx`insert into public.vendor_bills (organization_id, bill_number, vendor_id, status, bill_date, due_date, total_amount, paid_amount, balance_due) values
      (${orgA}, 'T-B1', ${vendor}, 'sent', ${utcDate(-20)}, ${utcDate(-3)}, 800, 0, 800),
      (${orgA}, 'T-B2', ${vendor}, 'sent', ${utcDate(-2)}, ${utcDate(5)}, 200, 0, 200),
      (${orgA}, 'T-B3', ${vendor}, 'draft', ${utcDate(-1)}, ${utcDate(20)}, 999, 0, 999),
      (${orgA}, 'T-B4', ${vendor}, 'paid', ${utcDate(-30)}, ${utcDate(-10)}, 300, 300, 0)`;

    // ---------- cash and bank (orgA) ----------
    // posted: Dr Cash 1500 / Cr Sales 1500; Dr Bank 2500 / Cr Sales 2500; Dr Expense 300 / Cr Cash 300
    // draft (ignored): Dr Cash 9999 / Cr Sales 9999
    // -> Cash in Hand 1200, Bank 2500, total 3700
    const cash = id(), bank = id(), sales = id(), expense = id();
    await tx`insert into public.accounts (id, organization_id, code, name, account_type) values
      (${cash}, ${orgA}, '1112', 'Cash in Hand', 'asset'),
      (${bank}, ${orgA}, '1113', 'Bank - Local', 'asset'),
      (${sales}, ${orgA}, '4100', 'Sales Revenue', 'revenue'),
      (${expense}, ${orgA}, '5100', 'Office Expense', 'expense')`;
    const journal = async (lines: [string, number, number][], posted: boolean) => {
      const je = id();
      const total = lines.reduce((s, l) => s + l[1], 0);
      await tx`insert into public.journal_entries (id, organization_id, entry_date, status, description)
               values (${je}, ${orgA}, ${utcDate(-1)}, 'draft', 'soft-ai test')`;
      for (const [acc, debit, credit] of lines) {
        await tx`insert into public.journal_entry_lines (organization_id, journal_entry_id, account_id, debit, credit)
                 values (${orgA}, ${je}, ${acc}, ${debit}, ${credit})`;
      }
      if (posted) {
        await tx`update public.journal_entries set status = 'posted', total_debit = ${total}, total_credit = ${total} where id = ${je}`;
      }
    };
    // Bank Accounts page: Meezan 5000 (no currency set -> company currency USD) and
    // HBL 900000 in PKR -> totals per currency, never added together.
    // "Bank Charges" is an EXPENSE account with "bank" in its name -> must not count as cash.
    const bankCharges = id();
    await tx`insert into public.accounts (id, organization_id, code, name, account_type) values
      (${bankCharges}, ${orgA}, '5200', 'Bank Charges', 'expense')`;
    await tx`insert into public.bank_accounts (organization_id, account_id, name, bank_name, account_number, currency_code, current_balance, is_active) values
      (${orgA}, ${bank}, 'Meezan Current', 'Meezan Bank', '01234567890123', null, 5000, true),
      (${orgA}, null, 'HBL Business', 'Habib Bank', '99887766554433', 'PKR', 900000, true)`;
    // Ledger after the entries below: Cash 1500 - 300 - 50 = 1150, Bank 2500 -> ledger total 3650
    await journal([[bankCharges, 50, 0], [cash, 0, 50]], true);
    await journal([[cash, 1500, 0], [sales, 0, 1500]], true);
    await journal([[bank, 2500, 0], [sales, 0, 2500]], true);
    await journal([[expense, 300, 0], [cash, 0, 300]], true);
    await journal([[cash, 9999, 0], [sales, 0, 9999]], false);

    // ---------- stock (orgA) ----------
    // Steel Rod: reorder 10; W1 on hand 6 (reserved 1), W2 on hand 2 -> available 7 -> LOW
    // Paint Blue: reorder 5; W1 on hand 50 -> fine
    // Service Fee: not tracked (ignored); Old Item: inactive (ignored)
    const w1 = id(), w2 = id(), rod = id(), paint = id(), service = id(), old = id();
    await tx`insert into public.warehouses (id, organization_id, code, name) values
      (${w1}, ${orgA}, 'TW1', 'Test Warehouse 1'), (${w2}, ${orgA}, 'TW2', 'Test Warehouse 2')`;
    await tx`insert into public.products (id, organization_id, sku, name, unit_of_measure, reorder_level, is_active, track_inventory) values
      (${rod}, ${orgA}, 'T-SR-1', 'Steel Rod', 'pcs', 10, true, true),
      (${paint}, ${orgA}, 'T-PB-1', 'Paint Blue', 'ltr', 5, true, true),
      (${service}, ${orgA}, 'T-SV-1', 'Service Fee', 'hr', 0, true, false),
      (${old}, ${orgA}, 'T-OLD-1', 'Old Item', 'pcs', 100, false, true)`;
    await tx`insert into public.product_stock (organization_id, product_id, warehouse_id, quantity_on_hand, quantity_reserved) values
      (${orgA}, ${rod}, ${w1}, 6, 1), (${orgA}, ${rod}, ${w2}, 2, 0), (${orgA}, ${paint}, ${w1}, 50, 0), (${orgA}, ${old}, ${w1}, 1, 0)`;

    // ---------- HR (orgA) ----------
    // Sara active (present today), Usman active (late today), Hina on_leave (approved leave -1..+1),
    // Old Guy terminated. Pending request: Usman, next week. -> active employees 3
    const sara = id(), usman = id(), hina = id(), oldGuy = id(), lt = id();
    await tx`insert into public.employees (id, organization_id, first_name, last_name, status) values
      (${sara}, ${orgA}, 'Sara', 'Khan', 'active'), (${usman}, ${orgA}, 'Usman', 'Ali', 'active'),
      (${hina}, ${orgA}, 'Hina', 'Riaz', 'on_leave'), (${oldGuy}, ${orgA}, 'Old', 'Guy', 'terminated')`;
    await tx`insert into public.attendance (organization_id, employee_id, attendance_date, status) values
      (${orgA}, ${sara}, ${utcDate(0)}, 'present'), (${orgA}, ${usman}, ${utcDate(0)}, 'late')`;
    await tx`insert into public.leave_types (id, organization_id, name, code) values (${lt}, ${orgA}, 'Annual', ${`T-AN-${orgA.slice(0, 6)}`})`;
    await tx`insert into public.leave_requests (organization_id, employee_id, leave_type_id, start_date, end_date, days, status) values
      (${orgA}, ${hina}, ${lt}, ${utcDate(-1)}, ${utcDate(1)}, 3, 'approved'),
      (${orgA}, ${usman}, ${lt}, ${utcDate(7)}, ${utcDate(8)}, 2, 'pending'),
      (${orgA}, ${sara}, ${lt}, ${utcDate(-20)}, ${utcDate(-19)}, 2, 'approved')`;

    // ---------- expenses (orgA), all dated -2 ----------
    // approved: Fuel 120, Fuel 80, (no category) 300 -> approved 500 (3); pending Fuel 50; rejected 999; deleted 777
    await tx`insert into public.expenses (organization_id, description, amount, expense_date, status, category, deleted_at) values
      (${orgA}, 'fuel 1', 120, ${utcDate(-2)}, 'approved', 'Fuel', null),
      (${orgA}, 'fuel 2', 80, ${utcDate(-2)}, 'approved', 'Fuel', null),
      (${orgA}, 'rent', 300, ${utcDate(-2)}, 'approved', '', null),
      (${orgA}, 'fuel 3', 50, ${utcDate(-2)}, 'pending', 'Fuel', null),
      (${orgA}, 'rejected', 999, ${utcDate(-2)}, 'rejected', 'Other', null),
      (${orgA}, 'deleted', 777, ${utcDate(-2)}, 'approved', 'Other', now())`;
  });
}
