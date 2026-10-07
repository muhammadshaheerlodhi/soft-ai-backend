import type { MemberContext } from "./member-context.js";

const PERMISSION_RE = /^[a-z0-9_-]+\.[a-z0-9_-]+$/;

/**
 * Same rule as the ERP's server check:
 *   - owners can do everything
 *   - everyone else needs the exact "module.action" permission of their role
 * Soft AI must never allow more than the ERP itself allows.
 */
export function can(member: MemberContext, permission: string): boolean {
  if (!PERMISSION_RE.test(permission)) {
    // A typo in OUR code must fail loudly, never silently allow or deny.
    throw new Error(`Invalid permission key: "${permission}" (expected "module.action")`);
  }
  return member.isOwner || member.permissions.has(permission);
}
