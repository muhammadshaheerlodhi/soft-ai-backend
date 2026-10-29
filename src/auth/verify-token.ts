import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";
import { isUuid } from "../lib/uuid.js";

/**
 * Checks the login token (Supabase access token) that the ERP sends with each
 * request. The user is already logged in to the ERP; we never see passwords.
 *
 * A token is accepted only if ALL of these hold:
 *   - signature is valid (Supabase's public keys, or the project's JWT secret)
 *   - issued by this Supabase project (iss = <SUPABASE_URL>/auth/v1)
 *   - meant for logged-in users (aud = "authenticated", role = "authenticated")
 *   - not expired
 *   - sub is a user id, and the user is not an anonymous guest
 * The "anon" key and the "service_role" key are rejected: they are not users.
 */

export interface VerifiedUser {
  userId: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<VerifiedUser>;

export type AuthErrorCode = "invalid_token" | "expired_token";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TokenVerifierOptions {
  supabaseUrl: string;
  mode: "jwks" | "secret";
  /** Required when mode = "secret". */
  secret?: string;
  /** Override the JWKS location (tests only). Default: <SUPABASE_URL>/auth/v1/.well-known/jwks.json */
  jwksUrl?: string;
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const issuer = `${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const common: JWTVerifyOptions = {
    issuer,
    audience: "authenticated",
    clockTolerance: 5, // seconds of clock difference we accept
  };

  let verify: (token: string) => Promise<JWTPayload>;

  if (options.mode === "jwks") {
    const jwks = createRemoteJWKSet(new URL(options.jwksUrl ?? `${issuer}/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    const opts = { ...common, algorithms: ["ES256", "RS256"] };
    verify = async (token) => (await jwtVerify(token, jwks, opts)).payload;
  } else {
    if (!options.secret || options.secret.length < 32) {
      throw new Error("JWT secret is required (at least 32 characters) in secret mode");
    }
    const key = new TextEncoder().encode(options.secret);
    const opts = { ...common, algorithms: ["HS256"] };
    verify = async (token) => (await jwtVerify(token, key, opts)).payload;
  }

  return async (token: string): Promise<VerifiedUser> => {
    let payload: JWTPayload;
    try {
      payload = await verify(token);
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AuthError("expired_token", "Login expired. Please sign in again.");
      }
      throw new AuthError("invalid_token", "Invalid login token.");
    }

    if (payload.role !== "authenticated") {
      throw new AuthError("invalid_token", "Invalid login token.");
    }
    if (payload.is_anonymous === true) {
      throw new AuthError("invalid_token", "Guest sessions cannot use Soft AI.");
    }
    if (!isUuid(payload.sub)) {
      throw new AuthError("invalid_token", "Invalid login token.");
    }

    return {
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  };
}
