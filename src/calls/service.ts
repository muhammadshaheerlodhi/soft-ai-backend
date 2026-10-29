import { randomBytes } from "node:crypto";
import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { MemberContext } from "../auth/member-context.js";
import { ApiError } from "../http/errors.js";
import type { CallProvider } from "./provider.js";

/**
 * "Talk to a person" support calls (migration 112).
 *
 *   customer   start -> ringing (room + own token) -> answered -> ended
 *              cancel while ringing; nobody answers in time -> missed
 *   admins     see ringing calls (live), the FIRST to answer gets the call
 *              (one database update decides), then end it
 * Rules checked on the server: Pro / White Label plan, support hours, one open
 * call per user. Free for the customer (no credits).
 */

export type CallStatus = "ringing" | "answered" | "ended" | "missed" | "cancelled";

export interface CallDetails {
  id: string;
  status: CallStatus;
  organizationId: string;
  organizationName: string;
  plan: string | null;
  callerName: string;
  callerEmail: string | null;
  answeredBy: string | null;
  pagePath: string | null;
  createdAt: string;
  ringUntil: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  durationSeconds: number | null;
}

interface CallRow {
  id: string;
  organization_id: string;
  caller_user_id: string;
  status: CallStatus;
  room_name: string;
  room_url: string | null;
  answered_by: string | null;
  ring_until: string;
  created_at: string;
  answered_at: string | null;
}

export interface CallSettings {
  enabled: boolean;
  allowedPlans: string[];
  timezone: string;
  workDays: number[];
  startTime: string;
  endTime: string;
  ringSeconds: number;
  maxMinutes: number;
  /** Participant-minutes per calendar month before calls switch off (null = no limit). */
  monthlyLimitMinutes: number | null;
}

/** Daily.co: free participant-minutes per calendar month. */
export const FREE_MINUTES_PER_MONTH = 10_000;

const ROW = (sql: Sql) =>
  sql`id, organization_id, caller_user_id, status, room_name, room_url, answered_by, ring_until, created_at, answered_at`;

