# Soft AI - Step 7: Company data (read-only tools) and the tool registry

Soft AI can now answer questions about the company's own data - receivables, invoices,
sales, customers, payables, cash and bank, stock, HR, expenses - limited by the user's role.
It still cannot create or change anything (step 8).

## 1. How a data question works

```
"How much do customers owe us?"
 -> Gemini is offered ONLY the tools this user's role allows (function calling)
 -> round 1: Gemini asks for receivables_summary
 -> our code checks: tool exists, role allows it, inputs valid
 -> the database function runs it (checks membership + permission AGAIN, read-only,
    this organization only, small result)
 -> round 2: Gemini answers with the real numbers, currency and date
 -> last round is forced to answer in text (no endless tool loops)
```

One credit hold covers all rounds; the real total is charged once. Data answers are
**never cached**. Every tool use is saved with the message (`tool_calls`) for audit.

## 2. The tools (registry: `src/tools/registry.ts`, SQL: migration 107)

| Tool | Permission | Answers |
|---|---|---|
| receivables_summary | sales.view | owed, overdue, aging, drafts (separately) |
| list_unpaid_invoices | sales.view | unpaid invoices by customer / overdue / days; max 20 rows + totals |
| sales_summary | sales.view | invoices, tax, payments received, top customers for a period |
| find_customers | crm.view or sales.view | customer details + open balance |
| payables_summary | purchases.view | owed to suppliers, overdue, due in 7 days, top vendors |
| cash_and_bank_balances | accounting.view | ledger cash & bank + Bank Accounts page (per currency) |
| stock_levels | inventory.view | on hand / reserved / available, low stock |
| hr_today | hr.view | employees, attendance, who is on leave, pending requests |
| expenses_summary | accounting.view | approved / pending, top categories for a period |

Business rules copied from the ERP's code (posted vs draft invoices, overdue by due date,
cash accounts `111%`). Uses the organization's currency and time zone for "today".

## 3. Security - two independent layers

1. **Backend:** only allowed tools are offered; any other request gets `forbidden`.
2. **Database:** each tool function checks membership + permission itself (the ERP's RLS
   only checks membership), filters by organization, is read-only, and is callable only by
   Soft AI's restricted role (browsers: no access).

**Deliberate-bug proof:** with the backend check removed, the database alone still refused
every forbidden request (tests still passed); with the database check removed, the
"database refuses" and "organizations are separate" tests failed.

Also: customer search treats `%` and `_` literally (no "match everything"); full bank account
numbers never go to the AI (last 4 digits only); tool results are capped in size; the AI is
told that text inside results is data, not instructions.

## 4. Tests

- **148 automated tests pass** (21 new data-tool tests). Test data is inserted into the ERP's
  real tables on the local database (his triggers run normally); every expected number is
  worked out by hand: receivables 2,100 / overdue 1,700 / aging buckets, sales 2,700,
  payables 1,000, cash ledger 3,650 vs bank accounts USD 5,000 + PKR 900,000 (never added),
  low stock (Steel Rod: 7 available vs reorder 10), HR (3 active, present 1, late 1, Hina on
  leave), expenses 500 (Uncategorized 300, Fuel 200).
- Chat flow: tool round + answer, "Checking receivables…" status, sources, audit, charged
  once for both rounds, never cached, sales user offered only sales tools, forbidden tool
  returns no data, loop stopped at the last round.

## 5. Live test (real Gemini, ERP's own "Load Demo Data")

| Question | Soft AI | Database | |
|---|---|---|---|
| How much do customers owe? What is overdue? | 410,000 USD, 2 invoices; 125,000 overdue; draft 78,000 noted | same | correct |
| (Roman Urdu) Overdue invoice kis customer ka hai? | Gulf Link Trading LLC, 10 din late, due 27 Sep | same | correct |
| Cash and bank? | Ledger 1,450,000 USD; HBL 2,950,000 PKR; Meezan 420,000 PKR; currencies not mixed | same | correct |

Gemini accepted our replay of its hidden "thought signatures" across tool rounds
(stateless generateContent) - the one point Google's docs did not confirm.

## 6. Problems found and fixed

1. **Cash tool v1 read only the ledger** and disagreed with the ERP's screens -> now shows both
   sources, labelled.
2. **Cash tool v2 added PKR bank balances into a "USD" total** -> totals per currency, never mixed.
3. An "expense" account named "Bank Charges" would have counted as cash -> asset accounts only.
4. Test data hit an ERP bug (numbering trigger) -> local-only fix file; reported (issue 5).
5. Test cleanup hit an ERP bug (delete organization + audit trigger) -> cleanup order; reported (issue 6).
6. A test sent tools without required inputs, so a deliberate-bug run looked like a failure ->
   the test now sends valid inputs, proving the database layer alone.
7. An older "stop" test assumed a fixed credit amount that grew with longer instructions ->
   now checks output tokens, which is what it means to test.

## 7. ERP issues for Shaheer

See `Documents/05_Code_Review/ERP_Issues_For_Shaheer.md` (13 items, most important first:
numbering trigger, Stripe webhook table, role checks in the database, credit tables,
wrong dashboard "Outstanding" and "Cash & Bank" figures).

## 8. Costs

Data answers take 2 AI rounds and include the tool list: ~0.2 test credits (~$0.002 at cost
price) vs ~0.02-0.05 for plain answers. Matches our early estimate for "complex" requests.

## 9. Not in this step

- Actions (create invoice, approve leave...) with preview / confirm / Activity / undo: step 8.
- More data tools (P&L, balance sheet, specific invoice details): add to the registry the
  same way when needed.
