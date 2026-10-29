import type { Hono } from "hono";
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { MemberContext } from "../auth/member-context.js";
import { can } from "../auth/permissions.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/types.js";
import { InsufficientCreditsError } from "./store.js";
import type { PaymentGateway } from "./payments.js";

/**
 * Credits for users (behind login + organization checks):
 *
 *   GET  /v1/credits                 balance, this month, limits, warnings (see app.ts)
 *   GET  /v1/credits/history         purchases, allowances, transfers, admin changes
 *   GET  /v1/credits/usage           credits used per chat (my chats)
 *   GET  /v1/credits/packs           packs for sale + whether this user may buy
 *   POST /v1/credits/checkout        start a Stripe payment page for a pack
 *   GET  /v1/credits/sub-accounts    agency owners: balances of their sub-accounts
 *   POST /v1/credits/transfer        agency owners: send credits to a sub-account
 */

export interface CreditStatus {
  balance: string;
  reserved: string;
  available: string;
  monthUsed: string;
  monthlyAllowance: string;
  monthlyLimit: string | null;
  userDayUsed: string;
  userDailyLimit: string | null;
  /** Monthly credits that expire within 30 days, and the first expiry date. */
  expiring30d: string;
  nextExpiry: string | null;
  warnings: string[];
}

/** Adds this month's allowance if due, then reads the status. */
export async function getCreditStatus(sql: Sql, member: MemberContext, log?: Logger): Promise<CreditStatus> {
  try {
    await sql`select soft_ai.grant_monthly_allowance(${member.organizationId}::uuid)`;
    await sql`select soft_ai.refresh_wallet(${member.organizationId}::uuid)`; // remove expired monthly credits
  } catch (err) {
    log?.warn({ err }, "monthly allowance could not be added"); // never block the balance
  }
  const [row] = await sql<{ s: Record<string, unknown> }[]>`
    select soft_ai.credit_status(${member.organizationId}::uuid, ${member.userId}::uuid) as s`;
  const s = row!.s;
  return {
    balance: String(s.balance),
    reserved: String(s.reserved),
    available: String(s.available),
    monthUsed: String(s.month_used),
    monthlyAllowance: String(s.monthly_allowance),
    monthlyLimit: (s.monthly_limit as string | null) ?? null,
    userDayUsed: String(s.user_day_used),
    userDailyLimit: (s.user_daily_limit as string | null) ?? null,
    expiring30d: String(s.expiring_30d ?? "0.0000"),
    nextExpiry: (s.next_expiry as string | null) ?? null,
    warnings: (s.warnings as string[]) ?? [],
  };
}

/** Buying credits spends the company's money: owners/admins, or roles with settings.edit. */
export function canBuyCredits(member: MemberContext): boolean {
  return member.isOwner || can(member, "settings.edit");
}

const checkoutSchema = z.object({ packId: z.string().min(1).max(64) }).strict();
const decimal = z.string().regex(/^\d{1,9}(\.\d{1,4})?$/, "amount must be a number with up to 4 decimals");
const transferSchema = z
  .object({
    toOrganizationId: z.string().uuid(),
    amount: decimal,
    reason: z.string().trim().max(300).optional(),
    /** Same id on a retry = no second transfer. */
    requestId: z.string().uuid(),
  })
  .strict();

export function registerCreditRoutes(
  v1: Hono<AppEnv>,
  opts: { sql: Sql; payments?: PaymentGateway; appUrl: string },
) {
  const { sql } = opts;

  v1.get("/credits/history", async (c) => {
    const m = c.get("member");
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    const rows = await sql`
      select id, entry_type as type, amount::text, balance_after::text as "balanceAfter", reason, created_at as "createdAt"
        from soft_ai.ledger
       where organization_id = ${m.organizationId} and entry_type <> 'usage'
         ${Number.isFinite(before) ? sql`and id < ${before}` : sql``}
       order by id desc
       limit 50`;
    return c.json({ entries: rows });
  });

  v1.get("/credits/usage", async (c) => {
    const m = c.get("member");
    const rows = await sql`
      select id, title, credits_used::text as "creditsUsed", message_count as "messageCount", last_message_at as "lastMessageAt"
        from soft_ai.conversations
       where organization_id = ${m.organizationId} and user_id = ${m.userId}
         and deleted_at is null and credits_used > 0
       order by last_message_at desc
       limit 30`;
    return c.json({ chats: rows });
  });

  v1.get("/credits/packs", async (c) => {
    const packs = await sql`
      select id, name, credits::text, price_cents as "priceCents", currency
        from soft_ai.credit_packs where is_active order by sort_order, price_cents`;
    return c.json({ packs, canBuy: canBuyCredits(c.get("member")), paymentsEnabled: Boolean(opts.payments) });
  });

  v1.post("/credits/checkout", async (c) => {
    const m = c.get("member");
    if (!canBuyCredits(m)) throw new ApiError(403, "forbidden", "Only owners and admins can buy credits.");
    if (!opts.payments) throw new ApiError(503, "payments_not_configured", "Buying credits is not available yet.");
    const body = await parse(c.req.raw, checkoutSchema);
    const [pack] = await sql<{ id: string; name: string; credits: string; price_cents: number; currency: string }[]>`
      select id, name, credits::text, price_cents, currency from soft_ai.credit_packs where id = ${body.packId} and is_active`;
    if (!pack) throw new ApiError(400, "bad_request", "This credit pack is not available.");

    const session = await opts.payments.createCheckout({
      organizationId: m.organizationId,
      userId: m.userId,
      pack: { id: pack.id, name: pack.name, credits: pack.credits, priceCents: pack.price_cents, currency: pack.currency },
      successUrl: `${opts.appUrl}/soft-ai?credits=success`,
      cancelUrl: `${opts.appUrl}/soft-ai?credits=cancelled`,
      customerEmail: c.get("user").email,
    });
    await sql`select soft_ai.start_credit_purchase(${m.organizationId}::uuid, ${m.userId}::uuid, ${pack.id}, ${session.id})`;
    return c.json({ url: session.url });
  });

  v1.get("/credits/sub-accounts", async (c) => {
    const m = c.get("member");
    if (!m.isOwner) throw new ApiError(403, "forbidden", "Only the owner can manage sub-account credits.");
    const [row] = await sql<{ list: unknown[] }[]>`
      select soft_ai.sub_account_balances(${m.organizationId}::uuid, ${m.userId}::uuid) as list`;
    return c.json({ subAccounts: row?.list ?? [] });
  });

  v1.post("/credits/transfer", async (c) => {
    const m = c.get("member");
    if (!m.isOwner) throw new ApiError(403, "forbidden", "Only the owner can send credits to sub-accounts.");
    const body = await parse(c.req.raw, transferSchema);
    if (Number(body.amount) <= 0) throw new ApiError(400, "bad_request", "Amount must be more than 0.");
    try {
      await sql`select soft_ai.transfer_credits_logged(${m.organizationId}::uuid, ${body.toOrganizationId}::uuid,
                  ${body.amount}::numeric, ${m.userId}::uuid, ${`transfer:${body.requestId}`}, ${body.reason ?? null})`;
    } catch (err) {
      const msg = String((err as Error).message ?? "");
      if (msg === "insufficient_credits") throw new InsufficientCreditsError();
      if (msg === "not_a_sub_account" || msg === "not_allowed" || msg === "cannot transfer to the same organization") {
        throw new ApiError(403, "forbidden", "Credits can only be sent to your own sub-accounts.");
      }
      throw err;
    }
    return c.json({ ok: true });
  });
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
