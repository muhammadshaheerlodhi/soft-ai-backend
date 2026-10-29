import { createHash } from "node:crypto";
import type { Sql } from "../db/client.js";
import { toPgVector, type Embedder } from "../ai/embedder.js";
import type { KnowledgeDoc } from "./extract-erp.js";

/**
 * Builds a knowledge release and switches it on (the "release pipeline").
 *
 *   1. split documents into chunks (most ERP help texts are already small)
 *   2. create release <version> with status "building"
 *   3. for each chunk: if the SAME text (same hash) is in the active release,
 *      copy its embedding (no Google call, no cost); otherwise embed it
 *   4. activate: one transaction switches users from the old release to the new
 *
 * If anything fails, the release is marked "failed" and the old one stays
 * active - users never see half-built knowledge.
 */

export interface Chunk {
  sourceType: KnowledgeDoc["sourceType"];
  sourceRef: string;
  title: string;
  content: string;
  urlPath: string | null;
  metadata: Record<string, unknown>;
  hash: string;
}

export interface IndexStats {
  version: string;
  status: "activated" | "already_active";
  chunks: number;
  embedded: number;
  reused: number;
}

const MAX_CHUNK_CHARS = 2000;

/** Splits long documents on line breaks into pieces of at most MAX_CHUNK_CHARS. */
export function chunkDocuments(docs: KnowledgeDoc[], embedderId: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of docs) {
    const parts = splitText(doc.content, MAX_CHUNK_CHARS);
    parts.forEach((content, i) => {
      const sourceRef = parts.length > 1 ? `${doc.sourceRef}#${i + 1}` : doc.sourceRef;
      chunks.push({
        sourceType: doc.sourceType,
        sourceRef,
        title: doc.title,
        content,
        urlPath: doc.urlPath,
        metadata: doc.metadata,
        // The embedder id is part of the hash: switching model re-embeds everything.
        hash: createHash("sha256").update(JSON.stringify([embedderId, doc.title, content, doc.urlPath])).digest("hex"),
      });
    });
  }
  return chunks;
}

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > max ? line.match(new RegExp(`.{1,${max}}`, "gs")) ?? [] : [line];
    for (const p of piece) {
      if (current && current.length + 1 + p.length > max) {
        parts.push(current);
        current = "";
      }
      current = current ? `${current}\n${p}` : p;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export async function indexRelease(opts: {
  sql: Sql;
  embedder: Embedder;
  docs: KnowledgeDoc[];
  version: string;
  notes?: string;
  log?: (msg: string) => void;
}): Promise<IndexStats> {
  const { sql, embedder, version } = opts;
  const log = opts.log ?? (() => {});
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(version)) throw new Error(`Invalid release version "${version}"`);

  const [existing] = await sql<{ status: string; chunk_count: number }[]>`
    select status, chunk_count from soft_ai.knowledge_releases where version = ${version}`;
  if (existing?.status === "active") {
    log(`release ${version} is already active (${existing.chunk_count} chunks); nothing to do`);
    return { version, status: "already_active", chunks: existing.chunk_count, embedded: 0, reused: 0 };
  }
  if (existing) {
    // A previous attempt with this version failed or was interrupted: start clean.
    await sql`delete from soft_ai.knowledge_releases where version = ${version} and status <> 'active'`;
  }

  const chunks = chunkDocuments(opts.docs, embedder.id);
  const unique = new Map(chunks.map((c) => [`${c.sourceRef}|${c.hash}`, c]));
  log(`release ${version}: ${unique.size} chunks from ${opts.docs.length} documents`);

  await sql`insert into soft_ai.knowledge_releases (version, status, notes)
            values (${version}, 'building', ${opts.notes ?? null})`;

  try {
    // Embeddings we can re-use from the active release (same text, same model).
    const reusable = new Map<string, string>();
    const rows = await sql<{ content_hash: string; embedding: string }[]>`
      select distinct on (c.content_hash) c.content_hash, c.embedding::text as embedding
        from soft_ai.knowledge_chunks c
        join soft_ai.knowledge_releases r on r.version = c.release_version and r.status = 'active'
       where c.organization_id is null`;
    for (const r of rows) reusable.set(r.content_hash, r.embedding);

    const toEmbed = [...unique.values()].filter((c) => !reusable.has(c.hash));
    log(`re-using ${unique.size - toEmbed.length} embeddings, embedding ${toEmbed.length} new or changed chunks`);
    const fresh = new Map<string, string>();
    if (toEmbed.length > 0) {
      const vectors = await embedder.embedDocuments(toEmbed.map((c) => ({ title: c.title, text: c.content })));
      toEmbed.forEach((c, i) => fresh.set(c.hash, toPgVector(vectors[i]!)));
    }

    await sql.begin(async (tx) => {
      for (const c of unique.values()) {
        const vector = reusable.get(c.hash) ?? fresh.get(c.hash)!;
        await tx`
          insert into soft_ai.knowledge_chunks
            (release_version, organization_id, source_type, source_ref, title, content, content_hash, url_path, embedding, metadata)
          values (${version}, null, ${c.sourceType}, ${c.sourceRef}, ${c.title}, ${c.content}, ${c.hash}, ${c.urlPath},
                  ${vector}::extensions.vector, ${tx.json({ ...c.metadata, embedder: embedder.id } as never)})`;
      }
    });

    const [activated] = await sql<{ n: number }[]>`select soft_ai.activate_knowledge_release(${version}) as n`;
    log(`release ${version} is now active with ${activated?.n} chunks`);
    return { version, status: "activated", chunks: unique.size, embedded: toEmbed.length, reused: unique.size - toEmbed.length };
  } catch (err) {
    await sql`update soft_ai.knowledge_releases set status = 'failed', notes = ${String((err as Error).message).slice(0, 500)}
              where version = ${version} and status = 'building'`.catch(() => {});
    throw err;
  }
}
