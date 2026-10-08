import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Sql } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { TokenVerifier } from "./auth/verify-token.js";
import { getCreditStatus } from "./credits/routes.js";
import { ApiError, describeError, errorResponse } from "./http/errors.js";
import { requestContext, requireOrganization, requireUser } from "./http/middleware.js";
import type { AppEnv } from "./http/types.js";

export interface AppDeps {
  sql: Sql;
  verifyToken: TokenVerifier;
  logger: Logger;
  corsAllowedOrigins: string[];
  /**
   * Adds more protected /v1 routes. Every route added here already has the
   * login + organization checks in front of it. Used by the chat routes
   * (step 4) and by tests.
   */
  extendV1?: (v1: Hono<AppEnv>) => void;
  /**
   * Routes OUTSIDE the organization checks: the Stripe webhook (Stripe's
   * signature is the proof) and the platform admin API (its own admin check).
   */
  extendRoot?: (app: Hono<AppEnv>) => void;
}

/**
 * Builds the HTTP app. Everything it needs is passed in (database, token
 * checker, logger), so tests can build the same app against a local database.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const allowed = new Set(deps.corsAllowedOrigins);

  app.use("*", requestContext(deps.logger));
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      // Only the ERP's own website may call this API from a browser.
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-Organization-Id"],
      exposeHeaders: ["X-Request-Id"],
      // We use bearer tokens, not cookies, so a malicious site cannot make
      // requests "as" the user (no CSRF).
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new ApiError(413, "bad_request", "Request is too large.");
      },
    }),
  );

  // ---------- public ----------

  /** Liveness: the process is up. */
  app.get("/health", (c) => c.json({ status: "ok" }));

  /** Readiness: the process can reach the database. */
  app.get("/ready", async (c) => {
    await deps.sql`select 1`;
    return c.json({ status: "ready" });
  });

  // ---------- protected: signed-in user + organization ----------

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireUser(deps.verifyToken));
  v1.use("*", requireOrganization(deps.sql));

  /** Who am I in this organization? The panel uses this on load. */
  v1.get("/me", (c) => {
    const m = c.get("member");
    return c.json({
      userId: m.userId,
      organizationId: m.organizationId,
      parentOrganizationId: m.parentOrganizationId,
      isOwner: m.isOwner,
      role: m.roleSlug,
      permissions: [...m.permissions].sort(),
    });
  });

  /** Credits of the current organization (credits button): balance, this month, limits, warnings. */
  v1.get("/credits", async (c) => c.json(await getCreditStatus(deps.sql, c.get("member"), c.get("log"))));

  deps.extendV1?.(v1);

  deps.extendRoot?.(app);
  app.route("/v1", v1);

  // ---------- errors ----------

  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found."));

  app.onError((err, c) => {
    const d = describeError(err);
    // Unexpected problems: full details go to OUR log, a plain message to the user.
    if (d.unexpected) c.get("log")?.error({ err }, "request failed");
    return errorResponse(c, d.status, d.code, d.message);
  });

  return app;
}
