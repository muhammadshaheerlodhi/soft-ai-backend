import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { rateLimit } from "../../src/http/rate-limit.js";
import { InsufficientCreditsError } from "../../src/credits/store.js";
import { AiTimeoutError } from "../../src/credits/metering.js";
import { AiProviderError } from "../../src/ai/provider.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * Request limits and AI error messages, through the REAL HTTP chain
 * (login check -> organization check -> limit -> route).
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
const run = Date.now().toString(36); // unique limit names per test run

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  app = createApp({
    sql: service,
    logger: pino({ level: "silent" }),
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
    extendV1: (v1) => {
      // 3 per user and 5 per organization per HOUR: small numbers to test quickly, and a long
      // window so a window boundary is very unlikely to pass during the test
      v1.post(
        "/test/limited",
        rateLimit(service, [
          { name: `t_user_${run}`, scope: "user", windowSeconds: 3600, max: 3 },
          { name: `t_org_${run}`, scope: "organization", windowSeconds: 3600, max: 5 },
        ]),
        (c) => c.json({ ok: true }),
      );
      v1.post("/test/no-credits", () => { throw new InsufficientCreditsError(); });
      v1.post("/test/ai-timeout", () => { throw new AiTimeoutError(); });
      v1.post("/test/ai-down", () => { throw new AiProviderError("upstream 500: secret internal detail"); });
    },
  });
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await admin`delete from soft_ai.rate_limit_counters where bucket like ${`t\\_%${run}%`}`;
  await service?.end();
  await admin?.end();
});

async function post(path: string, user: string, org: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${await signTestToken(user)}`, "X-Organization-Id": org },
  });
  return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get("Retry-After") };
}

describe("request limits", () => {
  it("lets a user make 3 requests, then answers 429 with a wait time", async () => {
    for (let i = 0; i < 3; i++) expect((await post("/v1/test/limited", f.salesA, f.orgA)).status).toBe(200);
    const r = await post("/v1/test/limited", f.salesA, f.orgA);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(Number(r.retryAfter)).toBeGreaterThan(0);
    expect(Number(r.retryAfter)).toBeLessThanOrEqual(3600);
  });

  it("one user hitting the limit does not block another user", async () => {
    expect((await post("/v1/test/limited", f.ownerA, f.orgA)).status).toBe(200);
  });

  it("the organization limit protects the whole organization", async () => {
    // Org A has used 4 so far: 3 by sales + 1 by owner. The sales request refused by the
    // USER limit is not counted against the organization (refused requests use nothing).
    expect((await post("/v1/test/limited", f.ownerA, f.orgA)).status).toBe(200); // 5th: allowed
    const r = await post("/v1/test/limited", f.ownerA, f.orgA); // 6th: over the org limit of 5
    expect(r.status).toBe(429);
  });

  it("other organizations are not affected", async () => {
    expect((await post("/v1/test/limited", f.ownerB, f.orgB)).status).toBe(200);
  });

  it("checks login BEFORE counting: anonymous requests do not use anyone's limit", async () => {
    const res = await app.request("/v1/test/limited", { method: "POST", headers: { "X-Organization-Id": f.orgB } });
    expect(res.status).toBe(401);
  });
});

describe("AI and credit errors shown to the user", () => {
  it("no credits -> 402 with a clear message", async () => {
    const r = await post("/v1/test/no-credits", f.ownerA, f.orgA);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("insufficient_credits");
  });

  it("timeout -> 504, says the user was not charged", async () => {
    const r = await post("/v1/test/ai-timeout", f.ownerA, f.orgA);
    expect(r.status).toBe(504);
    expect(r.body.error.message).toContain("not charged");
  });

  it("provider failure -> 502, never shows internal details", async () => {
    const r = await post("/v1/test/ai-down", f.ownerA, f.orgA);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("secret internal detail");
  });
});
