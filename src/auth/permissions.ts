import type { MemberContext } from "./member-context.js";

const PERMISSION_RE = /^[a-z0-9_-]+\.[a-z0-9_-]+$/;

/**
 * Same rule as the ERP's server check (api-auth.ts -> requireOrgPermissionApi):
 *   - full access (owner, company_owner or admin) can do everything
 *   - everyone else needs "module.action", or "module.*" (every action of that
 *     module, from the role's permission matrix)
 * Soft AI must never allow more than the ERP itself allows.
 * Same logic in the database: soft_ai.permission_allows (migration 108).
 */
export function can(member: MemberContext, permission: string): boolean {
  if (!PERMISSION_RE.test(permission)) {
    // A typo in OUR code must fail loudly, never silently allow or deny.
    throw new Error(`Invalid permission key: "${permission}" (expected "module.action")`);
  }
  if (member.isOwner) return true;
  const module = permission.slice(0, permission.indexOf("."));
  return member.permissions.has(permission) || member.permissions.has(`${module}.*`);
}
