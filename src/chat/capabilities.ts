import type { MemberContext } from "../auth/member-context.js";
import { toolsFor } from "../tools/registry.js";
import { actionsFor } from "../actions/registry.js";

/**
 * "What can you do?" questions. Recognised here; the AI answers them (with the list of what
 * this user's role allows, see capabilitiesContext). Until 17 Nov 2026 this was a fixed,
 * short reply without the AI (Shaheer, 9 Oct); now he wants a full, ChatGPT-like answer.
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

/**
 * What THIS user can ask Soft AI for (only what their role allows), given to the AI with a
 * "what can you do?" question. The AI then explains it in its own words, with examples
 * (Shaheer, 17 Nov 2026: answer like ChatGPT, not a fixed 4-line list).
 */
export function capabilitiesContext(member: MemberContext, enabled: { tools: boolean; actions: boolean }): string {
  const data = enabled.tools ? [...new Set(toolsFor(member).map((t) => DATA_LABELS[t.name]).filter(Boolean))] : [];
  const actions = enabled.actions ? [...new Set(actionsFor(member).map((a) => ACTION_LABELS[a.name]).filter(Boolean))] : [];
  const lines = [
    "<soft_ai_capabilities>",
    "- Open any Softoras page the user can use (for example: \"open invoices\").",
    "- Explain how to do things in Softoras, step by step, with links to the right pages.",
    data.length
      ? `- Read this company's live numbers and records: ${data.join(", ")}.`
      : "- (This user's role cannot read company numbers through Soft AI.)",
    actions.length
      ? `- Prepare changes for the user to confirm (with Undo): ${actions.join(", ")}. Never done without their Confirm.`
      : "- (This user's role cannot prepare changes through Soft AI.)",
    "- General help: write or improve emails, messages and descriptions; maths and calculations; explain business ideas; plan and brainstorm.",
    "- Cannot: send emails, take or record payments, post invoices or delete records.",
    "</soft_ai_capabilities>",
  ];
  return lines.join("\n");
}
