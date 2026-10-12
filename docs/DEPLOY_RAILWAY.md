# Deploying Soft AI - step by step (for Shaheer)

Three places: **Supabase** (database), **Railway** (Soft AI service), **Vercel** (the ERP).
Time: about 1 hour. Keep this page open and go in order. Keys are pasted only into
Railway / Vercel settings - never into chats or code.

---

## Step 1 - Supabase: backup and database

1. Supabase -> your project -> **Database -> Backups**: make sure there is a backup from today.
2. Check the ERP migrations up to **071** are applied (your `RUN_VERIFY_MIGRATIONS.sql`).
3. **SQL Editor -> New query** -> paste the whole file **`db/RUN_SOFT_AI_100_114.sql`** -> **Run**.
   It runs as one block: if anything fails, nothing is changed. It only creates the private
   `soft_ai` schema and does not touch ERP tables. Safe to run again.

## Step 2 - Supabase: password for the Soft AI database user

Soft AI does not use the `postgres` admin user; it has its own user with limited rights.
In the SQL Editor run (make up a long password, letters and numbers only, and keep it safe):

```sql
ALTER ROLE soft_ai_service LOGIN PASSWORD 'PUT-A-LONG-PASSWORD-HERE';
```

Then **Connect** (top of the dashboard) -> **Session pooler** (port **5432**, not 6543 - the call
feature needs it). Build the connection string like this:

```
postgresql://soft_ai_service.<project-ref>:<the password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
```

(`<project-ref>` is the part after `postgres.` in Supabase's own string.) This is `DATABASE_URL` below.

## Step 3 - GitHub

1. Make a new **private** repository, e.g. `soft-ai-backend`, and upload the `soft-ai-backend`
   folder (everything except `node_modules`, `dist` and `.env` - the zip already leaves these out).
2. ERP repository: copy the Soft AI files into it (see "ERP files" at the end) on a new branch
   `soft-ai`, check it builds, then merge when ready.

## Step 4 - Railway: the Soft AI service

1. Railway -> **New Project -> Deploy from GitHub repo** -> choose `soft-ai-backend`.
   Railway sees it is Node.js and uses: build `npm ci && npm run build`, start `npm start`.
2. **Settings -> Networking -> Generate Domain** -> you get e.g. `https://soft-ai-xxxx.up.railway.app`.
3. **Settings -> Deploy -> Healthcheck Path**: `/health`.
4. **Variables** (Raw Editor, one per line):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the string from step 2 |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `AUTH_JWT_MODE` | Supabase -> Settings -> **JWT Keys**: if it uses "JWT signing keys" -> `jwks`; if only the legacy JWT secret -> `secret` |
| `SUPABASE_JWT_SECRET` | only when `AUTH_JWT_MODE=secret`: the legacy JWT secret |
| `CORS_ALLOWED_ORIGINS` | the ERP's address, e.g. `https://app.softoras.com` (several: comma separated, https only) |
| `APP_PUBLIC_URL` | the ERP's address (Stripe sends customers back here) |
| `PLATFORM_OWNER_EMAIL` | the platform owner's e-mail (same as the ERP's owner) |
| `GEMINI_API_KEY` | key from Google AI Studio, project with **billing ON** (free keys: Google may use the data, and limits are low) |
| `STRIPE_SECRET_KEY` | Stripe live secret key (`sk_live_...`); leave out to keep buying switched off |
| `STRIPE_WEBHOOK_SECRET` | from step 5 |
| `DAILY_API_KEY` | Daily.co key from Softoras's own Daily account (card added); leave out = calls off |

All other settings have safe defaults (see `.env.example`).
5. **Deploy**. Open `https://<railway-domain>/health` -> must show `{"status":"ok"}`.
   If the deploy fails, **Deployments -> View logs**: a missing or wrong variable is named there.

## Step 5 - Stripe (only for buying credits)

Stripe -> **Developers -> Webhooks -> Add endpoint**:
- URL: `https://<railway-domain>/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- Copy the **Signing secret** (`whsec_...`) into Railway as `STRIPE_WEBHOOK_SECRET` (Railway redeploys).

## Step 6 - Vercel: connect the ERP to Soft AI

1. Vercel -> project -> **Settings -> Environment Variables**:
   `NEXT_PUBLIC_SOFT_AI_API_URL` = `https://<railway-domain>` (no slash at the end), Production.
2. Deploy the branch with the Soft AI files (**Redeploy** - `NEXT_PUBLIC_` values are read at build time).

## Step 7 - Soft AI's ERP knowledge (help pages)

Soft AI learns the ERP's pages and guides from the ERP code. Run once now, and again after each ERP
release that changes menus or page guides. On a computer with Node.js 20+:

1. In the `soft-ai-backend` folder: `npm ci`
2. Create a file `.env` there with: `DATABASE_URL=...` (same as Railway), `SUPABASE_URL=...`,
   `GEMINI_API_KEY=...`, `AUTH_JWT_MODE=jwks` (or `secret` + `SUPABASE_JWT_SECRET`).
3. `npm run knowledge:index -- --erp "<path to the ERP code>" --version "<today's date or git commit>"`
4. It ends with `... is now active`. Delete the `.env` afterwards (it holds keys).

## Step 8 - Check (5 minutes)

Log in to the ERP as a normal user:
- Spark button bottom-right -> "What can you do?" (free answer)
- "How much do customers owe us?" (answer from your data)
- "Create a draft invoice ..." -> Confirm -> Undo
- Credits window opens; Admin -> **Soft AI Credits** and **Support Calls** open
- Railway logs show no errors

If something is wrong: remove `NEXT_PUBLIC_SOFT_AI_API_URL` in Vercel and redeploy - Soft AI
disappears from the ERP and everything else works as before.

---

## ERP files (copy into the ERP repository)

New folders: `src/features/soft-ai/`, `src/features/support-calls/`,
`src/app/(admin)/admin/soft-ai/`, `src/app/(admin)/admin/support-calls/`.

Changed files (if you changed them yourself after 12 Oct, merge by hand):
`next.config.ts`, `package.json`, `package-lock.json`, `src/app/(dashboard)/soft-ai/page.tsx`,
`src/app/(dashboard)/support/page.tsx`, `src/components/admin/admin-shell.tsx`,
`src/components/layout/dashboard-layout.tsx`, `src/features/support/components/get-help-menu.tsx`,
`src/features/support/components/live-support-button.tsx`, `src/lib/security/headers.ts`.
