import { randomUUID } from "node:crypto";
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
}

/** RN-STO02: os N melhores, evitando duas stories da mesma categoria quando houver alternativa. */
export function pickClusters(cands: Candidate[], n: number, minScore: number): Candidate[] {
  const eligible = cands.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  const used = new Set<string>();
  for (const c of eligible) {
    if (picked.length >= n) break;
    if (!used.has(c.category ?? "other")) {
      picked.push(c);
      used.add(c.category ?? "other");
    }
  }
  for (const c of eligible) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

export async function loadSettings(pool: Pool, brandId: string): Promise<SelectionSettings> {
  const { rows } = await pool.query<SelectionSettings>(
    `select timezone, posts_per_day, lead_time_min, min_score::float8 as min_score, publish_times
       from settings where brand_id = $1`,
    [brandId],
  );
  if (!rows[0]) throw new Error("settings ausentes para a marca");
  return rows[0];
}

const MAX_SOURCES_PER_STORY = 6; // §9.1

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
    const claim = await client.query(
      "insert into scheduler_runs (job, run_key) values ('selection', $1) on conflict do nothing returning job",
      [clock.date],
    );
    if (!claim.rowCount) {
      await client.query("rollback");
      return null;
    }
    const { rows: cands } = await client.query<Candidate>(
      `select c.id, c.category, cluster_score(c)::float8 as score
         from clusters c
        where c.brand_id = $1 and not c.blocked and c.relevance_max > 0
          and c.last_seen_at > now() - interval '36 hours'
          and not exists (select 1 from stories st where st.cluster_id = c.id)
        order by score desc limit 50`,
      [brandId],
    );
    const picked = pickClusters(cands, s.posts_per_day, s.min_score);
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
