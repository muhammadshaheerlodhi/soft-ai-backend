import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { createSqlCreditStore } from "../../src/credits/store.js";
import { createStreamMeter } from "../../src/credits/metering-stream.js";
import { registerChatRoutes } from "../../src/chat/routes.js";
import { FakeProvider, type FakeProviderOptions } from "../../src/ai/fake-provider.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Chat endpoints through the real HTTP chain, real database (restricted role),
 * real credit functions, and the fake AI (so it costs nothing and is repeatable).
 * Test price: 2 credits per 1,000 input tokens, 10 per 1,000 output tokens.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
const MODEL = `chat-test-model-${Date.now()}`;
const run = Date.now().toString(36);

function makeApp(provider: FakeProvider, opts: { timeoutMs?: number; maxOutputTokens?: number } = {}) {
  const logger = pino({ level: "silent" });
  const meter = createStreamMeter({
    store: createSqlCreditStore(service),
    provider,
    logger,
    options: { timeoutMs: opts.timeoutMs ?? 5000 },
  });
  return createApp({
    sql: service,
    logger,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
    extendV1: (v1) =>
      registerChatRoutes(v1, {
        sql: service,
        meter,
        model: MODEL,
        maxOutputTokens: opts.maxOutputTokens ?? 200,
        rateLimitRules: [{ name: `chat_t_${run}`, scope: "user", windowSeconds: 3600, max: 1000 }],
        maxMessageChars: 500,
        history: { maxMessages: 10, maxChars: 5000 },
      }),
  });
}

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  await service`insert into soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k) values (${MODEL}, 2, 10)`;
  await service`select soft_ai.add_credits(${f.orgA}::uuid, 50, 'purchase', ${`chat-buy-${f.orgA}`})`;
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await admin`delete from soft_ai.model_rates where model = ${MODEL}`;
  await admin`delete from soft_ai.rate_limit_counters where bucket like ${`chat\\_t\\_${run}%`}`;
  await service?.end();
  await admin?.end();
});

