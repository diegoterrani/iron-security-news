/**
 * Teste a seco das fontes (RN-SRC05): busca e interpreta cada fonte, SEM gravar nada.
 * Uso no container:  node dist/test-sources.js [--all] [nome-parcial]
 *   --all  inclui fontes desativadas (todas começam desativadas no seed)
 */
import { loadConfig } from "./config";
import { createPool } from "./db";
import { SUPPORTED_KINDS, fetchSource } from "./ingest/fetchers";
import { isTooOld } from "./ingest/normalize";
import type { SourceRow } from "./ingest/types";

const args = process.argv.slice(2);
const all = args.includes("--all");
const filter = args.find((a) => !a.startsWith("--"))?.toLowerCase();

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

const { rows } = await pool.query<SourceRow & { enabled: boolean }>(
  `select s.id, s.brand_id, s.name, s.kind, s.url, s.lang, s.trust_weight::float8 as trust_weight,
          s.fetch_interval_min, s.config, null::text as etag, null::text as last_modified, s.consecutive_failures, s.enabled
     from sources s join brands b on b.id = s.brand_id
    where b.slug = $1 ${all ? "" : "and s.enabled"}
    order by s.name`,
  [config.BRAND_SLUG],
);
await pool.end();

const now = new Date();
let failures = 0;
for (const src of rows.filter((s) => !filter || s.name.toLowerCase().includes(filter))) {
  const tag = `${src.enabled ? "on " : "off"} ${src.name} [${src.kind}]`;
  if (!SUPPORTED_KINDS.includes(src.kind)) {
    console.log(`SKIP ${tag}: tipo ainda sem coletor`);
    continue;
  }
  const t0 = Date.now();
  try {
    const r = await fetchSource(src, { now, nvdApiKey: config.NVD_API_KEY, githubToken: config.GITHUB_TOKEN });
    const fresh = r.items.filter((i) => !isTooOld(i.publishedAt, now));
    const noDate = r.items.filter((i) => !i.publishedAt).length;
    console.log(`OK   ${tag}: ${r.items.length} itens, ${fresh.length} dos últimos 7 dias, ${noDate} sem data (${Date.now() - t0} ms)`);
    for (const i of fresh.slice(0, 2)) console.log(`       - ${i.publishedAt?.toISOString().slice(0, 10) ?? "????-??-??"} ${i.title.slice(0, 110)}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${tag}: ${(err as Error).message}`);
  }
}
process.exit(failures ? 1 : 0);
