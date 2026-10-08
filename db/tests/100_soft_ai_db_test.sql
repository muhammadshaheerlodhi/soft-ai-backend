-- =====================================================================
-- Soft AI database tests (step 1)
--
-- Run against a LOCAL / DEV database only, after ERP migrations 001-056 and
-- Soft AI migrations 100-103. Everything runs inside one transaction and is
-- ROLLED BACK at the end, so the test leaves no data behind.
--
-- Run (local Supabase in Docker):
--   psql "<local db url>" -v ON_ERROR_STOP=1 -f db/tests/100_soft_ai_db_test.sql
-- Success = the last line printed is "ALL SOFT AI DB TESTS PASSED".
-- Any failure stops the script with an error that names the test.
-- =====================================================================

\set ON_ERROR_STOP on
\o /dev/null
-- (query results are hidden; PASS / FAIL lines are printed as notices)
BEGIN;

-- ---------- helpers (temporary, disappear after the session) ----------

CREATE FUNCTION pg_temp.ok(label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE 'PASS  %', label; END $$;

CREATE FUNCTION pg_temp.eq(actual NUMERIC, expected NUMERIC, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % (expected %, got %)', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- Fails unless the condition is exactly TRUE (NULL or no row also fails).
CREATE FUNCTION pg_temp.check(cond BOOLEAN, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL  % (condition was %)', label, cond;
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- Runs a statement that MUST fail, and checks the error text contains `expected`.
CREATE FUNCTION pg_temp.fails(stmt TEXT, expected TEXT, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    IF position(lower(expected) IN lower(SQLERRM)) = 0 THEN
      RAISE EXCEPTION 'FAIL  % (wrong error: %)', label, SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  % (blocked: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % (statement was NOT blocked)', label;
END $$;

-- ---------- test data ----------

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'soft-ai-test-a@example.test'),
       ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'soft-ai-test-b@example.test');

INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-1111-4000-8000-000000000001', 'Soft AI Test Org A', 'soft-ai-test-org-a'),
       ('bbbbbbbb-1111-4000-8000-000000000002', 'Soft AI Test Org B', 'soft-ai-test-org-b');

\set orgA '''aaaaaaaa-1111-4000-8000-000000000001'''
\set orgB '''bbbbbbbb-1111-4000-8000-000000000002'''
\set userA '''aaaaaaaa-0000-4000-8000-000000000001'''
\set userB '''bbbbbbbb-0000-4000-8000-000000000002'''

-- ======================= CREDITS =======================

-- 1. Buying credits adds them once.
SELECT soft_ai.add_credits(:orgA, 100, 'purchase', 'stripe_evt_1', :userA, NULL, '{"pack":"100"}');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 100,
                  'credits: purchase adds 100');

-- 2. The same Stripe event arriving twice does not add twice.
SELECT pg_temp.eq(
  (SELECT soft_ai.add_credits(:orgA, 100, 'purchase', 'stripe_evt_1', :userA)),
  (SELECT id FROM soft_ai.ledger WHERE organization_id = :orgA AND idempotency_key = 'stripe_evt_1'),
  'credits: repeated payment event returns the first entry');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 100,
                  'credits: repeated payment event adds nothing');

-- 3. Reserve 30; asking for 80 more must fail (only 70 available).
SELECT soft_ai.reserve_credits(:orgA, :userA, 30) AS res1 \gset
SELECT pg_temp.eq((SELECT reserved FROM soft_ai.wallets WHERE organization_id = :orgA), 30,
                  'credits: 30 put on hold');
SELECT pg_temp.fails(format('SELECT soft_ai.reserve_credits(%L, %L, 80)', :orgA, :userA),
                     'insufficient_credits', 'credits: cannot hold more than available');

-- 4. Settle the hold at the real cost (12): balance 88, nothing on hold.
SELECT soft_ai.settle_reservation(:'res1', 12, '{"model":"test","input_tokens":1000}');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 88,
                  'credits: real cost 12 charged');
SELECT pg_temp.eq((SELECT reserved FROM soft_ai.wallets WHERE organization_id = :orgA), 0,
                  'credits: hold released after settle');

