import { randomUUID } from "node:crypto";
import type { Pool } from "../db";
import { canonicalUrl, extractCves, sha256, truncate } from "../ingest/normalize";
import { budgetStatus, recordUsage } from "../llm/usage";
import { parseTriageMessage, triageParams } from "../triage/triage";
import type { TriageDeps } from "../triage/run";
import { MANUAL_TEXT_MAX, MANUAL_TEXT_MIN, extractArticle, hostLabel, splitPastedText } from "./extract";
import { FetchRejected, safeFetch, type SafeFetchOptions } from "./safe-fetch";

/**
 * Notícia manual (/admin/nova). Um pedido por vez:
 *   pedido → (link: busca segura + extração | texto: limpeza) → raw_item da fonte "Envio manual"
 *   → triagem síncrona (categoria, severidade, CVEs) → story DRAFTING → fila story_build.
 * Daí em diante é o mesmo caminho da seleção diária: buildStory, Fact Guard, derivados, criativos, revisão.
 */

export interface ManualRequestRow {
  id: string;
  brand_id: string;
  kind: "url" | "text";
  input_url: string | null;
  input_text: string | null;
  source_name: string | null;
  source_url: string | null;
  attempts: number;
}

export interface ManualDeps extends TriageDeps {
  fetchOptions?: SafeFetchOptions;
}

/** Pedido preso em 'processing' (executor reiniciou no meio) volta para a fila depois disso. */
const STUCK_MINUTES = 15;
export const MAX_ATTEMPTS = 3;

/** Item pronto para virar raw_item. */
export interface ManualItem {
  url: string;
  canonical: string;
  sourceLabel: string;
  title: string;
  text: string;
  publishedAt: Date | null;
}

/** Monta o item a partir do pedido. Link: busca e extrai; texto: usa o que foi colado. */
export async function buildManualItem(req: ManualRequestRow, fetchOptions?: SafeFetchOptions): Promise<ManualItem> {
  if (req.kind === "url") {
    const page = await safeFetch(req.input_url!, fetchOptions);
    const isHtml = !page.contentType.startsWith("text/plain");
    const a = isHtml
      ? extractArticle(page.body)
      : { ...splitPastedText(page.body), description: null, siteName: null, publishedAt: null };
    // A descrição (og:description) costuma ser o lead; entra antes do corpo quando não está repetida nele.
    const lead = "description" in a && a.description && !a.text.includes(a.description.slice(0, 80)) ? `${a.description}\n\n` : "";
    const text = truncate(`${lead}${a.text}`.trim(), MANUAL_TEXT_MAX);
    if (text.length < MANUAL_TEXT_MIN) {
      throw new FetchRejected("não consegui ler o texto da matéria (paywall, bloqueio ou página em JavaScript); cole o texto");
    }
    if (!a.title) throw new FetchRejected("a página não tem título; cole o texto");
    return {
      url: page.url,
      canonical: canonicalUrl(page.url),
      sourceLabel: req.source_name ?? ("siteName" in a && a.siteName ? a.siteName : hostLabel(page.url)),
      title: a.title,
      text,
      publishedAt: a.publishedAt,
    };
  }
  const { title, text } = splitPastedText(req.input_text ?? "");
  if (text.length < 200) throw new FetchRejected("texto curto demais depois da limpeza (mínimo 200 caracteres)");
  // Sem link da fonte, a URL é um URN interno: o redator não a recebe nem a lista em "Fontes".
  const url = req.source_url ?? `urn:ironnews:manual:${req.id}`;
  return {
    url,
    canonical: req.source_url ? canonicalUrl(req.source_url) : url,
    sourceLabel: req.source_name ?? (req.source_url ? hostLabel(req.source_url) : "Envio da redação"),
    title,
    text,
    publishedAt: null,
  };
}

async function claimNext(pool: Pool): Promise<ManualRequestRow | null> {
  await pool.query(
    `update manual_requests
        set status = case when attempts >= $1 then 'failed' else 'pending' end,
            error = case when attempts >= $1 then 'interrompido várias vezes; envie de novo' else error end,
            updated_at = now()
      where status = 'processing' and started_at < now() - make_interval(mins => $2)`,
    [MAX_ATTEMPTS, STUCK_MINUTES],
  );
  const { rows } = await pool.query<ManualRequestRow>(
    `update manual_requests set status = 'processing', attempts = attempts + 1, started_at = now(), updated_at = now()
      where id = (select id from manual_requests where status = 'pending'
                   order by created_at for update skip locked limit 1)
      returning id, brand_id, kind, input_url, input_text, source_name, source_url, attempts`,
  );
  return rows[0] ?? null;
}

