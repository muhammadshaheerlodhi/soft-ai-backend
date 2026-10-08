# Soft AI - Step 9: Buying credits, allowance, limits, admin panel

## 1. What users see (Credits button in the Soft AI panel)

| Tab | Shows |
|---|---|
| Overview | credits available, used this month, monthly credits in the plan, limits, warnings |
| Usage | credits used per chat (my chats) |
| History | bought, monthly credits, sent / received (agency), changed by Softoras - with reasons |
| Buy | credit packs; pays on Stripe's own page (owners/admins or settings.edit only) |
| Sub-accounts | agency owners: balances of sub-accounts, "send credits" |

Warnings: banner at **80%** of this month's credits, of the monthly limit or of the
user's daily limit; at **0** or a reached limit Soft AI pauses with a clear message.

## 2. How the money and credits flow

```
Buy -> backend creates a Stripe Checkout page (pack price from OUR table)
    -> user pays on Stripe
    -> Stripe calls POST /webhooks/stripe (signed)
    -> signature checked (Stripe's library); amount + currency must match our record
    -> credits from OUR record added ONCE (key stripe:<session>) -> Activity entry
```
Coming back to the "success" page adds nothing; only Stripe's signed message does.
Retries, duplicate events and a second event for the same payment add nothing.

## 3. Monthly allowance and limits

- Each ERP plan (`subscription_plans`) can include monthly credits (admin panel).
  Added automatically once per month (first request or Credits screen), logged in
  Activity. Unused credits are kept (rollover) - to confirm with Shaheer.
- Per organization (admin panel): custom monthly credits, a monthly limit, a daily
  limit per user. Checked in the database whenever credits are put on hold, so two
  requests at once cannot pass the limit.

## 4. Admin panel (ERP: /admin/soft-ai)

For the ERP's platform admins (`platform_admins` list, owner e-mail - confirmed
e-mails only). Owner / super admin / billing manager can change; support only views.

- This month: credits used, AI requests, Google cost (USD, from token counts x
  Google's price per model), credits sold (money received).
- Organizations: available, used this month, monthly credits, limits; details with
  history and top users; add/remove credits (reason required); set limits.
- Monthly credits per plan; credit packs (name, credits, price, for sale).
- Every change: ledger / settings history + the organization's Activity feed.

## 5. Security

- Balance changes only through database functions; the browser never writes credits.
- Webhook: Stripe signature + timestamp (forged, tampered, other-secret: refused - tested).
- Only sessions Soft AI created are handled; other Stripe events are ignored.
- Admin API: separate from organization access; ERP organization owners are NOT
  platform admins (tested).
- Transfers only from an agency to its own sub-accounts, by its owner (tested).

## 6. Tests

180 automated tests pass (+14 billing: allowance once, warnings, both limits, admin
roles, adjustments, owner e-mail, summary, checkout permission, webhook paid /
replay / second event / forged / tampered / wrong amount / ignored / expired,
transfers). Database tests pass.

Live (local ERP): Credits window (overview, history), admin page (summary, company,
add 10 credits with reason) -> ledger + Activity page entry. Buying is off locally
(no Stripe keys) and says so.

## 7. Before going live (needs Shaheer)

1. Pack sizes and prices, monthly credits per plan, credit price vs Google cost
   (current local values are placeholders).
2. Which Stripe account receives credit payments (platform account assumed).
3. Stripe: add the webhook endpoint `https://<soft-ai>/webhooks/stripe` for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`; put the keys in Railway.
4. Rollover of unused monthly credits: keep (now) or expire monthly.
5. A real test payment with Stripe test keys (Tauseef's or Shaheer's test account).

## 8. ERP problems found in this step

- `platform_admins` security rule refers to itself ("infinite recursion"): on a
  database built from the migrations only the owner e-mail can open /admin.
- Dashboard counts deleted invoices and drafts in "Total Revenue" and lists
  deleted invoices under "Recent Invoices".
