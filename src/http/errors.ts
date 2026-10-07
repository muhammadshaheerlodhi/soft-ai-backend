import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { InsufficientCreditsError, ModelNotPricedError } from "../credits/store.js";
import { AiTimeoutError } from "../credits/metering.js";
import { AiProviderError } from "../ai/provider.js";
import type { AppEnv } from "./types.js";

/**
 * Every error the API returns has the same shape:
 *   { "error": { "code": "forbidden", "message": "...", "requestId": "..." } }
 * The panel shows `message`; support uses `requestId` to find the log line.
 * Internal details (SQL, stack traces, provider errors) are logged, never sent.
 */
export type ErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "expired_token"
  | "missing_organization"
  | "invalid_organization"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "conflict"
  | "rate_limited"
  | "insufficient_credits"
  | "ai_not_configured"
  | "ai_unavailable"
  | "ai_timeout"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface DescribedError {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  /** true = unexpected; log it with full details. */
  unexpected: boolean;
}

/** Turns any error into the safe status / code / message the user sees. */
export function describeError(err: unknown): DescribedError {
  if (err instanceof ApiError) return { status: err.status, code: err.code, message: err.message, unexpected: false };
  if (err instanceof HTTPException) return { status: err.status as 400, code: "bad_request", message: "Bad request.", unexpected: false };
  if (err instanceof InsufficientCreditsError) {
    return { status: 402, code: "insufficient_credits", message: "No credits left. Please buy credits to continue.", unexpected: false };
  }
  if (err instanceof ModelNotPricedError) {
    return { status: 503, code: "ai_not_configured", message: "Soft AI is not available right now. Please contact support.", unexpected: true };
  }
  if (err instanceof AiTimeoutError) {
    return { status: 504, code: "ai_timeout", message: "Soft AI took too long to answer. You were not charged. Please try again.", unexpected: false };
  }
  if (err instanceof AiProviderError) {
    return { status: 502, code: "ai_unavailable", message: "Soft AI could not answer right now. You were not charged. Please try again.", unexpected: true };
  }
  return { status: 500, code: "internal_error", message: "Something went wrong. Please try again.", unexpected: true };
}

export function errorResponse(c: Context<AppEnv>, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") ?? null } }, status);
}
