import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import { AuthError, type TokenVerifier } from "../auth/verify-token.js";
import { loadMemberContext } from "../auth/member-context.js";
import { can } from "../auth/permissions.js";
import { isUuid } from "../lib/uuid.js";
import { ApiError } from "./errors.js";
import type { AppEnv } from "./types.js";

/** Gives every request an id (returned in the X-Request-Id header) and a logger. */
export function requestContext(baseLogger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomUUID();
    const log = baseLogger.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    c.header("X-Request-Id", requestId);

    const started = performance.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: c.req.path, // path only: no query string, no headers, no body
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  };
}

/**
 * Step 1 of every protected request: who is calling?
 * Reads "Authorization: Bearer <token>" and checks it.
 */
export function requireUser(verifyToken: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header);
    if (!match?.[1]) {
      throw new ApiError(401, "unauthenticated", "Please sign in.");
    }
    try {
      c.set("user", await verifyToken(match[1]));
    } catch (err) {
      if (err instanceof AuthError) throw new ApiError(401, err.code, err.message);
      throw err;
    }
    await next();
  };
}

/**
 * Step 2: in which organization (or sub-account), and with what role?
 * The panel sends the organization the user is working in as
 * "X-Organization-Id". The user must be an active member of it.
 *
 * "Not a member" and "organization does not exist" get the SAME answer (403),
 * so nobody can use the API to discover which organization ids exist.
 */
export function requireOrganization(sql: Sql): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const orgId = c.req.header("X-Organization-Id");
    if (!orgId) {
      throw new ApiError(400, "missing_organization", "Organization is required.");
    }
    if (!isUuid(orgId)) {
      throw new ApiError(400, "invalid_organization", "Organization id is not valid.");
    }
    const member = await loadMemberContext(sql, orgId, c.get("user").userId);
    if (!member) {
      throw new ApiError(403, "forbidden", "You do not have access to this organization.");
    }
    c.set("member", member);
    await next();
  };
}

/** Step 3 (when needed): does the user's role allow this? e.g. "sales.create". */
export function requirePermission(permission: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!can(c.get("member"), permission)) {
      throw new ApiError(403, "forbidden", "Your role does not allow this.");
    }
    await next();
  };
}
