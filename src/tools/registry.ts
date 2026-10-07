import { z } from "zod";
import type { MemberContext } from "../auth/member-context.js";
import { can } from "../auth/permissions.js";

/**
 * The tool registry: every company-data tool Soft AI may use, in ONE list.
 *
 * Each entry says:
 *   name / description  - what the AI sees (it decides when to use a tool)
 *   parameters          - allowed inputs, checked by our code (zod) AND sent to the AI
 *   anyPermission       - ERP permissions that allow it (owners: everything)
 *   sqlFunction         - the read-only database function that runs it (migration 107);
 *                         the function checks the permission AGAIN inside the database
 *   page                - the ERP page to show as "Related page"
 *
 * A user is only ever OFFERED the tools their role allows, so the AI cannot even
 * try the others. Step 8 adds actions (create / change) to this registry.
 */

const period = z
  .enum(["today", "yesterday", "this_week", "last_7_days", "this_month", "last_month", "last_30_days", "this_quarter", "this_year", "last_year", "custom"])
  .describe("Time period. Use 'custom' with from/to for other dates.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  anyPermission: string[];
  sqlFunction: string;
  page: { title: string; urlPath: string };
  /** Short text shown in the panel while it runs. */
  statusText: string;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "receivables_summary",
    description:
      "Money customers owe the company (accounts receivable): open and overdue invoice totals, aging buckets, and draft invoices (not yet posted). Use for questions like 'how much do customers owe', 'how much is overdue'.",
    parameters: z.object({}),
    anyPermission: ["sales.view"],
    sqlFunction: "tool_receivables_summary",
    page: { title: "Accounts Receivable", urlPath: "/accounting/receivable" },
    statusText: "Checking receivables…",
  },
  {
    name: "list_unpaid_invoices",
    description:
      "List unpaid (open) customer invoices with balance due and days overdue. Can filter by customer name, overdue only, or minimum days overdue. Returns at most 20 rows plus the total count and balance of all matches.",
    parameters: z.object({
      customer: z.string().max(100).optional().describe("Part of the customer name"),
      overdue_only: z.boolean().optional().describe("Only invoices past their due date"),
      min_days_overdue: z.number().int().min(0).max(3650).optional().describe("Only invoices overdue at least this many days"),
      sort: z.enum(["oldest_due", "largest"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    anyPermission: ["sales.view"],
    sqlFunction: "tool_list_unpaid_invoices",
    page: { title: "Invoices", urlPath: "/sales/invoices" },
    statusText: "Looking up unpaid invoices…",
  },
  {
    name: "sales_summary",
    description:
      "Sales for a period: number and total of invoices (excluding drafts and cancelled), tax, payments received, and top 5 customers.",
    parameters: z.object({ period, from: isoDate.optional(), to: isoDate.optional() }),
    anyPermission: ["sales.view"],
    sqlFunction: "tool_sales_summary",
    page: { title: "Invoices", urlPath: "/sales/invoices" },
    statusText: "Adding up sales…",
  },
  {
    name: "find_customers",
    description: "Find customers by name or customer number. Returns contact details and each customer's open (unpaid) balance.",
    parameters: z.object({
      query: z.string().min(1).max(100).describe("Part of the customer's name or number"),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    anyPermission: ["crm.view", "sales.view"],
    sqlFunction: "tool_find_customers",
    page: { title: "Customers", urlPath: "/crm/customers" },
    statusText: "Searching customers…",
  },
  {
    name: "payables_summary",
    description:
      "Money the company owes suppliers (accounts payable): open and overdue vendor bill totals, amount due in the next 7 days, and top 5 vendors owed.",
    parameters: z.object({}),
    anyPermission: ["purchases.view"],
    sqlFunction: "tool_payables_summary",
    page: { title: "Bills", urlPath: "/purchasing/bills" },
    statusText: "Checking payables…",
  },
  {
    name: "cash_and_bank_balances",
    description:
      "Current cash and bank position: each bank account's balance (as shown on the Bank Accounts page, account number shortened to the last 4 digits), cash-in-hand ledger accounts, and the totals.",
    parameters: z.object({}),
    anyPermission: ["accounting.view"],
    sqlFunction: "tool_cash_and_bank",
    page: { title: "Bank Accounts", urlPath: "/accounting/bank-accounts" },
    statusText: "Checking cash and bank…",
  },
  {
    name: "stock_levels",
    description:
      "Stock on hand, reserved and available per product (all warehouses), with reorder level and a low-stock flag. Can filter by product name/SKU or show only low-stock products.",
    parameters: z.object({
      product: z.string().max(100).optional().describe("Part of the product name or SKU"),
      low_stock_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    anyPermission: ["inventory.view"],
    sqlFunction: "tool_stock_levels",
    page: { title: "Products", urlPath: "/inventory/products" },
    statusText: "Checking stock…",
  },
  {
    name: "hr_today",
    description:
      "HR overview for a day (default today): active employees, attendance counts by status, who is on approved leave, and pending leave requests.",
    parameters: z.object({ date: isoDate.optional() }),
    anyPermission: ["hr.view"],
    sqlFunction: "tool_hr_today",
    page: { title: "Attendance", urlPath: "/hr/attendance" },
    statusText: "Checking attendance and leave…",
  },
  {
    name: "expenses_summary",
    description: "Expenses for a period: approved and pending totals and the top 5 categories.",
    parameters: z.object({ period, from: isoDate.optional(), to: isoDate.optional() }),
    anyPermission: ["accounting.view"],
    sqlFunction: "tool_expenses_summary",
    page: { title: "Expenses", urlPath: "/accounting/expenses" },
    statusText: "Adding up expenses…",
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/** The tools this member may use (owners: all). */
export function toolsFor(member: MemberContext): ToolDefinition[] {
  return TOOLS.filter((t) => t.anyPermission.some((p) => can(member, p)));
}

/** JSON schema for the AI (Gemini parametersJsonSchema). */
export function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = zodToJson(value as z.ZodTypeAny);
    if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function zodToJson(t: z.ZodTypeAny): Record<string, unknown> {
  const description = t.description ? { description: t.description } : {};
  if (t instanceof z.ZodOptional) return { ...zodToJson(t.unwrap()), ...description };
  if (t instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string", ...description };
    for (const c of t._def.checks) {
      if (c.kind === "max") out.maxLength = c.value;
      if (c.kind === "min") out.minLength = c.value;
      if (c.kind === "regex") out.pattern = c.regex.source;
    }
    return out;
  }
  if (t instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: t.isInt ? "integer" : "number", ...description };
    for (const c of t._def.checks) {
      if (c.kind === "min") out.minimum = c.value;
      if (c.kind === "max") out.maximum = c.value;
    }
    return out;
  }
  if (t instanceof z.ZodBoolean) return { type: "boolean", ...description };
  if (t instanceof z.ZodEnum) return { type: "string", enum: t.options, ...description };
  throw new Error(`Unsupported tool parameter type: ${t._def.typeName}`);
}
