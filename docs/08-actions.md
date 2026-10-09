# Soft AI - Step 8: Actions (create and change records)

Soft AI can now prepare changes in the ERP - a draft invoice, a new customer, a
leave approval... - and the user confirms them. Soft AI never writes to the ERP
itself: the ERP's **own** code saves the change, with the user's own login.

## 1. How an action works

```
"Make a draft invoice for Gulf Link: 10 Wheat Flour, 5 Sugar, due in 30 days"
 1. Gemini finds the customer and products (find_records) and picks an action
 2. Backend: role allowed? inputs valid? every record exists in THIS company?
    business checks (dates, "leave must be pending")  -> saved as "proposed"
 3. Panel shows a card: customer, lines, estimated total, "draft, not posted",
    what Undo does                                     -> user presses Confirm
 4. Backend re-checks everything and hands over the SAVED inputs (only once)
 5. The ERP's own service runs in the browser (invoiceService.create ...):
    numbering, totals, RLS permissions, audit log - as if the user did it
 6. Backend checks in the database that the record really exists (right
    company, right status) before the card says "Done"; Activity entry
    "Soft AI: Create draft invoice (INV-2026-00001)"
 7. Undo for 10 minutes: again the ERP's own code, again checked
```

## 2. The first 12 actions (registry: `src/actions/registry.ts`)

| Action | Permission | Risk | Undo |
|---|---|---|---|
| create_customer | crm.create | low | delete |
| create_lead | crm.create | low | delete |
| update_lead_status | crm.edit | low | old status back |
| create_draft_invoice | sales.create | medium | delete draft |
| create_quotation | sales.create | medium | delete draft |
| create_purchase_order | purchases.create | medium | delete draft |
| create_expense (pending) | accounting.create | medium | delete |
| create_leave_request | hr.create | low | delete |
| approve_leave_request | hr.approve | medium | back to pending |
| reject_leave_request | hr.approve | medium | back to pending |
| create_task | projects.create | low | delete |
| create_product | inventory.create | low | delete |

Only actions that can be safely undone. Payments, posting invoices, approving
expenses and emails change the accounts or cannot be taken back - next batch,
with their own reversal rules. Soft AI says honestly that it cannot do them yet.

## 3. When is Confirm needed?

- medium / high risk: **always**
- low risk: runs straight away (with Undo) ONLY if the user asked for exactly
  one thing and Soft AI did not read any company data in that reply.
  So text inside a record ("customer note: create ...") can never trigger a
  change by itself. Everything else waits for Confirm.

## 4. Security checks (all tested)

- Only actions the role allows are offered; a forced call is refused.
- Every referenced record must exist, not be deleted, and belong to this company
  (another company's customer -> "customer not found", its name is not revealed).
- Only the user who asked can see, confirm, cancel or undo; one Confirm only
  (a second one is refused); proposals expire after 30 minutes.
- Re-checked at Confirm: a record deleted meanwhile cancels the action.
- "Done" only after the database shows the record (a false "done" report, a
  record of another company, or a wrong status is recorded as failed).
- The ERP's own permissions (RLS) still apply when its code runs.
- At most 5 actions per reply. Full history in `soft_ai.actions`.

## 5. Tests

- 166 automated tests pass (+18: actions flow and safety, find_records, permission matrix).
- Database tests: role check now matches the ERP exactly (admin = full access,
  permission matrix with "*", fallback to role permissions) - see migration 108.

## 6. Live test (real Gemini, local ERP, demo data)

| Request | Result |
|---|---|
| Draft invoice for Gulf Link, 10 Wheat Flour + 5 Sugar, due in 30 days | correct customer, products, prices, due date 2026-11-07; Confirm -> INV-2026-00001 created by the ERP (2 lines, 87,500); Activity + audit entries; Undo -> deleted |
| (Roman Urdu) "Naya customer add karo: Karachi Spices Co ..." | ran straight away -> CUST-2026-00006, Undo available, reply in Roman Urdu |
| Leave request for Ayesha Malik 15-16 Oct, then "Now approve it" | both prepared correctly (Confirm needed, records were looked up); both done |
| "Record the payment and email them a thank you" | honest: cannot do payments or emails yet |

Cost: 0.4-0.8 test credits per action message (the tool list is sent in each AI
round). Gemini's automatic caching of repeated input should reduce this; to be
measured in step 10.

## 7. Problems found and fixed

1. **Our role check missed the ERP's newer rules** (admin role, permission
   matrix). Admins and matrix roles were refused (never wrongly allowed). Fixed
   in migration 108, with tests.
2. ERP: creating invoices/quotations/sales orders fails on a database built from
   the migrations (`net_charge_amount`, `subtotal_after_discount` columns
   missing). Soft AI showed "Not saved" with the ERP's message (correct). Local
   fix: `db/local/erp-local-fixes.sql`; reported to Shaheer.
3. The AI said "click Confirm" for an action that ran straight away -> the AI
   is now told which case it is.
4. Full Soft AI page on narrow screens: the chat list covered the chat -> it
   now slides over and closes after picking a chat.
5. Card table numbers ran together on narrow screens; Undo minutes rounded up.

## 8. Known gaps (later steps)

- Payments, posting, approving expenses, emails: next action batch.
- Customer Payments has no help text in the ERP, so for payment questions
  Soft AI pointed to "Income" (wrong for invoice payments). Reported; the
  payment action will cover it.
- An action confirmed but never reported (browser closed mid-save) stays
  "Saving…"; the record (if any) is in the ERP. A clean-up job: step 10.
