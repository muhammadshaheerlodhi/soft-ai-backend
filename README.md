# soft-ai-backend

Backend service for **Soft AI**, the AI assistant inside Softoras ERP.
It runs on Render (see docs/DEPLOY_RENDER.md) and uses the ERP's Supabase database (its own private `soft_ai` schema).

> Status: step 1 (database) - done and tested on a LOCAL database (7 Oct 2026):
> ERP migrations 001-056 + Soft AI 100-104 applied, 55 checks passed, migrations re-runnable.
> Nothing is deployed. Quick re-run: `powershell -File db/run-local-tests.ps1`

> Step 2 (backend skeleton) - done 7 Oct 2026: login check, organization / sub-account
> scope, permissions, credits balance.
> Step 3 (credit metering + request limits) - done 7 Oct 2026.
> Step 4 (Gemini chat, streaming, chat history API) - done 7 Oct 2026; 97 automated tests pass
> (`npm test`); tested live with real Gemini on dummy questions.
> Step 6 (knowledge base from ERP code, rules engine, answer cache) - done 7 Oct 2026.
> Step 7 (read-only company data tools, tool registry) - done 7 Oct 2026.
> Step 8 (actions: propose, confirm, run with the ERP's own code, check, undo) - done 8 Oct 2026.
> Step 9 (buying credits with Stripe, monthly allowance, limits, warnings, admin panel) - done 8 Oct 2026; 180 tests pass.
> Shaheer's meeting changes, "Talk to a person" calls, Fast / Medium / High - done 9-12 Oct 2026; 199 tests pass.
>
> **Start here: [docs/HANDOVER.md](docs/HANDOVER.md)** (what is included, how to deploy, how to add features).

## Folder layout

```
soft-ai-backend/
  src/
    index.ts        starts the server (reads settings, graceful shutdown)
    app.ts          routes and the order of checks
    config.ts       settings, checked at startup
    auth/           login token check, membership/role, permission rule
    http/           middleware and error format
    credits/        wallet balance
    db/             database connection
  test/
    unit/           no database needed
    integration/    local database only (refuses any other host)
  db/
    migrations/     SQL files, applied in number order (100, 101, ...)
    tests/          SQL tests, run inside a transaction and rolled back
    local/          local-only helpers (never run on a real database)
  docs/             plain-English design notes for review
```

## Safety rules for this project

1. **Never point this code at the live ERP database.** Use a local or dev database only,
   until Shaheer applies our migrations to production himself.
2. **No secrets in files that are committed.** Keys go in `.env` (ignored by git).
   Never paste keys into chats or tickets.
3. **Work on a branch** (e.g. `soft-ai`), open pull requests, never push to `main`.
4. **Our migrations are numbered 100+** and only create things inside the `soft_ai`
   schema (plus one service role). They never change ERP tables.
5. When added to the ERP repo, add `soft-ai-backend` to `exclude` in the ERP's
   `tsconfig.json`, so the ERP's Vercel build ignores this folder.

## Requirements

- ERP database with ERP migrations **001-056** applied (we need `organizations.parent_organization_id` from 055).
- PostgreSQL 15+ with the `vector` extension (Supabase has it).

## Run the database tests (local only)

1. Start a local Supabase (Docker) with the ERP migrations.
2. Apply `db/migrations/100_*.sql` to `104_*.sql` in order.
3. Run:

   ```
   psql "<LOCAL database url>" -v ON_ERROR_STOP=1 -f db/tests/100_soft_ai_db_test.sql
   ```

4. The last line must be `ALL SOFT AI DB TESTS PASSED`. The test rolls everything back.

## Design docs

- [docs/01-database-design.md](docs/01-database-design.md)
- [docs/02-backend-skeleton.md](docs/02-backend-skeleton.md)
- [docs/03-credit-metering.md](docs/03-credit-metering.md)
- [docs/04-gemini-chat.md](docs/04-gemini-chat.md)
- [docs/05-chat-panel.md](docs/05-chat-panel.md)
- [docs/06-knowledge-rules-cache.md](docs/06-knowledge-rules-cache.md)
- [docs/07-data-tools.md](docs/07-data-tools.md)
- [docs/08-actions.md](docs/08-actions.md)
- [docs/09-credits-billing.md](docs/09-credits-billing.md)
- [docs/10-support-calls.md](docs/10-support-calls.md)
- [docs/HANDOVER.md](docs/HANDOVER.md)
