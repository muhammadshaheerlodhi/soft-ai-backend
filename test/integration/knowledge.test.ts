import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { createSqlCreditStore } from "../../src/credits/store.js";
import { createStreamMeter } from "../../src/credits/metering-stream.js";
import { registerChatRoutes } from "../../src/chat/routes.js";
import { createPageDirectory } from "../../src/chat/rules.js";
import { createAnswerCache } from "../../src/chat/answer-cache.js";
import { FakeProvider } from "../../src/ai/fake-provider.js";
import { FakeEmbedder } from "../../src/ai/embedder.js";
import { indexRelease } from "../../src/knowledge/indexer.js";
import { retrieveKnowledge } from "../../src/knowledge/retrieve.js";
import type { KnowledgeDoc, PageEntry } from "../../src/knowledge/extract-erp.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Step 6 on the real database: release pipeline, knowledge search, and the
 * chat flow (rules engine -> cache -> knowledge -> AI). Uses the free fake
 * embedder and fake AI. The local dev knowledge release that was active before
 * the tests is restored afterwards.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
let previouslyActive: string | null = null;
const run = Date.now().toString(36);
const V1 = `test-${run}-v1`;
const V2 = `test-${run}-v2`;
const MODEL = `kb-test-model-${run}`;

const page = (title: string, href: string, group: string, permission: string | null = null): PageEntry => ({
  title,
  href,
  group,
  module: null,
  permission,
  kind: "page",
});

const DOCS: KnowledgeDoc[] = [
  {
    sourceType: "module_guide",
    sourceRef: "guide:/purchasing/receipts",
    title: "Goods Receipts",
    content: "Record physical receipt of purchased goods into inventory. Link the goods receipt to the purchase order and confirm received quantities.",
    urlPath: "/purchasing/receipts",
    metadata: {},
  },
  {
    sourceType: "module_guide",
    sourceRef: "guide:/sales/invoices",
    title: "Invoices",
    content: "Create sales invoices for customers. Draft invoices do not post to the ledger.",
    urlPath: "/sales/invoices",
    metadata: {},
  },
  {
    sourceType: "page_map",
    sourceRef: "menu:Sales",
    title: "Sales menu",
    content: "Pages in the Sales menu: Invoices (/sales/invoices)",
    urlPath: "/sales/invoices",
    metadata: { group: "Sales", pages: [page("Invoices", "/sales/invoices", "Sales", "sales.view")] },
  },
  {
    sourceType: "page_map",
    sourceRef: "menu:HR",
    title: "HR menu",
    content: "Pages in the HR menu: Payroll (/hr/payroll)",
    urlPath: "/hr/payroll",
    metadata: { group: "HR", pages: [page("Payroll", "/hr/payroll", "HR", "hr.view")] },
  },
];

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  const [active] = await admin<{ version: string }[]>`select version from soft_ai.knowledge_releases where status = 'active'`;
  previouslyActive = active?.version ?? null;
  await service`insert into soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k) values (${MODEL}, 2, 10)`;
  await service`select soft_ai.add_credits(${f.orgA}::uuid, 50, 'purchase', ${`kb-buy-${f.orgA}`})`;
  await service`select soft_ai.add_credits(${f.orgB}::uuid, 50, 'purchase', ${`kb-buy-${f.orgB}`})`;
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await admin`delete from soft_ai.knowledge_releases where version like ${`test-${run}-%`}`;
  if (previouslyActive) {
    await admin`update soft_ai.knowledge_releases set status = 'active', activated_at = now()
                 where version = ${previouslyActive} and not exists (select 1 from soft_ai.knowledge_releases where status = 'active')`;
  }
  await admin`delete from soft_ai.model_rates where model = ${MODEL}`;
  await admin`delete from soft_ai.rate_limit_counters where bucket like ${`kbt\\_${run}%`}`;
  await service?.end();
  await admin?.end();
});

