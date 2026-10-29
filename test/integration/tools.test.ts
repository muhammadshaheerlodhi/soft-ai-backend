import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { loadMemberContext } from "../../src/auth/member-context.js";
import { createSqlCreditStore } from "../../src/credits/store.js";
import { createStreamMeter } from "../../src/credits/metering-stream.js";
import { registerChatRoutes } from "../../src/chat/routes.js";
import { createAnswerCache } from "../../src/chat/answer-cache.js";
import { FakeProvider } from "../../src/ai/fake-provider.js";
import { executeToolCalls } from "../../src/tools/execute.js";
import { toolsFor } from "../../src/tools/registry.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { seedErpData, utcDate } from "../helpers/erp-data.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Step 7: company-data tools on Shaheer's real tables (local database),
 * run as the restricted backend role. Expected numbers are worked out by hand
 * in test/helpers/erp-data.ts.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
const log = pino({ level: "silent" });
const MODEL = `tools-test-model-${Date.now()}`;

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  await seedErpData(admin, f.orgA, f.orgB);
  await service`insert into soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k) values (${MODEL}, 2, 10)`;
  await service`select soft_ai.add_credits(${f.orgA}::uuid, 100, 'purchase', ${`tools-buy-${f.orgA}`})`;
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await admin`delete from soft_ai.model_rates where model = ${MODEL}`;
  await service?.end();
  await admin?.end();
});

/** Runs one tool as a user, through the same code the chat uses. */
async function tool(user: string, org: string, name: string, args: Record<string, unknown> = {}) {
  const member = await loadMemberContext(service, org, user);
  if (!member) throw new Error("not a member");
  const [r] = await executeToolCalls({ sql: service, member, calls: [{ name, args }], log });
  return r!;
}

