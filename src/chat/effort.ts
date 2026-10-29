import type { Sql } from "../db/client.js";
import { ApiError } from "../http/errors.js";

/**
 * "Fast / Medium / High" in the message box (Shaheer, 12 Oct 2026).
 *
 * More effort = the AI thinks longer before answering: better on hard
 * questions, but it uses more tokens, so it costs more credits (credits are
 * charged on the tokens actually used, as always). Thinking tokens count
 * towards the reply limit, so higher effort also gets a higher limit.
 *
 * Fast and Medium: every plan. High: Pro and White Label only.
 */
export type Effort = "fast" | "medium" | "high";
export const EFFORTS: Effort[] = ["fast", "medium", "high"];

const HIGH_PLANS = ["pro", "white_label"];

export function effortSettings(effort: Effort, base: { maxOutputTokens: number }) {
  switch (effort) {
    case "fast":
      return { thinkingLevel: undefined, maxOutputTokens: base.maxOutputTokens }; // the configured default
    case "medium":
      return { thinkingLevel: "MEDIUM" as const, maxOutputTokens: Math.min(8192, base.maxOutputTokens * 4) };
    case "high":
      return { thinkingLevel: "HIGH" as const, maxOutputTokens: 8192 };
  }
}

/** The organization's current plan (same rule as support calls; migration 114). */
async function planOf(sql: Sql, organizationId: string): Promise<string | null> {
  const [row] = await sql<{ plan: string | null }[]>`select soft_ai.org_plan(${organizationId}::uuid) as plan`;
  return row?.plan ?? null;
}

/** Which levels this organization may use (the panel greys out the others). */
export async function allowedEfforts(sql: Sql, organizationId: string): Promise<{ plan: string | null; efforts: Effort[] }> {
  const plan = await planOf(sql, organizationId);
  return { plan, efforts: plan && HIGH_PLANS.includes(plan) ? EFFORTS : ["fast", "medium"] };
}

export async function requireEffort(sql: Sql, organizationId: string, effort: Effort): Promise<void> {
  if (effort !== "high") return;
  const { efforts } = await allowedEfforts(sql, organizationId);
  if (!efforts.includes("high")) {
    throw new ApiError(403, "forbidden", "High is included in the Pro and White Label plans. Please choose Fast or Medium.");
  }
}
