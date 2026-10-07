import type { Sql } from "../db/client.js";

/**
 * Credit amounts are returned as strings with 4 decimals (e.g. "12.5000"),
 * exactly as stored, so no rounding errors from JavaScript numbers.
 */
export interface WalletBalance {
  balance: string;
  reserved: string;
  available: string;
}

export async function getWalletBalance(sql: Sql, organizationId: string): Promise<WalletBalance> {
  const rows = await sql<{ balance: string; reserved: string; available: string }[]>`
    select balance::text,
           reserved::text,
           (balance - reserved)::numeric(18,4)::text as available
      from soft_ai.wallets
     where organization_id = ${organizationId}::uuid
  `;
  // No wallet yet = never had credits.
  return rows[0] ?? { balance: "0.0000", reserved: "0.0000", available: "0.0000" };
}
