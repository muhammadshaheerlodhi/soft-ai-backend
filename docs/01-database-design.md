# Soft AI - Step 1: Database design

This explains what the database files in `db/migrations/` do, in plain words, so you
can review them. Nothing here changes the ERP's own tables.

## 1. Where Soft AI's data lives

All Soft AI tables are in their own private schema, `soft_ai`, inside the same Supabase
database as the ERP.

- **The browser cannot reach it.** Supabase only exposes the `public` schema to the
  website (see `supabase/config.toml` -> `schemas = ["public", "graphql_public"]`).
  On top of that, `anon` and `authenticated` (the roles a browser uses) have no access
  to `soft_ai` at all. So even a logged-in user with developer tools cannot read
  another person's chat or change a credit balance.
- **The backend uses its own role, `soft_ai_service`.** It can read Soft AI tables, but
  it has no direct access to ERP tables, and it cannot change credit balances except
  through the safe functions below.

Why not use the existing `credit_balances` table? Its policy lets any member of an
organization edit it, so a normal user could give themselves credits. Our ledger cannot be
changed that way.

## 2. The tables

| Table | What it holds |
|---|---|
| `wallets` | One row per organization: current credit balance, and credits "on hold" |
| `ledger` | Every credit change ever made. Can never be edited or deleted |
| `reservations` | Credits put on hold while an AI request is running |
| `model_rates` | Admin-set price: credits per 1,000 tokens, per model, with date |
| `conversations` | One row per chat (the chat list on the left of the panel) |
| `messages` | Every message, with model, tokens, credits, speed, sources |
| `actions` | Every action Soft AI proposed or ran, its result and undo data |
| `knowledge_releases` | One row per ERP release indexed into the knowledge base |
| `knowledge_chunks` | Small pieces of guides/docs with their embedding (for search) |

**Wallets and sub-accounts (Shaheer's decision, 7 Oct 2026):** every organization, agency
or sub-account, has its own wallet. Credits can come from three places:

| Source | Function | Ledger entry |
|---|---|---|
| The organization buys them | `add_credits(..., 'purchase', ...)` | `purchase` |
| The agency gives them to its sub-account | `transfer_credits(agency, sub, amount, owner, key)` | `transfer_out` (agency) + `transfer_in` (sub) |
| The main Softoras admin dashboard assigns them | `add_credits(..., 'admin_adjust', ..., reason)` | `admin_adjust` |

Transfer rules, checked inside the database: only to the agency's **own** sub-account,
only by the agency **owner**, never more than the agency has available, both entries
written together, and a retried request never transfers twice.

## 3. How credits are charged (one AI request)

1. **Reserve** - `reserve_credits(org, user, estimate)` puts an estimate on hold.
   If the available balance (balance minus holds) is too small, it fails with
   `insufficient_credits`. This is the hard stop.
2. **Call the AI.**
3. **Settle** - `settle_reservation(id, real_cost)` charges the real cost and releases
   the hold. Or **release** - `release_reservation(id)` if the call failed: nothing charged.

Safety built into the database:

- Balance can never be negative (database check).
- The same Stripe event / grant is never counted twice (idempotency key).
- Settling the same request twice charges once.
- If the backend crashes mid-request, the hold expires (default 5 minutes) and the
  credits come back automatically.
- Two requests at the same moment cannot both spend the same credits: the wallet row is
  locked while it changes (always wallet first, so no deadlocks).
- `check_wallet_integrity()` proves balance = sum of ledger for every wallet.
- Admin adjustments require a reason; every change records who did it.

## 4. Chat history

- `conversations` keeps title, pinned, archived, deleted, message count, credits used and
  last activity, so the chat list loads fast (one index for "my chats, newest first").
- A message or action must belong to a chat of the **same organization and same user**.
  The database enforces this (composite foreign keys), so data can't be mixed even if our
  code has a bug.
- Deleting a chat is a soft delete for now. **Open question for Shaheer:** how long to
  keep chats, and whether organization owners can see staff chats.

## 5. Actions (create invoice, approve leave, ...)

The database enforces the safe flow:

- High-risk actions must require confirmation.
- An action that needs confirmation cannot be marked executed without being confirmed.
- After the user sees the preview, the action's details can't be swapped.
- A finished action can't be re-opened; undo only works inside its undo window.
- Unconfirmed actions expire after 30 minutes.

## 6. Knowledge base

- One "active" release at a time. The release pipeline builds a new release in the
  background, then switches it on in one step.
- `match_knowledge()` searches only the active release: platform knowledge plus the
  organization's own (for later, e.g. white-label docs).
- Embedding size is 768. To be re-confirmed against Google's docs in step 6.

## 7. Who-is-this-user check

`member_context(org, user)` returns the user's role, owner flag and `module.action`
permissions for that organization, or nothing if they are not an active member of an
active organization. It copies the ERP's own server check
(`src/lib/security/api-auth.ts`), so Soft AI never allows more than the ERP does.

## 8. Things deliberately NOT done yet

- Chat retention / purge job (waiting for Shaheer).
- Monthly allowance, 80% / 100% warnings, Stripe purchase (step 9).
- Splitting big tables by month (partitioning). Not needed yet; indexes are enough for a
  long time. We will measure before adding complexity.
- Platform-admin impersonation inside Soft AI (decide when we build the admin panel).
