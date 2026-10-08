import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { registerCreditRoutes } from "../../src/credits/routes.js";
import { registerStripeWebhook } from "../../src/credits/webhook.js";
import { createStripeGateway, type PaymentGateway } from "../../src/credits/payments.js";
import { createAdminRoutes } from "../../src/admin/routes.js";
import { createSqlCreditStore } from "../../src/credits/store.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Step 9: buying credits (Stripe), monthly allowance, limits, warnings,
 * sub-account transfers and the platform admin API.
 * The Stripe webhook signature check is Stripe's real code with a test secret.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
const log = pino({ level: "silent" });
const WEBHOOK_SECRET = "whsec_test_soft_ai_only";
const PACK = `test_pack_${randomUUID().slice(0, 8)}`;
const PLAN = `test_plan_${randomUUID().slice(0, 8)}`;
const stripeForTests = new Stripe("sk_test_unused");
const checkouts: string[] = [];

/** Real webhook verification; checkout pages are faked (no Stripe account needed). */
const gateway: PaymentGateway = {
  ...createStripeGateway({ webhookSecret: WEBHOOK_SECRET }),
  async createCheckout() {
    const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
    checkouts.push(id);
    return { id, url: `https://checkout.stripe.test/${id}` };
  },
};

const verifyToken = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret });
const app = () =>
  createApp({
    sql: service,
    logger: log,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken,
    extendRoot: (root) => {
      registerStripeWebhook(root, { sql: service, payments: gateway });
      root.route("/admin/v1", createAdminRoutes({ sql: service, verifyToken, ownerEmail: "boss@soft-ai-test.local" }));
    },
    extendV1: (v1) => registerCreditRoutes(v1, { sql: service, payments: gateway, appUrl: "http://localhost:3000" }),
  });

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  await admin`insert into soft_ai.credit_packs (id, name, credits, price_cents, currency) values (${PACK}, 'Test pack', 1000, 1500, 'usd')`;
});

afterAll(async () => {
  if (f) {
    await admin`delete from public.platform_admins where user_id in ${admin([f.ownerB, f.salesA, f.stranger])}`;
    await admin`delete from public.organization_subscriptions where organization_id = ${f.orgA}`;
    await removeFixtures(admin, f);
  }
  await admin`delete from soft_ai.credit_packs where id = ${PACK}`;
  await admin`delete from soft_ai.plan_allowances where plan_slug = ${PLAN}`;
  await service?.end();
  await admin?.end();
});