describe("release pipeline", () => {
  it("builds a release and switches it on", async () => {
    const embedder = new FakeEmbedder();
    const stats = await indexRelease({ sql: service, embedder, docs: DOCS, version: V1 });
    expect(stats).toMatchObject({ status: "activated", chunks: 4, embedded: 4, reused: 0 });
    const [r] = await admin<{ status: string; chunk_count: number }[]>`select status, chunk_count from soft_ai.knowledge_releases where version = ${V1}`;
    expect(r).toEqual({ status: "active", chunk_count: 4 });
  });

  it("running it again for the same release does nothing", async () => {
    const embedder = new FakeEmbedder();
    expect((await indexRelease({ sql: service, embedder, docs: DOCS, version: V1 })).status).toBe("already_active");
    expect(embedder.calls).toBe(0);
  });

  it("a new release re-uses unchanged embeddings and only embeds what changed", async () => {
    const changed = DOCS.map((d) => (d.sourceRef === "guide:/sales/invoices" ? { ...d, content: `${d.content} Sent invoices post to receivables.` } : d));
    const stats = await indexRelease({ sql: service, embedder: new FakeEmbedder(), docs: changed, version: V2 });
    expect(stats).toMatchObject({ status: "activated", chunks: 4, embedded: 1, reused: 3 });
    const statuses = await admin<{ version: string; status: string }[]>`
      select version, status from soft_ai.knowledge_releases where version in (${V1}, ${V2}) order by version`;
    expect(statuses).toEqual([{ version: V1, status: "retired" }, { version: V2, status: "active" }]);
  });

  it("an empty or broken release is refused and the current one stays active", async () => {
    await expect(indexRelease({ sql: service, embedder: new FakeEmbedder(), docs: [], version: `test-${run}-empty` })).rejects.toThrow(/no knowledge chunks/);
    const [active] = await admin<{ version: string }[]>`select version from soft_ai.knowledge_releases where status = 'active'`;
    expect(active?.version).toBe(V2);
    const [failed] = await admin<{ status: string }[]>`select status from soft_ai.knowledge_releases where version = ${`test-${run}-empty`}`;
    expect(failed?.status).toBe("failed");
  });
});

describe("knowledge search", () => {
  it("finds the right help page for a question, best match first", async () => {
    const r = await retrieveKnowledge({
      sql: service,
      embedder: new FakeEmbedder(),
      organizationId: f.orgA,
      question: "how do I record goods received against a purchase order",
      topK: 3,
      minSimilarity: 0.1,
    });
    expect(r.releaseVersion).toBe(V2);
    expect(r.hits[0]?.title).toBe("Goods Receipts");
  });

  it("returns nothing when no help text is close enough", async () => {
    const r = await retrieveKnowledge({ sql: service, embedder: new FakeEmbedder(), organizationId: f.orgA, question: "weather tomorrow", topK: 3, minSimilarity: 0.5 });
    expect(r.hits).toHaveLength(0);
  });
});

// ---------------- chat flow ----------------

function makeApp(provider: FakeProvider) {
  const logger = pino({ level: "silent" });
  return createApp({
    sql: service,
    logger,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
    extendV1: (v1) =>
      registerChatRoutes(v1, {
        sql: service,
        meter: createStreamMeter({ store: createSqlCreditStore(service), provider, logger, options: { timeoutMs: 5000 } }),
        model: MODEL,
        maxOutputTokens: 200,
        rateLimitRules: [{ name: `kbt_${run}`, scope: "user", windowSeconds: 3600, max: 1000 }],
        maxMessageChars: 500,
        history: { maxMessages: 10, maxChars: 5000 },
        knowledge: { embedder: new FakeEmbedder(), topK: 3, minSimilarity: 0.1 },
        pages: createPageDirectory(service),
        cache: createAnswerCache(service, { ttlHours: 24 }),
      }),
  });
}

