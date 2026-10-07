import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { StreamMeter } from "../credits/metering-stream.js";
import { getWalletBalance } from "../credits/wallet.js";
import { ApiError, describeError } from "../http/errors.js";
import { rateLimit, type RateLimitRule } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { isUuid } from "../lib/uuid.js";
import { createChatRepository, type ConversationRow, type MessageRow } from "./repository.js";
import { buildHistory, SYSTEM_PROMPT, titleFromMessage } from "./prompt.js";

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
    return c.json({ messages: rows.map(toMessage) });
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

    // Earlier conversation + the new message.
    const earlier = await repo.listMessages(me, id, opts.history.maxMessages * 2);
    const history = buildHistory([...earlier, { role: "user", content: body.content, status: "complete" }], opts.history);

    // 1. HOLD credits. Not enough -> 402 here, before anything is saved or sent to the AI.
    const reference: Record<string, unknown> = { conversation_id: id };
    const metered = await opts.meter.open({
      organizationId: me.organizationId,
      userId: me.userId,
      request: { model: opts.model, system: SYSTEM_PROMPT, messages: history, maxOutputTokens: opts.maxOutputTokens },
      reference,
    });

    // 2. Save the user's message and an empty reply. If saving fails, give the hold back.
    let ids: { userMessageId: string; assistantMessageId: string };
    try {
      ids = await repo.startExchange(me, id, body.content, body.pageContext ?? {});
      reference.message_id = ids.assistantMessageId;
      if (conv.message_count === 0) await repo.setTitleIfNew(me, id, titleFromMessage(body.content));
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
        const outcome = await metered.run((text) => sse.writeSSE({ event: "delta", data: JSON.stringify({ text }) }), userStop.signal);
        await repo.finishAssistantMessage(me, ids.assistantMessageId, {
          status: outcome.status,
          content: outcome.text,
          model: outcome.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          creditsCharged: outcome.charged,
          latencyMs: Math.round(performance.now() - started),
        });
        if (!sse.aborted) {
          const wallet = await getWalletBalance(opts.sql, me.organizationId);
          await sse.writeSSE({
            event: "done",
            data: JSON.stringify({
              messageId: ids.assistantMessageId,
              status: outcome.status,
              creditsCharged: outcome.charged ?? "0.0000",
              balance: wallet.available,
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
