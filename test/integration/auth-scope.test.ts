import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

let admin: Sql;
let service: Sql;
let f: Fixtures;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 5 });
  f = await createFixtures(admin);
  app = createApp({
    sql: service, // the app runs with the SAME restricted role as production
    logger: pino({ level: "silent" }),
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken: createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret }),
  });
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await service?.end();
  await admin?.end();
});

async function call(path: string, opts: { user?: string; token?: string; org?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token ?? (opts.user ? await signTestToken(opts.user) : undefined);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.org) headers["X-Organization-Id"] = opts.org;
  const res = await app.request(path, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, raw: text };
}

describe("public endpoints", () => {
  it("health and ready need no login", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/ready")).body).toEqual({ status: "ready" });
  });

  it("unknown paths return a clean 404", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });
});

describe("login check", () => {
  it("rejects requests without a token", async () => {
    const r = await call("/v1/me", { org: f.orgA });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
    expect(r.body.error.requestId).toBe(r.headers.get("X-Request-Id"));
  });

  it("rejects an expired token with a clear code", async () => {
    const token = await signTestToken(f.ownerA, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const r = await call("/v1/me", { token, org: f.orgA });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("expired_token");
  });

  it("rejects a forged token", async () => {
    const token = await signTestToken(f.ownerA, { secret: "forged-secret-forged-secret-forged-secret-00" });
    expect((await call("/v1/me", { token, org: f.orgA })).status).toBe(401);
  });

  it("never echoes the token back in an error", async () => {
    const token = await signTestToken(f.ownerA, { secret: "forged-secret-forged-secret-forged-secret-00" });
    const r = await call("/v1/me", { token, org: f.orgA });
    expect(r.raw).not.toContain(token);
  });
});

describe("organization scope", () => {
  it("requires an organization", async () => {
    const r = await call("/v1/me", { user: f.ownerA });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("missing_organization");
  });

  it("rejects an organization id that is not a uuid", async () => {
    const r = await call("/v1/me", { user: f.ownerA, org: "1 OR 1=1" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_organization");
  });

  it("owner of A gets their context", async () => {
    const r = await call("/v1/me", { user: f.ownerA, org: f.orgA });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: f.ownerA, organizationId: f.orgA, isOwner: true, parentOrganizationId: null });
  });

  it("sales user of A gets exactly their role's permissions", async () => {
    const r = await call("/v1/me", { user: f.salesA, org: f.orgA });
    expect(r.status).toBe(200);
    expect(r.body.isOwner).toBe(false);
    expect(r.body.permissions).toEqual(["sales.view"]);
  });

  it("a member of A cannot use organization B", async () => {
    const r = await call("/v1/me", { user: f.salesA, org: f.orgB });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
  });

  it("owner of B cannot use organization A", async () => {
    expect((await call("/v1/me", { user: f.ownerB, org: f.orgA })).status).toBe(403);
  });

  it("a deactivated member is refused", async () => {
    expect((await call("/v1/me", { user: f.inactiveA, org: f.orgA })).status).toBe(403);
  });

  it("a user with no organization is refused", async () => {
    expect((await call("/v1/me", { user: f.stranger, org: f.orgA })).status).toBe(403);
  });

  it("a non-existent organization looks the same as a forbidden one", async () => {
    const r = await call("/v1/me", { user: f.ownerA, org: "00000000-0000-4000-8000-00000000dead" });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("You do not have access to this organization.");
  });

  it("removing someone from an organization takes effect on the next request", async () => {
    expect((await call("/v1/me", { user: f.salesA, org: f.orgA })).status).toBe(200);
    await admin`update public.organization_members set is_active = false where organization_id = ${f.orgA} and user_id = ${f.salesA}`;
    try {
      expect((await call("/v1/me", { user: f.salesA, org: f.orgA })).status).toBe(403);
    } finally {
      await admin`update public.organization_members set is_active = true where organization_id = ${f.orgA} and user_id = ${f.salesA}`;
    }
  });
});

describe("sub-accounts", () => {
  it("the sub-account owner works in the sub-account and sees its agency", async () => {
    const r = await call("/v1/me", { user: f.ownerS, org: f.orgS });
    expect(r.status).toBe(200);
    expect(r.body.parentOrganizationId).toBe(f.orgA);
  });

  it("the agency owner is NOT automatically a member of the sub-account (same as the ERP)", async () => {
    expect((await call("/v1/me", { user: f.ownerA, org: f.orgS })).status).toBe(403);
  });

  it("the sub-account owner cannot use the agency", async () => {
    expect((await call("/v1/me", { user: f.ownerS, org: f.orgA })).status).toBe(403);
  });
});

describe("credits balance", () => {
  it("starts at zero", async () => {
    const r = await call("/v1/credits", { user: f.ownerB, org: f.orgB });
    expect(r.body).toMatchObject({ balance: "0.0000", reserved: "0.0000", available: "0.0000", warnings: ["empty"] });
  });

  it("shows the organization's own balance only", async () => {
    await admin`select soft_ai.add_credits(${f.orgA}::uuid, 25, 'purchase', ${`it-buy-${f.orgA}`})`;
    const a = await call("/v1/credits", { user: f.salesA, org: f.orgA });
    expect(a.body).toMatchObject({ balance: "25.0000", reserved: "0.0000", available: "25.0000", warnings: [] });
    const b = await call("/v1/credits", { user: f.ownerB, org: f.orgB });
    expect(b.body.balance).toBe("0.0000");
    expect((await call("/v1/credits", { user: f.ownerB, org: f.orgA })).status).toBe(403);
  });
});

describe("browser rules (CORS)", () => {
  it("allows the ERP's website", async () => {
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: TEST_ENV.allowedOrigin, "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(TEST_ENV.allowedOrigin);
  });

  it("allows every method the panels use (admin settings use PUT)", async () => {
    const res = await app.request("/admin/v1/support-calls/settings", {
      method: "OPTIONS",
      headers: { Origin: TEST_ENV.allowedOrigin, "Access-Control-Request-Method": "PUT" },
    });
    const allowed = (res.headers.get("Access-Control-Allow-Methods") ?? "").split(",").map((m) => m.trim());
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) expect(allowed).toContain(m);
  });

  it("does not allow other websites", async () => {
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