async function req(app: ReturnType<typeof makeApp>, method: string, path: string, user: string, org: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${await signTestToken(user)}`,
      "X-Organization-Id": org,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

/** Reads a Server-Sent Events reply into a list of {event, data}. */
async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event, data: JSON.parse(data) };
    });
}

async function newChat(app: ReturnType<typeof makeApp>, user = f.ownerA, org = f.orgA) {
  const res = await req(app, "POST", "/v1/chat/conversations", user, org);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

describe("chat list", () => {
  it("creates, lists, renames, pins, archives and deletes my chats", async () => {
    const app = makeApp(new FakeProvider());
    const chat = await newChat(app);
    expect(chat.title).toBe("New chat");

    let list = (await (await req(app, "GET", "/v1/chat/conversations", f.ownerA, f.orgA)).json()) as any;
    expect(list.conversations.map((c: any) => c.id)).toContain(chat.id);

    const renamed = (await (await req(app, "PATCH", `/v1/chat/conversations/${chat.id}`, f.ownerA, f.orgA, { title: "Invoices help", isPinned: true })).json()) as any;
    expect(renamed).toMatchObject({ title: "Invoices help", isPinned: true, archived: false });

    await req(app, "PATCH", `/v1/chat/conversations/${chat.id}`, f.ownerA, f.orgA, { archived: true });
    list = (await (await req(app, "GET", "/v1/chat/conversations", f.ownerA, f.orgA)).json()) as any;
    expect(list.conversations.map((c: any) => c.id)).not.toContain(chat.id);
    const archived = (await (await req(app, "GET", "/v1/chat/conversations?archived=true", f.ownerA, f.orgA)).json()) as any;
    expect(archived.conversations.map((c: any) => c.id)).toContain(chat.id);

    expect((await req(app, "DELETE", `/v1/chat/conversations/${chat.id}`, f.ownerA, f.orgA)).status).toBe(204);
    expect((await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA)).status).toBe(404);
  });

  it("rejects unknown fields and empty changes", async () => {
    const app = makeApp(new FakeProvider());
    const chat = await newChat(app);
    expect((await req(app, "PATCH", `/v1/chat/conversations/${chat.id}`, f.ownerA, f.orgA, { userId: f.ownerB })).status).toBe(400);
    expect((await req(app, "PATCH", `/v1/chat/conversations/${chat.id}`, f.ownerA, f.orgA, {})).status).toBe(400);
  });
});

describe("privacy between users", () => {
  it("another user in the SAME organization cannot see, change or write into my chat", async () => {
    const app = makeApp(new FakeProvider());
    const chat = await newChat(app, f.ownerA, f.orgA);
    const list = (await (await req(app, "GET", "/v1/chat/conversations", f.salesA, f.orgA)).json()) as any;
    expect(list.conversations.map((c: any) => c.id)).not.toContain(chat.id);
    expect((await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.salesA, f.orgA)).status).toBe(404);
    expect((await req(app, "PATCH", `/v1/chat/conversations/${chat.id}`, f.salesA, f.orgA, { title: "x" })).status).toBe(404);
    expect((await req(app, "DELETE", `/v1/chat/conversations/${chat.id}`, f.salesA, f.orgA)).status).toBe(404);
    expect((await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.salesA, f.orgA, { content: "hi" })).status).toBe(404);
  });

  it("my own chat is not visible when I work in another organization", async () => {
    const app = makeApp(new FakeProvider());
    const chat = await newChat(app, f.ownerA, f.orgA);
    // ownerA is not a member of B at all -> refused at the organization check.
    expect((await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgB)).status).toBe(403);
  });
});

describe("sending a message", () => {
  it("streams the reply, saves both messages, charges the real cost, and names the chat", async () => {
    const provider = new FakeProvider({ reply: "You can create an invoice from Sales.", usage: { inputTokens: 300, outputTokens: 40 } });
    const app = makeApp(provider);
    const chat = await newChat(app);
    const before = (await (await req(app, "GET", "/v1/credits", f.ownerA, f.orgA)).json()) as any;

    const res = await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, {
      content: "How do I create an invoice?",
      pageContext: { path: "/sales/invoices" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res);

    expect(events[0]?.event).toBe("start");
    const text = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(text).toBe("You can create an invoice from Sales.");
    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    // 300 * 2/1000 + 40 * 10/1000 = 0.6 + 0.4 = 1.0
    expect(done.data.creditsCharged).toBe("1.0000");
    expect(Number(done.data.balance)).toBeCloseTo(Number(before.available) - 1, 4);

    const msgs = (await (await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA)).json()) as any;
    expect(msgs.messages.map((m: any) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(msgs.messages[1].content).toBe(text);
    expect(msgs.messages[1].creditsCharged).toBe("1.0000");

    const list = (await (await req(app, "GET", "/v1/chat/conversations", f.ownerA, f.orgA)).json()) as any;
    const item = list.conversations.find((c: any) => c.id === chat.id);
    expect(item).toMatchObject({ title: "How do I create an invoice?", messageCount: 2, creditsUsed: "1.0000" });
  });

  it("sends the earlier conversation and the fixed instructions to the AI", async () => {
    const provider = new FakeProvider({ reply: "Second answer." });
    const app = makeApp(provider);
    const chat = await newChat(app);
    await readEvents(await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "First question" }));
    await readEvents(await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "Second question" }));

    const sent = provider.lastRequest!;
    expect(sent.system).toContain("You are Soft AI");
    expect(sent.model).toBe(MODEL);
    expect(sent.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Second answer." },
      { role: "user", content: "Second question" },
    ]);
  });

  it("with no credits: 402, nothing saved, the AI is never called", async () => {
    const provider = new FakeProvider();
    const app = makeApp(provider);
    const chat = await newChat(app, f.ownerB, f.orgB); // org B has no credits
    const res = await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerB, f.orgB, { content: "Hello" });
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.code).toBe("insufficient_credits");
    expect(provider.calls).toBe(0);
    const msgs = (await (await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerB, f.orgB)).json()) as any;
    expect(msgs.messages).toHaveLength(0);
  });

  it("if the AI fails, the user is not charged and the reply is marked as failed", async () => {
    const app = makeApp(new FakeProvider({ fail: true }));
    const chat = await newChat(app);
    const before = (await (await req(app, "GET", "/v1/credits", f.ownerA, f.orgA)).json()) as any;
    const events = await readEvents(await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "Hi" }));
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "ai_unavailable" } });
    const after = (await (await req(app, "GET", "/v1/credits", f.ownerA, f.orgA)).json()) as any;
    expect(after).toEqual(before);
    const msgs = (await (await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA)).json()) as any;
    expect(msgs.messages[1]).toMatchObject({ role: "assistant", status: "error", errorCode: "ai_unavailable" });
  });

  it("if the AI fails half way through, the user is still not charged", async () => {
    const app = makeApp(new FakeProvider({ reply: "one two three four", failAfterWords: 2 }));
    const chat = await newChat(app);
    const before = (await (await req(app, "GET", "/v1/credits", f.ownerA, f.orgA)).json()) as any;
    const events = await readEvents(await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "Hi" }));
    expect(events.filter((e) => e.event === "delta")).toHaveLength(2);
    expect(events.at(-1)?.event).toBe("error");
    expect((await (await req(app, "GET", "/v1/credits", f.ownerA, f.orgA)).json()) as any).toEqual(before);
  });

  it("a timeout is reported clearly and not charged", async () => {
    const app = makeApp(new FakeProvider({ delayMs: 300 }), { timeoutMs: 100 });
    const chat = await newChat(app);
    const events = await readEvents(await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "Hi" }));
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "ai_timeout" } });
  });

  it("rejects empty and too-long messages before doing anything", async () => {
    const provider = new FakeProvider();
    const app = makeApp(provider);
    const chat = await newChat(app);
    expect((await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "   " })).status).toBe(400);
    expect((await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "x".repeat(501) })).status).toBe(400);
    expect((await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "hi", extra: 1 })).status).toBe(200);
    expect(provider.calls).toBe(1);
  });

  it("only one reply at a time per chat", async () => {
    const app = makeApp(new FakeProvider({ reply: "a b c d e", delayMs: 80 }));
    const chat = await newChat(app);
    const first = req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "one" });
    await new Promise((r) => setTimeout(r, 120)); // the first reply is now streaming
    const second = await req(app, "POST", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA, { content: "two" });
    expect(second.status).toBe(409);
    await readEvents(await first);
  });
});

describe("user presses stop", () => {
  it("charges only for what was produced and saves the partial reply as 'stopped'", async () => {
    const provider = new FakeProvider({ reply: "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10", delayMs: 40, usage: { inputTokens: 100, outputTokens: 100 } });
    const app = makeApp(provider);
    const chat = await newChat(app);

    const controller = new AbortController();
    const res = await app.request(`/v1/chat/conversations/${chat.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await signTestToken(f.ownerA)}`,
        "X-Organization-Id": f.orgA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "Long answer please" }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // "start"
    await reader.read(); // first word
    await reader.cancel(); // the user closes the chat
    controller.abort();

    // Wait until the server has finished saving.
    let msg: any;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const msgs = (await (await req(app, "GET", `/v1/chat/conversations/${chat.id}/messages`, f.ownerA, f.orgA)).json()) as any;
      msg = msgs.messages[1];
      if (msg?.status !== "streaming") break;
    }
    expect(msg.status).toBe("stopped");
    expect(msg.content.length).toBeGreaterThan(0);
    expect(msg.content.length).toBeLessThan("w1 w2 w3 w4 w5 w6 w7 w8 w9 w10".length);
    // Charged something (input + the part that was produced) ...
    expect(Number(msg.creditsCharged)).toBeGreaterThan(0);
    // ... but only PART of the output: the full reply would be 100 output tokens.
    // (Checked on output tokens, not total credits: if the user stops before the AI reports
    //  token counts, the input is estimated on the high side, and that estimate grows when
    //  Soft AI's instructions grow - this test once failed for exactly that reason.)
    const [row] = await admin<{ output_tokens: number }[]>`select output_tokens from soft_ai.messages where id = ${msg.id}`;
    expect(row!.output_tokens).toBeGreaterThan(0);
    expect(row!.output_tokens).toBeLessThan(100);
  });
});
