import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import { budgetStatus, recordUsage, type ModelPrice } from "../llm/usage";
import { applyTriage, parseTriageMessage, triageParams, type TriageItem } from "./triage";

export interface TriageDeps {
  pool: Pool;
  log: Logger;
  client: Anthropic;
  brandId: string;
  model: string;
  prices: Record<string, ModelPrice>;
}

/** Triagem continua até 120% do orçamento mensal (§4.14). */
export const TRIAGE_BUDGET_CEILING = 1.2;
/** Itens que esperaram mais que isso sem triagem não entram mais em pauta. */
const STALE_HOURS = 48;
const MAX_BATCH_ITEMS = 500;
/** Lote que não terminou em 25 h é dado como perdido (a API expira em 24 h). */
const BATCH_TIMEOUT_HOURS = 25;

/** Itens novos ainda não enviados a um lote aberto. */
export async function pendingItems(pool: Pool, brandId: string, opts: { sinceHours: number; limit: number }): Promise<TriageItem[]> {
  const { rows } = await pool.query<TriageItem>(
    `select r.id, s.name as source_name, r.title, r.summary, r.content_excerpt, r.published_at
       from raw_items r join sources s on s.id = r.source_id
      where s.brand_id = $1 and r.status = 'new'
        and r.fetched_at > now() - make_interval(hours => $2)
        and not exists (select 1 from llm_batches b where b.status = 'in_progress' and r.id = any(b.item_ids))
      order by r.fetched_at desc
      limit $3`,
    [brandId, opts.sinceHours, opts.limit],
  );
  return rows;
}

async function overBudget(deps: TriageDeps): Promise<boolean> {
  const b = await budgetStatus(deps.pool, deps.brandId);
  if (b.ratio >= TRIAGE_BUDGET_CEILING) {
    deps.log.error({ module: "triage", spent: b.spent, budget: b.budget }, "LLM budget ceiling reached; triage paused");
    return true;
  }
  return false;
}

/** A cada 30 min (RN-TRI01): envia os itens novos num lote da Message Batches API (50% do custo). */
export async function submitTriageBatch(deps: TriageDeps): Promise<string | null> {
  const { pool, log } = deps;
  const stale = await pool.query(
    `update raw_items set status = 'discarded', discard_reason = 'sem triagem em ${STALE_HOURS} h'
      where status = 'new' and fetched_at <= now() - make_interval(hours => $1)`,
    [STALE_HOURS],
  );
  if (stale.rowCount) log.warn({ module: "triage", count: stale.rowCount }, "stale items discarded");

  const items = await pendingItems(pool, deps.brandId, { sinceHours: STALE_HOURS, limit: MAX_BATCH_ITEMS });
  if (items.length === 0 || (await overBudget(deps))) return null;

  const batch = await deps.client.messages.batches.create({
    requests: items.map((it) => ({ custom_id: it.id, params: triageParams(deps.model, it) })),
  });
  await pool.query("insert into llm_batches (id, task, item_ids) values ($1, 'triage', $2::uuid[])", [batch.id, items.map((i) => i.id)]);
  log.info({ module: "triage", batchId: batch.id, items: items.length }, "triage batch submitted");
  return batch.id;
}

/** A cada minuto: lotes terminados têm os resultados aplicados (em qualquer ordem, por custom_id). */
export async function pollTriageBatches(deps: TriageDeps): Promise<void> {
  const { pool, log, client } = deps;
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    "select id, created_at from llm_batches where status = 'in_progress' and task = 'triage' order by created_at",
  );
  for (const b of rows) {
    const batch = await client.messages.batches.retrieve(b.id);
    if (batch.processing_status !== "ended") {
      if (Date.now() - b.created_at.getTime() > BATCH_TIMEOUT_HOURS * 3_600_000) {
        await client.messages.batches.cancel(b.id).catch(() => undefined);
        await pool.query("update llm_batches set status = 'failed', error = 'timeout', ended_at = now() where id = $1", [b.id]);
        log.error({ module: "triage", batchId: b.id }, "triage batch timed out");
      }
      continue;
    }
    const counts = { succeeded: 0, invalid: 0, retry: 0, skipped: 0 };
    // Itens que já saíram de 'new' foram aplicados numa leitura anterior interrompida: não aplica nem cobra de novo.
    const { rows: open } = await pool.query<{ id: string }>(
      "select r.id from raw_items r join llm_batches b on r.id = any(b.item_ids) where b.id = $1 and r.status = 'new'",
      [b.id],
    );
    const pending = new Set(open.map((x) => x.id));
    for await (const r of await client.messages.batches.results(b.id)) {
      const itemId = r.custom_id;
      if (!pending.has(itemId)) {
        counts.skipped++;
        continue;
      }
      switch (r.result.type) {
        case "succeeded": {
          const msg = r.result.message;
          await recordUsage(pool, deps.prices, { task: "triage", model: msg.model, usage: msg.usage, batch: true });
          const outcome = parseTriageMessage(msg);
          await applyTriage(pool, itemId, outcome, msg.model);
          counts[outcome.ok ? "succeeded" : "invalid"]++;
          break;
        }
        case "errored":
          if (r.result.error.error?.type === "invalid_request_error") {
            await applyTriage(pool, itemId, { ok: false, reason: "requisição inválida" }, deps.model);
            counts.invalid++;
          } else {
            counts.retry++; // continua 'new' e entra no próximo lote
          }
          break;
        default: // expired | canceled
          counts.retry++;
      }
    }
    await pool.query("update llm_batches set status = 'ended', ended_at = now() where id = $1", [b.id]);
    log.info({ module: "triage", batchId: b.id, ...counts }, "triage batch applied");
  }
}

/** Triagem síncrona (urgência antes da seleção, RN-TRI01). Concorrência baixa para não estourar rate limit. */
export async function triageSync(deps: TriageDeps, items: TriageItem[], concurrency = 4): Promise<{ ok: number; failed: number }> {
  if (items.length === 0 || (await overBudget(deps))) return { ok: 0, failed: 0 };
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++]!;
      try {
        const msg = await deps.client.messages.create(triageParams(deps.model, it));
        await recordUsage(deps.pool, deps.prices, { task: "triage", model: msg.model, usage: msg.usage, batch: false });
        await applyTriage(deps.pool, it.id, parseTriageMessage(msg), msg.model);
        ok++;
      } catch (err) {
        failed++;
        // Erro de cliente (4xx exceto 429) não melhora tentando de novo; os demais ficam 'new'.
        if (err instanceof Anthropic.APIError && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          await applyTriage(deps.pool, it.id, { ok: false, reason: `API ${err.status}` }, deps.model);
        }
        deps.log.warn({ module: "triage", itemId: it.id, err: (err as Error).message }, "sync triage failed");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ok, failed };
}
