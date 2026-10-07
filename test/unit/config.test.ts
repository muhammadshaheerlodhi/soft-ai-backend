import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
  SUPABASE_URL: "https://abc.supabase.co/",
  GEMINI_API_KEY: "test-key-not-real",
};

describe("config", () => {
  it("loads valid settings and applies safe defaults", () => {
    const c = loadConfig({ ...base });
    expect(c.port).toBe(8787);
    expect(c.authJwtMode).toBe("jwks");
    expect(c.supabaseUrl).toBe("https://abc.supabase.co"); // trailing slash removed
    expect(c.corsAllowedOrigins).toEqual([]);
    expect(c.aiProvider).toBe("gemini");
    expect(c.thinkingLevel).toBe("MINIMAL"); // cheapest thinking by default
  });

  it("refuses to start without a database url", () => {
    expect(() => loadConfig({ SUPABASE_URL: base.SUPABASE_URL, GEMINI_API_KEY: "x" })).toThrow(/DATABASE_URL/);
  });

  it("requires a long JWT secret in secret mode", () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_MODE: "secret", SUPABASE_JWT_SECRET: "short" })).toThrow(
      /SUPABASE_JWT_SECRET/,
    );
  });

  it("never prints secret values in configuration errors", () => {
    const secret = "short-but-secret-value";
    try {
      loadConfig({ ...base, AUTH_JWT_MODE: "secret", SUPABASE_JWT_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });

  it("requires https origins in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "http://erp.example.com" }),
    ).toThrow(/https/);
    const ok = loadConfig({
      ...base,
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://erp.example.com/, https://app.example.com",
    });
    expect(ok.corsAllowedOrigins).toEqual(["https://erp.example.com", "https://app.example.com"]);
  });

  it("requires a Gemini key when the provider is Gemini", () => {
    const { GEMINI_API_KEY: _omit, ...noKey } = base;
    expect(() => loadConfig(noKey)).toThrow(/GEMINI_API_KEY/);
  });

  it("never allows the fake AI in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AI_PROVIDER: "fake" })).toThrow(/fake AI/);
    expect(loadConfig({ ...base, AI_PROVIDER: "fake" }).aiProvider).toBe("fake"); // fine locally
  });

  it("lets the model and thinking level be changed without code changes", () => {
    const c = loadConfig({ ...base, GEMINI_CHAT_MODEL: "some-new-model", GEMINI_THINKING_LEVEL: "DEFAULT" });
    expect(c.chatModel).toBe("some-new-model");
    expect(c.thinkingLevel).toBeUndefined();
  });
});
