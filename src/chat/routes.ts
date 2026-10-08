import type { Context, Hono } from "hono";
import { InsufficientCreditsError } from "../credits/store.js";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { StreamMeter } from "../credits/metering-stream.js";
import { getWalletBalance } from "../credits/wallet.js";
import { ApiError, describeError } from "../http/errors.js";
import { rateLimit, type RateLimitRule } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { isUuid } from "../lib/uuid.js";
import type { Embedder } from "../ai/embedder.js";
import { formatKnowledgeForPrompt, retrieveKnowledge, type RetrievalResult } from "../knowledge/retrieve.js";
import { createChatRepository, type ConversationRow, type MessageRow, type MessageSource, type Owner } from "./repository.js";
import { buildHistory, SYSTEM_PROMPT, titleFromMessage, withKnowledge } from "./prompt.js";
import { matchRule, type PageDirectory } from "./rules.js";
import type { AnswerCache } from "./answer-cache.js";
import { toJsonSchema, toolsFor, getTool } from "../tools/registry.js";
import { executeToolCalls, type ToolCall, type ToolResult } from "../tools/execute.js";
import { actionsFor, getAction } from "../actions/registry.js";
import type { ActionCard, ActionService, TurnActions } from "../actions/service.js";

export interface ChatRouteOptions {
  sql: Sql;
  meter: StreamMeter;
  model: string;
  maxOutputTokens: number;
  rateLimitRules: RateLimitRule[];
  /** Longest message a user may send (characters). */
  maxMessageChars: number;
  /** How much earlier conversation is sent to the AI with each new message. */
  history: { maxMessages: number; maxChars: number };
  /** Step 6: knowledge base search. Leave out to answer without ERP help text. */
  knowledge?: { embedder: Embedder; topK: number; minSimilarity: number };
  /** Step 6: free answers for common commands ("open invoices"). */
  pages?: PageDirectory;
  /** Step 6: free answers for repeated stand-alone questions. */
  cache?: AnswerCache;
  /** Step 7: company-data tools. maxRounds = AI rounds per question (tools + final answer). */
  tools?: { maxRounds: number };
  /** Step 8: actions the user confirms (needs tools: the AI finds records with them). */
  actions?: ActionService;
}

