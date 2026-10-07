import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createSql, type Sql } from "../../src/db/client.js";
import { createSqlCreditStore, InsufficientCreditsError, ModelNotPricedError } from "../../src/credits/store.js";
import { createMeteredRunner } from "../../src/credits/metering.js";
import { FakeProvider } from "../../src/ai/fake-provider.js";
import { AiProviderError } from "../../src/ai/provider.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";

/**
 * Metering against the REAL database functions, as the restricted backend role.
 * Price used here (test model only): 2 credits per 1,000 input tokens and
 * 10 credits per 1,000 output tokens.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
const MODEL = `test-model-${Date.now()}`;
const logger = pino({ level: "silent" });

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 20 });
  f = await createFixtures(admin);
  // The backend role may add prices (never edit old ones).
  await service`insert into soft_ai.model_rates (model, input_credits_per_1k, output_credits_per_1k)
                values (${MODEL}, 2, 10)`;
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await admin`delete from soft_ai.model_rates where model = ${MODEL}`;
  await service?.end();
  await admin?.end();
});

async function wallet(org: string) {
  const [w] = await service<{ balance: string; reserved: string }[]>`
    select balance::text, reserved::text from soft_ai.wallets where organization_id = ${org}::uuid`;
  return w ?? { balance: "0.0000", reserved: "0.0000" };
}

function run(provider: FakeProvider, timeoutMs = 5000) {
  return createMeteredRunner({ store: createSqlCreditStore(service), provider, logger, options: { timeoutMs } });
}

const call = (org: string, user: string, maxOutputTokens = 500) => ({
  organizationId: org,
  userId: user,
  request: { model: MODEL, messages: [{ role: "user" as const, content: "How many unpaid invoices?" }], maxOutputTokens },
  reference: { message_id: "test-message" },
});

describe("metered AI calls on the real database", () => {
  it("charges the exact real cost and records the details in the ledger", async () => {
    await service`select soft_ai.add_credits(${f.orgA}::uuid, 100, 'purchase', ${`m-buy-${f.orgA}`})`;
    // 1,234 input tokens * 2/1000 + 567 output * 10/1000 = 2.468 + 5.67 = 8.138
    const out = await run(new FakeProvider({ usage: { inputTokens: 1234, outputTokens: 567 } }))(call(f.orgA, f.ownerA));

    expect(out.charged).toBe("8.1380");
    expect(await wallet(f.orgA)).toEqual({ balance: "91.8620", reserved: "0.0000" });

    const [entry] = await admin<{ amount: string; reference: Record<string, unknown> }[]>`
      select amount::text, reference from soft_ai.ledger where reservation_id = ${out.reservationId}`;
    expect(entry?.amount).toBe("-8.1380");
    expect(entry?.reference).toMatchObject({
      model: MODEL,
      input_tokens: 1234,
      output_tokens: 567,
      usage_estimated: false,
      message_id: "test-message",
      provider: "fake",
    });
  });

  it("hard stop: with zero credits the AI is never called", async () => {
    const provider = new FakeProvider();
    await expect(run(provider)(call(f.orgB, f.ownerB))).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(provider.calls).toBe(0);
  });

  it("needs enough credits for the WORST case before calling", async () => {
    // Org S has 1 credit. Worst case = small input + 500 output tokens * 10/1000 = over 5 credits.
    await service`select soft_ai.add_credits(${f.orgS}::uuid, 1, 'trial', ${`m-trial-${f.orgS}`})`;
    const provider = new FakeProvider();
    await expect(run(provider)(call(f.orgS, f.ownerS))).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(provider.calls).toBe(0);
    // With a shorter reply cap the same balance is enough.
    const out = await run(new FakeProvider({ usage: { inputTokens: 10, outputTokens: 5 } }))(call(f.orgS, f.ownerS, 50));
    expect(out.charged).toBe("0.0700"); // 10*2/1000 + 5*10/1000
  });

  it("a failed AI call leaves the balance exactly as it was", async () => {
    const before = await wallet(f.orgA);
    await expect(run(new FakeProvider({ fail: true }))(call(f.orgA, f.ownerA))).rejects.toBeInstanceOf(AiProviderError);
    expect(await wallet(f.orgA)).toEqual(before);
  });

  it("refuses a model without a price", async () => {
    const provider = new FakeProvider();
    const req = { ...call(f.orgA, f.ownerA), request: { ...call(f.orgA, f.ownerA).request, model: "no-price-model" } };
    await expect(run(provider)(req)).rejects.toBeInstanceOf(ModelNotPricedError);
    expect(provider.calls).toBe(0);
  });

  it("15 AI calls at once on a small balance: only what the balance covers is called, nothing overspent", async () => {
    // Org B gets 30 credits. Worst case per call ~ (small input * 2 + 500*10)/1000 = just over 5 credits,
    // so at most 5 calls can hold credits at the same time.
    await service`select soft_ai.add_credits(${f.orgB}::uuid, 30, 'purchase', ${`m-buy-${f.orgB}`})`;
    const provider = new FakeProvider({ usage: { inputTokens: 100, outputTokens: 100 }, delayMs: 100 });
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => run(provider)(call(f.orgB, f.ownerB))));

    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(provider.calls); // every AI call that ran was paid for
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(5);
    // Each call cost 100*2/1000 + 100*10/1000 = 1.2 credits.
    const w = await wallet(f.orgB);
    expect(w.reserved).toBe("0.0000");
    expect(Number(w.balance)).toBeCloseTo(30 - ok * 1.2, 4);
    expect(await admin`select * from soft_ai.check_wallet_integrity()`).toHaveLength(0);
  });
});
