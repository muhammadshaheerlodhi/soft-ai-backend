import { z } from "zod";
import type { MemberContext } from "../auth/member-context.js";
import { can } from "../auth/permissions.js";

/**
 * The action registry: every change Soft AI may PROPOSE, in one list.
 *
 * Soft AI never writes to the ERP itself. An action is only a proposal; after
 * the user confirms, the ERP's OWN service function runs it in the user's
 * browser (see the panel's action handlers), so the ERP's numbering, posting,
 * permissions (RLS) and audit log all apply exactly as if the user did it.
 *
 * Each entry says:
 *   name / description  - what the AI sees
 *   parameters          - allowed inputs (checked by our code, sent to the AI)
 *   anyPermission       - ERP permissions that allow it (owners/admins: everything)
 *   risk                - low: may run straight away (with Undo) when the user asked
 *                         for exactly this; medium/high: ALWAYS needs Confirm
 *   record              - which ERP record it creates/changes (checked afterwards)
 *   refs                - records it refers to; each must exist in THIS organization
 *   normalize / check   - fill defaults (dates = today) and business checks
 *   preview             - what the confirmation card shows
 *   undo                - how it is undone, or null if it cannot be
 *
 * First batch (Oct 2026): only actions that can be undone safely. Payments,
 * posting invoices and approving expenses change the accounts and come later.
 */

export type RiskLevel = "low" | "medium" | "high";
export type RefType =
  | "customer" | "vendor" | "product" | "employee" | "leave_type" | "leave_request"
  | "lead" | "expense_account" | "cash_account" | "bank_account" | "project";
export type RecordKind =
  | "customer" | "lead" | "invoice" | "quotation" | "purchase_order" | "expense"
  | "leave_request" | "task" | "product";

export interface RefSpec {
  type: RefType;
  id: string;
}
/** Answer of soft_ai.action_refs: "type:id" -> details (name, status, ...). */
export type RefInfo = Record<string, Record<string, unknown>>;

export interface PreviewContext {
  refs: RefInfo;
  currency: string;
}

export interface ActionPreview {
  title: string;
  fields: { label: string; value: string }[];
  lines?: { description: string; quantity: number; unitPrice: string; total: string }[];
  totals?: { label: string; value: string }[];
  notes: string[];
  /** What Undo will do, or null when it cannot be undone. */
  undo: string | null;
}

export type UndoKind = "delete" | "restore_status";

export interface ActionDefinition<P = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  anyPermission: string[];
  risk: RiskLevel;
  record: RecordKind;
  /** ERP page of the record afterwards. */
  pagePath: (recordId: string) => string;
  statusText: string;
  refs: (p: P) => RefSpec[];
  normalize?: (p: P, today: string, refs: RefInfo) => P;
  /** Business checks with the referenced records. Returns a message for the AI, or null. */
  check?: (p: P, refs: RefInfo) => string | null;
  preview: (p: P, ctx: PreviewContext) => ActionPreview;
  /** Status the record must have after it ran (checked before "executed" is recorded). */
  executedStatus?: (p: P) => string;
  undo: { kind: UndoKind; label: string } | null;
}

// ---------- shared pieces ----------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const uuid = z.string().uuid();
const money = z.number().min(0).max(1_000_000_000);
const notes = z.string().max(1000).optional();

const saleLine = z.object({
  product_id: uuid.optional().describe("Product id from find_records (leave out for a free-text line)"),
  description: z.string().min(1).max(500).optional().describe("Line text; defaults to the product name"),
  quantity: z.number().gt(0).max(1_000_000),
  unit_price: money,
  discount_percent: z.number().min(0).max(100).optional(),
  tax_rate: z.number().min(0).max(100).optional().describe("Tax percent for this line, if the user gave one"),
});
type SaleLine = z.infer<typeof saleLine>;
const saleLines = z.array(saleLine).min(1).max(50);

const purchaseLine = saleLine.omit({ discount_percent: true });
const purchaseLines = z.array(purchaseLine).min(1).max(50);

export function ref(refs: RefInfo, type: RefType, id: string | undefined | null): Record<string, unknown> {
  return (id && refs[`${type}:${id}`]) || {};
}
function refName(refs: RefInfo, type: RefType, id: string | undefined | null): string {
  return String(ref(refs, type, id).name ?? "");
}
export function formatMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Product lines: fill the description from the product name. */
function withDescriptions<T extends SaleLine>(lines: T[], refs: RefInfo): T[] {
  return lines.map((l) => ({ ...l, description: l.description ?? (refName(refs, "product", l.product_id) || undefined) }));
}
function lineRefs(lines: { product_id?: string }[]): RefSpec[] {
  return lines.filter((l) => l.product_id).map((l) => ({ type: "product" as const, id: l.product_id! }));
}
function missingDescription(lines: { description?: string }[]): string | null {
  return lines.some((l) => !l.description) ? "Each line needs a product_id or a description." : null;
}

