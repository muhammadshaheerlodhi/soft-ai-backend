# Deploying Soft AI - step by step

Three places: **Supabase** (database), **Render** (Soft AI service), **Vercel** (the ERP).
Time: about 1 hour. Keep this page open and go in order. Keys are pasted only into
Render / Vercel settings - never into chats or code.

(Planned for Railway first; Railway paused new signups after its 21 October 2026 security
incident, so Soft AI runs on Render. Nothing in the code depends on the host: moving later means
a new service from the same repo, the same settings, and a new address in Vercel / Stripe.)

---

## Step 1 - Supabase: backup and database

1. Supabase -> your project -> **Database -> Backups**: make sure there is a backup from today.
2. Check the ERP migrations up to **071** are applied. (072 to 080 come with the ERP pull request and are run when that is deployed; Soft AI does not need them.)
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

## Step 3 - Render: the Soft AI service

The repo has a **`render.yaml`** (Render "Blueprint"): it already sets the build (`npm ci && npm run build`),
start (`npm start`), health check (`/health`), Node version (`.node-version`), plan **Starter**
(about $7 a month, always on) and region **Singapore** (closest to the database).

1. Sign up at [render.com](https://render.com) with the Softoras GitHub account.
   **Account settings -> Billing**: add the card (needed for the Starter plan).
2. **New -> Blueprint** -> connect GitHub -> **Only select repositories** -> `soft-ai-backend` -> pick the repo.
3. Render shows the service `soft-ai-backend` and asks for these values:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the string from step 2 |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `AUTH_JWT_MODE` | Supabase -> Settings -> **JWT Keys**: if it uses "JWT signing keys" -> `jwks`; if only the legacy JWT secret -> `secret` |
| `SUPABASE_JWT_SECRET` | only when `AUTH_JWT_MODE=secret`: the legacy JWT secret; otherwise leave empty |
| `CORS_ALLOWED_ORIGINS` | the ERP's address, e.g. `https://app.softoras.com` (several: comma separated, https only) |
| `APP_PUBLIC_URL` | the ERP's address (Stripe sends customers back here) |
| `PLATFORM_OWNER_EMAIL` | the platform owner's e-mail (same as the ERP's owner) |
| `GEMINI_API_KEY` | key from Google AI Studio, project with **billing ON** (free keys: Google may use the data, and limits are low) |
| `STRIPE_SECRET_KEY` | Stripe live secret key (`sk_live_...`); leave empty to keep buying switched off |
| `STRIPE_WEBHOOK_SECRET` | from step 4 (leave empty for now) |
| `DAILY_API_KEY` | Daily.co key from Softoras's own Daily account (card added); leave empty = calls off |

   All other settings have safe defaults (see `.env.example`). Click **Apply** / **Deploy Blueprint**.
4. The first deploy takes a few minutes. The service page shows its address, e.g.
   `https://soft-ai-backend-xxxx.onrender.com`. Open `https://<that address>/health` -> must show `{"status":"ok"}`.
   If the deploy fails, open **Logs**: a missing or wrong variable is named there.
5. Recommended: own address **`api.softoras.com`** (then moving hosts later is one DNS change):
   service -> **Settings -> Custom Domains -> Add** -> add the CNAME record Render shows at the domain's DNS provider.
   Use this address everywhere below instead of the `onrender.com` one.

Later changes: settings in **Environment** (saving redeploys); every push to `main` deploys automatically.

## Step 4 - Stripe (only for buying credits)

Stripe -> **Developers -> Webhooks -> Add endpoint**:
- URL: `https://<soft-ai address>/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- Copy the **Signing secret** (`whsec_...`) into Render -> **Environment** as `STRIPE_WEBHOOK_SECRET` (Render redeploys).

## Step 5 - Vercel: connect the ERP to Soft AI

1. Vercel -> project -> **Settings -> Environment Variables**:
   `NEXT_PUBLIC_SOFT_AI_API_URL` = `https://<soft-ai address>` (no slash at the end), Production.
2. **Redeploy** the ERP (`NEXT_PUBLIC_` values are read at build time). The Soft AI screens are already
   in the ERP code (merged with the ERP pull request).

## Step 6 - Soft AI's ERP knowledge (help pages)

Soft AI learns the ERP's pages and guides from the ERP code. Run once now, and again after each ERP
release that changes menus or page guides. On a computer with Node.js 20+:

1. In the `soft-ai-backend` folder: `npm ci`
2. Create a file `.env` there with: `DATABASE_URL=...` (same as Render), `SUPABASE_URL=...`,
   `GEMINI_API_KEY=...`, `AUTH_JWT_MODE=jwks` (or `secret` + `SUPABASE_JWT_SECRET`).
3. `npm run knowledge:index -- --erp "<path to the ERP code>" --version "<today's date or git commit>"`
4. It ends with `... is now active`. Delete the `.env` afterwards (it holds keys).

## Step 7 - Check (5 minutes)

Log in to the ERP as a normal user:
- Spark button bottom-right -> "What can you do?" (free answer)
- "How much do customers owe us?" (answer from your data)
- "Create a draft invoice ..." -> Confirm -> Undo
- Credits window opens; Admin -> **Soft AI Credits** and **Support Calls** open
- Render **Logs** show no errors

If something is wrong: remove `NEXT_PUBLIC_SOFT_AI_API_URL` in Vercel and redeploy - Soft AI
disappears from the ERP and everything else works as before.

## Moving to another host later (e.g. Railway)

1. New service from the same GitHub repo: build `npm ci && npm run build`, start `npm start`, health check `/health`.
2. Copy all variables from Render -> **Environment**.
3. When it answers on `/health`: point `api.softoras.com` to the new host (or change
   `NEXT_PUBLIC_SOFT_AI_API_URL` in Vercel + the Stripe webhook URL). Then delete the Render service.
