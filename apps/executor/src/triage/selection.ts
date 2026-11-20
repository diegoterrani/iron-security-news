import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { fromPgVector } from "../ingest/embeddings";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import { budgetStatus } from "../llm/usage";
import { pendingItems, triageSync, type TriageDeps } from "./run";

export interface SelectionSettings {
  timezone: string;
  posts_per_day: number;
  lead_time_min: number;
  min_score: number;
  publish_times: Record<string, string[]>;
  realtime_enabled: boolean;
  realtime_min_score: number;
  max_posts_per_day: number;
  min_gap_min: number;
}

/** Data e minuto do dia no fuso da marca. */
export function localClock(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** RN-STO01: seleção = primeiro horário de publicação do dia − lead_time_min (mínimo 00:00). */
export function selectionMinute(s: Pick<SelectionSettings, "publish_times" | "lead_time_min">): number {
  const all = Object.values(s.publish_times).flat().filter((t) => /^\d{2}:\d{2}$/.test(t));
  const first = all.length ? Math.min(...all.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))) : 8 * 60;
  return Math.max(0, first - s.lead_time_min);
}

export interface Candidate {
  id: string;
  category: string | null;
  score: number;
  /** Centroide (texto do pgvector); usado só para evitar duas pautas do mesmo evento na mesma rodada. */
  centroid?: string | null;
}

/**
 * Cosseno a partir do qual dois clusters são o MESMO evento para efeito de pauta. Mais baixo que o do
 * agrupamento (0,85): o mesmo fato em EN/PT ou com outro ângulo fica entre 0,78 e 0,86, e eventos
 * diferentes ficam abaixo de 0,72. Medido em produção em 20/11/2026.
 */
export const DEDUP_COSINE = 0.8;
/** Uma story criada nesse prazo "cobre" o evento; clusters parecidos não viram nova story. */
const DEDUP_WINDOW_HOURS = 72;

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const parseVec = (c: Candidate) => (c.centroid ? fromPgVector(c.centroid) : null);

/** Condição SQL (sobre `c`): o cluster ainda não é coberto por uma story recente, nem por CVE nem por similaridade. */
const NOT_COVERED_BY_RECENT_STORY = `
  and not exists (
    select 1 from stories st join clusters sc on sc.id = st.cluster_id
     where st.brand_id = c.brand_id and st.status <> 'REJECTED' and sc.id <> c.id
       and st.created_at > now() - interval '${DEDUP_WINDOW_HOURS} hours'
       and (sc.cve_ids && c.cve_ids
            or (sc.centroid is not null and c.centroid is not null and 1 - (sc.centroid <=> c.centroid) >= ${DEDUP_COSINE})))`;

/** RN-STO02: os N melhores, evitando duas stories da mesma categoria quando houver alternativa. */
export function pickClusters(cands: Candidate[], n: number, minScore: number): Candidate[] {
  const eligible = cands.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  const vecs = new Map<Candidate, number[] | null>();
  const vec = (c: Candidate) => {
    if (!vecs.has(c)) vecs.set(c, parseVec(c));
    return vecs.get(c)!;
  };
  // Dois clusters do mesmo evento nunca entram juntos, nem na 2ª passada (que só relaxa a categoria).
  const sameEvent = (c: Candidate) => {
    const v = vec(c);
    return !!v && picked.some((p) => { const pv = vec(p); return !!pv && cosine(v, pv) >= DEDUP_COSINE; });
  };
  const used = new Set<string>();
  for (const c of eligible) {
    if (picked.length >= n) break;
    if (!used.has(c.category ?? "other") && !sameEvent(c)) {
      picked.push(c);
      used.add(c.category ?? "other");
    }
  }
  for (const c of eligible) {
    if (picked.length >= n) break;
    if (!picked.includes(c) && !sameEvent(c)) picked.push(c);
  }
  return picked;
}

export async function loadSettings(pool: Pool, brandId: string): Promise<SelectionSettings> {
  const { rows } = await pool.query<SelectionSettings>(
    `select timezone, posts_per_day, lead_time_min, min_score::float8 as min_score, publish_times,
            realtime_enabled, realtime_min_score::float8 as realtime_min_score, max_posts_per_day, min_gap_min
       from settings where brand_id = $1`,
    [brandId],
  );
  if (!rows[0]) throw new Error("settings ausentes para a marca");
  return rows[0];
}

const MAX_SOURCES_PER_STORY = 6; // §9.1

/** Serializa a seleção diária e a contínua: sem isso, as duas poderiam criar story para o mesmo cluster. */
const SELECTION_LOCK = "select pg_advisory_xact_lock(hashtext('ironnews-selection'))";

