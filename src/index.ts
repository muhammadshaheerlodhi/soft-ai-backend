import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSql } from "./db/client.js";
import { createLogger } from "./logger.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { FakeProvider } from "./ai/fake-provider.js";
import type { AiProvider } from "./ai/provider.js";
import { createSqlCreditStore } from "./credits/store.js";
import { createStreamMeter } from "./credits/metering-stream.js";
import { aiRateLimitRules } from "./http/rate-limit.js";
import { registerChatRoutes } from "./chat/routes.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const sql = createSql(config.databaseUrl, { max: config.databasePoolMax });

const provider: AiProvider =
  config.aiProvider === "gemini"
    ? new GeminiProvider({ apiKey: config.geminiApiKey!, thinkingLevel: config.thinkingLevel })
    : new FakeProvider({ reply: "(Local test mode: this answer comes from the fake AI, not Gemini.)" });

const meter = createStreamMeter({
  store: createSqlCreditStore(sql),
  provider,
  logger,
  options: { timeoutMs: config.aiTimeoutMs },
});

const app = createApp({
  sql,
  logger,
  corsAllowedOrigins: config.corsAllowedOrigins,
  verifyToken: createTokenVerifier({
    supabaseUrl: config.supabaseUrl,
    mode: config.authJwtMode,
    secret: config.supabaseJwtSecret,
  }),
  extendV1: (v1) =>
    registerChatRoutes(v1, {
      sql,
      meter,
      model: config.chatModel,
      maxOutputTokens: config.aiMaxOutputTokens,
      rateLimitRules: aiRateLimitRules(config.rateLimits),
      maxMessageChars: config.chat.maxMessageChars,
      history: { maxMessages: config.chat.historyMaxMessages, maxChars: config.chat.historyMaxChars },
    }),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    { port: info.port, env: config.nodeEnv, authMode: config.authJwtMode, aiProvider: provider.name, model: config.chatModel },
    "soft-ai-backend started",
  );
});

// Graceful shutdown (Railway sends SIGTERM on deploy/stop):
// stop taking new requests, let running ones finish, close the database pool.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await sql.end({ timeout: 5 });
    logger.info("stopped");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
