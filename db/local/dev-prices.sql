-- LOCAL DEVELOPMENT ONLY. Placeholder prices so the AI can run on your PC.
-- Real prices are Shaheer's decision and will be set by an admin in production.
-- Example basis used here: 1 credit = $0.01, Gemini 3.5 Flash-Lite at
-- $0.30 / $2.50 per 1M tokens (input / output, checked Oct 2026):
--   input  $0.0003 per 1k tokens = 0.03 credits per 1k
--   output $0.0025 per 1k tokens = 0.25 credits per 1k
-- (No margin added: these are cost-level test prices, not selling prices.)
INSERT INTO soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k, effective_from,
                                 provider_input_usd_per_1m, provider_output_usd_per_1m)
VALUES ('gemini-3.5-flash-lite', 0.03, 0.25, '2026-01-01', 0.30, 2.50)
ON CONFLICT (model, effective_from) DO UPDATE
  SET provider_input_usd_per_1m = EXCLUDED.provider_input_usd_per_1m,
      provider_output_usd_per_1m = EXCLUDED.provider_output_usd_per_1m;

-- Placeholder credit packs (sizes and prices: Shaheer's decision).
INSERT INTO soft_ai.credit_packs (id, name, credits, price_cents, currency, sort_order) VALUES
  ('pack_1000',  'Starter 1,000 credits',   1000, 1500, 'usd', 1),
  ('pack_5000',  'Business 5,000 credits',  5000, 6500, 'usd', 2),
  ('pack_20000', 'Pro 20,000 credits',     20000, 22000, 'usd', 3)
ON CONFLICT (id) DO NOTHING;

-- Placeholder monthly allowance for the trial plan.
INSERT INTO soft_ai.plan_allowances (plan_slug, monthly_credits) VALUES ('trial', 50)
ON CONFLICT (plan_slug) DO NOTHING;
