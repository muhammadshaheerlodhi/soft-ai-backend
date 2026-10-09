import { describe, expect, it } from "vitest";
import { capabilitiesReply, isCapabilitiesQuestion } from "../../src/chat/capabilities.js";
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

  it("lists only what the role allows, in short lines", () => {
    const sales = capabilitiesReply(member(), "en", ON);
    expect(sales).toContain("money customers owe");
    expect(sales).toContain("draft invoices");
    expect(sales).not.toContain("cash & bank");      // needs accounting.view
    expect(sales).not.toContain("leave approvals");  // needs hr.approve
    expect(sales.split("\n").length).toBeLessThanOrEqual(9);

    const owner = capabilitiesReply(member({ isOwner: true, permissions: new Set() }), "en", ON);
    expect(owner).toContain("cash & bank");
    expect(owner).toContain("leave approvals");

    const none = capabilitiesReply(member({ permissions: new Set() }), "en", ON);
    expect(none).not.toContain("Check your numbers");
    expect(none).not.toContain("Prepare work");
  });

  it("answers in Roman Urdu when asked in Roman Urdu", () => {
    expect(capabilitiesReply(member(), "ur", ON)).toMatch(/^Main aap ke liye ye kaam kar sakta hoon:/);
  });

  it("does not offer actions when actions are switched off", () => {
    expect(capabilitiesReply(member(), "en", { tools: true, actions: false })).not.toContain("Prepare work");
  });
});
