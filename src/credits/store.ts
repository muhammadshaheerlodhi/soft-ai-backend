import type { Sql } from "../db/client.js";

/**
 * The credit operations the metering code needs. The real one talks to the
 * database functions from migrations 101 and 105; tests can swap in a fake to
 * check rare failures (for example the database going down mid-request).
 * Amounts are decimal strings ("1.7510") end to end - never JavaScript floats.
 */
export interface CreditStore {
  computeCost(model: string, inputTokens: number, outputTokens: number): Promise<string>;
  reserve(organizationId: string, userId: string, amount: string, ttlSeconds: number): Promise<string>;
  settle(reservationId: string, amount: string, reference: Record<string, unknown>): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/** Thrown when the organization does not have enough available credits. */
export class InsufficientCreditsError extends Error {
  constructor() {
    super("No credits left.");
    this.name = "InsufficientCreditsError";
  }
}

/** Thrown when a spending cap set by an admin is reached (monthly for the organization, or daily per user). */
export class CreditLimitError extends Error {
  constructor(public readonly limit: "monthly" | "user_daily") {
    super(`Credit limit reached: ${limit}`);
    this.name = "CreditLimitError";
  }
}

/** Thrown when an admin has not set a price for the model (we refuse to run for free). */
export class ModelNotPricedError extends Error {
  constructor(model: string) {
    super(`No price set for model ${model}.`);
    this.name = "ModelNotPricedError";
  }
}

export function createSqlCreditStore(sql: Sql): CreditStore {
  return {
    async computeCost(model, inputTokens, outputTokens) {
      try {
        const [row] = await sql<{ cost: string }[]>`
          select soft_ai.compute_cost(${model}, ${inputTokens}::int, ${outputTokens}::int)::text as cost`;
        return row!.cost;
      } catch (err) {
        if (isDbError(err, "no_rate_for_model")) throw new ModelNotPricedError(model);
        throw err;
      }
    },

    async reserve(organizationId, userId, amount, ttlSeconds) {
      try {
        const [row] = await sql<{ id: string }[]>`
          select soft_ai.reserve_credits(${organizationId}::uuid, ${userId}::uuid, ${amount}::numeric,
                                         make_interval(secs => ${ttlSeconds})) as id`;
        return row!.id;
      } catch (err) {
        if (isDbError(err, "insufficient_credits")) throw new InsufficientCreditsError();
        if (isDbError(err, "limit_reached")) {
          throw new CreditLimitError((err as { detail?: string }).detail === "user_daily" ? "user_daily" : "monthly");
        }
        throw err;
      }
    },

    async settle(reservationId, amount, reference) {
      await sql`select soft_ai.settle_reservation(${reservationId}::uuid, ${amount}::numeric, ${sql.json(toJson(reference))})`;
    },

    async release(reservationId) {
      await sql`select soft_ai.release_reservation(${reservationId}::uuid)`;
    },
  };
}

function isDbError(err: unknown, message: string): boolean {
  return typeof err === "object" && err !== null && "message" in err && String((err as Error).message) === message;
}

function toJson(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Parameters<Sql["json"]>[0];
}
