# Soft AI - Step 2: Backend skeleton

What the backend does today, how a request is checked, and how to run it.
No AI yet: this step is the safe "front door" that every later feature goes through.

## 1. Technology

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Same as the ERP; type errors caught before running |
| Web framework | Hono | Small, fast, built on web standards; easy to test without a real server |
| Database driver | postgres (postgres.js) | Simple, safe parameter handling (no SQL injection), works with Supabase pooler |
| Login check | jose | Standard library for checking signed tokens (JWT) |
| Validation | zod 3 | Same version as the ERP, so validation code can be shared later |
| Logs | pino | JSON logs, with a safety list that hides tokens and passwords |
| Tests | vitest | Fast; runs unit and database tests |

Versions are pinned exactly in `package.json`, so a new library release can't change
behavior by surprise.

## 2. How every protected request is checked

```
Browser (Soft AI panel in the ERP)
  | Authorization: Bearer <the user's Supabase login token>
  | X-Organization-Id: <organization the user is working in>
  v
1. requestContext  -> gives the request an id (X-Request-Id), starts the log line
2. CORS            -> only the ERP's own website may call from a browser
3. requireUser     -> is the login token real, from this Supabase project, not expired,
                      for a real signed-in user (not anon / service key / guest)?   else 401
4. requireOrganization -> is this user an ACTIVE member of this ACTIVE organization?
                      loads role + permissions fresh from the database            else 403
5. requirePermission("sales.create")  (used by later steps) -> role allows it?      else 403
6. the route itself
```

Important choices:
- **Same rules as the ERP.** Owners can do everything; others need the exact
  `module.action` permission. Copied from the ERP's own server check.
- **Checked on every request**, not cached: removing a user or changing a role works
  immediately (tested).
- **"Organization doesn't exist" looks the same as "not allowed"** (403), so nobody can
  probe which organization ids exist.
- **The agency owner is not automatically inside a sub-account.** Same as the ERP's
  membership model. If Shaheer wants agency owners to manage sub-account chats or
  credits, we add that deliberately later.
- **No cookies, bearer tokens only**, so other websites can't make requests "as" the user.
- **Errors are plain and safe**: `{ error: { code, message, requestId } }`. No SQL,
  no stack traces, never the token.

## 3. Endpoints so far

| Method | Path | Login | Returns |
|---|---|---|---|
| GET | `/health` | no | `{status:"ok"}` - process is up |
| GET | `/ready` | no | `{status:"ready"}` - database reachable |
| GET | `/v1/me` | yes + org | user id, organization, sub-account parent, owner flag, role, permissions |
| GET | `/v1/credits` | yes + org | `balance`, `reserved`, `available` as exact strings ("12.5000") |

## 4. Login token modes

Supabase projects sign login tokens in one of two ways; the backend supports both
(`AUTH_JWT_MODE`):

- `jwks` - new Supabase "signing keys" (ES256/RS256 public keys). **Local Supabase uses
  this**, and it is the likely mode for Shaheer's project - to confirm before going live.
- `secret` - older projects with one shared JWT secret (HS256).

The two modes never mix: a JWKS-mode server rejects HS256 tokens (tested), so nobody can
switch algorithms to sneak in a token.

## 5. Tests (49, all passing on 7 Oct 2026)

- **Unit (23):** settings checks, permission rule, login token rules in both modes
  (expired, forged, other project, anon/service keys, guests, no-signature tokens).
- **Integration (26), against the local database as the restricted role:**
  two organizations + an agency with a sub-account; owners, a sales role, a deactivated
  member, a stranger; CORS; credits balance per organization.
- **Parallel load (part of integration):** 25 requests at once for 10 credits -> exactly
  10 succeed; each settle sent twice -> charged once; a payment event delivered 10 times
  at once -> credited once; 12 parallel agency transfers -> never more than available.
  This closes the open point from step 1.
- **Mutation check:** a deliberately broken permission rule makes 3 tests fail, so the
  tests really catch mistakes.
- **End-to-end:** the real server started, a real login token from local Supabase was
  accepted for the user's own organization (200), refused for another (403), and a
  tampered token was refused (401). The token never appeared in the logs.

## 6. Run it (local)

```powershell
cd D:\Softoras_AI_Assistant\local-dev; npx supabase start          # local database
cd D:\Softoras_AI_Assistant\soft-ai-backend
powershell -ExecutionPolicy Bypass -File db\local\setup-local-db.ps1 -SkipErp   # Soft AI tables + local login
npm test                       # all tests
npm run typecheck              # type check
npm run dev                    # server on http://127.0.0.1:8787 (uses .env, local only)
```

## 7. Not in this step (on purpose)

- Rate limiting per user (step 3, with the AI calls it protects).
- Platform-admin access to organizations (admin panel step).
- Chat, AI, knowledge, actions (steps 3-8).
