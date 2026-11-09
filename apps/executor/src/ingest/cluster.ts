import type pg from "pg";
import { fromPgVector, toPgVector, updateCentroid } from "./embeddings";

/** Limiares do agrupamento (RN-ING05). Título só vale como fallback quando não há embedding. */
export const COSINE_MIN = 0.85;
export const TITLE_SIMILARITY_MIN = 0.45;
export const WINDOW_HOURS = 72;

export interface ClusterInput {
  brandId: string;
  title: string;
  cves: string[];
  trust: number;
  embedding: number[] | null;
  flags: Record<string, boolean>;
}

/** Só sinais verdadeiros entram em clusters.flags, para nunca apagar um `true` anterior. */
const trueFlags = (f: Record<string, boolean>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v === true));

/**
 * Coloca o item no cluster mais parecido das últimas 72 h (CVE em comum, cosseno ≥ 0,85 ou,
 * sem embeddings, título parecido) ou cria um cluster novo. Retorna o id do cluster.
 */
export async function assignCluster(db: pg.PoolClient | pg.Pool, it: ClusterInput): Promise<{ id: string; created: boolean }> {
  const vec = it.embedding ? toPgVector(it.embedding) : null;
  const { rows } = await db.query<{ id: string; item_count: number; centroid: string | null }>(
    `select id, item_count, centroid::text as centroid
       from clusters
      where brand_id = $1 and not blocked and last_seen_at > now() - make_interval(hours => $6)
        and ( cve_ids && $2::text[]
              or ($4::vector is not null and centroid is not null and 1 - (centroid <=> $4::vector) >= $5)
              or ($4::vector is null and similarity(title, $3) >= $7) )
      order by (cve_ids && $2::text[]) desc,
               coalesce(case when $4::vector is not null and centroid is not null then 1 - (centroid <=> $4::vector) end,
                        similarity(title, $3)) desc
      limit 1`,
    [it.brandId, it.cves, it.title, vec, COSINE_MIN, WINDOW_HOURS, TITLE_SIMILARITY_MIN],
  );

  const flags = JSON.stringify(trueFlags(it.flags));
  const hit = rows[0];
  if (!hit) {
    const ins = await db.query<{ id: string }>(
      `insert into clusters (brand_id, title, centroid, cve_ids, item_count, trust_max, flags)
       values ($1, $2, $3::vector, $4::text[], 1, $5, $6::jsonb) returning id`,
      [it.brandId, it.title, vec, it.cves, it.trust, flags],
    );
    return { id: ins.rows[0]!.id, created: true };
  }

  let centroid: string | null = null;
  if (it.embedding) {
    centroid = hit.centroid
      ? toPgVector(updateCentroid(fromPgVector(hit.centroid), hit.item_count, it.embedding))
      : vec;
  }
  await db.query(
    `update clusters
        set item_count = item_count + 1,
            last_seen_at = now(),
            cve_ids = array(select distinct unnest(cve_ids || $2::text[]) order by 1),
            trust_max = greatest(trust_max, $3),
            flags = flags || $4::jsonb,
            centroid = coalesce($5::vector, centroid)
      where id = $1`,
    [hit.id, it.cves, it.trust, flags, centroid],
  );
  return { id: hit.id, created: false };
}
