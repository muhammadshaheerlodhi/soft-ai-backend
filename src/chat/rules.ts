import type { Sql } from "../db/client.js";
import type { MemberContext } from "../auth/member-context.js";
import { can } from "../auth/permissions.js";
import type { PageEntry } from "../knowledge/extract-erp.js";

/**
 * The rules engine: common commands answered by our own code. Free (no AI,
 * no credits) and instant. It only answers when it is SURE:
 *   - a greeting or thanks on its own
 *   - "open / go to / show <page>" (also Roman Urdu "<page> kholo") that matches
 *     exactly ONE page the user is allowed to open
 *   - "create / new <thing>" that matches exactly one quick-create page
 * Anything else (e.g. "show unpaid invoices of Ali") goes to the AI as usual.
 */

export interface RuleAnswer {
  kind: "greeting" | "thanks" | "navigate";
  reply: string;
  /** For "navigate": the page the panel should open. */
  navigateTo?: string;
}

const GREETING = /^(hi|hii+|hello|hey|salam|salaam|assalam(u|o)?\s*(o|u)?\s*alaikum|aoa|good (morning|afternoon|evening)|السلام علیکم|سلام)$/i;
const THANKS = /^(thanks|thank you|thank u|thx|ty|shukriya|bohat shukriya|bahut shukriya|jazakallah|شکریہ)( (so much|a lot|bhai))?$/i;
const OPEN = /^(?:please\s+)?(?:open|go to|goto|take me to|navigate to|show me|show)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:page|screen|tab|section|menu))?$/i;
const OPEN_URDU = /^(?:mujhe\s+)?(.+?)\s+(?:kholo|khol do|open karo|open kardo|par le jao|pe le jao|page kholo)$/i;
const CREATE = /^(?:please\s+)?(?:create|new|add|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(.+)$/i;

/** Short names people use for some pages. */
const ALIASES: Record<string, string> = {
  po: "purchase orders",
  pos: "pos till",
  till: "pos till",
  grn: "goods receipts",
  grns: "goods receipts",
  home: "dashboard",
  "chart of accounts": "chart of accounts",
  coa: "chart of accounts",
  "journal entries": "journal vouchers",
  journals: "journal vouchers",
};

export function matchRule(text: string, pages: PageEntry[]): RuleAnswer | null {
  const t = clean(text);
  if (!t || t.length > 80) return null;

  if (GREETING.test(t)) return { kind: "greeting", reply: "Hi! How can I help you today?" };
  if (THANKS.test(t)) return { kind: "thanks", reply: "You're welcome! Anything else I can help with?" };

  const create = CREATE.exec(t);
  if (create?.[1]) {
    const page = findOne(pages.filter((p) => p.kind === "create"), create[1], (p) => p.title.replace(/^new\s+/i, ""));
    if (page) {
      return {
        kind: "navigate",
        reply: `Opening the form for a **${page.title}**. [${page.title}](${page.href})`,
        navigateTo: page.href,
      };
    }
    return null; // e.g. "create an invoice for Ali ..." -> the AI handles it
  }

  const open = OPEN.exec(t) ?? OPEN_URDU.exec(t);
  if (open?.[1]) {
    const page = findOne(pages.filter((p) => p.kind === "page"), open[1], (p) => p.title);
    if (page) {
      return {
        kind: "navigate",
        reply: `Opening **${page.title}**${page.group !== page.title ? ` (${page.group})` : ""}. [${page.title}](${page.href})`,
        navigateTo: page.href,
      };
    }
  }
  return null;
}

/** Exactly one page whose name matches the target, or null (ambiguous / not found). */
function findOne(pages: PageEntry[], target: string, nameOf: (p: PageEntry) => string): PageEntry | null {
  const want = norm(ALIASES[clean(target)] ?? target);
  if (!want) return null;
  const exact = uniqueByHref(pages.filter((p) => norm(nameOf(p)) === want));
  if (exact.length === 1) return exact[0]!;
  // "sales invoices" / "invoices in sales": group + name
  const withGroup = uniqueByHref(
    pages.filter((p) => norm(`${p.group} ${nameOf(p)}`) === want || norm(`${nameOf(p)} ${p.group}`) === want),
  );
  return withGroup.length === 1 ? withGroup[0]! : null;
}

function uniqueByHref(pages: PageEntry[]): PageEntry[] {
  return [...new Map(pages.map((p) => [p.href, p])).values()];
}

function clean(s: string): string {
  return s.toLowerCase().replace(/[?!.,؟۔]+$/u, "").replace(/\s+/g, " ").trim();
}

/** Compare names loosely: no punctuation, no plural "s". */
function norm(s: string): string {
  return clean(s)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");
}

// ---------------- the page list, from the active knowledge release ----------------

/**
 * Loads the menu pages saved by the release pipeline, and keeps them in
 * memory until the active release changes.
 */
export function createPageDirectory(sql: Sql) {
  let cache: { version: string; pages: PageEntry[]; checkedAt: number } | null = null;
  const RECHECK_MS = 60_000;

  async function allPages(): Promise<PageEntry[]> {
    if (cache && Date.now() - cache.checkedAt < RECHECK_MS) return cache.pages;
    const [release] = await sql<{ version: string }[]>`
      select version from soft_ai.knowledge_releases where status = 'active' limit 1`;
    if (!release) {
      cache = { version: "", pages: [], checkedAt: Date.now() };
      return [];
    }
    if (cache?.version === release.version) {
      cache.checkedAt = Date.now();
      return cache.pages;
    }
    const rows = await sql<{ metadata: { pages?: PageEntry[] } }[]>`
      select metadata from soft_ai.knowledge_chunks
       where release_version = ${release.version} and source_type = 'page_map' and organization_id is null`;
    const pages = rows.flatMap((r) => r.metadata.pages ?? []);
    cache = { version: release.version, pages, checkedAt: Date.now() };
    return pages;
  }

  return {
    /** Pages this member may open (same permission rule as the ERP's menu). */
    async pagesFor(member: MemberContext): Promise<PageEntry[]> {
      return (await allPages()).filter((p) => !p.permission || !/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(p.permission) || can(member, p.permission));
    },
  };
}

export type PageDirectory = ReturnType<typeof createPageDirectory>;
