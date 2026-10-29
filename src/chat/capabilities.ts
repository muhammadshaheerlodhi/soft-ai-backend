import type { MemberContext } from "../auth/member-context.js";
import { toolsFor } from "../tools/registry.js";
import { actionsFor } from "../actions/registry.js";

/**
 * "What can you do?" - a SHORT answer, built from what THIS user's role
 * allows (free: answered by our own code, no AI). Shaheer's request (9 Oct 2026):
 * the user should see at a glance what kind of work Soft AI can do.
 */

const ASK_EN =
  /^(?:so\s+)?(?:what\s+(?:can|could)\s+(?:you|u|soft\s*ai)\s+do(?:\s+for\s+(?:me|us))?|what\s+do\s+you\s+do|what\s+are\s+you\s+able\s+to\s+do|how\s+can\s+you\s+help(?:\s+(?:me|us))?|what\s+can\s+i\s+(?:ask|do)(?:\s+(?:you|here|with\s+(?:you|soft\s*ai)))?|help|features|your\s+features|capabilities)$/i;
const ASK_UR =
  /^(?:tum|aap|ap|tm)\s+(?:kya|kia)(?:\s+(?:kya|kia))?\s+(?:kar|kr)\s+(?:sakte|sakty|skte|skty|sakti)\s*(?:ho|hain|hn|hai)?(?:\s+mere\s+liye)?$/i;

export function isCapabilitiesQuestion(text: string): "en" | "ur" | null {
  const t = text.toLowerCase().replace(/[?!.,؟۔]+$/u, "").replace(/\s+/g, " ").trim();
  if (ASK_EN.test(t)) return "en";
  if (ASK_UR.test(t)) return "ur";
  return null;
}

// Short labels for the data tools and actions (only the ones the role allows are shown).
const DATA_LABELS: Record<string, string> = {
  receivables_summary: "money customers owe",
  list_unpaid_invoices: "unpaid invoices",
  sales_summary: "sales",
  find_customers: "customers",
  payables_summary: "bills to pay",
  cash_and_bank_balances: "cash & bank",
  stock_levels: "stock",
  hr_today: "attendance & leave",
  expenses_summary: "expenses",
};
const ACTION_LABELS: Record<string, string> = {
  create_draft_invoice: "draft invoices",
  create_quotation: "quotations",
  create_purchase_order: "purchase orders",
  create_customer: "customers",
  create_lead: "leads",
  update_lead_status: "lead status",
  create_expense: "expenses",
  create_leave_request: "leave requests",
  approve_leave_request: "leave approvals",
  create_task: "tasks",
  create_product: "products",
};

export function capabilitiesReply(
  member: MemberContext,
  lang: "en" | "ur",
  enabled: { tools: boolean; actions: boolean },
): string {
  const data = enabled.tools ? [...new Set(toolsFor(member).map((t) => DATA_LABELS[t.name]).filter(Boolean))] : [];
  const actions = enabled.actions ? [...new Set(actionsFor(member).map((a) => ACTION_LABELS[a.name]).filter(Boolean))] : [];

  if (lang === "ur") {
    const lines = [
      "Main aap ke liye ye kaam kar sakta hoon:",
      "- **Koi bhi page kholna** - jaise \"invoices kholo\"",
      "- **Softoras chalana sikhana** - kisi bhi feature ke steps",
      ...(data.length ? [`- **Aap ke numbers batana** - ${data.join(", ")}`] : []),
      ...(actions.length ? [`- **Kaam tayyar karna** - ${actions.join(", ")} (aap confirm karein, undo bhi ho sakta hai)`] : []),
      "- **General sawal** - likhna, hisaab, mashwara",
      "",
      "Bas likhiye aap ko kya chahiye.",
    ];
    return lines.join("\n");
  }
  const lines = [
    "Here's what I can do for you:",
    "- **Open any page** - e.g. \"open invoices\"",
    "- **Show you how** to do anything in Softoras",
    ...(data.length ? [`- **Check your numbers** - ${data.join(", ")}`] : []),
    ...(actions.length ? [`- **Prepare work for you** - ${actions.join(", ")} (you confirm, and can undo)`] : []),
    "- **General help** - writing, maths, business questions",
    "",
    "Just type what you need.",
  ];
  return lines.join("\n");
}