/** Cria a story (DRAFTING), liga as fontes e enfileira story_build. Chamar dentro de uma transação. */
async function createStories(client: PoolClient, brandId: string, picked: Candidate[]): Promise<string[]> {
  const storyIds: string[] = [];
  for (const c of picked) {
    const { rows } = await client.query<{ id: string }>(
      `insert into stories (brand_id, cluster_id, status, score, category, severity, cve_ids)
       select $1, c.id, 'DRAFTING', $3, coalesce(c.category, 'other'),
              coalesce((select r.severity from raw_items r
                         where r.cluster_id = c.id and r.status = 'triaged' and r.severity is not null
                         order by array_position(array['critical','high','medium','low','info']::severity[], r.severity)
                         limit 1), 'info'),
              c.cve_ids
         from clusters c where c.id = $2
       returning id`,
      [brandId, c.id, c.score],
    );
    const storyId = rows[0]!.id;
    await client.query(
      `insert into story_sources (story_id, raw_item_id)
       select $1, r.id from raw_items r join sources s on s.id = r.source_id
        where r.cluster_id = $2 and r.status = 'triaged'
        order by r.relevance desc nulls last, s.trust_weight desc, r.published_at desc nulls last
        limit $3`,
      [storyId, c.id, MAX_SOURCES_PER_STORY],
    );
    await client.query("update clusters set top_score = $2 where id = $1", [c.id, c.score]);
    const envelope = { v: 1, traceId: randomUUID(), attempt: 1, payload: { story_id: storyId } };
    await client.query("select pgmq.send('story_build', $1::jsonb)", [JSON.stringify(envelope)]);
    storyIds.push(storyId);
  }
  return storyIds;
}

/**
 * Roda a seleção do dia, uma única vez por data local (scheduler_runs garante idempotência).
 * Antes, faz a triagem síncrona do que ainda está pendente das últimas 36 h.
 */
