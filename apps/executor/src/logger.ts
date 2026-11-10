import pino from "pino";

/** Logger JSON com redação de segredos e PII (§14.1). */
export function createLogger(level: string, version: string) {
  return pino({
    level,
    base: { service: "executor", version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "*.access_token", "*.refresh_token", "*.authorization", "*.Authorization", "*.apiKey",
        "*.password", "*.email", "*.serviceKey", "*.apikey", "*.SUPABASE_SERVICE_ROLE_KEY", "headers.cookie", "config.DATABASE_URL", "DATABASE_URL",
      ],
      censor: "[redacted]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
