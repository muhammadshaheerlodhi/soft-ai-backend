import { describe, expect, it } from "vitest";
import { capabilitiesContext, isCapabilitiesQuestion } from "../../src/chat/capabilities.js";
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
const ON = { tools: true, actions: true };

describe('"What can you do?"', () => {
  it("is recognised in English and Roman Urdu", () => {
    for (const q of ["What can you do?", "what can you do for me", "How can you help me?", "help", "What can I ask you?"]) {
      expect(isCapabilitiesQuestion(q)).toBe("en");
    }
    for (const q of ["Tum kya kar sakte ho?", "aap kya kya kar sakte hain", "ap kya kar sakte ho mere liye"]) {
      expect(isCapabilitiesQuestion(q)).toBe("ur");
    }
  });

  it("does not catch real requests", () => {
    for (const q of ["What can you do about the overdue invoice of Ali?", "help me write an email", "Can you create an invoice?"]) {
      expect(isCapabilitiesQuestion(q)).toBeNull();
    }
  });

  it("the list given to the AI has only what the role allows", () => {
    const sales = capabilitiesContext(member(), ON);
    expect(sales).toMatch(/^<soft_ai_capabilities>/);
    expect(sales).toContain("money customers owe");
    expect(sales).toContain("draft invoices");
    expect(sales).not.toContain("cash & bank");      // needs accounting.view
    expect(sales).not.toContain("leave approvals");  // needs hr.approve

    const owner = capabilitiesContext(member({ isOwner: true, permissions: new Set() }), ON);
    expect(owner).toContain("cash & bank");
    expect(owner).toContain("leave approvals");

    const none = capabilitiesContext(member({ permissions: new Set() }), ON);
    expect(none).toContain("cannot read company numbers");
    expect(none).toContain("cannot prepare changes");
  });

  it("always says what Soft AI cannot do, and no actions when they are switched off", () => {
    expect(capabilitiesContext(member(), ON)).toContain("Cannot: send emails");
    expect(capabilitiesContext(member(), { tools: true, actions: false })).toContain("cannot prepare changes");
  });
});
