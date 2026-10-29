import type { Sql } from "../db/client.js";

/**
 * Who the user is inside ONE organization: owner or not, role, permissions.
 * Loaded fresh on every request from soft_ai.member_context(), which copies the
 * ERP's own server-side check (src/lib/security/api-auth.ts in the ERP).
 * So if an admin removes someone or changes their role, it applies immediately.
 */
export interface MemberContext {
  organizationId: string;
  userId: string;
  isOwner: boolean;
  roleSlug: string | null;
  permissions: ReadonlySet<string>;
  /** Set when this organization is a sub-account of an agency. */
  parentOrganizationId: string | null;
}

interface MemberContextRow {
  organization_id: string;
  user_id: string;
  is_owner: boolean | null;
  role_slug: string | null;
  permissions: string[] | null;
  parent_organization_id: string | null;
}

/** Returns null if the user is not an active member of an active organization. */
export async function loadMemberContext(
  sql: Sql,
  organizationId: string,
  userId: string,
): Promise<MemberContext | null> {
  const rows = await sql<MemberContextRow[]>`
    select organization_id, user_id, is_owner, role_slug, permissions, parent_organization_id
      from soft_ai.member_context(${organizationId}::uuid, ${userId}::uuid)
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    isOwner: row.is_owner === true,
    roleSlug: row.role_slug,
    permissions: new Set(row.permissions ?? []),
    parentOrganizationId: row.parent_organization_id,
  };
}
