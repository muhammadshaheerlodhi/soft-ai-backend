import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { MemberContext } from "../auth/member-context.js";
import { ApiError } from "../http/errors.js";
import type { ToolCall, ToolResult } from "../tools/execute.js";
import {
  getAction, memberCanRun, ref,
  type ActionDefinition, type ActionPreview, type RecordKind, type RefInfo, type RiskLevel,
} from "./registry.js";

/**
 * Actions, step by step (the AI never writes to the ERP):
 *
 *   propose()  during the AI's reply: checks role, inputs and every referenced
 *              record; keeps the proposal for this reply. The AI is told it is
 *              only PROPOSED - it must not say "done".
 *   persist()  when the reply ends: saves the proposals ("proposed") and decides
 *              which need Confirm (see needsConfirmation).
 *   start()    the user pressed Confirm (or a low-risk action runs by itself):
 *              re-checks everything, claims the action ("confirmed") so it can
 *              never run twice, and returns what the panel must run.
 *   result()   the panel ran the ERP's own service and reports the record id;
 *              we check in the database that the record really exists (and has
 *              the right status) before recording "executed".
 *   undoStart / undoResult   same for Undo, inside the undo window.
 *
 * Every query is filtered by organization AND user: nobody can see or run
 * another user's actions, even by guessing an id.
 */

export interface ActionCard {
  id: string;
  name: string;
  status: "proposed" | "confirmed" | "executed" | "failed" | "cancelled" | "expired" | "undone";
  risk: RiskLevel;
  needsConfirmation: boolean;
  preview: ActionPreview;
  expiresAt: string;
  undoUntil: string | null;
  result: { recordId: string; number: string | null; total: string | null; pagePath: string } | null;
  error: string | null;
}

/** What the panel must run after Confirm (only ever from a saved, checked proposal). */
export interface ActionRun {
  id: string;
  name: string;
  record: RecordKind;
  params: Record<string, unknown>;
  /** Names and ids of referenced records (e.g. an employee's user id for task assignment). */
  context: RefInfo;
}

export interface UndoRun {
  id: string;
  name: string;
  kind: "delete" | "restore_status";
  recordId: string;
  previousStatus: string | null;
}

/** Proposals made during one AI reply. */
export interface TurnActions {
  proposals: { def: ActionDefinition; params: Record<string, unknown>; preview: ActionPreview; refs: RefInfo }[];
  /** Did the AI read company data in this reply? (Then every action needs Confirm.) */
  usedReadTools: boolean;
  today?: { today: string; currency: string };
}

interface ActionRow {
  id: string;
  action_name: string;
  params: Record<string, unknown>;
  risk_level: RiskLevel;
  confirmation_required: boolean;
  status: ActionCard["status"];
  result: { record_id: string; number: string | null; total: string | null } | null;
  undo_data: { kind?: string; record_id?: string; previous_status?: string | null } | null;
  undo_until: string | null;
  error_message: string | null;
  expires_at: string;
  preview: ActionPreview | null;
  message_id: string | null;
}

export const MAX_ACTIONS_PER_MESSAGE = 5;

/**
 * Low-risk actions run without Confirm (the user can Undo) ONLY when the user
 * asked for exactly one thing and the AI did not read any company data in this
 * reply - so text inside records (a customer note saying "create ...") can never
 * trigger a change by itself. Everything else waits for the user's Confirm.
 */
export function needsConfirmation(turn: TurnActions, risk: RiskLevel): boolean {
  return risk !== "low" || turn.usedReadTools || turn.proposals.length !== 1;
}