export function createCallService(deps: { sql: Sql; provider: CallProvider; log: Logger }) {
  const { sql, provider, log } = deps;

  async function settings(): Promise<{ ringSeconds: number; maxMinutes: number }> {
    const [s] = await sql<{ ring_seconds: number; max_minutes: number }[]>`
      select ring_seconds, max_minutes from soft_ai.support_call_settings limit 1`;
    return { ringSeconds: s?.ring_seconds ?? 60, maxMinutes: s?.max_minutes ?? 60 };
  }

  async function details(ids: string[]): Promise<CallDetails[]> {
    if (ids.length === 0) return [];
    const rows = await sql<Record<string, unknown>[]>`select * from soft_ai.support_call_details(${ids}::uuid[])`;
    return rows.map((r) => ({
      id: String(r.id),
      status: r.status as CallStatus,
      organizationId: String(r.organization_id),
      organizationName: String(r.organization_name),
      plan: (r.plan_slug as string | null) ?? null,
      callerName: String(r.caller_name ?? "Customer"),
      callerEmail: (r.caller_email as string | null) ?? null,
      answeredBy: (r.answered_by_email as string | null) ?? null,
      pagePath: (r.page_path as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      ringUntil: new Date(r.ring_until as string).toISOString(),
      answeredAt: r.answered_at ? new Date(r.answered_at as string).toISOString() : null,
      endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
      endedBy: (r.ended_by as string | null) ?? null,
      durationSeconds: (r.duration_seconds as number | null) ?? null,
    }));
  }

  async function closeRoom(name: string) {
    try {
      await provider.deleteRoom(name);
    } catch (err) {
      log.warn({ err, room: name }, "could not delete call room (it expires by itself)");
    }
  }

  /** Calls nobody answered in time -> missed; calls over the time limit -> ended. Safe to run often. */
  async function sweep(): Promise<number> {
    const { maxMinutes } = await settings();
    const missed = await sql<{ room_name: string }[]>`
      update soft_ai.support_calls set status = 'missed', ended_by = 'system'
       where status = 'ringing' and ring_until < now() returning room_name`;
    const tooLong = await sql<{ room_name: string }[]>`
      update soft_ai.support_calls set status = 'ended', ended_by = 'system'
       where status = 'answered' and answered_at < now() - make_interval(mins => ${maxMinutes}) returning room_name`;
    for (const r of [...missed, ...tooLong]) await closeRoom(r.room_name);
    return missed.length + tooLong.length;
  }

  async function callerRow(member: MemberContext, id: string): Promise<CallRow> {
    const [row] = await sql<CallRow[]>`
      select ${ROW(sql)} from soft_ai.support_calls
       where id = ${id} and organization_id = ${member.organizationId} and caller_user_id = ${member.userId}`;
    if (!row) throw new ApiError(404, "not_found", "Call not found.");
    return row;
  }

  return {
    providerName: provider.name,
    sweep,
    details,

    async eligibility(organizationId: string) {
      const [row] = await sql<{ e: { ok: boolean; reason?: string; plan?: string | null; hours?: unknown } }[]>`
        select soft_ai.support_call_eligibility(${organizationId}::uuid) as e`;
      return row!.e;
    },

    /** The customer presses "Talk to a person". */
    async start(member: MemberContext, input: { callerName: string; pagePath?: string }) {
      await sweep();
      const e = await this.eligibility(member.organizationId);
      if (!e.ok) {
        const message =
          e.reason === "plan"
            ? "Calls with our team are included in the Pro and White Label plans."
            : e.reason === "closed"
              ? "Our team is available Monday to Friday, 9:00-18:00 (Pakistan time). Please request a callback."
              : e.reason === "limit"
                ? "Our call lines are busy this month. Please request a callback and our team will call you."
                : "Calls are not available right now. Please request a callback.";
        throw new ApiError(403, "forbidden", message);
      }
      const { ringSeconds, maxMinutes } = await settings();
      const roomName = `softoras-${randomBytes(9).toString("hex")}`;
      const ringUntil = new Date(Date.now() + ringSeconds * 1000);
      const roomExpires = new Date(ringUntil.getTime() + maxMinutes * 60_000);

      let row: CallRow;
      try {
        const inserted = await sql<CallRow[]>`
          insert into soft_ai.support_calls (organization_id, caller_user_id, plan_slug, room_name, ring_until, page_path)
          values (${member.organizationId}, ${member.userId}, ${e.plan ?? null}, ${roomName}, ${ringUntil}, ${input.pagePath?.slice(0, 300) ?? null})
          returning ${ROW(sql)}`;
        row = inserted[0]!;
      } catch (err) {
        if (String((err as { code?: string }).code) === "23505") {
          throw new ApiError(409, "conflict", "You already have a call in progress.");
        }
        throw err;
      }

      try {
        const room = await provider.createRoom({ name: roomName, expiresAt: roomExpires });
        await sql`update soft_ai.support_calls set room_url = ${room.url} where id = ${row.id}`;
        const token = await provider.createToken({ roomName, userName: input.callerName, expiresAt: roomExpires, isAgent: false });
        return { callId: row.id, ringUntil: ringUntil.toISOString(), room: { url: room.url, token }, provider: provider.name };
      } catch (err) {
        log.error({ err }, "could not create the call room");
        await sql`update soft_ai.support_calls set status = 'cancelled', ended_by = 'system' where id = ${row.id} and status = 'ringing'`;
        await closeRoom(roomName);
        throw new ApiError(503, "internal_error", "The call could not be started. Please try again or request a callback.");
      }
    },

    async getForCaller(member: MemberContext, id: string) {
      await sweep();
      const row = await callerRow(member, id);
      const [d] = await details([row.id]);
      return d!;
    },

    /** Customer hangs up (or cancels while it is ringing). */
    async hangUpByCaller(member: MemberContext, id: string) {
      const row = await callerRow(member, id);
      const next = row.status === "ringing" ? "cancelled" : row.status === "answered" ? "ended" : null;
      if (next) {
        await sql`update soft_ai.support_calls set status = ${next}, ended_by = 'caller' where id = ${id} and status = ${row.status}`;
        await closeRoom(row.room_name);
      }
      const [d] = await details([id]);
      return d!;
    },

    // ---------- admins ----------

    /** Calls ringing now plus calls in progress (for the admin popup). */
    async openCalls(): Promise<CallDetails[]> {
      await sweep();
      const rows = await sql<{ id: string }[]>`select id from soft_ai.support_calls where status in ('ringing', 'answered')`;
      return details(rows.map((r) => r.id));
    },

    async history(opts: { limit: number; before?: string }): Promise<CallDetails[]> {
      await sweep();
      const rows = await sql<{ id: string }[]>`
        select id from soft_ai.support_calls
         ${opts.before ? sql`where created_at < ${opts.before}::timestamptz` : sql``}
         order by created_at desc limit ${opts.limit}`;
      return details(rows.map((r) => r.id));
    },

    /** The first admin to answer gets the call (one update decides; the others get 409). */
    async answer(adminUserId: string, id: string) {
      await sweep();
      const [row] = await sql<CallRow[]>`
        update soft_ai.support_calls set status = 'answered', answered_by = ${adminUserId}
         where id = ${id} and status = 'ringing' and ring_until >= now()
        returning ${ROW(sql)}`;
      if (!row) {
        const [d] = await details([id]);
        if (!d) throw new ApiError(404, "not_found", "Call not found.");
        throw new ApiError(409, "conflict", d.status === "answered" ? `Already answered by ${d.answeredBy ?? "another admin"}.` : "This call is no longer ringing.");
      }
      const { maxMinutes } = await settings();
      const token = await provider.createToken({
        roomName: row.room_name,
        userName: "Softoras Support",
        expiresAt: new Date(Date.now() + maxMinutes * 60_000),
        isAgent: true,
      });
      const [d] = await details([id]);
      return { call: d!, room: { url: row.room_url ?? "", token }, provider: provider.name };
    },

    async endByAgent(adminUserId: string, id: string) {
      const [row] = await sql<CallRow[]>`
        update soft_ai.support_calls set status = 'ended', ended_by = 'agent'
         where id = ${id} and status = 'answered' and answered_by = ${adminUserId}
        returning ${ROW(sql)}`;
      if (!row) throw new ApiError(409, "conflict", "Only the admin who answered can end this call, and only while it is in progress.");
      await closeRoom(row.room_name);
      const [d] = await details([id]);
      return d!;
    },

    async getSettings(): Promise<CallSettings> {
      const [s] = await sql<Record<string, unknown>[]>`
        select enabled, allowed_plans, timezone, work_days, to_char(start_time, 'HH24:MI') as start_time,
               to_char(end_time, 'HH24:MI') as end_time, ring_seconds, max_minutes, monthly_limit_minutes
          from soft_ai.support_call_settings limit 1`;
      return {
        enabled: Boolean(s!.enabled),
        allowedPlans: s!.allowed_plans as string[],
        timezone: String(s!.timezone),
        workDays: s!.work_days as number[],
        startTime: String(s!.start_time),
        endTime: String(s!.end_time),
        ringSeconds: Number(s!.ring_seconds),
        maxMinutes: Number(s!.max_minutes),
        monthlyLimitMinutes: s!.monthly_limit_minutes == null ? null : Number(s!.monthly_limit_minutes),
      };
    },

    /** This month's call minutes (for the admin page). */
    async usage() {
      const [row] = await sql<{ used: number; limit: number | null }[]>`
        select soft_ai.support_call_minutes_this_month() as used,
               (select monthly_limit_minutes from soft_ai.support_call_settings limit 1) as limit`;
      return { usedMinutes: Number(row!.used), limitMinutes: row!.limit == null ? null : Number(row!.limit), freeMinutes: FREE_MINUTES_PER_MONTH };
    },

    async saveSettings(adminUserId: string, s: CallSettings) {
      await sql`
        update soft_ai.support_call_settings set
          enabled = ${s.enabled}, allowed_plans = ${s.allowedPlans}, timezone = ${s.timezone}, work_days = ${s.workDays},
          start_time = ${s.startTime}::time, end_time = ${s.endTime}::time, ring_seconds = ${s.ringSeconds},
          max_minutes = ${s.maxMinutes}, monthly_limit_minutes = ${s.monthlyLimitMinutes}, updated_at = now(), updated_by = ${adminUserId}`;
    },
  };
}

export type CallService = ReturnType<typeof createCallService>;
