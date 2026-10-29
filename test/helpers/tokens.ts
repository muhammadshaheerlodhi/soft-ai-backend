import { SignJWT } from "jose";
import { TEST_ENV } from "./local-env.js";

interface TokenOptions {
  secret?: string;
  issuer?: string;
  audience?: string;
  role?: string;
  expiresIn?: string | number;
  extra?: Record<string, unknown>;
}

/** Makes a login token shaped like a Supabase access token, signed with the test secret. */
export async function signTestToken(userId: string, opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: opts.role ?? "authenticated",
    email: `${userId}@soft-ai-test.local`,
    ...opts.extra,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(opts.issuer ?? `${TEST_ENV.supabaseUrl}/auth/v1`)
    .setAudience(opts.audience ?? "authenticated")
    .setIssuedAt(now - 10)
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(opts.secret ?? TEST_ENV.jwtSecret));
}
