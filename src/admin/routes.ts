import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { TokenVerifier } from "../auth/verify-token.js";
import { ApiError } from "../http/errors.js";
import { requireUser } from "../http/middleware.js";
import type { AppEnv } from "../http/types.js";
import { isUuid } from "../lib/uuid.js";

/**
 * Soft AI admin panel API, for the ERP's PLATFORM admins (Shaheer's team),
 * not for organization owners. Mounted at /admin/v1.
 *
 * Who is a platform admin: the ERP's own list (public.platform_admins, the
 * owner e-mail in system_settings) or PLATFORM_OWNER_EMAIL - matched only for
 * a confirmed e-mail. Roles (same as the ERP):
 *   owner, super_admin, billing_manager  - may change credits, limits, packs, plans
 *   support                              - may only look
 *
 *   GET  /me                          my admin role
 *   GET  /summary?from&to             usage, Google cost, credit sales, top organizations
 *   GET  /organizations?search&limit&offset
 *   GET  /organizations/:id           ledger and top users
 *   POST /organizations/:id/adjust    add/remove credits (reason required)
 *   PUT  /organizations/:id/settings  allowance override, monthly cap, daily cap per user
 *   GET  /plans   PUT /plans/:slug    monthly credits per ERP plan
 *   GET  /packs   PUT /packs/:id      credit packs for sale
 * Every change is in the ledger / settings history and the organization's Activity feed.
 */

type AdminRole = "owner" | "super_admin" | "billing_manager" | "support";
type AdminEnv = AppEnv & { Variables: AppEnv["Variables"] & { adminRole: AdminRole } };

const CAN_CHANGE: AdminRole[] = ["owner", "super_admin", "billing_manager"];

const decimal = z.string().regex(/^-?\d{1,9}(\.\d{1,4})?$/, "must be a number with up to 4 decimals");
const optionalLimit = z.union([z.string().regex(/^\d{1,9}(\.\d{1,4})?$/), z.null()]);

const adjustSchema = z
  .object({ amount: decimal, reason: z.string().trim().min(3).max(300), requestId: z.string().uuid() })
  .strict();