describe("data tools: exact numbers", () => {
  it("receivables: open, overdue, aging, drafts reported separately", async () => {
    const r = await tool(f.ownerA, f.orgA, "receivables_summary");
    expect(r.ok).toBe(true);
    expect(r.response).toMatchObject({
      currency: "USD",
      as_of: utcDate(0),
      open_invoices: 4, // I1, I2, I3, I7
      open_balance: 2100, // 1000 + 300 + 700 + 100
      overdue_invoices: 2, // I1, I3
      overdue_balance: 1700,
      aging_balance: { not_yet_due: 400, overdue_1_30: 700, overdue_31_60: 1000, overdue_61_90: 0, overdue_over_90: 0 },
      draft_invoices: 1,
      draft_total: 250,
    });
  });

  it("unpaid invoices: filters by customer, overdue, days; shows totals of all matches", async () => {
    const ali = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { customer: "ali" });
    expect(ali.response).toMatchObject({ matching_count: 2, matching_balance: 1300 }); // I1 1000 + I2 300
    const overdue = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { overdue_only: true });
    expect((overdue.response.invoices as { invoice_number: string }[]).map((i) => i.invoice_number)).toEqual(["T-I1", "T-I3"]);
    const old = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { min_days_overdue: 30 });
    expect(old.response).toMatchObject({ matching_count: 1 });
    expect((old.response.invoices as { days_overdue: number }[])[0]?.days_overdue).toBe(45);
    const largest = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { sort: "largest", limit: 1 });
    expect(largest.response).toMatchObject({ matching_count: 4, shown: 1 });
    expect((largest.response.invoices as { invoice_number: string }[])[0]?.invoice_number).toBe("T-I1");
  });

  it("customer search treats % and _ as normal characters (no 'match everything')", async () => {
    const pct = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { customer: "%" });
    expect(pct.response).toMatchObject({ matching_count: 1 }); // only "Zed_100% Ltd"
    const und = await tool(f.ownerA, f.orgA, "find_customers", { query: "_" });
    expect((und.response.customers as { name: string }[]).map((c) => c.name)).toEqual(["Zed_100% Ltd"]);
  });

  it("sales for a period", async () => {
    const r = await tool(f.ownerA, f.orgA, "sales_summary", { period: "custom", from: utcDate(-80), to: utcDate(0) });
    expect(r.response).toMatchObject({
      invoices_count: 5, // I1, I2, I3, I5, I7 (no draft, cancelled or deleted)
      invoiced_total: 2700,
      payments_received: 600,
      top_customers: [
        { customer: "Ali Traders", invoiced: 1900 },
        { customer: "Bilal & Co", invoiced: 700 },
        { customer: "Zed_100% Ltd", invoiced: 100 },
      ],
    });
  });

  it("find customers with their open balance", async () => {
    const r = await tool(f.ownerA, f.orgA, "find_customers", { query: "ali tra" });
    expect(r.response.customers).toEqual([
      { customer_number: expect.anything(), name: "Ali Traders", phone: "0300-1111111", email: "ali@example.test", is_active: true, open_balance: 1300 },
    ]);
  });

  it("payables", async () => {
    const r = await tool(f.ownerA, f.orgA, "payables_summary");
    expect(r.response).toMatchObject({
      open_bills: 2,
      open_balance: 1000,
      overdue_bills: 1,
      overdue_balance: 800,
      due_next_7_days: 200,
      top_vendors_owed: [{ vendor: "Steel Supplier", owed: 1000 }],
    });
  });

  it("cash and bank: ledger and Bank Accounts page both shown, currencies never mixed", async () => {
    const r = await tool(f.ownerA, f.orgA, "cash_and_bank_balances");
    expect(r.response).toMatchObject({
      company_currency: "USD",
      ledger_total: 3650, // Cash 1150 + Bank 2500; "Bank Charges" (expense) not counted; draft entry ignored
      ledger_accounts: [
        { code: "1112", name: "Cash in Hand", balance: 1150 },
        { code: "1113", name: "Bank - Local", balance: 2500 },
      ],
      bank_accounts: [
        { name: "HBL Business", bank_name: "Habib Bank", account_last4: "4433", currency: "PKR", balance: 900000 },
        { name: "Meezan Current", bank_name: "Meezan Bank", account_last4: "0123", currency: "USD", balance: 5000 },
      ],
      bank_totals_by_currency: { USD: 5000, PKR: 900000 },
    });
    // The full bank account numbers never go to the AI.
    expect(JSON.stringify(r.response)).not.toContain("01234567890123");
    expect(JSON.stringify(r.response)).not.toContain("99887766554433");
  });

  it("stock levels and low stock", async () => {
    const all = await tool(f.ownerA, f.orgA, "stock_levels");
    expect(all.response).toMatchObject({ products_matching: 2, low_stock_count: 1 });
    const low = await tool(f.ownerA, f.orgA, "stock_levels", { low_stock_only: true });
    expect(low.response.products).toEqual([
      { sku: "T-SR-1", name: "Steel Rod", unit: "pcs", reorder_level: 10, on_hand: 8, reserved: 1, available: 7, is_low: true },
    ]);
  });

  it("HR today", async () => {
    const r = await tool(f.ownerA, f.orgA, "hr_today");
    expect(r.response).toMatchObject({
      date: utcDate(0),
      active_employees: 3,
      attendance: { present: 1, late: 1 },
      on_leave: [{ name: "Hina Riaz", start_date: utcDate(-1), end_date: utcDate(1) }],
      pending_leave_requests: 1,
    });
  });

  it("expenses for a period", async () => {
    const r = await tool(f.ownerA, f.orgA, "expenses_summary", { period: "custom", from: utcDate(-5), to: utcDate(0) });
    expect(r.response).toMatchObject({
      approved_total: 500,
      approved_count: 3,
      pending_total: 50,
      pending_count: 1,
      by_category: [
        { category: "Uncategorized", total: 300 },
        { category: "Fuel", total: 200 },
      ],
    });
  });
});

describe("find_records (ids for actions)", () => {
  it("finds records of this organization only, with the details needed for actions", async () => {
    const r = await tool(f.ownerA, f.orgA, "find_records", { type: "customer", query: "ali" });
    expect((r.response.records as { name: string }[]).map((c) => c.name)).toEqual(["Ali Traders"]); // not org B's
    const banks = await tool(f.ownerA, f.orgA, "find_records", { type: "bank_account" });
    expect(banks.response.records).toContainEqual(expect.objectContaining({ name: "HBL Business", account_last4: "4433", currency: "PKR" }));
    expect(JSON.stringify(banks.response)).not.toContain("99887766554433"); // full number never sent
    const leave = await tool(f.ownerA, f.orgA, "find_records", { type: "leave_request", status: "pending" });
    expect(leave.response.records).toEqual([expect.objectContaining({ employee: "Usman Ali", status: "pending" })]);
  });

  it("each record type needs its own permission (checked in the database)", async () => {
    const own = await tool(f.salesA, f.orgA, "find_records", { type: "customer" }); // sales.view: allowed
    expect(own.ok).toBe(true);
    const hr = await tool(f.salesA, f.orgA, "find_records", { type: "employee" });
    expect(hr).toMatchObject({ ok: false, response: { error: "forbidden" } });
  });
});

