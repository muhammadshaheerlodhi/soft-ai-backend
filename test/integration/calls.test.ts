import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import { createSql, type Sql } from "../../src/db/client.js";
import { createTokenVerifier } from "../../src/auth/verify-token.js";
import { createAdminRoutes } from "../../src/admin/routes.js";
import { FakeCallProvider } from "../../src/calls/provider.js";
import { createCallService } from "../../src/calls/service.js";
import { createCallEvents, registerCallRoutes } from "../../src/calls/routes.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";
import { signTestToken } from "../helpers/tokens.js";

/**
 * "Talk to a person" calls (migration 112), with the fake voice provider.
 * Customers: ownerA / salesA (org A). Platform admins: ownerB and stranger.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;
let savedSettings: Record<string, unknown>;
const log = pino({ level: "silent" });
const provider = new FakeCallProvider();
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 10 });
  f = await createFixtures(admin);
  [savedSettings] = (await admin`select * from soft_ai.support_call_settings`) as unknown as [Record<string, unknown>];
  // Open all day, every day, while testing (hours are tested separately below).
  await admin`update soft_ai.support_call_settings set enabled = true, work_days = '{1,2,3,4,5,6,7}', start_time = '00:00', end_time = '23:59'`;
  await admin`insert into public.platform_admins (user_id, email, role) values
                (${f.ownerB}, ${`${f.ownerB}@soft-ai-test.local`}, 'support'),
                (${f.stranger}, ${`${f.stranger}@soft-ai-test.local`}, 'owner')`;
  const verifyToken = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret });
  const calls = { service: createCallService({ sql: service, provider, log }), events: createCallEvents(service, log) };
  app = createApp({
    sql: service,
    logger: log,
    corsAllowedOrigins: [TEST_ENV.allowedOrigin],
    verifyToken,
    extendRoot: (root) => root.route("/admin/v1", createAdminRoutes({ sql: service, verifyToken, calls })),
    extendV1: (v1) => registerCallRoutes(v1, { sql: service, calls: calls.service }),
  });
});

afterAll(async () => {
  if (savedSettings) {
    await admin`update soft_ai.support_call_settings set enabled = ${savedSettings.enabled as boolean}, work_days = ${savedSettings.work_days as number[]},
                  start_time = ${savedSettings.start_time as string}, end_time = ${savedSettings.end_time as string},
                  monthly_limit_minutes = ${(savedSettings.monthly_limit_minutes as number | null) ?? null}`;
  }
  if (f) {
    await admin`delete from public.platform_admins where user_id in ${admin([f.ownerB, f.stranger])}`;
    await admin`delete from public.organization_subscriptions where organization_id = ${f.orgA}`;
    await removeFixtures(admin, f);
  }
  await service?.end();
  await admin?.end();
});

async function call(method: string, path: string, user: string, org?: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${await signTestToken(user)}` };
  if (org) headers["X-Organization-Id"] = org;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const start = (user = f.ownerA) => call("POST", "/v1/support-calls", user, f.orgA, { pagePath: "/sales/invoices" });

describe("who may call", () => {
  it("only Pro and White Label plans", async () => {
    const r = await start();
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("Pro and White Label");
    expect((await call("GET", "/v1/support-calls/eligibility", f.ownerA, f.orgA)).body).toMatchObject({ ok: false, reason: "plan" });
    await admin`insert into public.organization_subscriptions (organization_id, plan_slug, status) values (${f.orgA}, 'pro', 'active')`;
    expect((await call("GET", "/v1/support-calls/eligibility", f.ownerA, f.orgA)).body).toMatchObject({ ok: true, plan: "pro" });
  });

  it("only during support hours", async () => {
    await admin`update soft_ai.support_call_settings set work_days = '{}'::int[] || (case when extract(isodow from now() at time zone 'Asia/Karachi') = 1 then 2 else 1 end)`;
    const r = await start();
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("Monday to Friday");
    await admin`update soft_ai.support_call_settings set work_days = '{1,2,3,4,5,6,7}'`;
  });
});

describe("a call from ringing to the end", () => {
  it("customer calls, the first admin answers, the second is told, the right admin ends it", async () => {
    const r = await start();
    expect(r.status).toBe(201);
    expect(r.body.room).toMatchObject({ url: expect.stringContaining("fake.daily.test/softoras-"), token: expect.stringContaining("caller") });
    const callId = r.body.callId as string;
    expect(provider.rooms.size).toBeGreaterThan(0);

    // Only one open call per user.
    expect((await start()).status).toBe(409);

    // Not a platform admin -> cannot answer.
    expect((await call("POST", `/admin/v1/support-calls/${callId}/answer`, f.ownerA)).status).toBe(403);

    // Two admins press Answer at the same moment: exactly one wins.
    const [a, b] = await Promise.all([
      call("POST", `/admin/v1/support-calls/${callId}/answer`, f.ownerB),
      call("POST", `/admin/v1/support-calls/${callId}/answer`, f.stranger),
    ]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(winner.body.room).toMatchObject({ url: r.body.room.url, token: expect.stringContaining("agent") });
    expect(loser.body.error.message).toContain("Already answered");

    // The customer sees it was answered.
    expect((await call("GET", `/v1/support-calls/${callId}`, f.ownerA, f.orgA)).body).toMatchObject({ status: "answered", organizationName: "Test Agency A", plan: "pro" });

    // Only the admin who answered can end it.
    const winnerUser = a.status === 200 ? f.ownerB : f.stranger;
    const otherUser = a.status === 200 ? f.stranger : f.ownerB;
    expect((await call("POST", `/admin/v1/support-calls/${callId}/end`, otherUser)).status).toBe(409);
    const ended = await call("POST", `/admin/v1/support-calls/${callId}/end`, winnerUser);
    expect(ended.body).toMatchObject({ status: "ended", endedBy: "agent" });
    expect(ended.body.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(provider.rooms.has(r.body.room.url.split("/").pop())).toBe(false); // room closed

    // Shows in the call log.
    const logRes = await call("GET", "/admin/v1/support-calls", f.ownerB);
    expect(logRes.body.calls.find((x: { id: string }) => x.id === callId)).toMatchObject({ status: "ended", callerEmail: `${f.ownerA}@soft-ai-test.local` });
  });

  it("nobody answers in time -> missed; it can no longer be answered", async () => {
    const r = await start();
    await admin`update soft_ai.support_calls set ring_until = now() - interval '1 second' where id = ${r.body.callId}`;
    expect((await call("GET", `/v1/support-calls/${r.body.callId}`, f.ownerA, f.orgA)).body).toMatchObject({ status: "missed", endedBy: "system" });
    expect((await call("POST", `/admin/v1/support-calls/${r.body.callId}/answer`, f.ownerB)).status).toBe(409);
  });

  it("customer hangs up while it rings -> cancelled; a new call can start", async () => {
    const r = await start();
    expect((await call("POST", `/v1/support-calls/${r.body.callId}/hang-up`, f.ownerA, f.orgA)).body).toMatchObject({ status: "cancelled", endedBy: "caller" });
    const again = await start();
    expect(again.status).toBe(201);
    await call("POST", `/v1/support-calls/${again.body.callId}/hang-up`, f.ownerA, f.orgA);
  });

  it("another user or organization cannot see someone's call", async () => {
    const r = await start();
    expect((await call("GET", `/v1/support-calls/${r.body.callId}`, f.salesA, f.orgA)).status).toBe(404);
    expect((await call("GET", `/v1/support-calls/${r.body.callId}`, f.ownerB, f.orgB)).status).toBe(404);
    await call("POST", `/v1/support-calls/${r.body.callId}/hang-up`, f.ownerA, f.orgA);
  });
});

describe("monthly limit (stay inside Daily's free minutes)", () => {
  it("calls switch off once this month's minutes reach the limit; the admin sees the usage", async () => {
    // A finished 60-minute call this month: caller 60 min + admin 59 min = 119 participant-minutes.
    const [used] = await admin`
      insert into soft_ai.support_calls (organization_id, caller_user_id, plan_slug, status, room_name, room_url,
                                         created_at, ring_until, answered_at, ended_at, ended_by)
      values (${f.orgA}, ${f.salesA}, 'pro', 'ended', ${`softoras-limit-${Date.now()}`}, 'https://x.daily.co/limit',
              now() - interval '60 minutes', now() - interval '59 minutes', now() - interval '59 minutes', now(), 'agent')
      returning id`;
    try {
      await admin`update soft_ai.support_call_settings set monthly_limit_minutes = 100`;
      expect((await call("GET", "/v1/support-calls/eligibility", f.ownerA, f.orgA)).body).toMatchObject({ ok: false, reason: "limit" });
      const r = await start();
      expect(r.status).toBe(403);
      expect(r.body.error.message).toContain("request a callback");

      const usage = (await call("GET", "/admin/v1/support-calls/usage", f.ownerB)).body;
      expect(usage.usedMinutes).toBeGreaterThanOrEqual(119);
      expect(usage).toMatchObject({ limitMinutes: 100, freeMinutes: 10000 });
      expect((await call("GET", "/v1/support-calls/usage", f.ownerA, f.orgA)).status).toBe(404); // customers cannot see it

      // No limit -> calls are allowed again.
      await admin`update soft_ai.support_call_settings set monthly_limit_minutes = null`;
      expect((await call("GET", "/v1/support-calls/eligibility", f.ownerA, f.orgA)).body).toMatchObject({ ok: true });
    } finally {
      await admin`delete from soft_ai.support_calls where id = ${used!.id}`;
      await admin`update soft_ai.support_call_settings set monthly_limit_minutes = 9000`;
    }
  });

  it("the limit is a setting; it cannot be set below 100 minutes", async () => {
    const settings = (await call("GET", "/admin/v1/support-calls/settings", f.stranger)).body;
    expect(settings.monthlyLimitMinutes).toBe(9000);
    expect((await call("PUT", "/admin/v1/support-calls/settings", f.stranger, undefined, { ...settings, monthlyLimitMinutes: 5 })).status).toBe(400);
    const saved = await call("PUT", "/admin/v1/support-calls/settings", f.stranger, undefined, { ...settings, monthlyLimitMinutes: 8000 });
    expect(saved.body.monthlyLimitMinutes).toBe(8000);
    await call("PUT", "/admin/v1/support-calls/settings", f.stranger, undefined, settings);
  });
});

describe("admin panel rings live", () => {
  it("an open admin stream gets the new call at once", async () => {
    const res = await app.request("/admin/v1/support-calls/stream", { headers: { Authorization: `Bearer ${await signTestToken(f.ownerB)}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      const until = Date.now() + 8000;
      while (!text.includes(needle) && Date.now() < until) {
        const chunk = await Promise.race([reader.read(), new Promise<{ value?: undefined; done: true }>((r) => setTimeout(() => r({ done: true }), 500))]);
        if (chunk.value) text += decoder.decode(chunk.value);
      }
      return text.includes(needle);
    };
    expect(await readUntil("event: snapshot")).toBe(true);
    const r = await start();
    expect(await readUntil(`"id":"${r.body.callId}"`)).toBe(true);
    expect(text).toContain('"status":"ringing"');
    await reader.cancel();
    await call("POST", `/v1/support-calls/${r.body.callId}/hang-up`, f.ownerA, f.orgA);
  });

  it("settings: only owner / super admin / billing manager may change them", async () => {
    const settings = (await call("GET", "/admin/v1/support-calls/settings", f.ownerB)).body;
    expect(settings).toMatchObject({ allowedPlans: ["pro", "white_label"], timezone: "Asia/Karachi" });
    expect((await call("PUT", "/admin/v1/support-calls/settings", f.ownerB, undefined, settings)).status).toBe(403); // support role
    const bad = await call("PUT", "/admin/v1/support-calls/settings", f.stranger, undefined, { ...settings, startTime: "18:00", endTime: "09:00" });
    expect(bad.status).toBe(400);
    expect((await call("PUT", "/admin/v1/support-calls/settings", f.stranger, undefined, settings)).status).toBe(200);
  });
});