const settingsSchema = z
  .object({
    monthlyAllowance: optionalLimit,
    monthlyLimit: optionalLimit,
    userDailyLimit: optionalLimit,
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
const planSchema = z.object({ monthlyCredits: z.string().regex(/^\d{1,9}(\.\d{1,4})?$/) }).strict();
const packSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    credits: z.string().regex(/^\d{1,9}(\.\d{1,4})?$/),
    priceCents: z.number().int().min(50).max(100_000_000),
    currency: z.string().regex(/^[a-zA-Z]{3}$/),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .strict();

export function createAdminRoutes(opts: { sql: Sql; verifyToken: TokenVerifier; ownerEmail?: string }) {
  const { sql } = opts;
  const admin = new Hono<AdminEnv>();

  admin.use("*", requireUser(opts.verifyToken) as unknown as MiddlewareHandler<AdminEnv>);
  admin.use("*", async (c, next) => {
    const userId = c.get("user").userId;
    const [row] = await sql<{ role: AdminRole | null; email: string | null }[]>`
      select soft_ai.platform_admin_role(${userId}::uuid) as role, soft_ai.confirmed_email(${userId}::uuid) as email`;
    let role = row?.role ?? null;
    if (!role && opts.ownerEmail && row?.email && row.email === opts.ownerEmail.toLowerCase()) role = "owner";
    if (!role) throw new ApiError(403, "forbidden", "Platform admins only.");
    c.set("adminRole", role);
    await next();
  });
  const requireChange: MiddlewareHandler<AdminEnv> = async (c, next) => {
    if (!CAN_CHANGE.includes(c.get("adminRole"))) throw new ApiError(403, "forbidden", "Your admin role can only view.");
    await next();
  };
  const orgId = (raw: string) => {
    if (!isUuid(raw)) throw new ApiError(404, "not_found", "Organization not found.");
    return raw;
  };

  admin.get("/me", (c) => c.json({ role: c.get("adminRole"), canChange: CAN_CHANGE.includes(c.get("adminRole")) }));

  admin.get("/summary", async (c) => {
    const now = new Date();
    const from = parseDate(c.req.query("from")) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = parseDate(c.req.query("to")) ?? now;
    const [row] = await sql<{ s: unknown }[]>`select soft_ai.admin_summary(${from}, ${to}) as s`;
    return c.json({ from: from.toISOString(), to: to.toISOString(), ...(row?.s as object) });
  });

  admin.get("/organizations", async (c) => {
    const search = c.req.query("search")?.trim() || null;
    const limit = clampInt(c.req.query("limit"), 1, 100, 25);
    const offset = clampInt(c.req.query("offset"), 0, 100_000, 0);
    const [row] = await sql<{ r: unknown }[]>`select soft_ai.admin_organizations(${search}, ${limit}, ${offset}) as r`;
    return c.json(row?.r ?? { total: 0, organizations: [] });
  });

  admin.get("/organizations/:id", async (c) => {
    const id = orgId(c.req.param("id"));
    const [row] = await sql<{ r: { organization: unknown } }[]>`select soft_ai.admin_organization_detail(${id}::uuid) as r`;
    if (!row?.r.organization) throw new ApiError(404, "not_found", "Organization not found.");
    return c.json(row.r);
  });

  admin.post("/organizations/:id/adjust", requireChange, async (c) => {
    const id = orgId(c.req.param("id"));
    const body = await parse(c.req.raw, adjustSchema);
    if (Number(body.amount) === 0) throw new ApiError(400, "bad_request", "Amount must not be 0.");
    try {
      await sql`select soft_ai.admin_adjust_credits(${id}::uuid, ${body.amount}::numeric, ${body.reason},
                  ${c.get("user").userId}::uuid, ${`admin:${body.requestId}`})`;
    } catch (err) {
      if (String((err as Error).message) === "insufficient_credits") {
        throw new ApiError(400, "bad_request", "Cannot remove more credits than the organization has.");
      }
      if (String((err as { code?: string }).code) === "23503") throw new ApiError(404, "not_found", "Organization not found.");
      throw err;
    }
    return c.json({ ok: true });
  });

  admin.put("/organizations/:id/settings", requireChange, async (c) => {
    const id = orgId(c.req.param("id"));
    const b = await parse(c.req.raw, settingsSchema);
    try {
      await sql`select soft_ai.admin_set_org_settings(${id}::uuid, ${b.monthlyAllowance}::numeric, ${b.monthlyLimit}::numeric,
                  ${b.userDailyLimit}::numeric, ${b.note ?? null}, ${c.get("user").userId}::uuid)`;
    } catch (err) {
      if (String((err as Error).message) === "invalid_argument") throw new ApiError(404, "not_found", "Organization not found.");
      throw err;
    }
    return c.json({ ok: true });
  });

  admin.get("/plans", async (c) => {
    const [row] = await sql<{ r: unknown }[]>`select soft_ai.admin_plans() as r`;
    return c.json({ plans: row?.r ?? [] });
  });

  admin.put("/plans/:slug", requireChange, async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw new ApiError(400, "bad_request", "Invalid plan.");
    const b = await parse(c.req.raw, planSchema);
    await sql`select soft_ai.admin_set_plan_allowance(${slug}, ${b.monthlyCredits}::numeric, ${c.get("user").userId}::uuid)`;
    return c.json({ ok: true });
  });

  admin.get("/packs", async (c) => {
    const packs = await sql`
      select id, name, credits::text, price_cents as "priceCents", currency, is_active as "isActive", sort_order as "sortOrder"
        from soft_ai.credit_packs order by sort_order, price_cents`;
    return c.json({ packs });
  });

  admin.put("/packs/:id", requireChange, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, "bad_request", "Invalid pack id.");
    const b = await parse(c.req.raw, packSchema);
    await sql`select soft_ai.admin_set_pack(${id}, ${b.name}, ${b.credits}::numeric, ${b.priceCents}::int,
                ${b.currency}, ${b.isActive}, ${b.sortOrder}::int)`;
    return c.json({ ok: true });
  });

  return admin;
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "bad_request", "Invalid date.");
  return d;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function parse<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}
