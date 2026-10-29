import { createHash } from "node:crypto";
import type { Sql } from "../db/client.js";

/**
 * Answer cache: the same stand-alone question asked again in the SAME
 * organization gets the saved answer - instantly and free.
 *
 * Deliberately narrow, to never give a wrong or someone else's answer:
 *   - only for the FIRST message of a chat (answers that depend on earlier
 *     messages are never cached)
 *   - only for answers that used NO company data (true for all answers until
 *     step 7; data answers will never be cached)
 *   - per organization (never shared), per knowledge release (a new ERP release
 *     starts fresh), per model, and only for a limited time (default 24 hours)
 */

export interface CachedAnswer {
  answer: string;
  sources: unknown[];
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").replace(/[?!.,؟۔\s]+$/u, "").trim();
}

function hashQuestion(q: string): string {
  return createHash("sha256").update(normalizeQuestion(q)).digest("hex");
}

export function createAnswerCache(sql: Sql, opts: { ttlHours: number }) {
  return {
    async get(key: { organizationId: string; question: string; releaseVersion: string; model: string }): Promise<CachedAnswer | null> {
      const [row] = await sql<{ answer: string; sources: unknown[] }[]>`
        update soft_ai.answer_cache set hits = hits + 1
         where organization_id = ${key.organizationId}
           and question_hash = ${hashQuestion(key.question)}
           and release_version = ${key.releaseVersion}
           and model = ${key.model}
           and expires_at > now()
        returning answer, sources`;
      return row ?? null;
    },

    async put(key: { organizationId: string; question: string; releaseVersion: string; model: string }, value: CachedAnswer): Promise<void> {
      await sql`
        insert into soft_ai.answer_cache (organization_id, question_hash, release_version, model, answer, sources, expires_at)
        values (${key.organizationId}, ${hashQuestion(key.question)}, ${key.releaseVersion}, ${key.model},
                ${value.answer}, ${sql.json(value.sources as never)}, now() + make_interval(hours => ${opts.ttlHours}))
        on conflict (organization_id, question_hash, release_version, model)
        do update set answer = excluded.answer, sources = excluded.sources, expires_at = excluded.expires_at, hits = 0`;
    },

    /** Housekeeping: remove expired answers (scheduled job later). */
    async cleanup(): Promise<number> {
      const rows = await sql`delete from soft_ai.answer_cache where expires_at < now() returning 1`;
      return rows.length;
    },
  };
}

export type AnswerCache = ReturnType<typeof createAnswerCache>;
