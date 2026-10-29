import type { MiddlewareHandler } from "hono";
import type { Sql } from "../db/client.js";
import { errorResponse } from "./errors.js";
import type { AppEnv } from "./types.js";

/**
 * Request limits, counted in the database so every copy of the backend shares
 * the same counts. Used on routes that call the AI (from step 4).
 *
 * Limits protect two things: the system (one user or a loop can't flood it)
 * and the AI bill (separate from credits, which protect the customer's wallet).
 * Fixed windows: a user could burst up to 2x at a window edge; acceptable for
 * this purpose and much simpler than exact sliding windows.
 */
export interface RateLimitRule {
  /** Short stable name, part of the counter key. */
  name: string;
  scope: "user" | "organization";
  windowSeconds: number;
  max: number;
}

export function rateLimit(sql: Sql, rules: RateLimitRule[]): MiddlewareHandler<AppEnv> {
  if (rules.length === 0) throw new Error("rateLimit needs at least one rule");
  const windows = rules.map((r) => r.windowSeconds);
  const maxes = rules.map((r) => r.max);

  return async (c, next) => {
    const m = c.get("member");
    const buckets = rules.map((r) =>
      r.scope === "user" ? `${r.name}:u:${m.organizationId}:${m.userId}` : `${r.name}:o:${m.organizationId}`,
    );
    const [row] = await sql<{ allowed: boolean; limited_bucket: string | null; retry_after_seconds: number }[]>`
      select allowed, limited_bucket, retry_after_seconds
        from soft_ai.hit_rate_limits(${buckets}::text[], ${windows}::int[], ${maxes}::int[])`;

    if (!row?.allowed) {
      c.get("log").info({ bucket: row?.limited_bucket?.split(":")[0] }, "rate limited");
      const res = errorResponse(c, 429, "rate_limited", "Too many requests. Please wait a moment and try again.");
      res.headers.set("Retry-After", String(row?.retry_after_seconds ?? 60));
      return res;
    }
    await next();
  };
}

/** The standard limits for AI routes, from settings. */
export function aiRateLimitRules(limits: { userPerMinute: number; userPerDay: number; orgPerMinute: number }): RateLimitRule[] {
  return [
    { name: "ai_user_min", scope: "user", windowSeconds: 60, max: limits.userPerMinute },
    { name: "ai_user_day", scope: "user", windowSeconds: 86_400, max: limits.userPerDay },
    { name: "ai_org_min", scope: "organization", windowSeconds: 60, max: limits.orgPerMinute },
  ];
}
