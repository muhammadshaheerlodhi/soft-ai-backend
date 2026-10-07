import type { Sql } from "../db/client.js";

/**
 * Database access for chats. EVERY query is filtered by organization AND user,
 * so one user can never read or change another user's chat - even by guessing
 * an id. (The database also enforces this with composite foreign keys.)
 */

export interface ConversationRow {
  id: string;
  title: string;
  is_pinned: boolean;
  archived_at: string | null;
  message_count: number;
  credits_used: string;
  last_message_at: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  status: "streaming" | "complete" | "stopped" | "error";
  error_code: string | null;
  model: string | null;
  credits_charged: string;
  created_at: string;
}

export interface Owner {
  organizationId: string;
  userId: string;
}

const CONV_COLUMNS = (sql: Sql) =>
  sql`id, title, is_pinned, archived_at, message_count, credits_used::text, last_message_at, created_at`;

export function createChatRepository(sql: Sql) {
  return {
    async createConversation(owner: Owner, title = "New chat"): Promise<ConversationRow> {
      const [row] = await sql<ConversationRow[]>`
        insert into soft_ai.conversations (organization_id, user_id, title)
        values (${owner.organizationId}, ${owner.userId}, ${title})
        returning ${CONV_COLUMNS(sql)}`;
      return row!;
    },

    /**
     * Newest first. `before` = last_message_at of the last item already shown
     * (for "load more"). Pinned chats are flagged; the panel shows them on top.
     */
    async listConversations(owner: Owner, opts: { limit: number; before?: string; archived: boolean }) {
      return sql<ConversationRow[]>`
        select ${CONV_COLUMNS(sql)}
          from soft_ai.conversations
         where organization_id = ${owner.organizationId}
           and user_id = ${owner.userId}
           and deleted_at is null
           and ${opts.archived ? sql`archived_at is not null` : sql`archived_at is null`}
           ${opts.before ? sql`and last_message_at < ${opts.before}::timestamptz` : sql``}
         order by last_message_at desc, id desc
         limit ${opts.limit}`;
    },

    async getConversation(owner: Owner, id: string): Promise<ConversationRow | null> {
      const [row] = await sql<ConversationRow[]>`
        select ${CONV_COLUMNS(sql)}
          from soft_ai.conversations
         where id = ${id} and organization_id = ${owner.organizationId}
           and user_id = ${owner.userId} and deleted_at is null`;
      return row ?? null;
    },

    async updateConversation(
      owner: Owner,
      id: string,
      changes: { title?: string; isPinned?: boolean; archived?: boolean },
    ): Promise<ConversationRow | null> {
      const [row] = await sql<ConversationRow[]>`
        update soft_ai.conversations set
          title       = coalesce(${changes.title ?? null}, title),
          is_pinned   = coalesce(${changes.isPinned ?? null}::boolean, is_pinned),
          archived_at = case
                          when ${changes.archived ?? null}::boolean is null then archived_at
                          when ${changes.archived ?? null}::boolean then coalesce(archived_at, now())
                          else null
                        end
         where id = ${id} and organization_id = ${owner.organizationId}
           and user_id = ${owner.userId} and deleted_at is null
        returning ${CONV_COLUMNS(sql)}`;
      return row ?? null;
    },

    /** Soft delete (hidden from the user; purge rules wait for the retention decision). */
    async deleteConversation(owner: Owner, id: string): Promise<boolean> {
      const rows = await sql`
        update soft_ai.conversations set deleted_at = now()
         where id = ${id} and organization_id = ${owner.organizationId}
           and user_id = ${owner.userId} and deleted_at is null
        returning id`;
      return rows.length > 0;
    },

    async listMessages(owner: Owner, conversationId: string, limit: number): Promise<MessageRow[]> {
      // Newest N, returned oldest-first for display.
      return sql<MessageRow[]>`
        select * from (
          select m.id, m.role, m.content, m.status, m.error_code, m.model,
                 m.credits_charged::text, m.created_at
            from soft_ai.messages m
            join soft_ai.conversations c on c.id = m.conversation_id
           where m.conversation_id = ${conversationId}
             and m.organization_id = ${owner.organizationId} and m.user_id = ${owner.userId}
             and c.deleted_at is null
           order by m.created_at desc, m.id desc
           limit ${limit}
        ) recent
        order by created_at asc, id asc`;
    },

    /** Is a reply still being written in this chat (started in the last few minutes)? */
    async hasActiveReply(owner: Owner, conversationId: string): Promise<boolean> {
      const rows = await sql`
        select 1 from soft_ai.messages
         where conversation_id = ${conversationId}
           and organization_id = ${owner.organizationId} and user_id = ${owner.userId}
           and status = 'streaming' and created_at > now() - interval '3 minutes'
         limit 1`;
      return rows.length > 0;
    },

    /**
     * Saves the user's message and an empty assistant message ("streaming") together.
     * created_at uses clock_timestamp() (the real time of each insert), because
     * now() is the same for the whole transaction and both messages would get
     * the same time, making their order random.
     */
    async startExchange(
      owner: Owner,
      conversationId: string,
      content: string,
      pageContext: Record<string, unknown>,
    ): Promise<{ userMessageId: string; assistantMessageId: string }> {
      return sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          insert into soft_ai.messages (conversation_id, organization_id, user_id, role, content, page_context, created_at)
          values (${conversationId}, ${owner.organizationId}, ${owner.userId}, 'user', ${content},
                  ${tx.json(pageContext as never)}, clock_timestamp())
          returning id`;
        const [a] = await tx<{ id: string }[]>`
          insert into soft_ai.messages (conversation_id, organization_id, user_id, role, content, status, answered_by, created_at)
          values (${conversationId}, ${owner.organizationId}, ${owner.userId}, 'assistant', '', 'streaming', 'model',
                  clock_timestamp())
          returning id`;
        return { userMessageId: u!.id, assistantMessageId: a!.id };
      });
    },

    async finishAssistantMessage(
      owner: Owner,
      messageId: string,
      result: {
        status: "complete" | "stopped" | "error";
        content: string;
        errorCode?: string | null;
        model?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        creditsCharged?: string | null;
        latencyMs: number;
      },
    ): Promise<void> {
      await sql`
        update soft_ai.messages set
          status          = ${result.status},
          content         = ${result.content},
          error_code      = ${result.errorCode ?? null},
          model           = ${result.model ?? null},
          input_tokens    = ${result.inputTokens ?? null},
          output_tokens   = ${result.outputTokens ?? null},
          credits_charged = ${result.creditsCharged ?? "0"}::numeric,
          latency_ms      = ${result.latencyMs}
         where id = ${messageId}
           and organization_id = ${owner.organizationId} and user_id = ${owner.userId}`;
    },

    /** Gives a "New chat" a title from its first message (free: no AI call). */
    async setTitleIfNew(owner: Owner, conversationId: string, title: string): Promise<void> {
      await sql`
        update soft_ai.conversations set title = ${title}
         where id = ${conversationId} and organization_id = ${owner.organizationId}
           and user_id = ${owner.userId} and title = 'New chat'`;
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
