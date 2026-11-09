import type { Pool } from "../db";

/** Preço por 1M de tokens (US$). Sobrescrevível por LLM_PRICE_TABLE (JSON com o mesmo formato). */
export interface ModelPrice {
  input: number;
  output: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

/** Multiplicadores sobre o preço de input: leitura de cache ~0,1×, escrita ~1,25×. Batch: 50% de tudo. */
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;
const BATCH = 0.5;

export function parsePriceTable(json: string | undefined): Record<string, ModelPrice> {
  if (!json) return DEFAULT_PRICES;
  const parsed = JSON.parse(json) as Record<string, ModelPrice>;
  for (const [model, p] of Object.entries(parsed)) {
    if (!(p && Number.isFinite(p.input) && Number.isFinite(p.output))) throw new Error(`LLM_PRICE_TABLE inválida em ${model}`);
  }
  return { ...DEFAULT_PRICES, ...parsed };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(prices: Record<string, ModelPrice>, model: string, u: Usage, batch: boolean): number {
  const p = prices[model];
  if (!p) throw new Error(`modelo sem preço configurado: ${model}`);
  const inputEq = u.input_tokens + (u.cache_read_input_tokens ?? 0) * CACHE_READ + (u.cache_creation_input_tokens ?? 0) * CACHE_WRITE;
  const usd = (inputEq * p.input + u.output_tokens * p.output) / 1_000_000;
  return batch ? usd * BATCH : usd;
}

export interface UsageRecord {
  storyId?: string | null;
  task: "triage" | "write" | "derive" | "regenerate" | "factcheck";
  model: string;
  usage: Usage;
  batch: boolean;
}

export async function recordUsage(pool: Pool, prices: Record<string, ModelPrice>, r: UsageRecord): Promise<number> {
  const cost = costUsd(prices, r.model, r.usage, r.batch);
  await pool.query(
    `insert into llm_usage (story_id, task, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, batch, cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [r.storyId ?? null, r.task, r.model, r.usage.input_tokens, r.usage.output_tokens,
      r.usage.cache_read_input_tokens ?? 0, r.usage.cache_creation_input_tokens ?? 0, r.batch, cost.toFixed(6)],
  );
  return cost;
}

/** Gasto do mês corrente (fuso da marca) em relação ao orçamento de `settings` (§4.14). */
export async function budgetStatus(pool: Pool, brandId: string): Promise<{ spent: number; budget: number; ratio: number }> {
  const { rows } = await pool.query<{ spent: string; budget: string }>(
    `select coalesce((select sum(cost_usd) from llm_usage
                       where created_at >= date_trunc('month', now() at time zone st.timezone) at time zone st.timezone), 0) as spent,
            st.llm_monthly_budget_usd as budget
       from settings st where st.brand_id = $1`,
    [brandId],
  );
  const spent = Number(rows[0]?.spent ?? 0);
  const budget = Number(rows[0]?.budget ?? 0);
  return { spent, budget, ratio: budget > 0 ? spent / budget : Infinity };
}
