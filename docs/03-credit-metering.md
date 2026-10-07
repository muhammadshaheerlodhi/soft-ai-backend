# Soft AI - Step 3: Credit metering and request limits

How every AI call is paid for, and how we stop overuse. Still no real AI: Gemini is
step 4. A "fake" AI is used to test every path.

## 1. Pricing: tokens -> credits

- An admin sets a price per model in `soft_ai.model_rates`:
  credits per 1,000 input tokens and per 1,000 output tokens. A new price row with a later
  date changes the price from that date; old prices stay for history.
- `soft_ai.compute_cost(model, input_tokens, output_tokens)` does the maths in the
  database with exact decimals and rounds **up** to 4 decimals (never undercharge by rounding).
  Example (price 0.5 in / 2 out): 1,234 in + 567 out = 1.7510 credits.
- **No price = no AI.** A model without a price is refused before any AI call
  (`ai_not_configured`), so a missing setting can never give answers away for free.
  **Prices are Shaheer's decision** - production has none until he sets them.

## 2. One paid AI call (`src/credits/metering.ts`)

```
1. price the WORST case   = estimated input tokens + the reply length cap (AI_MAX_OUTPUT_TOKENS)
2. HOLD that many credits  -> not enough? stop: 402 "No credits left", the AI is NOT called
3. call the AI             (timeout AI_TIMEOUT_MS, enforced even if the provider ignores it)
4a. success -> CHARGE the real cost from the provider's token counts, release the rest
4b. failure / timeout -> RELEASE the hold, charge nothing
```

Decisions and their reasons:

| Situation | What happens | Why |
|---|---|---|
| Balance lower than the worst case | Refused before calling | The hard stop must hold even for a long reply. Side effect: the last few credits may need a shorter reply cap to use. |
| Provider reports no token counts | Charge the (high) estimate, flagged `usage_estimated` in the ledger | Gemini normally reports counts; this is a safety net, visible for review. |
| Charging fails (database blip) | Retry 3 times; if still failing, the user keeps the answer and is **not charged**; the hold expires; an error is logged for reconciliation | In doubt, never overcharge the customer. |
| Timeout | Hold released, user not charged, 504 | Note: the AI company may still bill US for that call; it is rare and logged. |
| Free model (price 0) | Holds 0.0001 | The zero-credit stop still applies. |

Input tokens are estimated on the high side (3 bytes per token); Urdu letters use more
bytes, so Urdu is also estimated high. The real counts from the provider are what is charged.

Every charge in the ledger records: provider, model asked, model that answered, input and
output tokens, whether usage was estimated, and the message id.

## 3. Request limits (`src/http/rate-limit.ts`)

Separate from credits: credits protect the customer's wallet, limits protect the system
and the AI bill from floods or loops.

| Limit | Default | Setting |
|---|---|---|
| Per user per minute | 20 | `RATE_USER_PER_MINUTE` |
| Per user per day | 500 | `RATE_USER_PER_DAY` |
| Per organization per minute | 120 | `RATE_ORG_PER_MINUTE` |

- Counted in the database (`soft_ai.hit_rate_limits`), so all copies of the backend on
  Railway share the same counts.
- Over the limit: `429 rate_limited` with a `Retry-After` header (seconds).
- Login and organization are checked **before** counting, so anonymous traffic can't use
  up anyone's limit.
- A request refused by one limit is not counted against the later ones (refused requests
  use nothing).
- Fixed time windows: at a window edge a user can briefly get up to 2x; fine for this
  purpose and much simpler.
- `soft_ai.cleanup_rate_limits()` removes old counters; to be scheduled daily at deploy time.
- The defaults are starting points; we tune them with real usage.

## 4. Error messages the panel will show

| Code | HTTP | Message |
|---|---|---|
| `insufficient_credits` | 402 | No credits left. Please buy credits to continue. |
| `rate_limited` | 429 | Too many requests. Please wait a moment and try again. |
| `ai_timeout` | 504 | Soft AI took too long to answer. You were not charged. |
| `ai_unavailable` | 502 | Soft AI could not answer right now. You were not charged. |
| `ai_not_configured` | 503 | Soft AI is not available right now. Please contact support. |

Internal details (provider errors, SQL) are logged, never shown to users (tested).

## 5. Tests (7 Oct 2026)

- 75 automated tests pass (26 new), run twice in a row; nothing left behind in the database.
- Unit: every path of the metering flow with an in-memory store, including database
  failures during charging, a provider that ignores timeouts, missing usage, free models.
- Integration on the real database as the restricted role: exact charge recorded in the
  ledger, hard stop (AI never called), worst-case rule, failed call leaves the balance
  untouched, unpriced model refused, 15 parallel AI calls on a small balance (only what is
  covered runs, every call that ran was paid, wallet still matches its ledger).
- Limits through the real HTTP chain: user limit, org limit, other users/orgs unaffected,
  anonymous requests rejected before counting, safe error messages.
- SQL tests for pricing and limits added to `db/tests` (all pass).
- Deliberate bug check: removing "release the hold on failure" made 3 tests fail.

## 6. New settings (`.env`)

`AI_TIMEOUT_MS` (60000), `AI_MAX_OUTPUT_TOKENS` (1024), `RATE_USER_PER_MINUTE` (20),
`RATE_USER_PER_DAY` (500), `RATE_ORG_PER_MINUTE` (120).

## 7. Not in this step

- Real AI (Gemini) and streaming replies: step 4. Streaming will charge the tokens actually
  generated, including when the user closes the chat mid-answer.
- Monthly plan allowance, admin limits per organization / sub-account, 80% / 100% warnings,
  Stripe purchase: step 9.
