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
  /** Coleta das fontes (Fase 1). "0" desliga sem precisar de deploy de código. */
  INGEST_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v === "1"),
  NVD_API_KEY: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  /** Embeddings (Workers AI bge-m3). Sem os dois, o agrupamento usa CVE + título. */
  CF_ACCOUNT_ID: z.string().min(1).optional(),
  CF_AI_TOKEN: z.string().min(1).optional(),
  /** IA (§8.1). Sem ANTHROPIC_API_KEY a triagem fica desligada. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_MODEL_DEFAULT: z.string().default("claude-haiku-5-5"),
  LLM_MODEL_FALLBACK: z.string().default("claude-sonnet-5-5"),
  /** JSON {"modelo": {"input": US$/MTok, "output": US$/MTok}} que sobrescreve os preços padrão. */
  LLM_PRICE_TABLE: z.string().optional(),
  TRIAGE_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v === "1"),
  /** Seleção diária cria stories; só faz sentido com a geração de conteúdo (etapa 3) no ar. */
  SELECTION_ENABLED: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  /** Ilustração de fundo dos criativos por IA (precisa de CF_ACCOUNT_ID + CF_AI_TOKEN com Workers AI). */
  BACKGROUNDS_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v === "1"),
  /** Storage do Supabase para os criativos (bucket `media`). Sem os dois, a renderização fica desligada. */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** Site público e revalidação das páginas após publicar (§5.5). */
  SITE_URL: z.string().url().default("https://news.iron-security.com").transform((u) => u.replace(/\/+$/, "")),
  REVALIDATE_URL: z.string().url().optional(),
  REVALIDATE_SECRET: z.string().min(16).optional(),
  /** Chave AES-256-GCM dos tokens OAuth (MESMO valor da Vercel). Sem ela, a publicação no Instagram fica desligada. */
  TOKEN_ENC_KEY: z.string().min(40).optional(),
  INSTAGRAM_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
  /** LinkedIn-Version (YYYYMM, §8.5). Cada versão vale ~1 ano: atualizar aqui sem mexer no código. Vazio = padrão. */
  LINKEDIN_API_VERSION: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^\d{6}$/).default("202606")),
  /** Só para renovar o token da página (refresh token). Mesmos valores da Vercel; opcionais. */
  LINKEDIN_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  LINKEDIN_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  LINKEDIN_ORG_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  LINKEDIN_ORG_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  PUBLISH_DRY_RUN: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "1")),
  GIT_SHA: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : "dev")),
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
