import type { Sql } from "../db/client.js";
import { toPgVector, type Embedder } from "../ai/embedder.js";

/**
 * Finds the pieces of ERP help that best match a question (the "R" in RAG).
 * Only pieces at least `minSimilarity` close are used, so a question with no
 * good match gets NO help text (and the AI says it does not know the screen)
 * instead of loosely related text.
 */
export interface KnowledgeHit {
  id: number;
  title: string;
  content: string;
  urlPath: string | null;
  sourceType: string;
  similarity: number;
}

export interface RetrievalResult {
  hits: KnowledgeHit[];
  releaseVersion: string | null;
}

export async function retrieveKnowledge(opts: {
  sql: Sql;
  embedder: Embedder;
  organizationId: string;
  question: string;
  topK: number;
  minSimilarity: number;
}): Promise<RetrievalResult> {
  const [release] = await opts.sql<{ version: string }[]>`
    select version from soft_ai.knowledge_releases where status = 'active' limit 1`;
  if (!release) return { hits: [], releaseVersion: null }; // nothing indexed yet

  const vector = await opts.embedder.embedQuery(opts.question);
  const rows = await opts.sql<{ id: string; title: string; content: string; url_path: string | null; source_type: string; similarity: number }[]>`
    select id::text, title, content, url_path, source_type, similarity
      from soft_ai.match_knowledge(${toPgVector(vector)}::extensions.vector, ${opts.organizationId}::uuid, ${opts.topK})`;

  return {
    releaseVersion: release.version,
    hits: rows
      .filter((r) => Number(r.similarity) >= opts.minSimilarity)
      .map((r) => ({
        id: Number(r.id),
        title: r.title,
        content: r.content,
        urlPath: r.url_path,
        sourceType: r.source_type,
        similarity: Number(r.similarity),
      })),
  };
}

/** The help text block added to the user's question for the AI. */
export function formatKnowledgeForPrompt(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h, i) => `[${i + 1}] ${h.title}${h.urlPath ? ` (page: ${h.urlPath})` : ""}\n${h.content}`);
  return `<softoras_help>\n${parts.join("\n\n")}\n</softoras_help>`;
}
