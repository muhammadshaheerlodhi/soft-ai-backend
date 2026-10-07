-- LOCAL DEVELOPMENT ONLY. Placeholder prices so the AI can run on your PC.
-- Real prices are Shaheer's decision and will be set by an admin in production.
-- Example basis used here: 1 credit = $0.01, Gemini 3.5 Flash-Lite at
-- $0.30 / $2.50 per 1M tokens (input / output, checked Oct 2026):
--   input  $0.0003 per 1k tokens = 0.03 credits per 1k
--   output $0.0025 per 1k tokens = 0.25 credits per 1k
-- (No margin added: these are cost-level test prices, not selling prices.)
INSERT INTO soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k, effective_from)
VALUES ('gemini-3.5-flash-lite', 0.03, 0.25, '2026-01-01')
ON CONFLICT (model, effective_from) DO NOTHING;