-- 5. Settling twice (a retry) does not charge twice; releasing after settle does nothing.
SELECT soft_ai.settle_reservation(:'res1', 12);
SELECT soft_ai.release_reservation(:'res1');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 88,
                  'credits: settle retry charges once');
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.ledger WHERE reservation_id = :'res1'), 1,
                  'credits: one usage entry per request');

-- 6. A failed AI call: hold then release, nothing charged.
SELECT soft_ai.reserve_credits(:orgA, :userA, 10) AS res2 \gset
SELECT soft_ai.release_reservation(:'res2');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 88,
                  'credits: failed call charges nothing');
SELECT pg_temp.eq((SELECT reserved FROM soft_ai.wallets WHERE organization_id = :orgA), 0,
                  'credits: failed call releases hold');

-- 7. A hold that times out (backend crashed) is given back automatically.
SELECT soft_ai.reserve_credits(:orgA, :userA, 40) AS res3 \gset
UPDATE soft_ai.reservations SET expires_at = now() - interval '1 minute' WHERE id = :'res3';
SELECT soft_ai.reserve_credits(:orgA, :userA, 1) AS res4 \gset
SELECT pg_temp.eq((SELECT reserved FROM soft_ai.wallets WHERE organization_id = :orgA), 1,
                  'credits: timed-out hold returned');
SELECT soft_ai.release_reservation(:'res4');

-- 8. Real cost higher than the balance: balance stops at 0, shortfall recorded.
SELECT soft_ai.reserve_credits(:orgA, :userA, 50) AS res5 \gset
SELECT soft_ai.settle_reservation(:'res5', 500);
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgA), 0,
                  'credits: balance never below zero');
SELECT pg_temp.eq((SELECT (reference->>'shortfall')::numeric FROM soft_ai.ledger WHERE reservation_id = :'res5'),
                  412, 'credits: shortfall recorded');

-- 9. Hard stop at zero.
SELECT pg_temp.fails(format('SELECT soft_ai.reserve_credits(%L, %L, 1)', :orgA, :userA),
                     'insufficient_credits', 'credits: hard stop at zero');

-- 10. Admin adjustments need a reason and cannot go below zero.
SELECT pg_temp.fails(format('SELECT soft_ai.add_credits(%L, 20, %L, %L, %L)', :orgA, 'admin_adjust', 'adm_1', :userA),
                     'reason is required', 'credits: admin adjust needs a reason');
SELECT soft_ai.add_credits(:orgA, 20, 'admin_adjust', 'adm_2', :userA, 'goodwill credit');
SELECT pg_temp.fails(format('SELECT soft_ai.add_credits(%L, -50, %L, %L, %L, %L)', :orgA, 'admin_adjust', 'adm_3', :userA, 'correction'),
                     'insufficient_credits', 'credits: admin cannot make balance negative');
SELECT pg_temp.fails(format('SELECT soft_ai.add_credits(%L, -5, %L, %L)', :orgA, 'purchase', 'p_neg'),
                     'only admin_adjust', 'credits: purchase cannot be negative');

-- 11. Organizations are separate: org B is untouched.
SELECT pg_temp.eq(COALESCE((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgB), 0), 0,
                  'credits: other organization unaffected');

-- 12. The ledger cannot be edited or deleted.
SELECT pg_temp.fails(format('UPDATE soft_ai.ledger SET amount = 1000 WHERE organization_id = %L', :orgA),
                     'append-only', 'ledger: update blocked');
SELECT pg_temp.fails(format('DELETE FROM soft_ai.ledger WHERE organization_id = %L', :orgA),
                     'append-only', 'ledger: delete blocked');

-- 13. Wallet balance always equals the sum of the ledger.
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.check_wallet_integrity()), 0,
                  'ledger: wallet balance equals ledger sum');

-- ======================= ACCESS =======================

-- 14. Browsers (anon / authenticated) cannot see the soft_ai schema at all.
SET LOCAL ROLE authenticated;
SELECT pg_temp.fails('SELECT * FROM soft_ai.wallets', 'permission denied', 'access: logged-in user cannot read wallets');
SELECT pg_temp.fails(format('SELECT soft_ai.add_credits(%L, 1000, %L, %L)', 'aaaaaaaa-1111-4000-8000-000000000001', 'purchase', 'hack_1'),
                     'permission denied', 'access: logged-in user cannot add credits');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.fails('SELECT * FROM soft_ai.messages', 'permission denied', 'access: anonymous cannot read chats');
