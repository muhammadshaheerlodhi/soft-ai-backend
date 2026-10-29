import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Reads the help content that already exists in Shaheer's ERP code and turns
 * it into knowledge documents:
 *
 *   src/config/module-instructions.ts   page guides (title, summary, steps)  -> "module_guide"
 *   src/config/navigation.ts            menu: groups, pages, permissions     -> "page_map"
 *   src/config/settings-navigation.ts   settings menu                        -> "page_map"
 *   src/lib/shaka/knowledge.ts          how-to answers (old Shaka assistant) -> "faq"
 *
 * The files are imported as real TypeScript modules (they are plain data), so
 * there is no fragile text parsing. Each shape is checked; if Shaheer changes a
 * file's structure, extraction FAILS LOUDLY and the release pipeline keeps the
 * previous knowledge active instead of indexing something wrong.
 */

export type SourceType = "module_guide" | "page_map" | "faq";

export interface KnowledgeDoc {
  sourceType: SourceType;
  /** Stable id of the source, e.g. "guide:/sales/invoices". */
  sourceRef: string;
  title: string;
  content: string;
  /** ERP page to link to, or null. */
  urlPath: string | null;
  metadata: Record<string, unknown>;
}

/** One page of the ERP menu, used by the rules engine ("open invoices"). */
export interface PageEntry {
  title: string;
  href: string;
  group: string;
  module: string | null;
  permission: string | null;
  kind: "page" | "create";
}

export interface ExtractResult {
  docs: KnowledgeDoc[];
  pages: PageEntry[];
}

// ---------- shapes we expect in the ERP files ----------

const instructionsSchema = z.record(
  z.string().startsWith("/"),
  z.object({ title: z.string().min(1), summary: z.string(), steps: z.array(z.string()) }),
);
const navItemSchema = z.object({
  title: z.string().min(1),
  href: z.string().startsWith("/"),
  module: z.string().optional(),
  permission: z.string().optional(),
});
const navGroupsSchema = z.array(z.object({ title: z.string().min(1), module: z.string().optional(), items: z.array(navItemSchema) }));
const settingsNavSchema = z.array(navItemSchema);
const quickCreateSchema = z.array(z.object({ title: z.string().min(1), href: z.string().startsWith("/"), module: z.string().optional() }));
const shakaKnowledgeSchema = z.array(z.object({ reply: z.string().min(1), navigateTo: z.string().startsWith("/").optional() }));

export async function extractErpKnowledge(erpRoot: string): Promise<ExtractResult> {
  const load = async (rel: string) => {
    const file = join(erpRoot, rel);
    if (!existsSync(file)) throw new Error(`ERP file not found: ${rel}`);
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  };
  const check = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const r = schema.safeParse(value);
    if (!r.success) {
      throw new Error(`ERP file changed shape (${what}): ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
    }
    return r.data;
  };

  const instructions = check(instructionsSchema, (await load("src/config/module-instructions.ts")).MODULE_INSTRUCTIONS, "MODULE_INSTRUCTIONS");
  const nav = await load("src/config/navigation.ts");
  const groups = check(navGroupsSchema, nav.mainNavigation, "mainNavigation");
  const quickCreate = check(quickCreateSchema, nav.quickCreateOptions, "quickCreateOptions");
  const settingsNav = check(settingsNavSchema, (await load("src/config/settings-navigation.ts")).settingsNavigation, "settingsNavigation");
  const shaka = check(shakaKnowledgeSchema, (await load("src/lib/shaka/knowledge.ts")).SHAKA_KNOWLEDGE, "SHAKA_KNOWLEDGE");

  // ---------- the page list ----------
  const pages: PageEntry[] = [];
  const seen = new Set<string>();
  const addPage = (p: PageEntry) => {
    const key = `${p.kind}:${p.href}`;
    if (seen.has(key)) return;
    seen.add(key);
    pages.push(p);
  };
  for (const g of groups) {
    for (const item of g.items) {
      addPage({ title: item.title, href: item.href, group: g.title, module: item.module ?? g.module ?? null, permission: item.permission ?? null, kind: "page" });
    }
  }
  for (const item of settingsNav) {
    addPage({ title: item.title, href: item.href, group: "Settings", module: null, permission: item.permission ?? null, kind: "page" });
  }
  for (const item of quickCreate) {
    addPage({ title: `New ${item.title}`, href: item.href, group: "Create", module: item.module ?? null, permission: null, kind: "create" });
  }

  const docs: KnowledgeDoc[] = [];

  // ---------- menu (page map): one document per menu group ----------
  const byGroup = new Map<string, PageEntry[]>();
  for (const p of pages) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
  for (const [group, list] of byGroup) {
    const lines = list.map((p) => `- ${p.title}: [${p.title}](${p.href})`);
    docs.push({
      sourceType: "page_map",
      sourceRef: `menu:${group}`,
      title: group === "Create" ? "Create new records (quick create)" : `${group} menu`,
      content: `${group === "Create" ? "Pages to create new records" : `Pages in the ${group} menu of Softoras ERP`}:\n${lines.join("\n")}`,
      urlPath: list[0]?.href ?? null,
      metadata: { group, pages: list },
    });
  }

  // ---------- page guides ----------
  for (const [route, ins] of Object.entries(instructions)) {
    const page = findPage(pages, route);
    const where = page ? `Where: ${page.group} menu > ${page.title}.` : null;
    const steps = ins.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    docs.push({
      sourceType: "module_guide",
      sourceRef: `guide:${route}`,
      title: ins.title,
      content: [ins.summary, where, steps ? `How to use:\n${steps}` : null, `Link: [${ins.title}](${route})`].filter(Boolean).join("\n"),
      urlPath: route,
      metadata: { route, group: page?.group ?? null, permission: page?.permission ?? null },
    });
  }

  // ---------- how-to answers ----------
  shaka.forEach((entry, i) => {
    // Title: the linked page's real name (short, good as a "Related pages" link);
    // otherwise the first sentence of the answer.
    const linked = entry.navigateTo ? findPage(pages, entry.navigateTo) : undefined;
    const firstSentence = entry.reply.split(/(?<=[.!?])\s/)[0] ?? entry.reply;
    const title = linked?.title ?? (firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence);
    docs.push({
      sourceType: "faq",
      sourceRef: `faq:${i}`,
      title,
      content: entry.navigateTo ? `${entry.reply}\nLink: (${entry.navigateTo})` : entry.reply,
      urlPath: entry.navigateTo ?? null,
      metadata: {},
    });
  });

  if (docs.length === 0 || pages.length === 0) throw new Error("No ERP knowledge found");
  return { docs, pages };
}

/** The menu page for a route: exact match, else the longest menu link that the route starts with. */
function findPage(pages: PageEntry[], route: string): PageEntry | undefined {
  const exact = pages.find((p) => p.kind === "page" && p.href === route);
  if (exact) return exact;
  return pages
    .filter((p) => p.kind === "page" && route.startsWith(`${p.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
