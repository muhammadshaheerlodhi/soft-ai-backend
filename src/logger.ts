import { pino, type Logger } from "pino";

export type { Logger };

/**
 * JSON logs. We never log request headers or bodies by default; the redact
 * list is a second safety net in case someone logs an object containing a token.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "soft-ai-backend" },
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
        "token",
        "*.token",
        "password",
        "*.password",
      ],
      censor: "[redacted]",
    },
  });
}