RESET ROLE;

-- 15. The backend role can read balances and call the functions, but cannot
--     edit balances or the ledger directly.
GRANT soft_ai_service TO CURRENT_USER;   -- test only; rolled back at the end
SET LOCAL ROLE soft_ai_service;
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.wallets WHERE organization_id = 'aaaaaaaa-1111-4000-8000-000000000001'), 1,
                  'access: backend can read wallets');
SELECT pg_temp.fails(format('UPDATE soft_ai.wallets SET balance = 999999 WHERE organization_id = %L', 'aaaaaaaa-1111-4000-8000-000000000001'),
                     'permission denied', 'access: backend cannot set a balance directly');
SELECT pg_temp.fails(format('INSERT INTO soft_ai.ledger (organization_id, entry_type, amount, balance_after) VALUES (%L, %L, 5, 5)',
                            'aaaaaaaa-1111-4000-8000-000000000001', 'purchase'),
                     'permission denied', 'access: backend cannot write the ledger directly');
SELECT pg_temp.fails('SELECT * FROM public.invoices LIMIT 1', 'permission denied', 'access: backend has no direct ERP table access');
SELECT soft_ai.add_credits('aaaaaaaa-1111-4000-8000-000000000001', 5, 'trial', 'trial_a');
SELECT pg_temp.ok('access: backend can add credits through the function');
RESET ROLE;

-- 16. member_context: members get a row with their permissions, others get none.
INSERT INTO public.roles (id, organization_id, name, slug)
VALUES ('aaaaaaaa-2222-4000-8000-000000000001', :orgA, 'Sales test', 'soft-ai-sales-test');
INSERT INTO public.permissions (module, action) VALUES ('soft_ai_test', 'view')
ON CONFLICT (module, action) DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT 'aaaaaaaa-2222-4000-8000-000000000001', id FROM public.permissions
 WHERE module = 'soft_ai_test' AND action = 'view';
INSERT INTO public.organization_members (organization_id, user_id, role_id, is_active)
VALUES (:orgA, :userA, 'aaaaaaaa-2222-4000-8000-000000000001', true);

SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.member_context(:orgA, :userA)), 1,
                  'roles: member found');
SELECT pg_temp.check((SELECT 'soft_ai_test.view' = ANY(permissions) AND NOT is_owner
                        FROM soft_ai.member_context(:orgA, :userA)), 'roles: permissions loaded');
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.member_context(:orgA, :userB)), 0,
                  'roles: non-member gets nothing');
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.member_context(:orgB, :userA)), 0,
                  'roles: member of A is not a member of B');
UPDATE public.organization_members SET is_active = false WHERE organization_id = :orgA AND user_id = :userA;
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.member_context(:orgA, :userA)), 0,
                  'roles: deactivated member gets nothing');
UPDATE public.organization_members SET is_active = true WHERE organization_id = :orgA AND user_id = :userA;

-- 16b. Same rules as the ERP's api-auth.ts (migration 108):
--      a permission_matrix on the role wins over role_permissions; "*" = whole module;
--      role slug "admin" = full access.
UPDATE public.roles SET permission_matrix = '{"sales": ["view", "create"], "crm": ["*"], "hr": []}'
 WHERE id = 'aaaaaaaa-2222-4000-8000-000000000001';
SELECT pg_temp.check((SELECT permissions = ARRAY['crm.*', 'sales.create', 'sales.view'] AND NOT is_owner
                        FROM soft_ai.member_context(:orgA, :userA)), 'roles: permission matrix used (role_permissions ignored)');
SELECT pg_temp.check(soft_ai.permission_allows(ARRAY['crm.*'], ARRAY['crm.delete']), 'roles: "crm.*" allows crm.delete');
SELECT pg_temp.check(NOT soft_ai.permission_allows(ARRAY['crm.*', 'sales.view'], ARRAY['hr.view', 'sales.create']),
                     'roles: matrix does not allow other modules or actions');
UPDATE public.roles SET permission_matrix = '{}' WHERE id = 'aaaaaaaa-2222-4000-8000-000000000001';
SELECT pg_temp.check((SELECT permissions = ARRAY['soft_ai_test.view'] FROM soft_ai.member_context(:orgA, :userA)),
                     'roles: empty matrix falls back to role_permissions');
