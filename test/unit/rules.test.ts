import { describe, expect, it } from "vitest";
import { matchRule } from "../../src/chat/rules.js";
import type { PageEntry } from "../../src/knowledge/extract-erp.js";

const p = (title: string, href: string, group: string, kind: "page" | "create" = "page"): PageEntry => ({
  title,
  href,
  group,
  module: null,
  permission: null,
  kind,
});

const PAGES: PageEntry[] = [
  p("Dashboard", "/dashboard", "Dashboard"),
  p("Invoices", "/sales/invoices", "Sales"),
  p("Quotations", "/sales/quotations", "Sales"),
  p("Payments", "/sales/payments", "Sales"),
  p("Customer Payments", "/sales/payments", "Payments"),
  p("Vendor Payments", "/purchasing/payments", "Payments"),
  p("Customers", "/crm/customers", "CRM"),
  p("Purchase Orders", "/purchasing/orders", "Purchasing"),
  p("Goods Receipts", "/purchasing/receipts", "Purchasing"),
  p("Reports", "/sales/reports", "Sales"),
  p("Reports", "/hr/reports", "HR"),
  p("New Invoice", "/sales/invoices/new", "Create", "create"),
  p("New Customer", "/crm/customers/new", "Create", "create"),
];

describe("rules engine", () => {
  it("answers greetings and thanks on their own (English, Roman Urdu, Urdu)", () => {
    for (const g of ["hi", "Hello!", "salam", "Assalam o alaikum", "AoA", "السلام علیکم"]) {
      expect(matchRule(g, PAGES)?.kind, g).toBe("greeting");
    }
    for (const t of ["thanks", "Thank you!", "shukriya", "bohat shukriya", "شکریہ"]) {
      expect(matchRule(t, PAGES)?.kind, t).toBe("thanks");
    }
  });

  it("does NOT treat a greeting inside a real question as a greeting", () => {
    expect(matchRule("hi, how do I post a bill?", PAGES)).toBeNull();
  });

  it("opens a page by name, in different phrasings", () => {
    for (const q of ["open invoices", "Open the invoices page", "go to invoices", "take me to Invoices", "show invoices", "invoice kholo", "invoices kholo"]) {
      const r = matchRule(q, PAGES);
      expect(r?.navigateTo, q).toBe("/sales/invoices");
      expect(r?.reply).toContain("[Invoices](/sales/invoices)");
    }
  });

  it("understands common short names", () => {
    expect(matchRule("open po", PAGES)?.navigateTo).toBe("/purchasing/orders");
    expect(matchRule("open GRN", PAGES)?.navigateTo).toBe("/purchasing/receipts");
    expect(matchRule("go home", PAGES)).toBeNull(); // not a pattern we claim
    expect(matchRule("open home", PAGES)?.navigateTo).toBe("/dashboard");
  });

  it("opens 'create' forms only for a plain create command", () => {
    expect(matchRule("create invoice", PAGES)?.navigateTo).toBe("/sales/invoices/new");
    expect(matchRule("new customer", PAGES)?.navigateTo).toBe("/crm/customers/new");
    // Details mean a real task for the AI (actions come in step 8), not just opening a form.
    expect(matchRule("create an invoice for Ali for 10 units", PAGES)).toBeNull();
  });

  it("leaves anything uncertain to the AI", () => {
    expect(matchRule("show unpaid invoices of Ali", PAGES)).toBeNull(); // a data question
    expect(matchRule("open reports", PAGES)).toBeNull(); // two different "Reports" pages: ambiguous
    expect(matchRule("open something that does not exist", PAGES)).toBeNull();
    expect(matchRule("How do I create an invoice?", PAGES)).toBeNull();
  });

  it("resolves an ambiguous name when the menu group is given", () => {
    expect(matchRule("open hr reports", PAGES)?.navigateTo).toBe("/hr/reports");
    expect(matchRule("open sales reports", PAGES)?.navigateTo).toBe("/sales/reports");
  });

  it("treats two names for the same page as one page (not ambiguous)", () => {
    expect(matchRule("open payments", PAGES)?.navigateTo).toBe("/sales/payments");
  });

  it("can only open pages it was given (pages the user may open)", () => {
    const onlySales = PAGES.filter((x) => x.group === "Sales");
    expect(matchRule("open customers", onlySales)).toBeNull();
  });
});
