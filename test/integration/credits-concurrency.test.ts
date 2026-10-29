import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../../src/db/client.js";
import { TEST_ENV } from "../helpers/local-env.js";
import { createFixtures, removeFixtures, type Fixtures } from "../helpers/fixtures.js";

/**
 * Proves the credit functions stay correct when many requests hit the same
 * wallet at the SAME moment (something a single SQL script cannot test).
 * Uses many real database connections in parallel, as the restricted backend role.
 */
let admin: Sql;
let service: Sql;
let f: Fixtures;

beforeAll(async () => {
  admin = createSql(TEST_ENV.adminDatabaseUrl, { max: 2 });
  service = createSql(TEST_ENV.serviceDatabaseUrl, { max: 30 });
  f = await createFixtures(admin);
});

afterAll(async () => {
  if (f) await removeFixtures(admin, f);
  await service?.end();
  await admin?.end();
});

async function wallet(org: string) {
  const [w] = await service<{ balance: string; reserved: string }[]>`
    select balance::text, reserved::text from soft_ai.wallets where organization_id = ${org}::uuid`;
  return w;
}

async function integrityProblems() {
  return admin`select * from soft_ai.check_wallet_integrity()`;
}

describe("credits under parallel load", () => {
  it("25 requests at once for 1 credit each, with only 10 credits: exactly 10 succeed", async () => {
    await service`select soft_ai.add_credits(${f.orgA}::uuid, 10, 'purchase', ${`conc-buy-${f.orgA}`})`;

    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        service<{ id: string }[]>`select soft_ai.reserve_credits(${f.orgA}::uuid, ${f.ownerA}::uuid, 1) as id`,
      ),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const refused = attempts.filter((a) => a.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(15);
    for (const r of refused) {
      expect(String((r as PromiseRejectedResult).reason)).toContain("insufficient_credits");
    }
    expect(await wallet(f.orgA)).toEqual({ balance: "10.0000", reserved: "10.0000" });

    // Settle all 10 at once, and send each settle TWICE (simulated retries).
    const ids = ok.map((a) => (a as PromiseFulfilledResult<{ id: string }[]>).value[0]!.id);
    await Promise.all(
      [...ids, ...ids].map((id) => service`select soft_ai.settle_reservation(${id}::uuid, 1)`),
    );

    expect(await wallet(f.orgA)).toEqual({ balance: "0.0000", reserved: "0.0000" });
    const [usage] = await admin<{ count: string }[]>`
      select count(*)::text from soft_ai.ledger where organization_id = ${f.orgA} and entry_type = 'usage'`;
    expect(usage?.count).toBe("10"); // charged once per request, never twice
    expect(await integrityProblems()).toHaveLength(0);
  });

  it("the same payment event delivered 10 times at once adds credits only once", async () => {
    const key = `conc-stripe-evt-${f.orgB}`;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        service`select soft_ai.add_credits(${f.orgB}::uuid, 50, 'purchase', ${key})`,
      ),
    );
    expect((await wallet(f.orgB))?.balance).toBe("50.0000");
    expect(await integrityProblems()).toHaveLength(0);
  });

  it("parallel agency transfers never give away more than the agency has", async () => {
    // Agency A gets 30 credits, then 12 transfers of 5 are fired at once to sub-account S.
    await service`select soft_ai.add_credits(${f.orgA}::uuid, 30, 'admin_adjust', ${`conc-grant-${f.orgA}`}, null, 'test grant')`;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        service`select soft_ai.transfer_credits(${f.orgA}::uuid, ${f.orgS}::uuid, 5, ${f.ownerA}::uuid, ${`conc-tr-${i}-${f.orgA}`})`,
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    expect((await wallet(f.orgA))?.balance).toBe("0.0000");
    expect((await wallet(f.orgS))?.balance).toBe("30.0000");
    expect(await integrityProblems()).toHaveLength(0);
  });
});