UPDATE public.roles SET slug = 'admin' WHERE id = 'aaaaaaaa-2222-4000-8000-000000000001';
SELECT pg_temp.check((SELECT is_owner FROM soft_ai.member_context(:orgA, :userA)), 'roles: "admin" role has full access');
UPDATE public.roles SET slug = 'soft-ai-sales-test', permission_matrix = NULL WHERE id = 'aaaaaaaa-2222-4000-8000-000000000001';

-- ======================= CHAT HISTORY =======================

-- 17. A chat and its messages; the chat list fields update automatically.
INSERT INTO soft_ai.conversations (id, organization_id, user_id, title)
VALUES ('aaaaaaaa-3333-4000-8000-000000000001', :orgA, :userA, 'Unpaid invoices');
INSERT INTO soft_ai.messages (conversation_id, organization_id, user_id, role, content)
VALUES ('aaaaaaaa-3333-4000-8000-000000000001', :orgA, :userA, 'user', 'Show unpaid invoices');
INSERT INTO soft_ai.messages (conversation_id, organization_id, user_id, role, content,
                              model, answered_by, input_tokens, output_tokens, credits_charged)
VALUES ('aaaaaaaa-3333-4000-8000-000000000001', :orgA, :userA, 'assistant', 'You have 3 unpaid invoices.',
        'gemini-test', 'model', 1200, 80, 1.5);
SELECT pg_temp.eq((SELECT message_count FROM soft_ai.conversations WHERE id = 'aaaaaaaa-3333-4000-8000-000000000001'), 2,
                  'chat: message count updated');
SELECT pg_temp.eq((SELECT credits_used FROM soft_ai.conversations WHERE id = 'aaaaaaaa-3333-4000-8000-000000000001'), 1.5,
                  'chat: credits used updated');

