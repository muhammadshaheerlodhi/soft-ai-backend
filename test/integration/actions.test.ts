import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { loadMemberContext } from "../../src/auth/member-context.js";
import { createSqlCreditStore } from "../../src/credits/store.js";
import { createStreamMeter } from "../../src/credits/metering-stream.js";
import { registerChatRoutes } from "../../src/chat/routes.js";
import { FakeProvider } from "../../src/ai/fake-provider.js";
import { ACTIONS, actionsFor } from "../../src/actions/registry.js";
import { createActionService, type ActionCard } from "../../src/actions/service.js";
import { registerActionRoutes } from "../../src/actions/routes.js";
import { TOOLS, toJsonSchema } from "../../src/tools/registry.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { seedErpData, utcDate } from "../helpers/erp-data.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Step 8: actions. The AI only proposes; the user confirms; the ERP's own code
 * runs it in the browser (simulated here by inserting/updating the ERP tables
 * directly, like the ERP service would); the backend checks the result.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
let creatorA: string; // role from a permission MATRIX: sales view+create, crm view
const log = pino({ level: "silent" });
const MODEL = `actions-test-model-${Date.now()}`;
const ids = {} as { ali: string; aliB: string; rod: string; usmanLeave: string; hinaLeave: string };

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  await seedErpData(admin, f.orgA, f.orgB);
  await service`insert into soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k) values (${MODEL}, 2, 10)`;
  await service`select soft_ai.add_credits(${f.orgA}::uuid, 5000, 'purchase', ${`actions-buy-${f.orgA}`})`;

  creatorA = randomUUID();
  const roleId = randomUUID();
  await admin`insert into auth.users (id, instance_id, aud, role, email)
              values (${creatorA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`${creatorA}@soft-ai-test.local`})`;
  await admin`insert into public.roles (id, organization_id, name, slug, permission_matrix)
              values (${roleId}, ${f.orgA}, 'Sales creator (test)', ${`sales-creator-${roleId.slice(0, 8)}`},
                      ${admin.json({ sales: ["view", "create"], crm: ["view"] })})`;
  await admin`insert into public.organization_members (organization_id, user_id, role_id, is_owner, is_active)
              values (${f.orgA}, ${creatorA}, ${roleId}, false, true)`;

  const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
  ids.ali = await one(admin`select id from public.customers where organization_id = ${f.orgA} and name = 'Ali Traders'`);
  ids.aliB = await one(admin`select id from public.customers where organization_id = ${f.orgB}`);
  ids.rod = await one(admin`select id from public.products where organization_id = ${f.orgA} and name = 'Steel Rod'`);
  ids.usmanLeave = await one(admin`select l.id from public.leave_requests l join public.employees e on e.id = l.employee_id
                                    where l.organization_id = ${f.orgA} and e.first_name = 'Usman' and l.status = 'pending'`);
  ids.hinaLeave = await one(admin`select l.id from public.leave_requests l join public.employees e on e.id = l.employee_id
                                   where l.organization_id = ${f.orgA} and e.first_name = 'Hina'`);
});

afterAll(async () => {
  if (f) {
    await admin`delete from public.organization_members where user_id = ${creatorA}`;
    await removeFixtures(admin, f);
    await admin`delete from auth.users where id = ${creatorA}`;
  }
  await admin`delete from soft_ai.model_rates where model = ${MODEL}`;
  await service?.end();
  await admin?.end();
});

function makeApp(provider: FakeProvider, undoMinutes = 10) {
  const actions = createActionService({ sql: service, log, undoMinutes });
  return createApp({
    sql: service,
    logger: log,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
    extendV1: (v1) => {
      registerActionRoutes(v1, actions);
      registerChatRoutes(v1, {
        sql: service,
        meter: createStreamMeter({ store: createSqlCreditStore(service), provider, logger: log, options: { timeoutMs: 5000 } }),
        model: MODEL,
        maxOutputTokens: 200,
        rateLimitRules: [{ name: `actions_t_${MODEL}`, scope: "user", windowSeconds: 3600, max: 1000 }],
        maxMessageChars: 500,
        history: { maxMessages: 10, maxChars: 5000 },
        tools: { maxRounds: 4 },
        actions,
      });
    },
  });
}
type App = ReturnType<typeof makeApp>;

