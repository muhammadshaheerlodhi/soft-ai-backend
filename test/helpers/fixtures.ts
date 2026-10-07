import { randomUUID } from "node:crypto";
import type { Sql } from "../../src/db/client.js";

/**
 * Creates fresh test organizations and users with random ids, so tests never
 * collide with each other or with real data, and removes them afterwards.
 *
 *   Agency A        ownerA (owner), salesA (role with "sales.view"), inactiveA (deactivated)
 *     └ Sub-account S   ownerS (owner)
 *   Org B           ownerB (owner)
 */
export interface Fixtures {
  orgA: string;
  orgS: string;
  orgB: string;
  ownerA: string;
  salesA: string;
  inactiveA: string;
  ownerS: string;
  ownerB: string;
  /** A real-looking user id that belongs to no organization. */
  stranger: string;
}

export async function createFixtures(admin: Sql): Promise<Fixtures> {
  const f: Fixtures = {
    orgA: randomUUID(),
    orgS: randomUUID(),
    orgB: randomUUID(),
    ownerA: randomUUID(),
    salesA: randomUUID(),
    inactiveA: randomUUID(),
    ownerS: randomUUID(),
    ownerB: randomUUID(),
    stranger: randomUUID(),
  };
  const users = [f.ownerA, f.salesA, f.inactiveA, f.ownerS, f.ownerB, f.stranger];
  const tag = f.orgA.slice(0, 8);

  await admin.begin(async (tx) => {
    for (const id of users) {
      await tx`
        insert into auth.users (id, instance_id, aud, role, email)
        values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                ${`${id}@soft-ai-test.local`})`;
    }
    await tx`insert into public.organizations (id, name, slug) values
               (${f.orgA}, 'Test Agency A', ${`soft-ai-it-a-${tag}`}),
               (${f.orgB}, 'Test Org B', ${`soft-ai-it-b-${tag}`})`;
    await tx`insert into public.organizations (id, name, slug, parent_organization_id) values
               (${f.orgS}, 'Test Sub-account S', ${`soft-ai-it-s-${tag}`}, ${f.orgA})`;

    const roleId = randomUUID();
    await tx`insert into public.roles (id, organization_id, name, slug)
             values (${roleId}, ${f.orgA}, 'Sales (test)', ${`sales-test-${tag}`})`;
    await tx`insert into public.permissions (module, action) values ('sales', 'view')
             on conflict (module, action) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_id)
             select ${roleId}, id from public.permissions where module = 'sales' and action = 'view'`;

    await tx`insert into public.organization_members (organization_id, user_id, role_id, is_owner, is_active) values
               (${f.orgA}, ${f.ownerA},    null,      true,  true),
               (${f.orgA}, ${f.salesA},    ${roleId}, false, true),
               (${f.orgA}, ${f.inactiveA}, ${roleId}, false, false),
               (${f.orgS}, ${f.ownerS},    null,      true,  true),
               (${f.orgB}, ${f.ownerB},    null,      true,  true)`;
  });

  return f;
}

/** Removes everything created above (organizations cascade to their Soft AI data). */
export async function removeFixtures(admin: Sql, f: Fixtures): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`delete from public.organizations where id in (${f.orgS}, ${f.orgA}, ${f.orgB})`;
    await tx`delete from auth.users where id in ${tx([f.ownerA, f.salesA, f.inactiveA, f.ownerS, f.ownerB, f.stranger])}`;
  });
}
