/**
 * Gera de novo os derivados (Instagram, Facebook, LinkedIn, Short) que faltam numa story e pede os criativos.
 * Uso no container:  node dist/regen-derivatives.js <story-id> [pt|en]
 *   sem idioma: completa os idiomas com artigo e sem carrossel; com idioma: refaz só aquele.
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { parsePriceTable } from "./llm/usage";
import { createLogger } from "./logger";
import { regenerateDerivatives } from "./story/build";

const [storyId, lang] = process.argv.slice(2);
if (!storyId || !/^[0-9a-f-]{36}$/i.test(storyId) || (lang && lang !== "pt" && lang !== "en")) {
  console.error("uso: node dist/regen-derivatives.js <story-id> [pt|en]");
  process.exit(2);
}
const config = loadConfig();
if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY ausente");
const pool = createPool(config.DATABASE_URL);
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA);
const { rows } = await pool.query<{ id: string }>("select id from brands where slug = $1", [config.BRAND_SLUG]);
try {
  const result = await regenerateDerivatives({
    pool, log, client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 }), brandId: rows[0]!.id,
    model: config.LLM_MODEL_DEFAULT, fallbackModel: config.LLM_MODEL_FALLBACK, prices: parsePriceTable(config.LLM_PRICE_TABLE),
  }, storyId, lang as "pt" | "en" | undefined);
  console.log(result.length ? JSON.stringify(result) : "nada a completar: todos os idiomas já têm derivados");
} finally {
  await pool.end();
}
