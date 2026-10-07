import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkDocuments } from "../../src/knowledge/indexer.js";
import { extractErpKnowledge, type KnowledgeDoc } from "../../src/knowledge/extract-erp.js";
import { FakeEmbedder, normalize, toPgVector, EMBEDDING_DIMENSIONS } from "../../src/ai/embedder.js";
import { formatKnowledgeForPrompt } from "../../src/knowledge/retrieve.js";
import { withKnowledge } from "../../src/chat/prompt.js";

const doc = (content: string, title = "Invoices"): KnowledgeDoc => ({
  sourceType: "module_guide",
  sourceRef: `guide:${title}`,
  title,
  content,
  urlPath: "/sales/invoices",
  metadata: {},
});

describe("chunking", () => {
  it("keeps short help texts whole", () => {
    expect(chunkDocuments([doc("short text")], "m1")).toHaveLength(1);
  });

  it("splits long texts on line breaks, every piece within the limit", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i}: some help text that is long enough.`).join("\n");
    const chunks = chunkDocuments([doc(long)], "m1");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(2000);
    expect(new Set(chunks.map((c) => c.sourceRef)).size).toBe(chunks.length); // unique ids
    expect(chunks.map((c) => c.content).join("\n")).toBe(long); // nothing lost
  });

  it("the same text gets the same hash; a change of text or model gets a new one", () => {
    const [a] = chunkDocuments([doc("x")], "m1");
    const [b] = chunkDocuments([doc("x")], "m1");
    const [c] = chunkDocuments([doc("y")], "m1");
    const [d] = chunkDocuments([doc("x")], "m2");
    expect(a!.hash).toBe(b!.hash);
    expect(a!.hash).not.toBe(c!.hash);
    expect(a!.hash).not.toBe(d!.hash); // new embedding model -> re-embed
  });
});

describe("vectors", () => {
  it("are normalized to length 1 and have 768 numbers", async () => {
    const [v] = await new FakeEmbedder().embedDocuments([{ title: "t", text: "receive goods purchase order" }]);
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.sqrt(v!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("an empty text never produces broken numbers", () => {
    expect(normalize([0, 0, 0]).every(Number.isFinite)).toBe(true);
    expect(toPgVector([1, Number.NaN])).toBe("[1.0000000,0.0000000]");
  });
});

describe("help text for the AI", () => {
  it("is added before the question, and nothing is added when there is no match", () => {
    const block = formatKnowledgeForPrompt([
      { id: 1, title: "Goods Receipts", content: "Record goods received.", urlPath: "/purchasing/receipts", sourceType: "module_guide", similarity: 0.8 },
    ]);
    expect(block).toContain("<softoras_help>");
    expect(block).toContain("(page: /purchasing/receipts)");
    expect(withKnowledge("How do I receive goods?", block)).toMatch(/<\/softoras_help>\n\nUser question: How do I receive goods\?$/);
    expect(withKnowledge("hi there", "")).toBe("hi there");
  });
});

// Reads Shaheer's real ERP code when it is on this computer (skipped elsewhere).
const ERP = process.env.ERP_PATH ?? "D:/Softoras_AI_Assistant/repo/current/Softoras-ERP-main";
describe.skipIf(!existsSync(ERP))("reading the real ERP code", () => {
  it("finds page guides, menu pages and how-to answers with valid links", async () => {
    const { docs, pages } = await extractErpKnowledge(ERP);
    expect(docs.filter((d) => d.sourceType === "module_guide").length).toBeGreaterThan(50);
    expect(docs.some((d) => d.sourceType === "page_map")).toBe(true);
    expect(pages.find((x) => x.href === "/sales/invoices")?.title).toBe("Invoices");
    for (const d of docs) {
      expect(d.content.length).toBeGreaterThan(0);
      if (d.urlPath) expect(d.urlPath.startsWith("/")).toBe(true);
    }
  });

  it("fails loudly when the ERP folder is wrong (old knowledge stays active)", async () => {
    await expect(extractErpKnowledge("D:/does-not-exist")).rejects.toThrow(/ERP file not found/);
  });
});