async function finish(pool: Pool, id: string, status: "pending" | "failed", error: string) {
  await pool.query("update manual_requests set status = $2, error = $3, updated_at = now() where id = $1", [id, status, error.slice(0, 500)]);
}

/** Processa no máximo um pedido. Devolve o id da story criada, ou null. */
export async function processManualRequest(deps: ManualDeps): Promise<string | null> {
  const { pool, log } = deps;
  const req = await claimNext(pool);
  if (!req) return null;
  const ctx = { module: "manual", requestId: req.id, kind: req.kind, attempt: req.attempts };

  try {
    const budget = await budgetStatus(pool, req.brand_id);
    if (budget.ratio >= 1) throw new FetchRejected(`orçamento de IA do mês atingido (US$ ${budget.spent.toFixed(2)} de ${budget.budget.toFixed(2)})`);

    const item = await buildManualItem(req, deps.fetchOptions);
    const { rows: src } = await pool.query<{ id: string }>(
      "select id from sources where brand_id = $1 and kind = 'manual' order by created_at limit 1",
      [req.brand_id],
    );
    if (!src[0]) throw new FetchRejected("fonte 'Envio manual' ausente (migration 20261117000002 não aplicada)");

    // Triagem síncrona com o mesmo prompt da coleta. O editor já decidiu que a pauta vale: "não relevante"
    // não descarta, só fica registrado; falha de triagem cai em other/info e o redator segue.
    const itemId = randomUUID();
    const cves = extractCves(item.title, item.text);
    const triageItem = { id: itemId, source_name: item.sourceLabel, title: item.title, summary: item.text, content_excerpt: null, published_at: item.publishedAt };
    const msg = await deps.client.messages.create(triageParams(deps.model, triageItem));
    await recordUsage(pool, deps.prices, { task: "triage", model: msg.model, usage: msg.usage, batch: false });
    const triage = parseTriageMessage(msg);
    const t = triage.ok ? triage.triage : null;
    const category = t?.category ?? "other";
    const severity = t?.severity ?? "info";
    const relevance = t?.relevance ?? 0.5;
    const allCves = [...new Set([...cves, ...(t?.entities.cves ?? [])])].sort();

    const client = await pool.connect();
    let storyId: string;
    try {
      await client.query("begin");
      await client.query(
        `insert into raw_items (id, source_id, url, canonical_url, url_hash, title, summary, content_excerpt, published_at,
                                lang, cve_ids, status, triage, category, severity, relevance, source_label)
         values ($1, $2, $3, $4, $5, $6, $7, null, $8, null, $9::text[], 'triaged', $10::jsonb, $11, $12, $13, $14)`,
        [itemId, src[0].id, item.url, item.canonical, sha256(`manual:${req.id}`), truncate(item.title, 300), item.text,
          item.publishedAt, allCves,
          JSON.stringify(t ? { ...t, model: msg.model, manual_request: req.id } : { manual_request: req.id, triage_error: triage.ok ? null : triage.reason }),
          category, severity, relevance, truncate(item.sourceLabel, 120)],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into stories (brand_id, cluster_id, status, score, category, severity, cve_ids)
         values ($1, null, 'DRAFTING', $2, $3, $4, $5::text[]) returning id`,
        [req.brand_id, Math.round(relevance * 10_000) / 100, category, severity, allCves],
      );
      storyId = rows[0]!.id;
      await client.query("insert into story_sources (story_id, raw_item_id) values ($1, $2)", [storyId, itemId]);
      await client.query("select pgmq.send('story_build', $1::jsonb)", [
        JSON.stringify({ v: 1, traceId: req.id, attempt: 1, payload: { story_id: storyId } }),
      ]);
      await client.query(
        "update manual_requests set status = 'done', story_id = $2, error = $3, updated_at = now() where id = $1",
        [req.id, storyId, t && !t.is_relevant ? `triagem considerou pouco relevante (${t.discard_reason ?? "sem motivo"}); gerada mesmo assim` : null],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    log.info({ ...ctx, storyId, category, severity, triage: triage.ok }, "manual story queued");
    return storyId;
  } catch (err) {
    const message = (err as Error).message;
    const permanent = err instanceof FetchRejected ? err.permanent : false;
    const giveUp = permanent || req.attempts >= MAX_ATTEMPTS;
    await finish(pool, req.id, giveUp ? "failed" : "pending", message);
    log[giveUp ? "warn" : "info"]({ ...ctx, err: message, giveUp }, "manual request not processed");
    return null;
  }
}
