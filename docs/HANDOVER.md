# Soft AI - handover (12 Oct 2026)

Everything below was built and tested on a **local** copy (local Supabase in Docker, dummy data).
Nothing has been deployed and the live database has not been changed.

## 1. What is included

| Part | Where |
|---|---|
| Soft AI service (Hono + Gemini) | this folder `soft-ai-backend/` (own git history) |
| ERP changes (panel, admin pages, calls, security headers) | ERP repo, branch **`soft-ai`** (Shaheer's code is on `main`; `soft-ai` = `main` + Soft AI) |
| Database (only the private `soft_ai` schema) | `db/migrations/100_*.sql` ... `114_*.sql` |
| Design notes, one per step | `docs/01-...md` ... `docs/10-...md` |

Features: chat panel (Spark button bottom-left, docked / maximized / minimized, history with search,
Fast / Medium / High, credits bar with 80% / 90% notice), ERP help knowledge, free answers for common
commands, company data answers (only what the user's role allows), 12 actions with confirm + undo,
credits (monthly 50 / 100 / 200, packs 1,000 / 2,000 / 3,000 = $25 / $50 / $75 via Stripe, expiry after
1 year), admin pages (Soft AI Credits, Support Calls), "Talk to a person" voice calls (Pro / White Label,
Mon-Fri 9:00-18:00, monthly minute limit).

## 2. Deploy, in this order (with a backup first)

**Simple click-by-click version for Render + Vercel: [DEPLOY_RENDER.md](DEPLOY_RENDER.md).**
All database changes in one file for the Supabase SQL editor: `db/RUN_SOFT_AI_100_114.sql`.

1. **Backup** the live database (Supabase dashboard -> Database -> Backups).
2. **ERP migrations** up to `071` must be on live (check with `local-dev/live-check.ps1`; on 9 Oct live
   matched local up to 068).
3. **Soft AI migrations** `100` to `114`, in number order, each in one transaction
   (`psql "<url>" -v ON_ERROR_STOP=1 -1 -f db/migrations/1NN_....sql`). All are safe to re-run.
4. **Service role login** (the files never contain a password):
   `ALTER ROLE soft_ai_service LOGIN PASSWORD '<strong password>';`
   The backend's `DATABASE_URL` uses this role, never the `postgres` owner.
5. **Backend hosting** (Render, `render.yaml`): `npm ci && npm run build`, start `npm start`, health check `/health`.
   Environment: copy `.env.example`, fill in the values (see the comments there). Must-haves:
   `DATABASE_URL`, `SUPABASE_URL`, `AUTH_JWT_MODE`, `CORS_ALLOWED_ORIGINS` (the ERP's address),
   `GEMINI_API_KEY`, `APP_PUBLIC_URL`, `PLATFORM_OWNER_EMAIL`. Optional: `STRIPE_SECRET_KEY` +
   `STRIPE_WEBHOOK_SECRET` (buying credits), `DAILY_API_KEY` (calls; Softoras's own Daily account with
   Shaheer's card).
6. **Stripe**: add a webhook to `https://<backend>/webhooks/stripe`, events `checkout.session.completed`,
   `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
7. **ERP (Vercel)**: deploy branch `soft-ai`; set `NEXT_PUBLIC_SOFT_AI_API_URL=https://<backend>`.
   The security headers then allow the browser to reach it.
8. **Knowledge base** (ERP help pages for Soft AI) - after every ERP deployment:
   `npm run knowledge:index -- --erp <path to ERP code> --version <git commit id>`
   Best: run it automatically from the deploy pipeline. Only changed pages are re-read.
9. **Check**: open the ERP, Soft AI button -> "What can you do?" (free), a data question, one action with
   undo, Credits window, Admin -> Soft AI Credits, Admin -> Support Calls.

Automatic, nothing to schedule: monthly credits are added on first use each month; calls that are not
answered / too long are closed every 10 s by the backend.

## 3. Adding a new feature to Soft AI later

Soft AI does not learn new ERP features by itself (on purpose: it may only see what each role allows).

| Wanted | What to do |
|---|---|
| Soft AI explains / opens a new page | Add the page to the ERP menu (`navigation.ts`) and page guide (`module-instructions.ts`) as usual, then run the knowledge command (step 8). No Soft AI code. |
| Soft AI answers from new data | Add a SQL function in a new migration (copy a `tool_*` function from `107_soft_ai_read_tools.sql`, keep the permission check) and register it in `src/tools/registry.ts` (name, description, permission, page). Add a test in `test/integration/tools.test.ts`. |
| Soft AI does something new | Add an entry in `src/actions/registry.ts` (copy an existing one) and its handler in the ERP `src/features/soft-ai/lib/action-handlers.ts`, which calls the ERP's own service. Add a test in `test/integration/actions.test.ts`. |
| Better AI | Change `GEMINI_CHAT_MODEL` (setting, no code). |

**ERP tables Soft AI reads** (renaming / removing a column here can break Soft AI; adding columns is fine):
organizations, organization_members, roles, permissions, role_permissions, profiles, platform_admins,
system_settings, organization_subscriptions, subscription_plans, customers, leads, invoices, quotations,
payments, vendors, vendor_bills, purchase_orders, expenses, accounts, bank_accounts, journal_entries,
journal_entry_lines, products, product_stock, employees, attendance, leave_requests, leave_types,
projects, tasks, activity_events. Changes to how roles / permissions work must be copied to
`108_soft_ai_member_permissions.sql`.

## 4. Tests

- Backend: `npm test` - 199 tests (needs the local Supabase; the tests refuse any other database).
- Database: `powershell -File db/run-local-tests.ps1`.
- ERP: `npx tsx src/features/soft-ai/lib/soft-ai-lib.test.ts` (10), `npx tsc --noEmit`, `npx next build`.

## 5. Open points

- **Not tested with real services yet**: a real Stripe test payment (needs Stripe test keys) and a real
  two-person voice call (Daily needs a card on the account).
- **Later, to discuss with Shaheer**: microphone input, attachments, "page vision".
- **ERP issues found** (not Soft AI code): `Documents/05_Code_Review/ERP_Issues_For_Shaheer.md` -
  two serious ones in the 12 Oct integration code (tokens readable by every member, open redirect).
- Step 10 with Shaheer: security and load review on the real setup, then go live.