-- 18. A message cannot be attached to another organization's or user's chat.
SELECT pg_temp.fails(format(
  'INSERT INTO soft_ai.messages (conversation_id, organization_id, user_id, role, content) VALUES (%L, %L, %L, %L, %L)',
  'aaaaaaaa-3333-4000-8000-000000000001', 'bbbbbbbb-1111-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'x'),
  'foreign key', 'chat: cannot mix organizations');
SELECT pg_temp.fails(format(
  'INSERT INTO soft_ai.messages (conversation_id, organization_id, user_id, role, content) VALUES (%L, %L, %L, %L, %L)',
  'aaaaaaaa-3333-4000-8000-000000000001', 'aaaaaaaa-1111-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'user', 'x'),
  'foreign key', 'chat: cannot write into another user''s chat');

-- ======================= ACTIONS =======================

-- 19. High-risk actions must require confirmation.
SELECT pg_temp.fails(format(
  'INSERT INTO soft_ai.actions (conversation_id, organization_id, user_id, action_name, risk_level, confirmation_required) VALUES (%L, %L, %L, %L, %L, false)',
  'aaaaaaaa-3333-4000-8000-000000000001', 'aaaaaaaa-1111-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'run_payroll', 'high'),
  'check constraint', 'actions: high risk always needs confirmation');

-- 20. An action that needs confirmation cannot be executed without it.
INSERT INTO soft_ai.actions (id, conversation_id, organization_id, user_id, action_name, params, risk_level, confirmation_required)
VALUES ('aaaaaaaa-4444-4000-8000-000000000001', 'aaaaaaaa-3333-4000-8000-000000000001', :orgA, :userA,
        'create_invoice', '{"customer":"Ali Traders","total":5850}', 'medium', true);
SELECT pg_temp.fails($$UPDATE soft_ai.actions SET status = 'executed' WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001'$$,
                     'invalid action status change', 'actions: cannot run before confirmation');

-- 21. Details cannot be changed after the user saw the preview.
SELECT pg_temp.fails($$UPDATE soft_ai.actions SET params = '{"customer":"Ali Traders","total":99999}' WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001'$$,
                     'cannot be changed', 'actions: preview cannot be swapped');

-- 22. Normal path: confirm, execute, undo (within the undo window).
UPDATE soft_ai.actions SET status = 'confirmed' WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001';
UPDATE soft_ai.actions SET status = 'executed', result = '{"invoice_id":"x"}', undo_until = now() + interval '10 minutes'
 WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001';
UPDATE soft_ai.actions SET status = 'undone' WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001';
SELECT pg_temp.check((SELECT status = 'undone' AND confirmed_at IS NOT NULL AND executed_at IS NOT NULL AND undone_at IS NOT NULL
                        FROM soft_ai.actions WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001'),
                      'actions: confirm -> execute -> undo works');

-- 23. A finished action cannot be re-opened.
SELECT pg_temp.fails($$UPDATE soft_ai.actions SET status = 'executed' WHERE id = 'aaaaaaaa-4444-4000-8000-000000000001'$$,
                     'invalid action status change', 'actions: undone action cannot run again');

-- ======================= KNOWLEDGE =======================

-- 24. Only one active release at a time.
-- (A real release may already be active on this database; set it aside inside this
--  test transaction - everything is rolled back at the end.)
UPDATE soft_ai.knowledge_releases SET status = 'retired' WHERE status = 'active';
INSERT INTO soft_ai.knowledge_releases (version, status) VALUES ('test-r1', 'active');
SELECT pg_temp.fails($$INSERT INTO soft_ai.knowledge_releases (version, status) VALUES ('test-r2', 'active')$$,
                     'duplicate key', 'knowledge: only one active release');

-- 25. Search returns the closest chunk of the active release.
INSERT INTO soft_ai.knowledge_chunks (release_version, source_type, source_ref, title, content, content_hash, url_path, embedding)
SELECT 'test-r1', 'module_guide', '/sales/invoices', 'Invoices', 'How to create an invoice', 'h1', '/sales/invoices',
       ('[' || array_to_string(array_fill(0.0::float8, ARRAY[767]), ',') || ',1]')::extensions.vector;
INSERT INTO soft_ai.knowledge_chunks (release_version, source_type, source_ref, title, content, content_hash, url_path, embedding)
SELECT 'test-r1', 'module_guide', '/hr/leave', 'Leave', 'How to approve leave', 'h2', '/hr/leave',
       ('[1,' || array_to_string(array_fill(0.0::float8, ARRAY[767]), ',') || ']')::extensions.vector;
SELECT pg_temp.check((SELECT title FROM soft_ai.match_knowledge(
          ('[' || array_to_string(array_fill(0.0::float8, ARRAY[767]), ',') || ',0.9]')::extensions.vector,
          :orgA, 1)) = 'Invoices', 'knowledge: nearest chunk found');

-- ======================= AGENCY -> SUB-ACCOUNT TRANSFERS =======================

-- Test data: org A is the agency (user A is its owner), org C is A's sub-account,
-- org B is NOT related to A.
INSERT INTO public.organizations (id, name, slug, parent_organization_id)
VALUES ('cccccccc-1111-4000-8000-000000000003', 'Soft AI Test Sub C', 'soft-ai-test-sub-c', :orgA);
\set orgC '''cccccccc-1111-4000-8000-000000000003'''
UPDATE public.organization_members SET is_owner = true WHERE organization_id = :orgA AND user_id = :userA;
INSERT INTO public.organization_members (organization_id, user_id, is_active, is_owner)
VALUES (:orgB, :userB, true, true);
SELECT soft_ai.add_credits(:orgA, 50, 'admin_adjust', 'platform_grant_1', NULL, 'platform grant to agency');
SELECT soft_ai.add_credits(:orgB, 50, 'purchase', 'b_buy_1', :userB);

-- 27. Agency owner gives 20 credits to its sub-account.
SELECT soft_ai.transfer_credits(:orgA, :orgC, 20, :userA, 'tr_1', 'monthly share');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgC), 20,
                  'transfer: sub-account received 20');
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.ledger WHERE idempotency_key = 'tr_1'), 2,
                  'transfer: both ledger entries written');

-- 28. A retried transfer does not move credits twice.
SELECT soft_ai.transfer_credits(:orgA, :orgC, 20, :userA, 'tr_1', 'monthly share');
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgC), 20,
                  'transfer: retry moves nothing');

-- 29. Cannot send to an organization that is not your sub-account.
SELECT pg_temp.fails(format('SELECT soft_ai.transfer_credits(%L, %L, 5, %L, %L)', :orgA, :orgB, :userA, 'tr_2'),
                     'not_a_sub_account', 'transfer: only to own sub-account');

