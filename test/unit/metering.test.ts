import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { createMeteredRunner, AiTimeoutError } from "../../src/credits/metering.js";
import { InsufficientCreditsError, ModelNotPricedError, type CreditStore } from "../../src/credits/store.js";
import { FakeProvider } from "../../src/ai/fake-provider.js";
import { AiProviderError, type AiProvider } from "../../src/ai/provider.js";
import { estimateInputTokens } from "../../src/ai/token-estimate.js";

/** In-memory credit store that records every call, with switches to simulate failures. */
function memoryStore(opts: { balanceOk?: boolean; settleFailures?: number; priced?: boolean; zeroPrice?: boolean } = {}) {
  const log: string[] = [];
  let settleFailuresLeft = opts.settleFailures ?? 0;
  const store: CreditStore = {
    async computeCost(model, input, output) {
      if (opts.priced === false) throw new ModelNotPricedError(model);
      if (opts.zeroPrice) return "0.0000";
      log.push(`cost:${input}:${output}`);
      return `${input + output}.0000`; // 1 credit per token, easy to read in tests
    },
    async reserve(_org, _user, amount) {
      if (opts.balanceOk === false) throw new InsufficientCreditsError();
      log.push(`reserve:${amount}`);
      return "res-1";
    },
    async settle(id, amount, reference) {
      if (settleFailuresLeft > 0) {
        settleFailuresLeft -= 1;
        log.push("settle:fail");
        throw new Error("database unreachable");
      }
      log.push(`settle:${id}:${amount}:${reference.usage_estimated}`);
    },
    async release(id) {
      log.push(`release:${id}`);
    },
  };
  return { store, log };
}

const base = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  request: { model: "test-model", messages: [{ role: "user" as const, content: "hello" }], maxOutputTokens: 50 },
};
const logger = pino({ level: "silent" });
// eslint-disable-next-line require-yield
async function* notUsed(): AsyncIterable<never> { throw new Error("stream not used in this test"); }

function runner(store: CreditStore, provider: AiProvider, timeoutMs = 2000) {
  return createMeteredRunner({ store, provider, logger, options: { timeoutMs, settleRetryDelayMs: 1 } });
}

describe("metered AI calls", () => {
  it("holds the worst case, then charges the real token cost", async () => {
    const { store, log } = memoryStore();
    const provider = new FakeProvider({ usage: { inputTokens: 7, outputTokens: 3 } });
    const out = await runner(store, provider)(base);

    const estimate = estimateInputTokens(undefined, base.request.messages);
    expect(log).toEqual([
      `cost:${estimate}:50`, // worst case: estimated input + reply cap
      `reserve:${estimate + 50}.0000`,
      "cost:7:3", // real usage
      "settle:res-1:10.0000:false",
    ]);
    expect(out.charged).toBe("10.0000");
    expect(out.usageEstimated).toBe(false);
  });

  it("never calls the AI when there are not enough credits", async () => {
    const { store } = memoryStore({ balanceOk: false });
    const provider = new FakeProvider();
    await expect(runner(store, provider)(base)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(provider.calls).toBe(0);
  });

  it("never calls the AI when the model has no price (no free answers by mistake)", async () => {
    const { store } = memoryStore({ priced: false });
    const provider = new FakeProvider();
    await expect(runner(store, provider)(base)).rejects.toBeInstanceOf(ModelNotPricedError);
    expect(provider.calls).toBe(0);
  });

  it("releases the hold and charges nothing when the AI fails", async () => {
    const { store, log } = memoryStore();
    await expect(runner(store, new FakeProvider({ fail: true }))(base)).rejects.toBeInstanceOf(AiProviderError);
    expect(log.at(-1)).toBe("release:res-1");
    expect(log.some((l) => l.startsWith("settle"))).toBe(false);
  });

  it("wraps unexpected provider errors without leaking them", async () => {
    const { store } = memoryStore();
    const broken: AiProvider = { name: "broken", generate: async () => { throw new TypeError("boom"); }, stream: notUsed };
    await expect(runner(store, broken)(base)).rejects.toBeInstanceOf(AiProviderError);
  });

  it("times out, releases the hold, and charges nothing", async () => {
    const { store, log } = memoryStore();
    await expect(runner(store, new FakeProvider({ delayMs: 500 }), 50)(base)).rejects.toBeInstanceOf(AiTimeoutError);
    expect(log.at(-1)).toBe("release:res-1");
  });

  it("times out even if the provider ignores the stop signal", async () => {
    const { store } = memoryStore();
    const stubborn: AiProvider = {
      name: "stubborn",
      generate: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late", model: "m", usage: null }), 500)),
      stream: notUsed,
    };
    await expect(runner(store, stubborn, 50)(base)).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it("charges the (high) estimate when the provider reports no token counts, and flags it", async () => {
    const { store, log } = memoryStore();
    const out = await runner(store, new FakeProvider({ usage: null }))(base);
    const estimate = estimateInputTokens(undefined, base.request.messages);
    expect(out.usageEstimated).toBe(true);
    expect(out.charged).toBe(`${estimate + 50}.0000`);
    expect(log.at(-1)).toContain(":true");
  });

  it("retries a failed charge and succeeds", async () => {
    const { store, log } = memoryStore({ settleFailures: 2 });
    const out = await runner(store, new FakeProvider())(base);
    expect(log.filter((l) => l === "settle:fail")).toHaveLength(2);
    expect(out.charged).not.toBeNull();
  });

  it("if charging keeps failing, the user still gets the answer and is NOT charged", async () => {
    const { store } = memoryStore({ settleFailures: 99 });
    const out = await runner(store, new FakeProvider({ reply: "answer" }))(base);
    expect(out.result.text).toBe("answer");
    expect(out.charged).toBeNull(); // the hold expires on its own; logged for reconciliation
  });

  it("a free (zero-price) model still respects the zero-credit stop", async () => {
    const { store, log } = memoryStore({ zeroPrice: true });
    await runner(store, new FakeProvider())(base);
    expect(log[0]).toBe("reserve:0.0001");
  });
});

describe("token estimate", () => {
  it("over-estimates on purpose, and counts Urdu on the safe side", () => {
    const english = estimateInputTokens(undefined, [{ role: "user", content: "Show me unpaid invoices" }]);
    expect(english).toBeGreaterThanOrEqual(Math.ceil(24 / 4)); // above the usual ~4 chars/token
    const urdu = estimateInputTokens(undefined, [{ role: "user", content: "غیر ادا شدہ انوائس دکھائیں" }]);
    expect(urdu).toBeGreaterThan(english);
  });
});