/**
 * Estimated totals for the card: quantity x price, minus discount, plus tax.
 * The ERP calculates the final amounts when it saves (it may also apply
 * company taxes and charges); the result card shows the real total afterwards.
 */
function linePreview(lines: SaleLine[], currency: string) {
  let subtotal = 0;
  let tax = 0;
  const out = lines.map((l) => {
    const net = round2(l.quantity * l.unit_price * (1 - (l.discount_percent ?? 0) / 100));
    subtotal += net;
    tax += round2(net * ((l.tax_rate ?? 0) / 100));
    return { description: l.description ?? "", quantity: l.quantity, unitPrice: formatMoney(l.unit_price, currency), total: formatMoney(net, currency) };
  });
  const totals = [
    { label: "Subtotal", value: formatMoney(round2(subtotal), currency) },
    ...(tax > 0 ? [{ label: "Tax", value: formatMoney(round2(tax), currency) }] : []),
    { label: "Estimated total", value: formatMoney(round2(subtotal + tax), currency) },
  ];
  return { lines: out, totals };
}

function optionalFields(pairs: [string, unknown][]): { label: string; value: string }[] {
  return pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([l, v]) => ({ label: l, value: String(v) }));
}

const DRAFT_UNDO = "Undo deletes the draft";

// ---------- the actions ----------

const createCustomer = z.object({
  name: z.string().trim().min(1).max(200).describe("Customer or company name"),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional().describe("Billing address as one line"),
  tax_number: z.string().max(50).optional(),
  notes,
});

const createLead = z.object({
  contact_name: z.string().trim().min(1).max(200),
  company: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(50).optional(),
  source: z.enum(["website", "referral", "cold_call", "social_media", "advertisement", "email", "other", "facebook_ad", "instagram_ad", "linkedin", "whatsapp", "walk_in", "website_form"]).optional(),
  estimated_value: money.optional(),
  notes,
});

const leadStatus = z.enum(["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"]);
const updateLeadStatus = z.object({
  lead_id: uuid.describe("Lead id from find_records"),
  status: leadStatus,
});

const createInvoice = z.object({
  customer_id: uuid.describe("Customer id from find_records"),
  invoice_date: isoDate.optional().describe("Defaults to today"),
  due_date: isoDate.optional(),
  items: saleLines,
  notes,
});

const createQuotation = z.object({
  customer_id: uuid.describe("Customer id from find_records"),
  quotation_date: isoDate.optional().describe("Defaults to today"),
  valid_until: isoDate.optional(),
  items: saleLines,
  notes,
});

const createPurchaseOrder = z.object({
  vendor_id: uuid.describe("Vendor id from find_records"),
  order_date: isoDate.optional().describe("Defaults to today"),
  expected_delivery_date: isoDate.optional(),
  items: purchaseLines,
  notes,
});

const paymentMethod = z.enum(["cash", "bank_transfer", "cheque", "credit_card", "online", "other"]);
const createExpense = z.object({
  expense_account_id: uuid.describe("Expense account id from find_records type expense_account"),
  description: z.string().trim().min(1).max(500),
  amount: z.number().gt(0).max(1_000_000_000),
  expense_date: isoDate.optional().describe("Defaults to today"),
  payment_method: paymentMethod.optional().describe("Defaults to cash"),
  cash_account_id: uuid.optional().describe("Required for cash: find_records type cash_account"),
  bank_account_id: uuid.optional().describe("Required for bank_transfer or cheque: find_records type bank_account"),
  vendor_id: uuid.optional(),
  category: z.string().max(100).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  reference: z.string().max(100).optional(),
  notes,
});

const createLeaveRequest = z.object({
  employee_id: uuid.describe("Employee id from find_records"),
  leave_type_id: uuid.describe("Leave type id from find_records"),
  start_date: isoDate,
  end_date: isoDate,
  days: z.number().min(0.5).max(366).optional().describe("Defaults to the number of calendar days"),
  reason: z.string().max(1000).optional(),
});

const leaveDecision = z.object({
  leave_request_id: uuid.describe("Leave request id from find_records type leave_request"),
});