const sendSchema = z.object({
  content: z.string().trim().min(1, "Message is empty."),
  /** Which ERP page the user is on (helps later steps; stored with the message). */
  pageContext: z
    .object({
      path: z.string().max(300).optional(),
      title: z.string().max(200).optional(),
    })
    .strict()
    .optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    isPinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

/**
 * Chat endpoints (all behind login + organization checks):
 *
 *   POST   /v1/chat/conversations                 new chat
 *   GET    /v1/chat/conversations                 my chats (chat list), ?archived=true, ?before=<time>
 *   GET    /v1/chat/conversations/:id/messages    messages of one chat
 *   PATCH  /v1/chat/conversations/:id             rename / pin / archive
 *   DELETE /v1/chat/conversations/:id             delete (hidden)
 *   POST   /v1/chat/conversations/:id/messages    send a message; the reply streams back
 *
 * A user only ever sees their OWN chats in the current organization.
 */
export function registerChatRoutes(v1: Hono<AppEnv>, opts: ChatRouteOptions) {
  const repo = createChatRepository(opts.sql);
  const owner = (c: { get: (k: "member") => { organizationId: string; userId: string } }) => ({
    organizationId: c.get("member").organizationId,
    userId: c.get("member").userId,
  });

  v1.post("/chat/conversations", async (c) => {
    const conv = await repo.createConversation(owner(c));
    return c.json(toConversation(conv), 201);
  });

  v1.get("/chat/conversations", async (c) => {
    const before = c.req.query("before");
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw new ApiError(400, "bad_request", "Invalid 'before' value.");
    }
    const limit = clampInt(c.req.query("limit"), 1, 100, 30);
    const rows = await repo.listConversations(owner(c), {
      limit,
      before,
      archived: c.req.query("archived") === "true",
    });
    return c.json({ conversations: rows.map(toConversation) });
  });

  v1.get("/chat/conversations/:id/messages", async (c) => {
    const id = requireId(c.req.param("id"));
    if (!(await repo.getConversation(owner(c), id))) throw notFound();
    const rows = await repo.listMessages(owner(c), id, clampInt(c.req.query("limit"), 1, 200, 100));
    const cards = opts.actions
      ? await opts.actions.listForMessages(c.get("member"), rows.filter((r) => r.role === "assistant").map((r) => r.id))
      : new Map<string, ActionCard[]>();
    return c.json({ messages: rows.map((m) => ({ ...toMessage(m), actions: cards.get(m.id) ?? [] })) });
  });

  v1.patch("/chat/conversations/:id", async (c) => {
    const id = requireId(c.req.param("id"));
    const body = await parseJson(c.req.raw, updateSchema);
    const conv = await repo.updateConversation(owner(c), id, body);
    if (!conv) throw notFound();
    return c.json(toConversation(conv));
  });

  v1.delete("/chat/conversations/:id", async (c) => {
    const id = requireId(c.req.param("id"));
    if (!(await repo.deleteConversation(owner(c), id))) throw notFound();
    return c.body(null, 204);
  });

  v1.post("/chat/conversations/:id/messages", rateLimit(opts.sql, opts.rateLimitRules), async (c) => {
    const id = requireId(c.req.param("id"));
    const me = owner(c);
    const log = c.get("log");
    const body = await parseJson(c.req.raw, sendSchema);
    if (body.content.length > opts.maxMessageChars) {
      throw new ApiError(400, "bad_request", `Message is too long (max ${opts.maxMessageChars} characters).`);
    }

    const conv = await repo.getConversation(me, id);
    if (!conv) throw notFound();
    if (await repo.hasActiveReply(me, id)) {
      throw new ApiError(409, "conflict", "Soft AI is still answering your last message in this chat.");
    }

    const isFirstMessage = conv.message_count === 0;
    const pageContext = body.pageContext ?? {};

    // ---- A. Rules engine: common commands, answered by our own code (free) ----
    if (opts.pages) {
      const rule = matchRule(body.content, await opts.pages.pagesFor(c.get("member")));
      if (rule) {
        return sendInstantAnswer(c, repo, me, id, isFirstMessage, body.content, pageContext, {
          answeredBy: "rules",
          text: rule.reply,
          sources: [],
          navigateTo: rule.navigateTo,
        });
      }
    }

    // Free answers end here; everything below may cost credits.
    // This month's plan allowance (added once per month; never blocks chatting if it fails).
    await opts.sql`select soft_ai.grant_monthly_allowance(${me.organizationId}::uuid)`.catch((err) =>
      log.warn({ err }, "monthly allowance could not be added"),
    );
    // Quick check first so an organization with no credits does not even trigger a search.
    const wallet = await getWalletBalance(opts.sql, me.organizationId);
    if (Number(wallet.available) <= 0) throw new InsufficientCreditsError();

    // ---- B. Knowledge search (which help pages match the question) ----
    let retrieval: RetrievalResult = { hits: [], releaseVersion: null };
    if (opts.knowledge) {
      try {
        retrieval = await retrieveKnowledge({
          sql: opts.sql,
          embedder: opts.knowledge.embedder,
          organizationId: me.organizationId,
          question: body.content,
          topK: opts.knowledge.topK,
          minSimilarity: opts.knowledge.minSimilarity,
        });
      } catch (err) {
        // Search problems must not block chatting: answer without help text, and log it.
        log.warn({ err }, "knowledge search failed; answering without help text");
      }
    }
    const sources: MessageSource[] = dedupeSources(retrieval.hits.map((h) => ({ title: h.title, urlPath: h.urlPath })));

    // ---- C. Answer cache: same stand-alone question in this organization (free) ----
    const cacheKey =
      opts.cache && isFirstMessage && retrieval.releaseVersion
        ? { organizationId: me.organizationId, question: body.content, releaseVersion: retrieval.releaseVersion, model: opts.model }
        : null;
    if (cacheKey && opts.cache) {
      const cached = await opts.cache.get(cacheKey).catch(() => null);
      if (cached) {
        return sendInstantAnswer(c, repo, me, id, isFirstMessage, body.content, pageContext, {
          answeredBy: "cache",
          text: cached.answer,
          sources: cached.sources as MessageSource[],
        });
      }
    }

    // ---- D. The AI ----
    // Earlier conversation + the new message (with the matching help text for the AI only).
    const earlier = await repo.listMessages(me, id, opts.history.maxMessages * 2);
    const history = buildHistory([...earlier, { role: "user", content: body.content, status: "complete" }], opts.history);
    const last = history[history.length - 1];
    if (last) last.content = withKnowledge(last.content, formatKnowledgeForPrompt(retrieval.hits));

    // Company-data tools: ONLY the ones this user's role allows are offered to the AI.
    const member = c.get("member");
    const userTools = opts.tools ? toolsFor(member) : [];
    // Actions: likewise only the ones this role allows. The AI can only PROPOSE them.
    const userActions = opts.tools && opts.actions ? actionsFor(member) : [];
    const toolDeclarations = [...userTools, ...userActions].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters),
    }));
    const turn: TurnActions = { proposals: [], usedReadTools: false };
    if (userActions.length && last && opts.actions) {
      // Dates like "today" or "next Friday" need the company's own date.
      turn.today = await opts.actions.today(me.organizationId);
      last.content = `${last.content}\n\n(Today is ${turn.today.today}. Company currency: ${turn.today.currency}.)`;
    }
    const runCalls = async (calls: ToolCall[]): Promise<ToolResult[]> => {
      const results: ToolResult[] = [];
      for (const call of calls) {
        if (getAction(call.name) && opts.actions) {
          results.push(await opts.actions.propose(member, call, turn));
        } else {
          turn.usedReadTools = true;
          results.push(...(await executeToolCalls({ sql: opts.sql, member, calls: [call], log })));
        }
      }
      return results;
    };

    // 1. HOLD credits. Not enough -> 402 here, before anything is saved or sent to the AI.
    const reference: Record<string, unknown> = { conversation_id: id, knowledge_release: retrieval.releaseVersion };
    const metered = await opts.meter.open({
      organizationId: me.organizationId,
      userId: me.userId,
      request: {
        model: opts.model,
        system: SYSTEM_PROMPT,
        messages: history,
        maxOutputTokens: opts.maxOutputTokens,
        ...(toolDeclarations.length ? { tools: toolDeclarations } : {}),
      },
      maxRounds: opts.tools?.maxRounds,
      reference,
    });

    // 2. Save the user's message and an empty reply. If saving fails, give the hold back.
    let ids: { userMessageId: string; assistantMessageId: string };
    try {
      ids = await repo.startExchange(me, id, body.content, pageContext);
      reference.message_id = ids.assistantMessageId;
      if (isFirstMessage) await repo.setTitleIfNew(me, id, titleFromMessage(body.content));
    } catch (err) {
      await metered.cancel();
      throw err;
    }

    // 3. Stream the reply as Server-Sent Events:
    //    event "start" {messageId} -> many "delta" {text} -> "done" {...} or "error" {code, message}
    return streamSSE(c, async (sse) => {
      const started = performance.now();
      const userStop = new AbortController();
      sse.onAbort(() => userStop.abort()); // the user closed the chat or pressed stop

      await sse.writeSSE({ event: "start", data: JSON.stringify({ messageId: ids.assistantMessageId, userMessageId: ids.userMessageId }) });

      try {
        const outcome = await metered.run((text) => sse.writeSSE({ event: "delta", data: JSON.stringify({ text }) }), userStop.signal, {
          executeTools: runCalls,
          onToolsStart: (calls) => {
            const name = calls[0]?.name ?? "";
            const text = getTool(name)?.statusText ?? getAction(name)?.statusText ?? "Looking that up…";
            return sse.writeSSE({ event: "status", data: JSON.stringify({ text }) });
          },
        });
        // Proposals are saved only for a reply that finished (not when the user pressed stop).
        const actionCards =
          opts.actions && outcome.status === "complete" && turn.proposals.length
            ? await opts.actions.persist(member, id, ids.assistantMessageId, turn)
            : [];
        // Pages of the data the answer used (e.g. Invoices), after the help pages.
        const toolPages: MessageSource[] = outcome.toolCalls
          .filter((t) => t.ok)
          .map((t) => getTool(t.name)?.page)
          .filter((p): p is { title: string; urlPath: string } => Boolean(p));
        const allSources = dedupeSources([...toolPages, ...sources]);
        await repo.finishAssistantMessage(me, ids.assistantMessageId, {
          status: outcome.status,
          content: outcome.text,
          model: outcome.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          creditsCharged: outcome.charged,
          sources: allSources,
          toolCalls: outcome.toolCalls,
          latencyMs: Math.round(performance.now() - started),
        });
        // Remember complete stand-alone answers for the cache - NEVER answers that used company
        // data (they change all the time), and when the user has data tools, only how-to answers
        // based on ERP help text.
        const cacheable =
          outcome.status === "complete" &&
          outcome.text.trim() !== "" &&
          outcome.toolCalls.length === 0 &&
          (userTools.length === 0 || retrieval.hits.length > 0);
        if (cacheKey && opts.cache && cacheable) {
          await opts.cache.put(cacheKey, { answer: outcome.text, sources }).catch((e) => log.warn({ err: e }, "could not save answer to cache"));
        }
        if (!sse.aborted) {
          const after = await getWalletBalance(opts.sql, me.organizationId);
          await sse.writeSSE({
            event: "done",
            data: JSON.stringify({
              messageId: ids.assistantMessageId,
              status: outcome.status,
              creditsCharged: outcome.charged ?? "0.0000",
              balance: after.available,
              answeredBy: "model",
              sources: allSources,
              usedData: outcome.toolCalls.length > 0,
              actions: actionCards,
            }),
          });
        }
      } catch (err) {
        const d = describeError(err);
        if (d.unexpected) log.error({ err }, "chat reply failed");
        await repo
          .finishAssistantMessage(me, ids.assistantMessageId, {
            status: "error",
            content: "",
            errorCode: d.code,
            latencyMs: Math.round(performance.now() - started),
          })
          .catch((e) => log.error({ err: e }, "could not mark reply as failed"));
        if (!sse.aborted) {
          await sse.writeSSE({ event: "error", data: JSON.stringify({ code: d.code, message: d.message, requestId: c.get("requestId") }) });
        }
      }
    });
  });
}

