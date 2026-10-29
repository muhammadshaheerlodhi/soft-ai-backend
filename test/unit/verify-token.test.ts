import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, createTokenVerifier } from "../../src/auth/verify-token.js";
import { signTestToken } from "../helpers/tokens.js";
import { TEST_ENV } from "../helpers/local-env.js";

type CryptoKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const userId = randomUUID();

async function expectRejected(promise: Promise<unknown>, code: "invalid_token" | "expired_token") {
  await expect(promise).rejects.toBeInstanceOf(AuthError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("token verifier - secret mode (older Supabase projects)", () => {
  const verify = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: TEST_ENV.jwtSecret });

  it("accepts a valid user token", async () => {
    const user = await verify(await signTestToken(userId));
    expect(user.userId).toBe(userId);
    expect(user.email).toBe(`${userId}@soft-ai-test.local`);
  });

  it("rejects an expired token", async () => {
    const token = await signTestToken(userId, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    await expectRejected(verify(token), "expired_token");
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signTestToken(userId, { secret: "another-secret-that-is-long-enough-000000000" });
    await expectRejected(verify(token), "invalid_token");
  });

  it("rejects a token from another Supabase project", async () => {
    await expectRejected(verify(await signTestToken(userId, { issuer: "https://evil.supabase.co/auth/v1" })), "invalid_token");
  });

  it("rejects the anon key and the service_role key (they are not users)", async () => {
    await expectRejected(verify(await signTestToken(userId, { role: "anon", audience: "authenticated" })), "invalid_token");
    await expectRejected(verify(await signTestToken(userId, { role: "service_role" })), "invalid_token");
  });

  it("rejects a token for the wrong audience", async () => {
    await expectRejected(verify(await signTestToken(userId, { audience: "anon" })), "invalid_token");
  });

  it("rejects anonymous guest sessions", async () => {
    await expectRejected(verify(await signTestToken(userId, { extra: { is_anonymous: true } })), "invalid_token");
  });

  it("rejects a token whose subject is not a user id", async () => {
    await expectRejected(verify(await signTestToken("not-a-uuid")), "invalid_token");
  });

  it("rejects an unsigned token (alg none) and garbage", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", iss: `${TEST_ENV.supabaseUrl}/auth/v1`, exp: 9999999999 }),
    ).toString("base64url");
    await expectRejected(verify(`${header}.${body}.`), "invalid_token");
    await expectRejected(verify("not.a.token"), "invalid_token");
  });

  it("refuses to be created with a short secret", () => {
    expect(() => createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "secret", secret: "short" })).toThrow();
  });
});

describe("token verifier - JWKS mode (Supabase signing keys)", () => {
  let server: Server;
  let jwksUrl: string;
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  const kid = "test-key-1";

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    otherPrivateKey = (await generateKeyPair("ES256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function es256Token(key: CryptoKey, keyId = kid) {
    return new SignJWT({ role: "authenticated", email: "x@soft-ai-test.local" })
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setSubject(userId)
      .setIssuer(`${TEST_ENV.supabaseUrl}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
  }

  it("accepts a token signed with the project's published key", async () => {
    const verify = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "jwks", jwksUrl });
    expect((await verify(await es256Token(privateKey))).userId).toBe(userId);
  });

  it("rejects a token signed with a key the project did not publish", async () => {
    const verify = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "jwks", jwksUrl });
    await expectRejected(verify(await es256Token(otherPrivateKey)), "invalid_token");
  });

  it("rejects an HS256 token in JWKS mode (no algorithm switching)", async () => {
    const verify = createTokenVerifier({ supabaseUrl: TEST_ENV.supabaseUrl, mode: "jwks", jwksUrl });
    await expectRejected(verify(await signTestToken(userId)), "invalid_token");
  });
});