-- 30. A non-owner cannot transfer from the agency.
SELECT pg_temp.fails(format('SELECT soft_ai.transfer_credits(%L, %L, 5, %L, %L)', :orgA, :orgC, :userB, 'tr_3'),
                     'not_allowed', 'transfer: only the agency owner');

-- 31. Cannot give more than the agency has available.
SELECT pg_temp.fails(format('SELECT soft_ai.transfer_credits(%L, %L, 100000, %L, %L)', :orgA, :orgC, :userA, 'tr_4'),
                     'insufficient_credits', 'transfer: not more than available');

-- 32. A sub-account can also buy its own credits.
SELECT soft_ai.add_credits(:orgC, 30, 'purchase', 'c_buy_1', NULL);
SELECT pg_temp.eq((SELECT balance FROM soft_ai.wallets WHERE organization_id = :orgC), 50,
                  'transfer: sub-account can also buy credits');

SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.check_wallet_integrity()), 0,
                  'transfer: all wallets still equal their ledgers');

-- ======================= PRICING AND LIMITS (migration 105) =======================

INSERT INTO soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k)
VALUES ('sql-test-model', 0.5, 2);

-- 33. Exact price, rounded UP to 4 decimals; unknown models refuse to run.
SELECT pg_temp.eq(soft_ai.compute_cost('sql-test-model', 1234, 567), 1.7510, 'pricing: exact cost');
SELECT pg_temp.check(soft_ai.compute_cost('sql-test-model', 0, 0)::text = '0.0000', 'pricing: 4 decimals returned');
SELECT pg_temp.fails($$SELECT soft_ai.compute_cost('no-such-model', 1, 1)$$, 'no_rate_for_model', 'pricing: model without price refused');

-- 34. A newer price applies from its date; history keeps the old one.
INSERT INTO soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k, effective_from)
VALUES ('sql-test-model', 1, 4, now() + interval '1 day');
SELECT pg_temp.eq(soft_ai.compute_cost('sql-test-model', 1000, 0), 0.5, 'pricing: current price used today');
SELECT pg_temp.eq(soft_ai.compute_cost('sql-test-model', 1000, 0, now() + interval '2 days'), 1, 'pricing: new price from its date');

-- 35. Request limits: 2 allowed, the 3rd refused with a wait time.
SELECT pg_temp.check((SELECT allowed FROM soft_ai.hit_rate_limits(ARRAY['sqltest'], ARRAY[3600], ARRAY[2])), 'limits: 1st allowed');
SELECT pg_temp.check((SELECT allowed FROM soft_ai.hit_rate_limits(ARRAY['sqltest'], ARRAY[3600], ARRAY[2])), 'limits: 2nd allowed');
SELECT pg_temp.check((SELECT NOT allowed AND retry_after_seconds > 0
                        FROM soft_ai.hit_rate_limits(ARRAY['sqltest'], ARRAY[3600], ARRAY[2])), 'limits: 3rd refused');

-- 36. Browsers cannot reach pricing or limits; the backend uses functions only.
SET LOCAL ROLE authenticated;
SELECT pg_temp.fails($$SELECT soft_ai.compute_cost('sql-test-model', 1, 1)$$, 'permission denied', 'access: browser cannot use pricing');
RESET ROLE;
SET LOCAL ROLE soft_ai_service;
SELECT pg_temp.fails('SELECT * FROM soft_ai.rate_limit_counters', 'permission denied', 'access: backend cannot edit limit counters directly');
RESET ROLE;

-- ======================= ERP COMPATIBILITY =======================

-- 26. The ERP's own "delete organization" must still work after the
--     organization has used Soft AI (ledger rows go with it).
SELECT soft_ai.add_credits(:orgB, 10, 'trial', 'trial_b');
SELECT soft_ai.reserve_credits(:orgB, NULL, 3) AS resb \gset
SELECT soft_ai.settle_reservation(:'resb', 2);
DELETE FROM public.organizations WHERE id = :orgB;
SELECT pg_temp.eq((SELECT count(*) FROM soft_ai.ledger WHERE organization_id = :orgB), 0,
                  'erp: deleting an organization also removes its Soft AI data');

-- ======================= DONE =======================

DO $$ BEGIN RAISE NOTICE 'ALL SOFT AI DB TESTS PASSED'; END $$;
ROLLBACK;
