import { z } from "zod";

/**
 * All settings come from environment variables and are checked at startup.
 * If anything is missing or wrong, the service refuses to start (fail fast),
 * instead of running half-configured. Error messages never include values,
 * so secrets are not printed to logs.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    SUPABASE_URL: z.string().url(),
    AUTH_JWT_MODE: z.enum(["jwks", "secret"]).default("jwks"),
    SUPABASE_JWT_SECRET: z.string().optional(),

    CORS_ALLOWED_ORIGINS: z.string().default(""),

    // AI calls
    AI_PROVIDER: z.enum(["gemini", "fake"]).default("gemini"),
    GEMINI_API_KEY: z.string().optional(),
    // Model names change over time, so they are settings, not code.
    GEMINI_CHAT_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
    GEMINI_THINKING_LEVEL: z.enum(["MINIMAL", "LOW", "MEDIUM", "HIGH", "DEFAULT"]).default("MINIMAL"),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(8192).default(1024),

    // Knowledge base (step 6)
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2"),
    KNOWLEDGE_TOP_K: z.coerce.number().int().min(1).max(20).default(4),
    // How close a help text must be to the question to be used (0..1). Measured with
    // gemini-embedding-2 on 7 Oct 2026: real ERP questions matched at 0.67-0.79, unrelated
    // questions (weather, poems) at most 0.57 -> 0.62 sits in the gap. Re-check if the model changes.
    KNOWLEDGE_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.62),
    ANSWER_CACHE_TTL_HOURS: z.coerce.number().int().min(0).max(24 * 30).default(24),

    // Company-data tools (step 7): AI rounds per question (tool rounds + final answer)
    TOOLS_ENABLED: z.enum(["true", "false"]).default("true"),
    TOOLS_MAX_ROUNDS: z.coerce.number().int().min(2).max(5).default(3),

    // Chat
    CHAT_MAX_MESSAGE_CHARS: z.coerce.number().int().min(100).max(20_000).default(4000),
    CHAT_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(20),
    CHAT_HISTORY_MAX_CHARS: z.coerce.number().int().min(1000).max(200_000).default(24_000),

    // Request limits for AI routes
    RATE_USER_PER_MINUTE: z.coerce.number().int().min(1).default(20),
    RATE_USER_PER_DAY: z.coerce.number().int().min(1).default(500),
    RATE_ORG_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_JWT_MODE === "secret" && (!env.SUPABASE_JWT_SECRET || env.SUPABASE_JWT_SECRET.length < 32)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_JWT_SECRET"],
        message: "required (at least 32 characters) when AUTH_JWT_MODE=secret",
      });
    }
    if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GEMINI_API_KEY"], message: "required when AI_PROVIDER=gemini" });
    }
    if (env.AI_PROVIDER === "fake" && env.NODE_ENV === "production") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AI_PROVIDER"], message: "the fake AI is not allowed in production" });
    }
    if (env.NODE_ENV === "production") {
      for (const origin of splitList(env.CORS_ALLOWED_ORIGINS)) {
        if (!origin.startsWith("https://")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["CORS_ALLOWED_ORIGINS"],
            message: "production origins must use https://",
          });
        }
      }
    }
  });

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  supabaseUrl: string;
  authJwtMode: "jwks" | "secret";
  supabaseJwtSecret: string | undefined;
  corsAllowedOrigins: string[];
  aiProvider: "gemini" | "fake";
  geminiApiKey: string | undefined;
  chatModel: string;
  thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined;
  aiTimeoutMs: number;
  aiMaxOutputTokens: number;
  chat: { maxMessageChars: number; historyMaxMessages: number; historyMaxChars: number };
  rateLimits: { userPerMinute: number; userPerDay: number; orgPerMinute: number };
  embeddingModel: string;
  knowledge: { topK: number; minSimilarity: number };
  /** 0 = cache off. */
  answerCacheTtlHours: number;
  /** null = company-data tools off. */
  tools: { maxRounds: number } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    supabaseUrl: e.SUPABASE_URL.replace(/\/+$/, ""),
    authJwtMode: e.AUTH_JWT_MODE,
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    corsAllowedOrigins: splitList(e.CORS_ALLOWED_ORIGINS),
    aiProvider: e.AI_PROVIDER,
    geminiApiKey: e.GEMINI_API_KEY,
    chatModel: e.GEMINI_CHAT_MODEL,
    thinkingLevel: e.GEMINI_THINKING_LEVEL === "DEFAULT" ? undefined : e.GEMINI_THINKING_LEVEL,
    aiTimeoutMs: e.AI_TIMEOUT_MS,
    aiMaxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
    chat: {
      maxMessageChars: e.CHAT_MAX_MESSAGE_CHARS,
      historyMaxMessages: e.CHAT_HISTORY_MAX_MESSAGES,
      historyMaxChars: e.CHAT_HISTORY_MAX_CHARS,
    },
    embeddingModel: e.GEMINI_EMBEDDING_MODEL,
    knowledge: { topK: e.KNOWLEDGE_TOP_K, minSimilarity: e.KNOWLEDGE_MIN_SIMILARITY },
    answerCacheTtlHours: e.ANSWER_CACHE_TTL_HOURS,
    tools: e.TOOLS_ENABLED === "true" ? { maxRounds: e.TOOLS_MAX_ROUNDS } : null,
    rateLimits: {
      userPerMinute: e.RATE_USER_PER_MINUTE,
      userPerDay: e.RATE_USER_PER_DAY,
      orgPerMinute: e.RATE_ORG_PER_MINUTE,
    },
  };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}