async function headers(user: string, org = f.orgA) {
  return { Authorization: `Bearer ${await signTestToken(user)}`, "X-Organization-Id": org, "Content-Type": "application/json" };
}

async function ask(app: App, user: string, content: string) {
  const h = await headers(user);
  const { id } = (await (await app.request("/v1/chat/conversations", { method: "POST", headers: h })).json()) as { id: string };
  const res = await app.request(`/v1/chat/conversations/${id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content }) });
  const events = (await res.text())
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") }));
  const done = events.find((e) => e.event === "done")?.data;
  return { conversationId: id, events, done, actions: (done?.actions ?? []) as ActionCard[] };
}

async function post(app: App, user: string, path: string, body?: unknown) {
  const res = await app.request(`/v1${path}`, { method: "POST", headers: await headers(user), ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { message: string } } };
}

const invoiceArgs = () => ({ customer_id: ids.ali, items: [{ product_id: ids.rod, quantity: 2, unit_price: 150, tax_rate: 10 }] });

/** What the ERP's invoice service does after Confirm (simplified): insert a draft. */
async function erpCreatesDraftInvoice(org: string, customerId: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into public.invoices (organization_id, customer_id, status, invoice_date, subtotal, tax_amount, total_amount, paid_amount, balance_due)
    values (${org}, ${customerId}, 'draft', ${utcDate(0)}, 300, 30, 330, 0, 330) returning id`;
  return row!.id;
}

describe("action registry", () => {
  it("every action has a valid AI schema, a permission and a unique name (no clash with data tools)", () => {
    const names = new Set<string>();
    for (const a of [...ACTIONS, ...TOOLS]) {
      expect(names.has(a.name)).toBe(false);
      names.add(a.name);
    }
    for (const a of ACTIONS) {
      expect(() => toJsonSchema(a.parameters)).not.toThrow();
      expect(a.anyPermission.length).toBeGreaterThan(0);
      if (a.risk === "high") expect(a.undo).not.toBeNull(); // first batch: everything can be undone
    }
  });

  it("a matrix role with sales view+create is offered exactly the sales create actions", async () => {
    const member = await loadMemberContext(service, f.orgA, creatorA);
    expect(actionsFor(member!).map((a) => a.name).sort()).toEqual(["create_draft_invoice", "create_quotation"]);
    const sales = await loadMemberContext(service, f.orgA, f.salesA); // sales.view only
    expect(actionsFor(sales!)).toEqual([]);
  });
});

describe("propose -> confirm -> run in the ERP -> check -> undo", () => {
  it("full flow for a draft invoice", async () => {
    const provider = new FakeProvider({
      toolRounds: [
        [{ name: "find_records", args: { type: "customer", query: "ali" } }],
        [{ name: "create_draft_invoice", args: invoiceArgs() }],
      ],
      reply: "I prepared a draft invoice for Ali Traders. Please check and confirm it.",
    });
    const app = makeApp(provider);
    const r = await ask(app, f.ownerA, "Make an invoice for Ali Traders: 2 steel rods at 150, 10% tax");

    // The AI was told it is only proposed.
    const proposeResult = provider.requests[2]!.messages.at(-1) as { role: string; results: { response: Record<string, unknown> }[] };
    expect(proposeResult.results[0]!.response).toMatchObject({ status: "proposed" });
    expect(String(proposeResult.results[0]!.response.note)).toContain("NOT done yet");

    // One card, needs Confirm (medium risk), with names and estimated totals.
    expect(r.actions).toHaveLength(1);
    const card = r.actions[0]!;
    expect(card).toMatchObject({ name: "create_draft_invoice", status: "proposed", needsConfirmation: true });
    expect(card.preview.fields).toContainEqual({ label: "Customer", value: "Ali Traders" });
    expect(card.preview.fields).toContainEqual({ label: "Invoice date", value: utcDate(0) }); // filled in: today
    expect(card.preview.lines).toEqual([{ description: "Steel Rod", quantity: 2, unitPrice: "USD 150.00", total: "USD 300.00" }]);
    expect(card.preview.totals).toContainEqual({ label: "Estimated total", value: "USD 330.00" });

    // Confirm: the panel gets exactly the saved params to run.
    const start = await post(app, f.ownerA, `/actions/${card.id}/start`);
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ name: "create_draft_invoice", record: "invoice", params: { customer_id: ids.ali, invoice_date: utcDate(0) } });
    // ...only once.
    expect((await post(app, f.ownerA, `/actions/${card.id}/start`)).status).toBe(409);

    // The ERP creates the draft; the panel reports it; the backend checks it really exists.
    const invoiceId = await erpCreatesDraftInvoice(f.orgA, ids.ali);
    const done = await post(app, f.ownerA, `/actions/${card.id}/result`, { ok: true, recordId: invoiceId });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "executed", result: { recordId: invoiceId, total: "330.00", pagePath: `/sales/invoices/${invoiceId}` } });
    expect(done.body.undoUntil).toBeTruthy();
    expect((done.body.result as { number: string }).number).toBeTruthy(); // ERP numbering trigger

    // Chat history shows the card with its outcome.
    const hist = await app.request(`/v1/chat/conversations/${r.conversationId}/messages`, { headers: await headers(f.ownerA) });
    const msgs = ((await hist.json()) as { messages: { role: string; actions: ActionCard[] }[] }).messages;
    expect(msgs.find((m) => m.role === "assistant")!.actions[0]).toMatchObject({ id: card.id, status: "executed" });

    // Undo: the panel deletes the draft with the ERP's own code; backend checks it is gone.
    const undo = await post(app, f.ownerA, `/actions/${card.id}/undo/start`);
    expect(undo.body).toMatchObject({ kind: "delete", recordId: invoiceId });
    expect((await post(app, f.ownerA, `/actions/${card.id}/undo/result`, { ok: true })).status).toBe(409); // not deleted yet!
    await admin`update public.invoices set deleted_at = now() where id = ${invoiceId}`;
    const undone = await post(app, f.ownerA, `/actions/${card.id}/undo/result`, { ok: true });
    expect(undone.body).toMatchObject({ status: "undone" });
  });

  it("a low-risk action the user asked for directly runs without Confirm (Undo available)", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_customer", args: { name: "New Co", phone: "0300-0000000" } }]], reply: "Done preparing." });
    const r = await ask(makeApp(provider), f.ownerA, "Add customer New Co, phone 0300-0000000");
    expect(r.actions[0]).toMatchObject({ name: "create_customer", needsConfirmation: false, risk: "low" });
    // The AI is told it will be saved (so it does not ask the user to press Confirm).
    const told = provider.requests[1]!.messages.at(-1) as { results: { response: Record<string, unknown> }[] };
    expect(told.results[0]!.response).toMatchObject({ status: "will_save_after_your_reply" });
  });

  it("...but needs Confirm when the AI read company data in the same reply (text in records cannot trigger changes)", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "find_records", args: { type: "customer" } }], [{ name: "create_customer", args: { name: "Other Co" } }]],
      reply: "Prepared.",
    });
    const r = await ask(makeApp(provider), f.ownerA, "Add a customer");
    expect(r.actions[0]).toMatchObject({ name: "create_customer", needsConfirmation: true });
  });

  it("...and when several actions are proposed at once", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "create_customer", args: { name: "A Co" } }, { name: "create_customer", args: { name: "B Co" } }]],
      reply: "Prepared two.",
    });
    const r = await ask(makeApp(provider), f.ownerA, "Add A Co and B Co");
    expect(r.actions.map((a) => a.needsConfirmation)).toEqual([true, true]);
  });

  it("leave approval: only a PENDING request; undo sets it back to pending", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "approve_leave_request", args: { leave_request_id: ids.usmanLeave } }]], reply: "Prepared." });
    const app = makeApp(provider);
    const r = await ask(app, f.ownerA, "Approve Usman's leave");
    const card = r.actions[0]!;
    expect(card.preview.fields).toContainEqual({ label: "Employee", value: "Usman Ali" });
    await post(app, f.ownerA, `/actions/${card.id}/start`);

    // Reporting success while the ERP did NOT approve it -> failed, not executed.
    const fake = await post(app, f.ownerA, `/actions/${card.id}/result`, { ok: true, recordId: ids.usmanLeave });
    expect(fake.body).toMatchObject({ status: "failed", error: "The change could not be confirmed in the ERP." });

    // A real run.
    const r2 = await ask(app, f.ownerA, "Approve Usman's leave");
    const card2 = r2.actions[0]!;
    await post(app, f.ownerA, `/actions/${card2.id}/start`);
    await admin`update public.leave_requests set status = 'approved', approved_at = now() where id = ${ids.usmanLeave}`;
    expect((await post(app, f.ownerA, `/actions/${card2.id}/result`, { ok: true, recordId: ids.usmanLeave })).body).toMatchObject({ status: "executed" });
    expect((await post(app, f.ownerA, `/actions/${card2.id}/undo/start`)).body).toMatchObject({ kind: "restore_status", previousStatus: "pending" });
    await admin`update public.leave_requests set status = 'pending', approved_at = null where id = ${ids.usmanLeave}`;
    expect((await post(app, f.ownerA, `/actions/${card2.id}/undo/result`, { ok: true })).body).toMatchObject({ status: "undone" });

    // An already-approved request cannot be proposed again.
    const p3 = new FakeProvider({
      toolRounds: [[{ name: "approve_leave_request", args: { leave_request_id: ids.hinaLeave } }]],
      replyFromTools: (res) => JSON.stringify(res[0]),
    });
    const r3 = await ask(makeApp(p3), f.ownerA, "Approve Hina's leave");
    expect(r3.actions).toEqual([]);
    expect(r3.events.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toContain("already approved");
  });
});