const createTask = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Defaults to medium"),
  due_date: isoDate.optional(),
  project_id: uuid.optional(),
  assigned_employee_id: uuid.optional().describe("Employee id from find_records"),
});

const createProduct = z.object({
  name: z.string().trim().min(1).max(200),
  selling_price: money,
  cost_price: money.optional().describe("Defaults to 0"),
  product_type: z.enum(["goods", "service", "consumable"]).optional().describe("Defaults to goods"),
  unit_of_measure: z.string().max(30).optional().describe("Defaults to pcs"),
  reorder_level: z.number().min(0).max(1_000_000).optional().describe("Defaults to 0"),
  sku: z.string().max(60).optional().describe("Leave out to let the ERP number it"),
  description: z.string().max(2000).optional(),
});

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

export const ACTIONS: ActionDefinition<any>[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    name: "create_customer",
    description: "Create a new customer. Ask for the name if it is missing; other fields are optional.",
    parameters: createCustomer,
    anyPermission: ["crm.create"],
    risk: "low",
    record: "customer",
    pagePath: (id) => `/crm/customers/${id}`,
    statusText: "Preparing the new customer…",
    refs: () => [],
    preview: (p: z.infer<typeof createCustomer>) => ({
      title: "Create customer",
      fields: optionalFields([["Name", p.name], ["Email", p.email], ["Phone", p.phone], ["Address", p.address], ["Tax number", p.tax_number], ["Notes", p.notes]]),
      notes: [],
      undo: "Undo deletes the customer",
    }),
    undo: { kind: "delete", label: "Delete the customer" },
  },
  {
    name: "create_lead",
    description: "Create a new CRM lead (status New).",
    parameters: createLead,
    anyPermission: ["crm.create"],
    risk: "low",
    record: "lead",
    pagePath: (id) => `/crm/leads/${id}`,
    statusText: "Preparing the new lead…",
    refs: () => [],
    preview: (p: z.infer<typeof createLead>, ctx) => ({
      title: "Create lead",
      fields: optionalFields([
        ["Contact", p.contact_name], ["Company", p.company], ["Email", p.email], ["Phone", p.phone],
        ["Source", p.source && label(p.source)],
        ["Estimated value", p.estimated_value !== undefined ? formatMoney(p.estimated_value, ctx.currency) : undefined],
        ["Notes", p.notes],
      ]),
      notes: [],
      undo: "Undo deletes the lead",
    }),
    undo: { kind: "delete", label: "Delete the lead" },
  },
  {
    name: "update_lead_status",
    description: "Change the status of an existing lead (new, contacted, qualified, proposal, negotiation, won, lost).",
    parameters: updateLeadStatus,
    anyPermission: ["crm.edit"],
    risk: "low",
    record: "lead",
    pagePath: (id) => `/crm/leads/${id}`,
    statusText: "Preparing the status change…",
    refs: (p: z.infer<typeof updateLeadStatus>) => [{ type: "lead", id: p.lead_id }],
    check: (p: z.infer<typeof updateLeadStatus>, refs) =>
      ref(refs, "lead", p.lead_id).status === p.status ? `The lead is already "${p.status}".` : null,
    preview: (p: z.infer<typeof updateLeadStatus>, ctx) => {
      const lead = ref(ctx.refs, "lead", p.lead_id);
      return {
        title: "Change lead status",
        fields: optionalFields([["Lead", lead.name], ["Company", lead.company], ["Status", `${label(String(lead.status))} → ${label(p.status)}`]]),
        notes: [],
        undo: `Undo sets it back to ${label(String(lead.status))}`,
      };
    },
    executedStatus: (p: z.infer<typeof updateLeadStatus>) => p.status,
    undo: { kind: "restore_status", label: "Restore the previous status" },
  },
  {
    name: "create_draft_invoice",
    description:
      "Create a DRAFT customer invoice (not posted to the accounts, not sent). Find the customer and products with find_records first. Use the product's selling price unless the user gives another price.",
    parameters: createInvoice,
    anyPermission: ["sales.create"],
    risk: "medium",
    record: "invoice",
    pagePath: (id) => `/sales/invoices/${id}`,
    statusText: "Preparing the draft invoice…",
    refs: (p: z.infer<typeof createInvoice>) => [{ type: "customer", id: p.customer_id }, ...lineRefs(p.items)],
    normalize: (p: z.infer<typeof createInvoice>, today, refs) => ({ ...p, invoice_date: p.invoice_date ?? today, items: withDescriptions(p.items, refs) }),
    check: (p: z.infer<typeof createInvoice>) =>
      missingDescription(p.items) ?? (p.due_date && p.invoice_date && p.due_date < p.invoice_date ? "The due date is before the invoice date." : null),
    preview: (p: z.infer<typeof createInvoice>, ctx) => ({
      title: "Create draft invoice",
      fields: optionalFields([["Customer", refName(ctx.refs, "customer", p.customer_id)], ["Invoice date", p.invoice_date], ["Due date", p.due_date], ["Notes", p.notes]]),
      ...linePreview(p.items, ctx.currency),
      notes: ["Saved as a draft: not posted to the accounts and not sent to the customer."],
      undo: DRAFT_UNDO,
    }),
    executedStatus: () => "draft",
    undo: { kind: "delete", label: "Delete the draft invoice" },
  },
  {
    name: "create_quotation",
    description: "Create a DRAFT quotation for a customer. Find the customer and products with find_records first.",
    parameters: createQuotation,
    anyPermission: ["sales.create"],
    risk: "medium",
    record: "quotation",
    pagePath: (id) => `/sales/quotations/${id}`,
    statusText: "Preparing the quotation…",
    refs: (p: z.infer<typeof createQuotation>) => [{ type: "customer", id: p.customer_id }, ...lineRefs(p.items)],
    normalize: (p: z.infer<typeof createQuotation>, today, refs) => ({ ...p, quotation_date: p.quotation_date ?? today, items: withDescriptions(p.items, refs) }),
    check: (p: z.infer<typeof createQuotation>) =>
      missingDescription(p.items) ?? (p.valid_until && p.quotation_date && p.valid_until < p.quotation_date ? "'Valid until' is before the quotation date." : null),
    preview: (p: z.infer<typeof createQuotation>, ctx) => ({
      title: "Create quotation",
      fields: optionalFields([["Customer", refName(ctx.refs, "customer", p.customer_id)], ["Date", p.quotation_date], ["Valid until", p.valid_until], ["Notes", p.notes]]),
      ...linePreview(p.items, ctx.currency),
      notes: ["Saved as a draft: not sent to the customer."],
      undo: DRAFT_UNDO,
    }),
    executedStatus: () => "draft",
    undo: { kind: "delete", label: "Delete the draft quotation" },
  },
  {
    name: "create_purchase_order",
    description: "Create a DRAFT purchase order to a vendor. Find the vendor and products with find_records first. Use the product's cost price unless the user gives another price.",
    parameters: createPurchaseOrder,
    anyPermission: ["purchases.create"],
    risk: "medium",
    record: "purchase_order",
    pagePath: (id) => `/purchasing/orders/${id}`,
    statusText: "Preparing the purchase order…",
    refs: (p: z.infer<typeof createPurchaseOrder>) => [{ type: "vendor", id: p.vendor_id }, ...lineRefs(p.items)],
    normalize: (p: z.infer<typeof createPurchaseOrder>, today, refs) => ({ ...p, order_date: p.order_date ?? today, items: withDescriptions(p.items, refs) }),
    check: (p: z.infer<typeof createPurchaseOrder>) =>
      missingDescription(p.items) ??
      (p.expected_delivery_date && p.order_date && p.expected_delivery_date < p.order_date ? "The delivery date is before the order date." : null),
    preview: (p: z.infer<typeof createPurchaseOrder>, ctx) => ({
      title: "Create purchase order",
      fields: optionalFields([["Vendor", refName(ctx.refs, "vendor", p.vendor_id)], ["Order date", p.order_date], ["Expected delivery", p.expected_delivery_date], ["Notes", p.notes]]),
      ...linePreview(p.items, ctx.currency),
      notes: ["Saved as a draft: not sent to the vendor."],
      undo: DRAFT_UNDO,
    }),
    executedStatus: () => "draft",
    undo: { kind: "delete", label: "Delete the draft purchase order" },
  },
  {
    name: "create_expense",
    description:
      "Record an expense as PENDING (it is posted to the accounts only when someone approves it in the ERP). Needs the expense account (find_records expense_account) and, for cash, the cash account (cash_account) or, for bank transfer/cheque, the bank account (bank_account).",
    parameters: createExpense,
    anyPermission: ["accounting.create"],
    risk: "medium",
    record: "expense",
    pagePath: (id) => `/accounting/expenses/${id}`,
    statusText: "Preparing the expense…",
    refs: (p: z.infer<typeof createExpense>) => [
      { type: "expense_account", id: p.expense_account_id },
      ...(p.cash_account_id ? [{ type: "cash_account" as const, id: p.cash_account_id }] : []),
      ...(p.bank_account_id ? [{ type: "bank_account" as const, id: p.bank_account_id }] : []),
      ...(p.vendor_id ? [{ type: "vendor" as const, id: p.vendor_id }] : []),
    ],
    normalize: (p: z.infer<typeof createExpense>, today) => ({ ...p, expense_date: p.expense_date ?? today, payment_method: p.payment_method ?? "cash" }),
    check: (p: z.infer<typeof createExpense>) => {
      if (p.payment_method === "cash" && !p.cash_account_id) return "Cash expenses need cash_account_id (find_records type cash_account).";
      if ((p.payment_method === "bank_transfer" || p.payment_method === "cheque") && !p.bank_account_id)
        return "Bank transfer or cheque expenses need bank_account_id (find_records type bank_account).";
      return null;
    },
    preview: (p: z.infer<typeof createExpense>, ctx) => {
      const tax = round2(p.amount * ((p.tax_rate ?? 0) / 100));
      return {
        title: "Record expense",
        fields: optionalFields([
          ["Description", p.description],
          ["Expense account", refName(ctx.refs, "expense_account", p.expense_account_id)],
          ["Amount", formatMoney(p.amount, ctx.currency)],
          ["Tax", tax > 0 ? `${formatMoney(tax, ctx.currency)} (${p.tax_rate}%)` : undefined],
          ["Date", p.expense_date],
          ["Paid by", label(p.payment_method ?? "cash")],
          ["Paid from", refName(ctx.refs, "cash_account", p.cash_account_id) || refName(ctx.refs, "bank_account", p.bank_account_id) || undefined],
          ["Supplier", refName(ctx.refs, "vendor", p.vendor_id) || undefined],
          ["Category", p.category], ["Reference", p.reference], ["Notes", p.notes],
        ]),
        notes: ["Saved as Pending: nothing is posted to the accounts until it is approved."],
        undo: "Undo deletes the expense",
      };
    },
    executedStatus: () => "pending",
    undo: { kind: "delete", label: "Delete the expense" },
  },
  {
    name: "create_leave_request",
    description: "Create a leave request (status Pending) for an employee. Find the employee and leave type with find_records first.",
    parameters: createLeaveRequest,
    anyPermission: ["hr.create"],
    risk: "low",
    record: "leave_request",
    pagePath: () => `/hr/leave`,
    statusText: "Preparing the leave request…",
    refs: (p: z.infer<typeof createLeaveRequest>) => [{ type: "employee", id: p.employee_id }, { type: "leave_type", id: p.leave_type_id }],
    normalize: (p: z.infer<typeof createLeaveRequest>) => ({ ...p, days: p.days ?? daysBetween(p.start_date, p.end_date) }),
    check: (p: z.infer<typeof createLeaveRequest>) => (p.end_date < p.start_date ? "The end date is before the start date." : null),
    preview: (p: z.infer<typeof createLeaveRequest>, ctx) => ({
      title: "Create leave request",
      fields: optionalFields([
        ["Employee", refName(ctx.refs, "employee", p.employee_id)], ["Leave type", refName(ctx.refs, "leave_type", p.leave_type_id)],
        ["From", p.start_date], ["To", p.end_date], ["Days", p.days], ["Reason", p.reason],
      ]),
      notes: ["Status: Pending (needs approval)."],
      undo: "Undo deletes the request",
    }),
    executedStatus: () => "pending",
    undo: { kind: "delete", label: "Delete the leave request" },
  },
  {
    name: "approve_leave_request",
    description: "Approve a PENDING leave request. Find it with find_records type leave_request status pending.",
    parameters: leaveDecision,
    anyPermission: ["hr.approve", "hr.edit"],
    risk: "medium",
    record: "leave_request",
    pagePath: () => `/hr/leave`,
    statusText: "Preparing the approval…",
    refs: (p: z.infer<typeof leaveDecision>) => [{ type: "leave_request", id: p.leave_request_id }],
    check: (p: z.infer<typeof leaveDecision>, refs) => {
      const s = ref(refs, "leave_request", p.leave_request_id).status;
      return s === "pending" ? null : `This leave request is already ${s}; only pending requests can be approved.`;
    },
    preview: (p: z.infer<typeof leaveDecision>, ctx) => leavePreview("Approve leave request", p.leave_request_id, ctx),
    executedStatus: () => "approved",
    undo: { kind: "restore_status", label: "Set the request back to Pending" },
  },
  {
    name: "reject_leave_request",
    description: "Reject a PENDING leave request. Find it with find_records type leave_request status pending.",
    parameters: leaveDecision,
    anyPermission: ["hr.approve", "hr.edit"],
    risk: "medium",
    record: "leave_request",
    pagePath: () => `/hr/leave`,
    statusText: "Preparing the rejection…",
    refs: (p: z.infer<typeof leaveDecision>) => [{ type: "leave_request", id: p.leave_request_id }],
    check: (p: z.infer<typeof leaveDecision>, refs) => {
      const s = ref(refs, "leave_request", p.leave_request_id).status;
      return s === "pending" ? null : `This leave request is already ${s}; only pending requests can be rejected.`;
    },
    preview: (p: z.infer<typeof leaveDecision>, ctx) => leavePreview("Reject leave request", p.leave_request_id, ctx),
    executedStatus: () => "rejected",
    undo: { kind: "restore_status", label: "Set the request back to Pending" },
  },
  {
    name: "create_task",
    description: "Create a project task (status To do). Optionally link a project and assign an employee (find them with find_records).",
    parameters: createTask,
    anyPermission: ["projects.create"],
    risk: "low",
    record: "task",
    pagePath: () => `/projects/tasks`,
    statusText: "Preparing the task…",
    refs: (p: z.infer<typeof createTask>) => [
      ...(p.project_id ? [{ type: "project" as const, id: p.project_id }] : []),
      ...(p.assigned_employee_id ? [{ type: "employee" as const, id: p.assigned_employee_id }] : []),
    ],
    normalize: (p: z.infer<typeof createTask>) => ({ ...p, priority: p.priority ?? "medium" }),
    preview: (p: z.infer<typeof createTask>, ctx) => ({
      title: "Create task",
      fields: optionalFields([
        ["Title", p.title], ["Priority", label(p.priority ?? "medium")], ["Due date", p.due_date],
        ["Project", refName(ctx.refs, "project", p.project_id) || undefined],
        ["Assigned to", refName(ctx.refs, "employee", p.assigned_employee_id) || undefined],
        ["Description", p.description],
      ]),
      notes: [],
      undo: "Undo deletes the task",
    }),
    executedStatus: () => "to_do",
    undo: { kind: "delete", label: "Delete the task" },
  },
  {
    name: "create_product",
    description: "Create a product or service in inventory. Ask for the selling price if it is missing.",
    parameters: createProduct,
    anyPermission: ["inventory.create"],
    risk: "low",
    record: "product",
    pagePath: (id) => `/inventory/products/${id}`,
    statusText: "Preparing the product…",
    refs: () => [],
    normalize: (p: z.infer<typeof createProduct>) => ({
      ...p,
      cost_price: p.cost_price ?? 0,
      product_type: p.product_type ?? "goods",
      unit_of_measure: p.unit_of_measure ?? "pcs",
      reorder_level: p.reorder_level ?? 0,
    }),
    preview: (p: z.infer<typeof createProduct>, ctx) => ({
      title: "Create product",
      fields: optionalFields([
        ["Name", p.name], ["Type", label(p.product_type ?? "goods")], ["Selling price", formatMoney(p.selling_price, ctx.currency)],
        ["Cost price", formatMoney(p.cost_price ?? 0, ctx.currency)], ["Unit", p.unit_of_measure], ["Reorder level", p.reorder_level],
        ["SKU", p.sku ?? "automatic"], ["Description", p.description],
      ]),
      notes: [],
      undo: "Undo deletes the product",
    }),
    undo: { kind: "delete", label: "Delete the product" },
  },
];

function leavePreview(title: string, id: string, ctx: PreviewContext): ActionPreview {
  const l = ref(ctx.refs, "leave_request", id);
  return {
    title,
    fields: optionalFields([["Employee", l.name], ["Leave type", l.leave_type], ["From", l.start_date], ["To", l.end_date], ["Days", l.days]]),
    notes: [],
    undo: "Undo sets it back to Pending",
  };
}

const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): ActionDefinition | undefined {
  return BY_NAME.get(name);
}

/** The actions this member may propose (owners/admins: all). */
export function actionsFor(member: MemberContext): ActionDefinition[] {
  return ACTIONS.filter((a) => a.anyPermission.some((p) => can(member, p)));
}

export function memberCanRun(member: MemberContext, action: ActionDefinition): boolean {
  return action.anyPermission.some((p) => can(member, p));
}