describe("data tools: who may see what", () => {
  it("a sales user is offered only sales and customer tools", async () => {
    const member = await loadMemberContext(service, f.orgA, f.salesA);
    expect(toolsFor(member!).map((t) => t.name).sort()).toEqual(["find_customers", "find_records", "list_unpaid_invoices", "receivables_summary", "sales_summary"]);
  });

  it("a sales user cannot read cash, HR or payables (refused, nothing returned)", async () => {
    // Valid inputs, so the request would reach the database if our backend check were missing
    // (a deliberate-bug run showed the database then refuses on its own).
    const validArgs: Record<string, Record<string, unknown>> = { expenses_summary: { period: "this_month" } };
    for (const name of ["cash_and_bank_balances", "hr_today", "payables_summary", "stock_levels", "expenses_summary"]) {
      const r = await tool(f.salesA, f.orgA, name, validArgs[name] ?? {});
      expect(r, name).toMatchObject({ ok: false, response: { error: "forbidden" } });
      expect(JSON.stringify(r.response)).not.toMatch(/\d{3,}/); // no figures leaked
    }
  });

  it("the DATABASE refuses too, even if our backend code were skipped", async () => {
    await expect(service`select soft_ai.tool_cash_and_bank(${f.orgA}::uuid, ${f.salesA}::uuid, '{}'::jsonb)`).rejects.toThrow(/forbidden/);
    await expect(service`select soft_ai.tool_receivables_summary(${f.orgA}::uuid, ${f.stranger}::uuid, '{}'::jsonb)`).rejects.toThrow(/forbidden/);
    await expect(service`select soft_ai.tool_receivables_summary(${f.orgA}::uuid, ${f.inactiveA}::uuid, '{}'::jsonb)`).rejects.toThrow(/forbidden/);
  });

  it("organizations are separate: org B's 7,777 invoice never appears for org A, and org B's owner cannot read org A", async () => {
    const a = await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { limit: 20 });
    expect(JSON.stringify(a.response)).not.toContain("7777");
    expect(JSON.stringify(a.response)).not.toContain("org B");
    await expect(service`select soft_ai.tool_receivables_summary(${f.orgA}::uuid, ${f.ownerB}::uuid, '{}'::jsonb)`).rejects.toThrow(/forbidden/);
  });

  it("browsers cannot call the tool functions at all", async () => {
    await admin.begin(async (tx) => {
      await tx`set local role authenticated`;
      await expect(tx`select soft_ai.tool_receivables_summary(${f.orgA}::uuid, ${f.ownerA}::uuid, '{}'::jsonb)`).rejects.toThrow(/permission denied/);
    }).catch((e) => {
      if (!String(e).includes("permission denied")) throw e;
    });
  });

  it("bad or unknown requests from the AI get a clear error, not data", async () => {
    expect((await tool(f.ownerA, f.orgA, "drop_everything")).response).toMatchObject({ error: "unknown_tool" });
    expect((await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { limit: 500 })).response).toMatchObject({ error: "invalid_argument" });
    expect((await tool(f.ownerA, f.orgA, "list_unpaid_invoices", { sql: "drop table invoices" })).response).toMatchObject({ error: "invalid_argument" });
    expect((await tool(f.ownerA, f.orgA, "sales_summary", { period: "custom", from: "2026-13-45", to: "2026-01-01" })).response).toMatchObject({
      error: "invalid_argument",
    });
  });
});

// ---------------- in the chat ----------------

function makeApp(provider: FakeProvider) {
  return createApp({
    sql: service,
    logger: log,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
    extendV1: (v1) =>
      registerChatRoutes(v1, {
        sql: service,
        meter: createStreamMeter({ store: createSqlCreditStore(service), provider, logger: log, options: { timeoutMs: 5000 } }),
        model: MODEL,
        maxOutputTokens: 200,
        rateLimitRules: [{ name: `tools_t_${MODEL}`, scope: "user", windowSeconds: 3600, max: 1000 }],
        maxMessageChars: 500,
        history: { maxMessages: 10, maxChars: 5000 },
        cache: createAnswerCache(service, { ttlHours: 24 }),
        tools: { maxRounds: 3 },
      }),
  });
}