async function ask(app: ReturnType<typeof makeApp>, user: string, org: string, content: string, conversationId?: string) {
  const headers = { Authorization: `Bearer ${await signTestToken(user)}`, "X-Organization-Id": org, "Content-Type": "application/json" };
  const id = conversationId ?? ((await (await app.request("/v1/chat/conversations", { method: "POST", headers })).json()) as { id: string }).id;
  const res = await app.request(`/v1/chat/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ content }) });
  if (res.status !== 200) return { status: res.status, conversationId: id, done: null, text: "", body: await res.json() };
  const events = (await res.text())
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") }));
  return {
    status: 200,
    conversationId: id,
    text: events.filter((e) => e.event === "delta").map((e) => e.data.text).join(""),
    done: events.find((e) => e.event === "done")?.data,
    body: null,
  };
}

describe("rules engine in the chat (free)", () => {
  it("'open invoices' is answered without the AI, for 0 credits, with the page to open", async () => {
    const provider = new FakeProvider();
    const r = await ask(makeApp(provider), f.ownerA, f.orgA, "open invoices");
    expect(r.done).toMatchObject({ answeredBy: "rules", creditsCharged: "0.0000", navigateTo: "/sales/invoices" });
    expect(r.text).toContain("[Invoices](/sales/invoices)");
    expect(provider.calls).toBe(0);
  });

  it("a user without HR permission cannot open Payroll through Soft AI (it goes to the AI instead)", async () => {
    const provider = new FakeProvider({ reply: "I can't open that for you." });
    const r = await ask(makeApp(provider), f.salesA, f.orgA, "open payroll"); // salesA only has sales.view
    expect(r.done?.answeredBy).toBe("model");
    expect(r.done?.navigateTo).toBeUndefined();
  });

  it("still works with zero credits (it is free)", async () => {
    await service`select soft_ai.add_credits(${f.orgS}::uuid, 1, 'trial', ${`kb-trial-${f.orgS}`})`;
    const [w] = await service<{ balance: string }[]>`select balance::text from soft_ai.wallets where organization_id = ${f.orgS}`;
    await service`select soft_ai.add_credits(${f.orgS}::uuid, ${`-${w!.balance}`}::numeric, 'admin_adjust', ${`kb-zero-${f.orgS}`}, null, 'test zero')`;
    const r = await ask(makeApp(new FakeProvider()), f.ownerS, f.orgS, "hello");
    expect(r.done?.answeredBy).toBe("rules");
    const paid = await ask(makeApp(new FakeProvider()), f.ownerS, f.orgS, "what is a ledger?");
    expect(paid.status).toBe(402);
  });
});

describe("knowledge in AI answers", () => {
  it("sends the matching help text to the AI and returns its pages as sources", async () => {
    const provider = new FakeProvider({ reply: "Open [Goods Receipts](/purchasing/receipts) and link the PO." });
    const r = await ask(makeApp(provider), f.ownerA, f.orgA, "How do I record goods received for a purchase order?");
    const lastMsg = provider.lastRequest!.messages.at(-1)!;
    const sent = lastMsg.role === "user" ? lastMsg.content : "";
    expect(sent).toContain("<softoras_help>");
    expect(sent).toContain("Goods Receipts");
    expect(sent).toMatch(/User question: How do I record goods received for a purchase order\?$/);
    expect(r.done?.sources?.[0]).toEqual({ title: "Goods Receipts", urlPath: "/purchasing/receipts" });

    // Saved with the reply; the saved QUESTION is the user's own text only.
    const headers = { Authorization: `Bearer ${await signTestToken(f.ownerA)}`, "X-Organization-Id": f.orgA };
    const msgs = (await (await makeApp(provider).request(`/v1/chat/conversations/${r.conversationId}/messages`, { headers })).json()) as any;
    expect(msgs.messages[0].content).toBe("How do I record goods received for a purchase order?");
    expect(msgs.messages[1].sources[0].urlPath).toBe("/purchasing/receipts");
    expect(msgs.messages[1].answeredBy).toBe("model");
  });
});

describe("answer cache", () => {
  it("the same first question in a new chat is answered from cache: free, AI not called", async () => {
    const provider = new FakeProvider({ reply: "Draft invoices do not post to the ledger." });
    const app = makeApp(provider);
    const q = "Do draft invoices post to the ledger?";
    const first = await ask(app, f.ownerA, f.orgA, q);
    expect(first.done?.answeredBy).toBe("model");
    expect(provider.calls).toBe(1);

    const second = await ask(app, f.salesA, f.orgA, `  do DRAFT invoices post to the ledger  `); // same org, other user, different spacing/case
    expect(second.done).toMatchObject({ answeredBy: "cache", creditsCharged: "0.0000" });
    expect(second.text).toBe("Draft invoices do not post to the ledger.");
    expect(provider.calls).toBe(1);
  });

  it("is never shared with another organization", async () => {
    const provider = new FakeProvider({ reply: "Org B's own answer." });
    const r = await ask(makeApp(provider), f.ownerB, f.orgB, "Do draft invoices post to the ledger?");
    expect(r.done?.answeredBy).toBe("model");
    expect(r.text).toBe("Org B's own answer.");
  });

  it("follow-up questions inside a chat are never answered from cache", async () => {
    const provider = new FakeProvider({ reply: "Answer in context." });
    const app = makeApp(provider);
    const first = await ask(app, f.ownerA, f.orgA, "Tell me about receivables");
    const follow = await ask(app, f.ownerA, f.orgA, "Do draft invoices post to the ledger?", first.conversationId);
    expect(follow.done?.answeredBy).toBe("model");
  });
});
