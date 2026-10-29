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
import { FakeEmbedder, GeminiEmbedder, type Embedder } from "./ai/embedder.js";
import { createPageDirectory } from "./chat/rules.js";
import { createAnswerCache } from "./chat/answer-cache.js";
import { createActionService } from "./actions/service.js";
import { registerActionRoutes } from "./actions/routes.js";
import { registerCreditRoutes } from "./credits/routes.js";
import { registerStripeWebhook } from "./credits/webhook.js";
import { createStripeGateway } from "./credits/payments.js";
import { createAdminRoutes } from "./admin/routes.js";
import { DailyCallProvider, FakeCallProvider } from "./calls/provider.js";
import { createCallService } from "./calls/service.js";
import { createCallEvents, registerCallRoutes } from "./calls/routes.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const sql = createSql(config.databaseUrl, { max: config.databasePoolMax });

const provider: AiProvider =
  config.aiProvider === "gemini"
    ? new GeminiProvider({ apiKey: config.geminiApiKey!, thinkingLevel: config.thinkingLevel })
    : new FakeProvider({ reply: "(Local test mode: this answer comes from the fake AI, not Gemini.)" });

const embedder: Embedder =
  config.aiProvider === "gemini"
    ? new GeminiEmbedder({ apiKey: config.geminiApiKey!, model: config.embeddingModel })
    : new FakeEmbedder();

const meter = createStreamMeter({
  store: createSqlCreditStore(sql),
  provider,
  logger,
  options: { timeoutMs: config.aiTimeoutMs },
});

const actions = config.actions ? createActionService({ sql, log: logger, undoMinutes: config.actions.undoMinutes }) : undefined;

const payments = config.stripe
  ? createStripeGateway({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret })
  : undefined;
// "Talk to a person" calls: rooms on Daily.co (or test mode locally without a key).
const calls = config.calls
  ? {
      service: createCallService({
        sql,
        log: logger,
        provider: config.calls.provider === "daily" ? new DailyCallProvider(config.calls.apiKey) : new FakeCallProvider(),
      }),
      events: createCallEvents(sql, logger),
    }
  : undefined;
// Calls nobody answered in time become "missed" (also checked on every call request).
if (calls) setInterval(() => void calls.service.sweep().catch((err) => logger.warn({ err }, "call sweep failed")), 10_000).unref();

const verifyToken = createTokenVerifier({
  supabaseUrl: config.supabaseUrl,
  mode: config.authJwtMode,
  secret: config.supabaseJwtSecret,
});

const app = createApp({
  sql,
  logger,
  corsAllowedOrigins: config.corsAllowedOrigins,
  verifyToken,
  extendRoot: (root) => {
    if (payments) registerStripeWebhook(root, { sql, payments });
    root.route("/admin/v1", createAdminRoutes({ sql, verifyToken, ownerEmail: config.platformOwnerEmail, calls }));
  },
  extendV1: (v1) => {
    registerCreditRoutes(v1, { sql, payments, appUrl: config.appPublicUrl });
    if (calls) registerCallRoutes(v1, { sql, calls: calls.service });
    if (actions) registerActionRoutes(v1, actions);
    registerChatRoutes(v1, {
      sql,
      meter,
      model: config.chatModel,
      maxOutputTokens: config.aiMaxOutputTokens,
      rateLimitRules: aiRateLimitRules(config.rateLimits),
      maxMessageChars: config.chat.maxMessageChars,
      history: { maxMessages: config.chat.historyMaxMessages, maxChars: config.chat.historyMaxChars },
      knowledge: { embedder, topK: config.knowledge.topK, minSimilarity: config.knowledge.minSimilarity },
      pages: createPageDirectory(sql),
      cache: config.answerCacheTtlHours > 0 ? createAnswerCache(sql, { ttlHours: config.answerCacheTtlHours }) : undefined,
      tools: config.tools ?? undefined,
      actions,
    });
  },
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    { port: info.port, env: config.nodeEnv, authMode: config.authJwtMode, aiProvider: provider.name, model: config.chatModel },
    "soft-ai-backend started",
  );
});

// Graceful shutdown (the host, e.g. Render, sends SIGTERM on deploy/stop):
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
