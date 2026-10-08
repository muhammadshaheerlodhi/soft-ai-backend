import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/types.js";
import { isUuid } from "../lib/uuid.js";
import type { ActionService } from "./service.js";

/**
 * Action endpoints (behind login + organization checks). Only the user who
 * asked can see or run their actions.
 *
 *   POST /v1/actions/:id/start         Confirm -> what the panel must run
 *   POST /v1/actions/:id/result        the panel reports the outcome
 *   POST /v1/actions/:id/cancel        Cancel a proposal
 *   POST /v1/actions/:id/undo/start    Undo -> what the panel must run
 *   POST /v1/actions/:id/undo/result   the panel reports the undo outcome
 */
const resultSchema = z
  .object({
    ok: z.boolean(),
    recordId: z.string().uuid().optional(),
    error: z.string().max(2000).optional(),
  })
  .strict();

const undoResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().max(2000).optional(),
  })
  .strict();

export function registerActionRoutes(v1: Hono<AppEnv>, actions: ActionService) {
  const id = (raw: string) => {
    if (!isUuid(raw)) throw new ApiError(404, "not_found", "Action not found.");
    return raw;
  };

  v1.post("/actions/:id/start", async (c) => c.json(await actions.start(c.get("member"), id(c.req.param("id")))));

  v1.post("/actions/:id/result", async (c) => {
    const body = await parse(c.req.raw, resultSchema);
    return c.json(await actions.result(c.get("member"), id(c.req.param("id")), body));
  });

  v1.post("/actions/:id/cancel", async (c) => c.json(await actions.cancel(c.get("member"), id(c.req.param("id")))));

  v1.post("/actions/:id/undo/start", async (c) => c.json(await actions.undoStart(c.get("member"), id(c.req.param("id")))));

  v1.post("/actions/:id/undo/result", async (c) => {
    const body = await parse(c.req.raw, undoResultSchema);
    return c.json(await actions.undoResult(c.get("member"), id(c.req.param("id")), body));
  });
}

async function parse<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}
