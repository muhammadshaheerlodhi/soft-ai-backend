import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import { ApiError } from "../http/errors.js";
import { rateLimit } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { isUuid } from "../lib/uuid.js";
import type { CallService, CallSettings } from "./service.js";

/**
 * Live call events: the database NOTIFYs on every new / changed call
 * (migration 112); every open admin panel gets it at once (Server-Sent Events).
 */
export function createCallEvents(sql: Sql, log: Logger) {
  const listeners = new Set<(id: string) => void>();
  let started: Promise<unknown> | null = null;
  return {
    /** Starts listening to the database (once). */
    start() {
      started ??= sql
        .listen("soft_ai_support_calls", (payload) => {
          try {
            const { id } = JSON.parse(payload) as { id: string };
            for (const l of listeners) l(id);
          } catch (err) {
            log.warn({ err }, "bad support call notification");
          }
        })
        .catch((err) => {
          log.error({ err }, "could not listen for support calls");
          started = null;
        });
      return started;
    },
    subscribe(fn: (id: string) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
export type CallEvents = ReturnType<typeof createCallEvents>;

const startSchema = z.object({ pagePath: z.string().max(300).optional() }).strict();

/** Customer endpoints (behind login + organization checks). */
export function registerCallRoutes(v1: Hono<AppEnv>, opts: { sql: Sql; calls: CallService }) {
  const { calls } = opts;
  const id = (raw: string) => {
    if (!isUuid(raw)) throw new ApiError(404, "not_found", "Call not found.");
    return raw;
  };

  /** Can this user call now? (The panel shows "Talk to a person", "Upgrade" or "Request a callback".) */
  v1.get("/support-calls/eligibility", async (c) => c.json(await calls.eligibility(c.get("member").organizationId)));

  v1.post(
    "/support-calls",
    rateLimit(opts.sql, [{ name: "support_call_start", scope: "user", windowSeconds: 3600, max: 10 }]),
    async (c) => {
      const body = await parse(c.req.raw, startSchema);
      const user = c.get("user");
      const callerName = user.email ? user.email.split("@")[0]! : "Customer";
      return c.json(await calls.start(c.get("member"), { callerName, pagePath: body.pagePath }), 201);
    },
  );

  v1.get("/support-calls/:id", async (c) => c.json(await calls.getForCaller(c.get("member"), id(c.req.param("id")))));

  v1.post("/support-calls/:id/hang-up", async (c) => c.json(await calls.hangUpByCaller(c.get("member"), id(c.req.param("id")))));
}

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    allowedPlans: z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/)).max(20),
    timezone: z.string().min(1).max(64),
    workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    ringSeconds: z.number().int().min(15).max(300),
    maxMinutes: z.number().int().min(5).max(240),
  })
  .strict()
  .refine((s) => s.startTime < s.endTime, "The end time must be after the start time.")
  .refine((s) => Intl.supportedValuesOf("timeZone").includes(s.timezone) || s.timezone === "UTC", "Unknown time zone.");

/**
 * Platform admin endpoints, added to the admin API (/admin/v1):
 *   GET  /support-calls/stream        live: calls ringing / in progress (SSE)
 *   GET  /support-calls?before=       call log
 *   POST /support-calls/:id/answer    first admin wins; returns the voice room + token
 *   POST /support-calls/:id/end       the admin who answered ends the call
 *   GET/PUT /support-calls/settings   plans, hours, ring time (owner / super admin / billing manager)
 */
export function registerAdminCallRoutes(
  admin: Hono<AppEnv & { Variables: AppEnv["Variables"] & { adminRole: string } }>,
  opts: { calls: CallService; events: CallEvents; canChange: (role: string) => boolean },
) {
  const { calls, events } = opts;
  const id = (raw: string) => {
    if (!isUuid(raw)) throw new ApiError(404, "not_found", "Call not found.");
    return raw;
  };

  admin.get("/support-calls/settings", async (c) => c.json(await calls.getSettings()));

  admin.put("/support-calls/settings", async (c) => {
    if (!opts.canChange(c.get("adminRole"))) throw new ApiError(403, "forbidden", "Your admin role can only view.");
    const body = (await parse(c.req.raw, settingsSchema)) as CallSettings;
    await calls.saveSettings(c.get("user").userId, body);
    return c.json(await calls.getSettings());
  });

  admin.get("/support-calls", async (c) => {
    const before = c.req.query("before");
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw new ApiError(400, "bad_request", "Invalid 'before' value.");
    return c.json({ calls: await calls.history({ limit: 50, before }) });
  });

  admin.get("/support-calls/stream", async (c) => {
    await events.start();
    return streamSSE(c, async (sse) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe((callId) => {
        queue.push(callId);
        wake?.();
      });
      sse.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await sse.writeSSE({ event: "snapshot", data: JSON.stringify({ calls: await calls.openCalls() }) });
      // Calls that stop ringing by time alone (missed) have no event: re-check now and then.
      let lastSweep = Date.now();
      while (!sse.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000);
        });
        wake = null;
        if (sse.aborted) break;
        if (Date.now() - lastSweep > 10_000) {
          lastSweep = Date.now();
          await calls.sweep(); // turns expired rings into "missed" -> NOTIFY -> queued below
        }
        const ids = [...new Set(queue.splice(0))];
        for (const call of await calls.details(ids)) {
          await sse.writeSSE({ event: "call", data: JSON.stringify(call) });
        }
        if (ids.length === 0) await sse.writeSSE({ event: "ping", data: "{}" }); // keeps proxies from closing it
      }
    });
  });

  admin.post("/support-calls/:id/answer", async (c) => c.json(await calls.answer(c.get("user").userId, id(c.req.param("id")))));

  admin.post("/support-calls/:id/end", async (c) => c.json(await calls.endByAgent(c.get("user").userId, id(c.req.param("id")))));
}

async function parse<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, "bad_request", "Request body must be JSON.");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}