// ---------- free answers (rules engine, cache) ----------

/**
 * Saves and sends an answer that needed no AI call: same streaming format as
 * an AI answer (start -> delta -> done), charged 0 credits.
 */
async function sendInstantAnswer(
  c: Context<AppEnv>,
  repo: ReturnType<typeof createChatRepository>,
  me: Owner,
  conversationId: string,
  isFirstMessage: boolean,
  question: string,
  pageContext: Record<string, unknown>,
  answer: { answeredBy: "rules" | "cache"; text: string; sources: MessageSource[]; navigateTo?: string },
) {
  const started = performance.now();
  const ids = await repo.startExchange(me, conversationId, question, pageContext, answer.answeredBy);
  if (isFirstMessage) await repo.setTitleIfNew(me, conversationId, titleFromMessage(question));
  await repo.finishAssistantMessage(me, ids.assistantMessageId, {
    status: "complete",
    content: answer.text,
    creditsCharged: "0",
    sources: answer.sources,
    latencyMs: Math.round(performance.now() - started),
  });
  return streamSSE(c, async (sse) => {
    await sse.writeSSE({ event: "start", data: JSON.stringify({ messageId: ids.assistantMessageId, userMessageId: ids.userMessageId }) });
    await sse.writeSSE({ event: "delta", data: JSON.stringify({ text: answer.text }) });
    await sse.writeSSE({
      event: "done",
      data: JSON.stringify({
        messageId: ids.assistantMessageId,
        status: "complete",
        creditsCharged: "0.0000",
        answeredBy: answer.answeredBy,
        sources: answer.sources,
        ...(answer.navigateTo ? { navigateTo: answer.navigateTo } : {}),
      }),
    });
  });
}

function dedupeSources(sources: MessageSource[]): MessageSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = s.urlPath ?? s.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- helpers ----------

function toConversation(r: ConversationRow) {
  return {
    id: r.id,
    title: r.title,
    isPinned: r.is_pinned,
    archived: r.archived_at !== null,
    messageCount: r.message_count,
    creditsUsed: r.credits_used,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  };
}

function toMessage(m: MessageRow) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    errorCode: m.error_code,
    creditsCharged: m.credits_charged,
    answeredBy: m.answered_by,
    sources: m.sources ?? [],
    createdAt: m.created_at,
  };
}

function requireId(id: string): string {
  if (!isUuid(id)) throw notFound();
  return id;
}

function notFound() {
  // Same answer for "does not exist" and "not yours".
  return new ApiError(404, "not_found", "Chat not found.");
}

async function parseJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  return parsed.data;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
