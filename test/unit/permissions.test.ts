import { describe, expect, it } from "vitest";
import { can } from "../../src/auth/permissions.js";
import type { MemberContext } from "../../src/auth/member-context.js";

function member(overrides: Partial<MemberContext> = {}): MemberContext {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    isOwner: false,
    roleSlug: "sales",
    permissions: new Set(["sales.view", "sales.create"]),
    parentOrganizationId: null,
    ...overrides,
  };
}

describe("can()", () => {
  it("allows exactly the permissions of the role", () => {
    expect(can(member(), "sales.view")).toBe(true);
    expect(can(member(), "sales.create")).toBe(true);
    expect(can(member(), "sales.delete")).toBe(false);
    expect(can(member(), "hr.view")).toBe(false);
  });

  it("allows everything for owners (same as the ERP)", () => {
    expect(can(member({ isOwner: true, permissions: new Set() }), "payroll.approve")).toBe(true);
  });

  it("denies everything for a role with no permissions", () => {
    expect(can(member({ permissions: new Set() }), "sales.view")).toBe(false);
  });

  it("does not treat partial matches as permission", () => {
    expect(can(member({ permissions: new Set(["sales.view"]) }), "sales.viewx")).toBe(false);
  });

  it('treats "module.*" (permission matrix) as every action of that module only', () => {
    const m = member({ permissions: new Set(["crm.*"]) });
    expect(can(m, "crm.view")).toBe(true);
    expect(can(m, "crm.delete")).toBe(true);
    expect(can(m, "sales.view")).toBe(false);
    expect(can(member({ permissions: new Set(["crm.*"]) }), "crmx.view")).toBe(false);
  });

  it("fails loudly on a badly written permission key in our code", () => {
    expect(() => can(member(), "sales")).toThrow(/Invalid permission key/);
    expect(() => can(member(), "*")).toThrow(/Invalid permission key/);
    expect(() => can(member(), "Sales.View")).toThrow(/Invalid permission key/);
  });
});