async function call(method: string, path: string, user: string | null, org: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (user) headers.Authorization = `Bearer ${await signTestToken(user)}`;
  if (org) headers["X-Organization-Id"] = org;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app().request(path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const balance = async (org: string) =>
  Number((await admin<{ b: string }[]>`select coalesce((select balance from soft_ai.wallets where organization_id = ${org}), 0)::text as b`)[0]!.b);

/** Spend credits the way a real AI request does (hold, then charge). */
async function spend(org: string, user: string, amount: string) {
  const store = createSqlCreditStore(service);
  const res = await store.reserve(org, user, amount, 60);
  await store.settle(res, amount, { test: true });
}

function stripeEvent(type: string, session: Record<string, unknown>, id = `evt_${randomUUID()}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object: { object: "checkout.session", ...session } } });
  const signature = stripeForTests.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, signature, id };
}

describe("credits status, allowance and warnings", () => {
  it("an organization with nothing shows 0 and the 'empty' warning", async () => {
    const r = await call("GET", "/v1/credits", f.ownerB, f.orgB);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ balance: "0.0000", available: "0.0000", monthUsed: "0.0000", warnings: ["empty"] });
  });

  it("the plan's monthly allowance is added once per month, and logged in Activity", async () => {
    await admin`insert into soft_ai.plan_allowances (plan_slug, monthly_credits) values (${PLAN}, 200)`;
    await admin`insert into public.organization_subscriptions (organization_id, plan_slug, status) values (${f.orgA}, ${PLAN}, 'active')`;
    const first = await call("GET", "/v1/credits", f.ownerA, f.orgA);
    expect(first.body).toMatchObject({ balance: "200.0000", monthlyAllowance: "200.0000" });
    await call("GET", "/v1/credits", f.salesA, f.orgA); // another user, same month
    expect(await balance(f.orgA)).toBe(200);
    const acts = await admin`select description from public.activity_events where organization_id = ${f.orgA} and event_type = 'credits.allowance'`;
    expect(acts).toHaveLength(1);
  });

  it("warns at 80% of this month's credits used", async () => {
    await spend(f.orgA, f.ownerA, "165"); // 165 of 200 used
    const r = await call("GET", "/v1/credits", f.ownerA, f.orgA);
    expect(r.body).toMatchObject({ monthUsed: "165.0000", available: "35.0000" });
    expect(r.body.warnings).toEqual(["used_80"]);
  });
});

describe("limits set by a platform admin", () => {
  it("only platform admins can use the admin API; 'support' can only look", async () => {
    expect((await call("GET", "/admin/v1/me", f.ownerA, null)).status).toBe(403); // org owner is NOT a platform admin
    await admin`insert into public.platform_admins (user_id, email, role) values (${f.salesA}, ${`${f.salesA}@soft-ai-test.local`}, 'support')`;
    expect((await call("GET", "/admin/v1/me", f.salesA, null)).body).toEqual({ role: "support", canChange: false });
    expect((await call("GET", "/admin/v1/organizations?search=Test%20Agency", f.salesA, null)).status).toBe(200);
    const denied = await call("POST", `/admin/v1/organizations/${f.orgA}/adjust`, f.salesA, null, { amount: "10", reason: "test", requestId: randomUUID() });
    expect(denied.status).toBe(403);
  });

  it("monthly cap and daily cap per user stop AI requests", async () => {
    await admin`insert into public.platform_admins (user_id, email, role) values (${f.ownerB}, ${`${f.ownerB}@soft-ai-test.local`}, 'billing_manager')`;
    const set = await call("PUT", `/admin/v1/organizations/${f.orgA}/settings`, f.ownerB, null, {
      monthlyAllowance: null, monthlyLimit: "170", userDailyLimit: null, note: "test cap",
    });
    expect(set.status).toBe(200);
    const store = createSqlCreditStore(service);
    await expect(store.reserve(f.orgA, f.ownerA, "10", 60)).rejects.toMatchObject({ name: "CreditLimitError", limit: "monthly" });
    expect((await call("GET", "/v1/credits", f.ownerA, f.orgA)).body.warnings).toContain("limit_80");

    await call("PUT", `/admin/v1/organizations/${f.orgA}/settings`, f.ownerB, null, { monthlyAllowance: null, monthlyLimit: null, userDailyLimit: "5" });
    await expect(store.reserve(f.orgA, f.ownerA, "6", 60)).rejects.toMatchObject({ limit: "user_daily" }); // ownerA spent 165 today
    await expect(store.reserve(f.orgA, f.salesA, "4", 60)).resolves.toBeTruthy(); // another user is fine
    await call("PUT", `/admin/v1/organizations/${f.orgA}/settings`, f.ownerB, null, { monthlyAllowance: null, monthlyLimit: null, userDailyLimit: null });
  });

  it("admin adds / removes credits with a reason; logged in the ledger and Activity; never below zero", async () => {
    const before = await balance(f.orgB);
    const requestId = randomUUID();
    const add = await call("POST", `/admin/v1/organizations/${f.orgB}/adjust`, f.ownerB, null, { amount: "50", reason: "goodwill", requestId });
    expect(add.status).toBe(200);
    await call("POST", `/admin/v1/organizations/${f.orgB}/adjust`, f.ownerB, null, { amount: "50", reason: "goodwill", requestId }); // retry
    expect(await balance(f.orgB)).toBe(before + 50);
    const tooMuch = await call("POST", `/admin/v1/organizations/${f.orgB}/adjust`, f.ownerB, null, { amount: "-9999", reason: "oops", requestId: randomUUID() });
    expect(tooMuch.status).toBe(400);
    const noReason = await call("POST", `/admin/v1/organizations/${f.orgB}/adjust`, f.ownerB, null, { amount: "5", reason: "", requestId: randomUUID() });
    expect(noReason.status).toBe(400);
    const acts = await admin`select description from public.activity_events where organization_id = ${f.orgB} and event_type = 'credits.admin_adjust'`;
    expect(acts).toHaveLength(1);
    expect(acts[0]!.description).toContain("goodwill");
  });

  it("the platform owner e-mail from settings counts only for a confirmed e-mail", async () => {
    const boss = randomUUID();
    await admin`insert into auth.users (id, instance_id, aud, role, email) values (${boss}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'boss@soft-ai-test.local')`;
    try {
      expect((await call("GET", "/admin/v1/me", boss, null)).status).toBe(403); // e-mail not confirmed yet
      await admin`update auth.users set email_confirmed_at = now() where id = ${boss}`;
      expect((await call("GET", "/admin/v1/me", boss, null)).body).toMatchObject({ role: "owner" });
    } finally {
      await admin`delete from auth.users where id = ${boss}`;
    }
  });

  it("summary: credits used, requests and top organizations", async () => {
    const r = await call("GET", "/admin/v1/summary", f.ownerB, null);
    expect(r.status).toBe(200);
    expect(Number(r.body.credits_used)).toBeGreaterThanOrEqual(165);
    expect(r.body.top_organizations.some((o: { id: string }) => o.id === f.orgA)).toBe(true);
  });
});

describe("buying credits with Stripe", () => {
  it("only owners/admins (or settings.edit) may start a payment", async () => {
    expect((await call("POST", "/v1/credits/checkout", f.salesA, f.orgA, { packId: PACK })).status).toBe(403);
    const packs = await call("GET", "/v1/credits/packs", f.salesA, f.orgA);
    expect(packs.body).toMatchObject({ canBuy: false, paymentsEnabled: true });
  });

  it("checkout -> Stripe's signed webhook adds the pack's credits exactly once", async () => {
    const start = await call("POST", "/v1/credits/checkout", f.ownerB, f.orgB, { packId: PACK });
    expect(start.status).toBe(200);
    expect(start.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const sessionId = checkouts.at(-1)!;
    const before = await balance(f.orgB);

    // Coming back to the success page adds nothing; only the webhook does.
    const paid = { id: sessionId, payment_status: "paid", amount_total: 1500, currency: "usd", payment_intent: "pi_1", metadata: { soft_ai: "credits" } };
    const ev = stripeEvent("checkout.session.completed", paid);
    const r = await call("POST", "/webhooks/stripe", null, null, ev.payload, { "stripe-signature": ev.signature, "Content-Type": "application/json" });
    expect(r.body).toMatchObject({ result: "paid" });
    expect(await balance(f.orgB)).toBe(before + 1000);

    // Stripe retries the same event, or sends another event for the same session: no double credits.
    await call("POST", "/webhooks/stripe", null, null, ev.payload, { "stripe-signature": ev.signature });
    const ev2 = stripeEvent("checkout.session.async_payment_succeeded", paid);
    const again = await call("POST", "/webhooks/stripe", null, null, ev2.payload, { "stripe-signature": ev2.signature });
    expect(again.body).toMatchObject({ result: "already_paid" });
    expect(await balance(f.orgB)).toBe(before + 1000);

    const [p] = await admin`select status, ledger_id from soft_ai.credit_purchases where stripe_session_id = ${sessionId}`;
    expect(p).toMatchObject({ status: "paid" });
    const acts = await admin`select 1 from public.activity_events where organization_id = ${f.orgB} and event_type = 'credits.purchase'`;
    expect(acts).toHaveLength(1);
  });

  it("forged, unsigned or tampered webhooks are refused", async () => {
    const ev = stripeEvent("checkout.session.completed", { id: "cs_fake", payment_status: "paid", amount_total: 1500, currency: "usd", metadata: { soft_ai: "credits" } });
    expect((await call("POST", "/webhooks/stripe", null, null, ev.payload, {})).status).toBe(400);
    const wrong = new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload: ev.payload, secret: "whsec_someone_else" });
    expect((await call("POST", "/webhooks/stripe", null, null, ev.payload, { "stripe-signature": wrong })).status).toBe(400);
    const tampered = ev.payload.replace('"amount_total":1500', '"amount_total":1');
    expect((await call("POST", "/webhooks/stripe", null, null, tampered, { "stripe-signature": ev.signature })).status).toBe(400);
  });

  it("a payment with the wrong amount adds nothing; other Stripe events are ignored; unpaid checkouts expire", async () => {
    await call("POST", "/v1/credits/checkout", f.ownerB, f.orgB, { packId: PACK });
    const sessionId = checkouts.at(-1)!;
    const before = await balance(f.orgB);
    const ev = stripeEvent("checkout.session.completed", { id: sessionId, payment_status: "paid", amount_total: 100, currency: "usd", metadata: { soft_ai: "credits" } });
    const r = await call("POST", "/webhooks/stripe", null, null, ev.payload, { "stripe-signature": ev.signature });
    expect(r.body).toMatchObject({ result: "amount_mismatch" });
    expect(await balance(f.orgB)).toBe(before);

    const other = stripeEvent("checkout.session.completed", { id: "cs_erp_plan", payment_status: "paid", amount_total: 9900, currency: "usd", metadata: {} });
    expect((await call("POST", "/webhooks/stripe", null, null, other.payload, { "stripe-signature": other.signature })).body).toMatchObject({ ignored: true });

    await call("POST", "/v1/credits/checkout", f.ownerB, f.orgB, { packId: PACK });
    const s3 = checkouts.at(-1)!;
    const exp = stripeEvent("checkout.session.expired", { id: s3, payment_status: "unpaid", metadata: { soft_ai: "credits" } });
    await call("POST", "/webhooks/stripe", null, null, exp.payload, { "stripe-signature": exp.signature });
    const [p] = await admin`select status from soft_ai.credit_purchases where stripe_session_id = ${s3}`;
    expect(p!.status).toBe("expired");
  });
});

describe("agency -> sub-account credits", () => {
  it("the agency owner sees sub-accounts and sends credits once per request id", async () => {
    const list = await call("GET", "/v1/credits/sub-accounts", f.ownerA, f.orgA);
    expect(list.body.subAccounts.map((s: { id: string }) => s.id)).toEqual([f.orgS]);
    const requestId = randomUUID();
    const before = await balance(f.orgS);
    expect((await call("POST", "/v1/credits/transfer", f.ownerA, f.orgA, { toOrganizationId: f.orgS, amount: "10", requestId })).status).toBe(200);
    await call("POST", "/v1/credits/transfer", f.ownerA, f.orgA, { toOrganizationId: f.orgS, amount: "10", requestId }); // retry
    expect(await balance(f.orgS)).toBe(before + 10);
    const acts = await admin`select organization_id from public.activity_events where event_type in ('credits.transfer_out', 'credits.transfer_in')
                              and organization_id in ${admin([f.orgA, f.orgS])}`;
    expect(acts).toHaveLength(2);
  });

  it("not to another organization, not by a non-owner, not more than available", async () => {
    expect((await call("POST", "/v1/credits/transfer", f.ownerA, f.orgA, { toOrganizationId: f.orgB, amount: "1", requestId: randomUUID() })).status).toBe(403);
    expect((await call("POST", "/v1/credits/transfer", f.salesA, f.orgA, { toOrganizationId: f.orgS, amount: "1", requestId: randomUUID() })).status).toBe(403);
    expect((await call("GET", "/v1/credits/sub-accounts", f.salesA, f.orgA)).status).toBe(403);
    expect((await call("POST", "/v1/credits/transfer", f.ownerA, f.orgA, { toOrganizationId: f.orgS, amount: "999999", requestId: randomUUID() })).status).toBe(402);
  });
});
