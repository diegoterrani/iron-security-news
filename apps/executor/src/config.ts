import { z } from "zod";

/**
 * Configuração validada na inicialização (12-factor). Só DATABASE_URL é obrigatório na Fase 0;
 * as chaves de integrações entram como obrigatórias quando o módulo correspondente for ligado.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BRAND_SLUG: z.string().default("iron"),
  DATABASE_URL: z.string().url().refine((u) => u.startsWith("postgres"), "DATABASE_URL deve ser postgres://"),
  /** URL de heartbeat (healthchecks.io ou Uptime Kuma push). Opcional. */
  HEARTBEAT_URL: z.string().url().optional(),
  HEARTBEAT_INTERVAL_SEC: z.coerce.number().int().min(30).default(60),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  PUBLISH_DRY_RUN: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "1")),
  GIT_SHA: z.string().default("dev"),
});

export type Config = z.infer<typeof EnvSchema> & { PUBLISH_DRY_RUN: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const cfg = parsed.data;
  // Fora de produção, publicar nas redes fica desligado por padrão.
  const dryRun = cfg.PUBLISH_DRY_RUN ?? cfg.NODE_ENV !== "production";
  return { ...cfg, PUBLISH_DRY_RUN: dryRun };
}
