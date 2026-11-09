import type { Pool } from "../db";
import type { Logger } from "../logger";
import { assignCluster } from "./cluster";
import type { Embedder } from "./embeddings";
import { toPgVector } from "./embeddings";
import { SUPPORTED_KINDS, fetchSource } from "./fetchers";
import { canonicalUrl, isTooOld, sha256 } from "./normalize";
import type { FetchContext, FetchedItem, SourceRow } from "./types";

/** 5 falhas seguidas desativam a fonte (RN-SRC03). */
export const MAX_CONSECUTIVE_FAILURES = 5;
const SOURCES_PER_RUN = 6;
const CONCURRENCY = 3;

export interface IngestDeps {
  pool: Pool;
  log: Logger;
  brandId: string;
  embed: Embedder | null;
  ctx: Omit<FetchContext, "now">;
  fetchImpl?: typeof fetch;
}

export interface SourceRunResult {
  sourceId: string;
  name: string;
  ok: boolean;
  notModified?: boolean;
  fetched: number;
  inserted: number;
  newClusters: number;
  disabled?: boolean;
  error?: string;
}

/** Fontes ativas, de tipo suportado, cujo intervalo já venceu (mais atrasadas primeiro). */
export async function dueSources(pool: Pool, brandId: string, limit = SOURCES_PER_RUN): Promise<SourceRow[]> {
  const { rows } = await pool.query<SourceRow>(
    `select id, brand_id, name, kind, url, lang, trust_weight::float8 as trust_weight, fetch_interval_min,
            config, etag, last_modified, consecutive_failures
       from sources
      where brand_id = $1 and enabled and kind = any($2::source_kind[])
        and (last_fetched_at is null or last_fetched_at + make_interval(mins => fetch_interval_min) <= now())
      order by last_fetched_at asc nulls first
      limit $3`,
    [brandId, SUPPORTED_KINDS, limit],
  );
  return rows;
}

/** Roda um ciclo de coleta. Chamado pelo cron a cada minuto (com `protect`, sem sobreposição). */
export async function ingestDue(deps: IngestDeps): Promise<SourceRunResult[]> {
  const sources = await dueSources(deps.pool, deps.brandId);
  const results: SourceRunResult[] = [];
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(sources.slice(i, i + CONCURRENCY).map((s) => ingestSource(deps, s)))));
  }
  return results;
}

export async function ingestSource(deps: IngestDeps, src: SourceRow): Promise<SourceRunResult> {
  const { pool, log } = deps;
  const base = { sourceId: src.id, name: src.name, fetched: 0, inserted: 0, newClusters: 0 };
  const started = Date.now();
  try {
    const now = new Date();
    const res = await fetchSource(src, { ...deps.ctx, now }, deps.fetchImpl);
    const fresh = res.items.filter((it) => !isTooOld(it.publishedAt, now));
    const inserted = await insertItems(pool, src, fresh);
    const newClusters = await clusterItems(deps, src, inserted);

    await pool.query(
      `update sources set etag = coalesce($2, etag), last_modified = coalesce($3, last_modified),
              last_fetched_at = now(), last_error = null, consecutive_failures = 0
        where id = $1`,
      [src.id, res.etag, res.lastModified],
    );
    const r = { ...base, ok: true, notModified: res.notModified, fetched: res.items.length, inserted: inserted.length, newClusters };
    log.info({ module: "ingest", source: src.name, ...r, durationMs: Date.now() - started }, "source ingested");
    return r;
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    const { rows } = await pool.query<{ enabled: boolean; consecutive_failures: number }>(
      `update sources set last_fetched_at = now(), last_error = $2,
              consecutive_failures = consecutive_failures + 1,
              enabled = enabled and consecutive_failures + 1 < $3
        where id = $1 returning enabled, consecutive_failures`,
      [src.id, error, MAX_CONSECUTIVE_FAILURES],
    );
    const disabled = rows[0]?.enabled === false;
    log[disabled ? "error" : "warn"](
      { module: "ingest", source: src.name, err: error, failures: rows[0]?.consecutive_failures, disabled },
      disabled ? "source disabled after consecutive failures" : "source fetch failed",
    );
    return { ...base, ok: false, error, disabled };
  }
}

interface InsertedItem {
  id: string;
  item: FetchedItem;
}

/** Deduplica por url_hash (RN-ING01) e devolve só os itens realmente novos. */
async function insertItems(pool: Pool, src: SourceRow, items: FetchedItem[]): Promise<InsertedItem[]> {
  const out: InsertedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let canonical: string;
    try {
      canonical = canonicalUrl(item.url);
    } catch {
      continue;
    }
    const hash = sha256(canonical);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const { rows } = await pool.query<{ id: string }>(
      `insert into raw_items (source_id, url, canonical_url, url_hash, title, summary, content_excerpt,
                              published_at, lang, cve_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[])
       on conflict (url_hash) do nothing returning id`,
      [src.id, item.url, canonical, hash, item.title, item.summary, item.excerpt, item.publishedAt, src.lang, item.cves],
    );
    if (rows[0]) out.push({ id: rows[0].id, item });
  }
  return out;
}

async function clusterItems(deps: IngestDeps, src: SourceRow, inserted: InsertedItem[]): Promise<number> {
  if (inserted.length === 0) return 0;
  let vectors: (number[] | null)[] = inserted.map(() => null);
  if (deps.embed) {
    try {
      vectors = await deps.embed(inserted.map(({ item }) => `${item.title}\n${item.summary ?? ""}`.slice(0, 2000)));
    } catch (err) {
      // Sem embedding o item ainda é agrupado por CVE/título; não perde a coleta.
      deps.log.warn({ module: "ingest", source: src.name, err: (err as Error).message }, "embeddings failed");
    }
  }
  let created = 0;
  for (const [i, { id, item }] of inserted.entries()) {
    const embedding = vectors[i] ?? null;
    const cluster = await assignCluster(deps.pool, {
      brandId: deps.brandId,
      title: item.title,
      cves: item.cves,
      trust: src.trust_weight,
      embedding,
      flags: { ...item.flags },
    });
    if (cluster.created) created++;
    await deps.pool.query(
      "update raw_items set cluster_id = $2, embedding = $3::vector where id = $1",
      [id, cluster.id, embedding ? toPgVector(embedding) : null],
    );
  }
  return created;
}

/** Retenção (RN-ING06): itens sem story são apagados após 90 dias. */
export async function purgeOldItems(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from raw_items r
      where r.fetched_at < now() - interval '90 days'
        and not exists (select 1 from story_sources ss where ss.raw_item_id = r.id)`,
  );
  return rowCount ?? 0;
}