export function createActionService(deps: { sql: Sql; log: Logger; undoMinutes: number }) {
  const { sql } = deps;

  async function orgToday(organizationId: string) {
    const [row] = await sql<{ today: string; currency: string }[]>`
      select today::text, currency from soft_ai.org_today(${organizationId}::uuid)`;
    return row ?? { today: new Date().toISOString().slice(0, 10), currency: "USD" };
  }

  async function loadRefs(member: MemberContext, def: ActionDefinition, params: Record<string, unknown>): Promise<RefInfo> {
    const refs = def.refs(params);
    if (refs.length === 0) return {};
    const [row] = await sql<{ refs: RefInfo }[]>`
      select soft_ai.action_refs(${member.organizationId}::uuid, ${member.userId}::uuid, ${sql.json(refs as never)}) as refs`;
    return row?.refs ?? {};
  }

  async function getRow(member: MemberContext, id: string): Promise<ActionRow> {
    const [row] = await sql<ActionRow[]>`
      select id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
             undo_until, error_message, expires_at, preview, message_id
        from soft_ai.actions
       where id = ${id} and organization_id = ${member.organizationId} and user_id = ${member.userId}`;
    if (!row) throw new ApiError(404, "not_found", "Action not found.");
    return row;
  }

  function toCard(row: ActionRow): ActionCard {
    const def = getAction(row.action_name);
    const recordId = row.result?.record_id;
    return {
      id: row.id,
      name: row.action_name,
      status: row.status,
      risk: row.risk_level,
      needsConfirmation: row.confirmation_required,
      preview: row.preview ?? { title: row.action_name, fields: [], notes: [], undo: null },
      expiresAt: new Date(row.expires_at).toISOString(),
      undoUntil: row.status === "executed" && row.undo_until ? new Date(row.undo_until).toISOString() : null,
      result: recordId && def
        ? { recordId, number: row.result?.number ?? null, total: row.result?.total ?? null, pagePath: def.pagePath(recordId) }
        : null,
      error: row.error_message,
    };
  }

  async function recordState(member: MemberContext, kind: RecordKind, id: string) {
    const [row] = await sql<{ state: { exists: boolean; deleted?: boolean; status?: string; number?: string; total?: number } }[]>`
      select soft_ai.record_state(${member.organizationId}::uuid, ${kind}, ${id}::uuid) as state`;
    return row?.state ?? { exists: false };
  }

  /** The record an update/decision action works on (create actions: null = new record). */
  function targetId(params: Record<string, unknown>): string | null {
    return (params.lead_id as string) ?? (params.leave_request_id as string) ?? null;
  }

  return {
    /** The company's "today" (its own time zone) and currency. */
    today: orgToday,

    /** Called for each action the AI asks for during a reply. Never throws. */
    async propose(member: MemberContext, call: ToolCall, turn: TurnActions): Promise<ToolResult> {
      const fail = (error: string, message: string): ToolResult => ({ id: call.id, name: call.name, ok: false, response: { error, message } });
      const def = getAction(call.name);
      if (!def) return fail("unknown_action", `There is no action called ${call.name}.`);
      if (!memberCanRun(member, def)) return fail("forbidden", "The user's role does not allow this action.");
      if (turn.proposals.length >= MAX_ACTIONS_PER_MESSAGE) {
        return fail("too_many_actions", `At most ${MAX_ACTIONS_PER_MESSAGE} actions can be proposed in one reply. Ask the user to continue in the next message.`);
      }
      const parsed = def.parameters.strict().safeParse(call.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail("invalid_argument", `${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "invalid"}`);
      }
      try {
        turn.today ??= await orgToday(member.organizationId);
        const refs = await loadRefs(member, def, parsed.data);
        const params = def.normalize ? def.normalize(parsed.data, turn.today.today, refs) : parsed.data;
        const problem = def.check?.(params, refs);
        if (problem) return fail("invalid_argument", problem);
        const preview = def.preview(params, { refs, currency: turn.today.currency });
        turn.proposals.push({ def, params, preview, refs });
        return {
          id: call.id,
          name: call.name,
          ok: true,
          response: {
            status: "proposed",
            summary: preview.title,
            note:
              "NOT done yet. The user sees a card with these details and runs it with the Confirm button (some low-risk actions run straight away and can be undone). Tell the user briefly what you prepared and ask them to check it. Never say it is done.",
          },
        };
      } catch (err) {
        const message = String((err as Error).message ?? "");
        const detail = String((err as { detail?: string }).detail ?? "");
        if (message === "invalid_argument") return fail("invalid_argument", detail || "Invalid record.");
        if (message === "forbidden") return fail("forbidden", "The user's role does not allow this action.");
        deps.log.error({ err, action: call.name }, "action proposal failed");
        return fail("action_failed", "The action could not be prepared right now.");
      }
    },

    /** Saves the proposals of a finished reply and returns the cards for the panel. */
    async persist(member: MemberContext, conversationId: string, messageId: string, turn: TurnActions): Promise<ActionCard[]> {
      const cards: ActionCard[] = [];
      for (const p of turn.proposals) {
        const confirm = needsConfirmation(turn, p.def.risk);
        const previousStatus =
          p.def.undo?.kind === "restore_status" ? String(ref(p.refs, p.def.refs(p.params)[0]!.type, targetId(p.params)).status ?? "") || null : null;
        const [row] = await sql<ActionRow[]>`
          insert into soft_ai.actions
            (conversation_id, organization_id, user_id, message_id, action_name, params, risk_level,
             confirmation_required, preview, undo_data)
          values (${conversationId}, ${member.organizationId}, ${member.userId}, ${messageId}, ${p.def.name},
                  ${sql.json(p.params as never)}, ${p.def.risk}, ${confirm}, ${sql.json(p.preview as never)},
                  ${sql.json({ kind: p.def.undo?.kind ?? null, previous_status: previousStatus } as never)})
          returning id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
                    undo_until, error_message, expires_at, preview, message_id`;
        cards.push(toCard(row!));
      }
      return cards;
    },

    /** Action cards of these messages (chat history). */
    async listForMessages(member: MemberContext, messageIds: string[]): Promise<Map<string, ActionCard[]>> {
      const out = new Map<string, ActionCard[]>();
      if (messageIds.length === 0) return out;
      const rows = await sql<ActionRow[]>`
        select id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
               undo_until, error_message, expires_at, preview, message_id
          from soft_ai.actions
         where organization_id = ${member.organizationId} and user_id = ${member.userId}
           and message_id = any(${messageIds}::uuid[])
         order by created_at, id`;
      for (const r of rows) {
        const list = out.get(r.message_id!) ?? [];
        list.push(toCard(r));
        out.set(r.message_id!, list);
      }
      return out;
    },

    /** Confirm (or auto-run): re-check everything, claim it, return what to run. */
    async start(member: MemberContext, id: string): Promise<ActionRun> {
      const row = await getRow(member, id);
      if (row.status !== "proposed") throw new ApiError(409, "conflict", "This action was already handled.");
      if (new Date(row.expires_at) < new Date()) {
        await sql`update soft_ai.actions set status = 'expired' where id = ${id} and status = 'proposed'`;
        throw new ApiError(409, "conflict", "This action has expired. Please ask Soft AI again.");
      }
      const def = getAction(row.action_name);
      if (!def) throw new ApiError(409, "conflict", "This action is no longer available.");
      if (!memberCanRun(member, def)) throw new ApiError(403, "forbidden", "Your role does not allow this action.");

      // The records may have changed since the proposal (deleted, already approved...).
      let refs: RefInfo;
      try {
        refs = await loadRefs(member, def, row.params);
      } catch (err) {
        const detail = String((err as { detail?: string }).detail ?? "");
        await sql`update soft_ai.actions set status = 'cancelled', error_message = ${detail || "record not found"}
                   where id = ${id} and status = 'proposed'`;
        throw new ApiError(409, "conflict", `This action can no longer run: ${detail || "a record it needs is gone"}.`);
      }
      const problem = def.check?.(row.params, refs);
      if (problem) {
        await sql`update soft_ai.actions set status = 'cancelled', error_message = ${problem} where id = ${id} and status = 'proposed'`;
        throw new ApiError(409, "conflict", `This action can no longer run: ${problem}`);
      }

      // Claim it: only one Confirm can ever win.
      const claimed = await sql`update soft_ai.actions set status = 'confirmed' where id = ${id} and status = 'proposed' returning id`;
      if (claimed.length === 0) throw new ApiError(409, "conflict", "This action was already handled.");
      return { id, name: def.name, record: def.record, params: row.params, context: refs };
    },

    /** The panel ran it. Record the outcome - "executed" only after checking the ERP. */
    async result(member: MemberContext, id: string, body: { ok: boolean; recordId?: string; error?: string }): Promise<ActionCard> {
      const row = await getRow(member, id);
      if (row.status !== "confirmed") throw new ApiError(409, "conflict", "This action is not waiting for a result.");
      const def = getAction(row.action_name);

      const markFailed = async (message: string) => {
        const [r] = await sql<ActionRow[]>`
          update soft_ai.actions set status = 'failed', error_message = ${message.slice(0, 500)}
           where id = ${id} and status = 'confirmed'
          returning id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
                    undo_until, error_message, expires_at, preview, message_id`;
        return toCard(r ?? row);
      };

      if (!body.ok || !def) return markFailed(body.error?.trim() || "The ERP could not complete the action.");
      const expected = targetId(row.params);
      const recordId = body.recordId;
      if (!recordId || (expected && recordId !== expected)) return markFailed("The ERP did not return the record.");

      const state = await recordState(member, def.record, recordId);
      const wantStatus = def.executedStatus?.(row.params);
      if (!state.exists || state.deleted || (wantStatus && state.status !== wantStatus)) {
        deps.log.warn({ actionId: id, state }, "action reported done but the record does not match");
        return markFailed("The change could not be confirmed in the ERP.");
      }

      const result = { record_id: recordId, number: state.number ?? null, total: state.total != null ? String(state.total) : null };
      const undoData = { ...(row.undo_data ?? {}), record_id: recordId };
      const [r] = await sql<ActionRow[]>`
        update soft_ai.actions set
          status = 'executed',
          result = ${sql.json(result as never)},
          undo_data = ${sql.json(undoData as never)},
          undo_until = ${def.undo ? sql`now() + make_interval(mins => ${deps.undoMinutes})` : null}
         where id = ${id} and status = 'confirmed'
        returning id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
                  undo_until, error_message, expires_at, preview, message_id`;
      if (!r) throw new ApiError(409, "conflict", "This action was already handled.");
      return toCard(r);
    },

    async cancel(member: MemberContext, id: string): Promise<ActionCard> {
      const [r] = await sql<ActionRow[]>`
        update soft_ai.actions set status = 'cancelled'
         where id = ${id} and organization_id = ${member.organizationId} and user_id = ${member.userId}
           and status = 'proposed'
        returning id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
                  undo_until, error_message, expires_at, preview, message_id`;
      if (!r) {
        await getRow(member, id); // 404 if not theirs
        throw new ApiError(409, "conflict", "This action was already handled.");
      }
      return toCard(r);
    },

    async undoStart(member: MemberContext, id: string): Promise<UndoRun> {
      const row = await getRow(member, id);
      const def = getAction(row.action_name);
      if (row.status !== "executed" || !def?.undo || !row.undo_data?.record_id) {
        throw new ApiError(409, "conflict", "This action cannot be undone.");
      }
      if (!row.undo_until || new Date(row.undo_until) < new Date()) {
        throw new ApiError(409, "conflict", "The time to undo this action has passed.");
      }
      if (!memberCanRun(member, def)) throw new ApiError(403, "forbidden", "Your role does not allow this action.");
      // An undo that starts in time may finish a little after the window: give it 2 minutes.
      // (Never more than 2 minutes past the original window, however often it is started.)
      await sql`update soft_ai.actions
                   set undo_until = greatest(undo_until, least(now(), executed_at + make_interval(mins => ${deps.undoMinutes})) + interval '2 minutes')
                 where id = ${id} and status = 'executed'`;
      return {
        id,
        name: def.name,
        kind: def.undo.kind,
        recordId: row.undo_data.record_id,
        previousStatus: row.undo_data.previous_status ?? null,
      };
    },

    async undoResult(member: MemberContext, id: string, body: { ok: boolean; error?: string }): Promise<ActionCard> {
      const row = await getRow(member, id);
      const def = getAction(row.action_name);
      if (row.status !== "executed" || !def?.undo || !row.undo_data?.record_id) {
        throw new ApiError(409, "conflict", "This action cannot be undone.");
      }
      if (!body.ok) {
        throw new ApiError(409, "conflict", `Undo did not work: ${(body.error ?? "the ERP refused it").slice(0, 300)}`);
      }
      const state = await recordState(member, def.record, row.undo_data.record_id);
      const undone =
        def.undo.kind === "delete"
          ? !state.exists || state.deleted === true
          : state.exists && state.status === row.undo_data.previous_status;
      if (!undone) throw new ApiError(409, "conflict", "Undo could not be confirmed in the ERP.");
      const [r] = await sql<ActionRow[]>`
        update soft_ai.actions set status = 'undone'
         where id = ${id} and status = 'executed'
        returning id, action_name, params, risk_level, confirmation_required, status, result, undo_data,
                  undo_until, error_message, expires_at, preview, message_id`;
      if (!r) throw new ApiError(409, "conflict", "This action was already handled.");
      return toCard(r);
    },
  };
}

export type ActionService = ReturnType<typeof createActionService>;
