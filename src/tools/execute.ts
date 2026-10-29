import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { MemberContext } from "../auth/member-context.js";
import { getTool, toolsFor } from "./registry.js";

/**
 * Runs the tools the AI asked for. Never throws: every problem becomes a short
 * error result the AI can read and explain ("I could not look that up").
 *
 * Checks, in order:
 *   1. the tool exists in the registry
 *   2. the user's role allows it (again - it was only offered if allowed)
 *   3. the arguments match the registry's rules (types, lengths, ranges)
 *   4. the database function runs it, re-checking membership + permission inside
 * Results are capped in size so a big answer cannot flood the AI (or the bill).
 */

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  name: string;
  ok: boolean;
  /** Sent back to the AI. */
  response: Record<string, unknown>;
}

const MAX_RESULT_CHARS = 8000;

export async function executeToolCalls(opts: {
  sql: Sql;
  member: MemberContext;
  calls: ToolCall[];
  log: Logger;
}): Promise<ToolResult[]> {
  const allowed = new Set(toolsFor(opts.member).map((t) => t.name));
  const results: ToolResult[] = [];

  for (const call of opts.calls) {
    const fail = (code: string, message: string): ToolResult => ({
      id: call.id,
      name: call.name,
      ok: false,
      response: { error: code, message },
    });

    const tool = getTool(call.name);
    if (!tool) {
      results.push(fail("unknown_tool", `There is no tool called ${call.name}.`));
      continue;
    }
    if (!allowed.has(tool.name)) {
      results.push(fail("forbidden", "The user's role does not allow this information."));
      continue;
    }
    const parsed = tool.parameters.strict().safeParse(call.args ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      results.push(fail("invalid_argument", `${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "invalid"}`));
      continue;
    }

    try {
      const rows = await opts.sql<{ result: Record<string, unknown> }[]>`
        select soft_ai.${opts.sql(tool.sqlFunction)}(
          ${opts.member.organizationId}::uuid, ${opts.member.userId}::uuid, ${opts.sql.json(parsed.data as never)}
        ) as result`;
      results.push({ id: call.id, name: tool.name, ok: true, response: capSize(rows[0]?.result ?? {}) });
    } catch (err) {
      const message = String((err as Error).message ?? "");
      const detail = String((err as { detail?: string }).detail ?? "");
      if (message === "forbidden") {
        results.push(fail("forbidden", "The user's role does not allow this information."));
      } else if (message === "invalid_argument") {
        results.push(fail("invalid_argument", detail || "Invalid arguments."));
      } else {
        opts.log.error({ err, tool: tool.name }, "data tool failed");
        results.push(fail("tool_failed", "The data could not be loaded right now."));
      }
    }
  }
  return results;
}

/** Keeps results small: long lists are cut and marked as truncated. */
function capSize(result: Record<string, unknown>): Record<string, unknown> {
  let json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_CHARS) return result;
  const copy: Record<string, unknown> = { ...result, truncated: true };
  for (const [key, value] of Object.entries(copy)) {
    if (Array.isArray(value)) {
      let arr = value;
      while (arr.length > 1 && JSON.stringify({ ...copy, [key]: arr }).length > MAX_RESULT_CHARS) {
        arr = arr.slice(0, Math.ceil(arr.length / 2));
      }
      copy[key] = arr;
    }
  }
  json = JSON.stringify(copy);
  return json.length <= MAX_RESULT_CHARS ? copy : { truncated: true, error: "result_too_large" };
}