async function ask(app: ReturnType<typeof makeApp>, user: string, org: string, content: string) {
  const headers = { Authorization: `Bearer ${await signTestToken(user)}`, "X-Organization-Id": org, "Content-Type": "application/json" };
  const { id } = (await (await app.request("/v1/chat/conversations", { method: "POST", headers })).json()) as { id: string };
  const res = await app.request(`/v1/chat/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ content }) });
  const events = (await res.text())
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") }));
  return {
    conversationId: id,
    events,
    text: events.filter((e) => e.event === "delta").map((e) => e.data.text).join(""),
    done: events.find((e) => e.event === "done")?.data,
  };
}

describe("data questions in the chat", () => {
  it("the AI asks for data, our code fetches it, the AI answers with the real numbers", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "receivables_summary", args: {} }]],
      replyFromTools: (results) => `Customers owe ${(results[0] as { open_balance: number }).open_balance} USD.`,
    });
    const r = await ask(makeApp(provider), f.ownerA, f.orgA, "How much do customers owe us?");
    expect(r.text).toBe("Customers owe 2100 USD.");
    expect(r.events.find((e) => e.event === "status")?.data.text).toBe("Checking receivables…");
    expect(r.done).toMatchObject({ usedData: true, answeredBy: "model" });
    expect(r.done.sources[0]).toEqual({ title: "Accounts Receivable", urlPath: "/accounting/receivable" });
    expect(provider.calls).toBe(2); // round 1: asks for the tool; round 2: answers

    // The tool use is saved with the message (audit), and charged ONCE for both rounds.
    const [msg] = await admin<{ tool_calls: { name: string; ok: boolean }[]; credits_charged: string }[]>`
      select tool_calls, credits_charged::text from soft_ai.messages
       where conversation_id = ${r.conversationId} and role = 'assistant'`;
    expect(msg!.tool_calls).toEqual([{ name: "receivables_summary", args: {}, ok: true }]);
    // 2 rounds x (100 in * 2/1000 + 20 out * 10/1000) = 2 x 0.4 = 0.8
    expect(msg!.credits_charged).toBe("0.8000");
    const usage = await admin`select 1 from soft_ai.ledger l join soft_ai.reservations r on r.id = l.reservation_id
                               where l.reference->>'conversation_id' = ${r.conversationId}`;
    expect(usage).toHaveLength(1);
  });

  it("answers that used company data are never cached", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "receivables_summary", args: {} }]], reply: "2100 USD." });
    const app = makeApp(provider);
    await ask(app, f.ownerA, f.orgA, "What is our total receivable?");
    const again = await ask(app, f.ownerA, f.orgA, "What is our total receivable?");
    expect(again.done.answeredBy).toBe("model");
    expect(provider.calls).toBe(4); // 2 rounds each time, nothing from cache
  });

  it("a sales user is only OFFERED the tools their role allows", async () => {
    const provider = new FakeProvider({ reply: "ok" });
    await ask(makeApp(provider), f.salesA, f.orgA, "How much cash do we have?");
    expect(provider.requests[0]!.tools!.map((t) => t.name).sort()).toEqual(["find_customers", "find_records", "list_unpaid_invoices", "receivables_summary", "sales_summary"]);
  });

  it("if the AI still asks for a tool it is not allowed, it gets 'forbidden', not data", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "cash_and_bank_balances", args: {} }]],
      replyFromTools: (results) => JSON.stringify(results[0]),
    });
    const r = await ask(makeApp(provider), f.salesA, f.orgA, "How much cash do we have?");
    expect(r.text).toContain("forbidden");
    expect(r.text).not.toContain("3700");
  });

  it("an AI that keeps asking for tools is stopped: the last round must answer in text", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "receivables_summary", args: {} }], [{ name: "receivables_summary", args: {} }], [{ name: "receivables_summary", args: {} }]],
      reply: "Final answer.",
    });
    const r = await ask(makeApp(provider), f.ownerA, f.orgA, "Loop please");
    expect(provider.calls).toBe(3); // maxRounds
    expect(provider.requests[2]!.toolChoice).toBe("none");
    expect(r.text).toBe("Final answer.");
  });
});
