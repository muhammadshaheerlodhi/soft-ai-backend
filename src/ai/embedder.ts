import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { AiProviderError } from "./provider.js";

/**
 * Embeddings turn text into a list of numbers (a "vector") so that texts with
 * similar meaning get similar numbers. The knowledge base stores one vector per
 * piece of help text; a user's question is turned into a vector and the closest
 * pieces are found (step 6, RAG).
 *
 * All vectors are 768 numbers long (matches soft_ai.knowledge_chunks) and
 * normalized to length 1, so "closeness" is comparable everywhere.
 */
export const EMBEDDING_DIMENSIONS = 768;

export interface KnowledgeText {
  title: string;
  text: string;
}

export interface Embedder {
  /** Identifies the model + settings; part of each chunk's hash, so a model change re-embeds everything. */
  readonly id: string;
  embedDocuments(docs: KnowledgeText[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

// ---------------- Gemini ----------------

/**
 * Google Gemini embeddings (checked against Google's docs, Oct 2026):
 *  - gemini-embedding-2: the task is written INTO the text
 *      queries:   "task: search result | query: <question>"
 *      documents: "title: <title> | text: <content>"
 *  - gemini-embedding-001: the task is given as taskType
 *      RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT
 *  - outputDimensionality 768 is a recommended size.
 */
export class GeminiEmbedder implements Embedder {
  readonly id: string;
  private readonly client: GoogleGenAI;
  private readonly batchSize = 50;
  /** Requests at the same time when each text needs its own request (gentle on rate limits). */
  private readonly parallel = 2;
  /** Retries for "too many requests" (429) and temporary Google errors (5xx). */
  private readonly maxAttempts = 6;

  constructor(private readonly options: { apiKey: string; model: string }) {
    if (!options.apiKey) throw new Error("GEMINI_API_KEY is required for embeddings");
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.id = `gemini:${options.model}:${EMBEDDING_DIMENSIONS}`;
  }

  private get usesTaskType() {
    return this.options.model.includes("embedding-001");
  }

  async embedDocuments(docs: KnowledgeText[]): Promise<number[][]> {
    if (this.usesTaskType) {
      // gemini-embedding-001: one request can embed a list of texts (one vector each).
      const out: number[][] = [];
      for (let i = 0; i < docs.length; i += this.batchSize) {
        const batch = docs.slice(i, i + this.batchSize);
        out.push(...(await this.call(batch.map((d) => d.text), "RETRIEVAL_DOCUMENT", batch.map((d) => d.title))));
      }
      return out;
    }
    // gemini-embedding-2 is multimodal: several texts in ONE request are treated as one
    // combined input and return ONE vector (found when indexing; the size check caught it).
    // So each text is its own request, a few at a time.
    const out = new Array<number[]>(docs.length);
    let next = 0;
    const worker = async () => {
      while (next < docs.length) {
        const i = next++;
        const d = docs[i]!;
        const [vector] = await this.call([`title: ${d.title} | text: ${d.text}`], "RETRIEVAL_DOCUMENT");
        out[i] = vector!; // call() guarantees exactly one vector per text
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.parallel, docs.length) }, worker));
    return out;
  }

  async embedQuery(query: string): Promise<number[]> {
    const content = this.usesTaskType ? query : `task: search result | query: ${query}`;
    const [vector] = await this.call([content], "RETRIEVAL_QUERY");
    return vector!;
  }

  private async call(contents: string[], taskType: string, titles?: string[]): Promise<number[][]> {
    let response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await this.client.models.embedContent({
          model: this.options.model,
          contents,
          config: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            ...(this.usesTaskType ? { taskType, ...(titles?.length === 1 ? { title: titles[0] } : {}) } : {}),
          },
        });
        break;
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status);
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (retryable && attempt < this.maxAttempts) {
          // 1 s, 2 s, 4 s, 8 s, 16 s (+ a little randomness so parallel requests spread out)
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 500));
          continue;
        }
        throw new AiProviderError(`Gemini embedding failed${status ? ` (status ${status})` : ""}`, { cause: err });
      }
    }
    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== contents.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new AiProviderError(`Gemini embedding returned unexpected sizes (${vectors.length} for ${contents.length} texts)`);
    }
    return vectors.map(normalize);
  }
}

// ---------------- fake (tests, no cost) ----------------

/**
 * Deterministic "bag of words" vectors: texts sharing words get similar
 * vectors. Good enough to test search, ranking and the pipeline without
 * calling Google. Never used in production.
 */
export class FakeEmbedder implements Embedder {
  readonly id = `fake:bow:${EMBEDDING_DIMENSIONS}`;
  calls = 0;

  async embedDocuments(docs: KnowledgeText[]): Promise<number[][]> {
    this.calls += 1;
    return docs.map((d) => bagOfWords(`${d.title} ${d.text}`));
  }

  async embedQuery(query: string): Promise<number[]> {
    this.calls += 1;
    return bagOfWords(query);
  }
}

function bagOfWords(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 3) continue;
    const stem = word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
    const h = createHash("sha1").update(stem).digest();
    v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS]! += 1;
  }
  return normalize(v);
}

/** Scale a vector to length 1 (so cosine similarity works the same for every model). */
export function normalize(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (len === 0) {
    const unit = new Array<number>(v.length).fill(0);
    unit[0] = 1; // empty text: any fixed unit vector, never NaN
    return unit;
  }
  return v.map((x) => x / len);
}

/** pgvector text format: "[0.1,0.2,...]" */
export function toPgVector(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0).toFixed(7)).join(",")}]`;
}