export async function runSelectionIfDue(deps: TriageDeps & { log: Logger }, now = new Date()): Promise<string[] | null> {
  const { pool, log, brandId } = deps;
  const s = await loadSettings(pool, brandId);
  const clock = localClock(now, s.timezone);
  if (clock.minutes < selectionMinute(s)) return null;
  const already = await pool.query("select 1 from scheduler_runs where job = 'selection' and run_key = $1", [clock.date]);
  if (already.rowCount) return null;

  const budget = await budgetStatus(pool, brandId);
  if (budget.ratio >= 1) {
    await pool.query(
      "insert into scheduler_runs (job, run_key, detail) values ('selection', $1, $2::jsonb) on conflict do nothing",
      [clock.date, JSON.stringify({ skipped: "budget", spent: budget.spent, budget: budget.budget })],
    );
    log.error({ module: "selection", spent: budget.spent, budget: budget.budget }, "LLM budget reached; no stories today");
    return [];
  }

  const urgent = await pendingItems(pool, brandId, { sinceHours: 36, limit: 150 });
  if (urgent.length) {
    const r = await triageSync(deps, urgent);
    log.info({ module: "selection", ...r }, "urgent sync triage before selection");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(SELECTION_LOCK);
    const claim = await client.query(
      "insert into scheduler_runs (job, run_key) values ('selection', $1) on conflict do nothing returning job",
      [clock.date],
    );
    if (!claim.rowCount) {
      await client.query("rollback");
      return null;
    }
    const { rows: cands } = await client.query<Candidate>(
      `select c.id, c.category, cluster_score(c)::float8 as score, c.centroid::text as centroid
         from clusters c
        where c.brand_id = $1 and not c.blocked and c.relevance_max > 0
          and c.last_seen_at > now() - interval '36 hours'
          and not exists (select 1 from stories st where st.cluster_id = c.id)
          ${NOT_COVERED_BY_RECENT_STORY}
        order by score desc limit 50`,
      [brandId],
    );
    const picked = pickClusters(cands, s.posts_per_day, s.min_score);
    const storyIds = await createStories(client, brandId, picked);
    await client.query("update scheduler_runs set detail = $2::jsonb where job = 'selection' and run_key = $1", [
      clock.date,
      JSON.stringify({ candidates: cands.length, picked: picked.map((p) => ({ cluster: p.id, score: p.score, category: p.category })) }),
    ]);
    await client.query("commit");
    if (storyIds.length === 0) {
      // RN-STO03: sem pauta acima do min_score (alerta Telegram entra com o módulo de alertas).
      log.warn({ module: "selection", candidates: cands.length, minScore: s.min_score, best: cands[0]?.score ?? null }, "no candidates above min_score");
    } else {
      log.info({ module: "selection", stories: storyIds, scores: picked.map((p) => p.score) }, "daily selection done");
    }
    return storyIds;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface RealtimeGateInput {
  createdToday: number;
  maxPerDay: number;
  lastCreatedAt: Date | null;
  gapMin: number;
  now: Date;
}

/** Freios do modo contínuo: teto diário e intervalo mínimo entre stories. */
export function realtimeGate(i: RealtimeGateInput): { ok: true } | { ok: false; reason: "daily_cap" | "gap" } {
  if (i.createdToday >= i.maxPerDay) return { ok: false, reason: "daily_cap" };
  if (i.lastCreatedAt && i.now.getTime() - i.lastCreatedAt.getTime() < i.gapMin * 60_000) return { ok: false, reason: "gap" };
  return { ok: true };
}

/** Pautas urgentes só valem enquanto são recentes. */
const REALTIME_WINDOW_HOURS = 12;
/** Idade máxima da publicação original: a 1ª coleta de uma fonte nova traz itens velhos com last_seen_at = agora. */
const REALTIME_ARTICLE_MAX_HOURS = 24;
/** Itens frescos esperam a triagem em lote (até 10 min); no modo contínuo são triados na hora. */
const REALTIME_TRIAGE_HOURS = 3;
const REALTIME_TRIAGE_LIMIT = 40;

/**
 * Modo quase real-time: a cada minuto, triagem síncrona dos itens frescos e, se houver pauta com
 * score >= realtime_min_score, cria UMA story (respeitando teto diário e intervalo mínimo).
 * Complementa a seleção diária; fica desligado até settings.realtime_enabled.
 */
export async function runRealtimeSelection(deps: TriageDeps & { log: Logger }, now = new Date()): Promise<string[]> {
  const { pool, log, brandId } = deps;
  const s = await loadSettings(pool, brandId);
  if (!s.realtime_enabled) return [];

  const { rows: [stat] } = await pool.query<{ n: number; last: Date | null }>(
    `select count(*) filter (where status <> 'REJECTED')::int as n, max(created_at) as last
       from stories
      where brand_id = $1 and created_at >= (date_trunc('day', $3::timestamptz at time zone $2) at time zone $2)`,
    [brandId, s.timezone, now],
  );
  const gate = realtimeGate({ createdToday: stat!.n, maxPerDay: s.max_posts_per_day, lastCreatedAt: stat!.last, gapMin: s.min_gap_min, now });
  if (!gate.ok) {
    log.debug({ module: "realtime", reason: gate.reason }, "realtime selection gated");
    return [];
  }
  const budget = await budgetStatus(pool, brandId);
  if (budget.ratio >= 1) return [];

  const fresh = await pendingItems(pool, brandId, { sinceHours: REALTIME_TRIAGE_HOURS, limit: REALTIME_TRIAGE_LIMIT });
  if (fresh.length) {
    const r = await triageSync(deps, fresh);
    log.info({ module: "realtime", ...r }, "sync triage of fresh items");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(SELECTION_LOCK);
    const { rows: cands } = await client.query<Candidate>(
      `select c.id, c.category, cluster_score(c)::float8 as score, c.centroid::text as centroid
         from clusters c
        where c.brand_id = $1 and not c.blocked and c.relevance_max > 0
          and c.last_seen_at > now() - make_interval(hours => $2)
          and exists (select 1 from raw_items r
                       where r.cluster_id = c.id and coalesce(r.published_at, r.fetched_at) > now() - make_interval(hours => $3))
          and not exists (select 1 from stories st where st.cluster_id = c.id)
          ${NOT_COVERED_BY_RECENT_STORY}
          -- CVE só do NVD (sem imprensa, KEV ou alerta) só entra com sinal de urgência; senão espera a seleção diária.
          and (exists (select 1 from raw_items r join sources so on so.id = r.source_id
                        where r.cluster_id = c.id and so.kind <> 'nvd')
               or coalesce((c.flags->>'exploited')::boolean, false) or coalesce((c.flags->>'in_kev')::boolean, false)
               or coalesce((c.flags->>'zero_day')::boolean, false) or coalesce((c.flags->>'brazil')::boolean, false))
        order by score desc limit 20`,
      [brandId, REALTIME_WINDOW_HOURS, REALTIME_ARTICLE_MAX_HOURS],
    );
    const picked = pickClusters(cands, 1, s.realtime_min_score);
    if (picked.length === 0) {
      await client.query("rollback");
      return [];
    }
    const storyIds = await createStories(client, brandId, picked);
    await client.query("commit");
    log.info({ module: "realtime", stories: storyIds, score: picked[0]!.score, category: picked[0]!.category, today: stat!.n + 1 }, "realtime story created");
    return storyIds;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