describe("action safety", () => {
  it("a record of ANOTHER organization is refused; nothing is proposed", async () => {
    const provider = new FakeProvider({
      toolRounds: [[{ name: "create_draft_invoice", args: { ...invoiceArgs(), customer_id: ids.aliB } }]],
      replyFromTools: (res) => JSON.stringify(res[0]),
    });
    const r = await ask(makeApp(provider), f.ownerA, "Invoice the org B customer");
    expect(r.actions).toEqual([]);
    const text = r.events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(text).toContain("customer not found");
    expect(text).not.toContain("org B"); // its name is not revealed
  });

  it("a user without the permission is not offered actions, and a forced call is refused", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: invoiceArgs() }]], replyFromTools: (res) => JSON.stringify(res[0]) });
    const r = await ask(makeApp(provider), f.salesA, "Make an invoice");
    expect(provider.requests[0]!.tools!.map((t) => t.name)).not.toContain("create_draft_invoice");
    expect(r.actions).toEqual([]);
  });

  it("only the user who asked can confirm, cancel or see an action", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: invoiceArgs() }]], reply: "Prepared." });
    const app = makeApp(provider);
    const r = await ask(app, f.ownerA, "Make an invoice");
    const id = r.actions[0]!.id;
    expect((await post(app, creatorA, `/actions/${id}/start`)).status).toBe(404);
    expect((await post(app, creatorA, `/actions/${id}/cancel`)).status).toBe(404);
    // Cancel by the owner; it can no longer run.
    expect((await post(app, f.ownerA, `/actions/${id}/cancel`)).body).toMatchObject({ status: "cancelled" });
    expect((await post(app, f.ownerA, `/actions/${id}/start`)).status).toBe(409);
  });

  it("a reported record that is not the right kind or not in this organization is not accepted", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: invoiceArgs() }]], reply: "Prepared." });
    const app = makeApp(provider);
    const r = await ask(app, f.ownerA, "Make an invoice");
    const id = r.actions[0]!.id;
    await post(app, f.ownerA, `/actions/${id}/start`);
    const otherOrgInvoice = await erpCreatesDraftInvoice(f.orgB, ids.aliB);
    const res = await post(app, f.ownerA, `/actions/${id}/result`, { ok: true, recordId: otherOrgInvoice });
    expect(res.body).toMatchObject({ status: "failed" });
  });

  it("an ERP error is recorded as failed with its message", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: invoiceArgs() }]], reply: "Prepared." });
    const app = makeApp(provider);
    const id = (await ask(app, f.ownerA, "Make an invoice")).actions[0]!.id;
    await post(app, f.ownerA, `/actions/${id}/start`);
    const res = await post(app, f.ownerA, `/actions/${id}/result`, { ok: false, error: "Insufficient stock for Steel Rod" });
    expect(res.body).toMatchObject({ status: "failed", error: "Insufficient stock for Steel Rod" });
  });

  it("expired proposals and closed undo windows are refused", async () => {
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: invoiceArgs() }]], reply: "Prepared." });
    const app = makeApp(provider);
    const id = (await ask(app, f.ownerA, "Make an invoice")).actions[0]!.id;
    await admin`update soft_ai.actions set expires_at = now() - interval '1 minute' where id = ${id}`;
    const res = await post(app, f.ownerA, `/actions/${id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error!.message).toContain("expired");

    const id2 = (await ask(app, f.ownerA, "Make an invoice")).actions[0]!.id;
    await post(app, f.ownerA, `/actions/${id2}/start`);
    const inv = await erpCreatesDraftInvoice(f.orgA, ids.ali);
    await post(app, f.ownerA, `/actions/${id2}/result`, { ok: true, recordId: inv });
    await admin`update soft_ai.actions set undo_until = now() - interval '1 second' where id = ${id2}`;
    expect((await post(app, f.ownerA, `/actions/${id2}/undo/start`)).status).toBe(409);
  });

  it("if a referenced record is deleted before Confirm, the action is cancelled instead of run", async () => {
    const [cust] = await admin<{ id: string }[]>`insert into public.customers (organization_id, name) values (${f.orgA}, 'Short-lived Ltd') returning id`;
    const provider = new FakeProvider({ toolRounds: [[{ name: "create_draft_invoice", args: { ...invoiceArgs(), customer_id: cust!.id } }]], reply: "Prepared." });
    const app = makeApp(provider);
    const id = (await ask(app, f.ownerA, "Invoice Short-lived")).actions[0]!.id;
    await admin`update public.customers set deleted_at = now() where id = ${cust!.id}`;
    const res = await post(app, f.ownerA, `/actions/${id}/start`);
    expect(res.status).toBe(409);
    const [row] = await admin<{ status: string }[]>`select status from soft_ai.actions where id = ${id}`;
    expect(row!.status).toBe("cancelled");
  });

  it("at most 5 actions per reply", async () => {
    const calls = Array.from({ length: 4 }, (_, i) => ({ name: "create_customer", args: { name: `Bulk ${i}` } }));
    const provider = new FakeProvider({ toolRounds: [calls, [...calls]], reply: "Prepared." });
    const r = await ask(makeApp(provider), f.ownerA, "Add 8 customers");
    expect(r.actions).toHaveLength(5);
  });
});
