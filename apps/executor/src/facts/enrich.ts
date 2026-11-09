import type { Pool } from "../db";
import { httpGet } from "../ingest/http";

/** Fatos oficiais de uma CVE. Nunca vêm do LLM (RN-FG02). */
export interface CveFacts {
  exists: boolean;
  cvss?: { score: number; severity: string; version: string } | null;
  description?: string | null;
  published?: string | null;
  epss?: { score: number; percentile: number; date: string } | null;
  kev?: { in_kev: boolean; date_added?: string; due_date?: string; ransomware?: boolean } | null;
}
export type Facts = { cves: Record<string, CveFacts> };

const NVD = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const EPSS = "https://api.first.org/data/v1/epss";
const KEV = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const CACHE_HOURS = 24;
const MAX_CVES = 10;

interface NvdMetric { cvssData?: { baseScore?: number; baseSeverity?: string; version?: string } }
interface NvdCve {
  id: string;
  published?: string;
  descriptions?: { lang: string; value: string }[];
  metrics?: { cvssMetricV40?: NvdMetric[]; cvssMetricV31?: NvdMetric[]; cvssMetricV30?: NvdMetric[] };
}

export function parseNvdCve(json: string): Pick<CveFacts, "exists" | "cvss" | "description" | "published"> {
  const doc = JSON.parse(json) as { vulnerabilities?: { cve: NvdCve }[] };
  const cve = doc.vulnerabilities?.[0]?.cve;
  if (!cve) return { exists: false };
  const m = cve.metrics?.cvssMetricV31?.[0] ?? cve.metrics?.cvssMetricV30?.[0] ?? cve.metrics?.cvssMetricV40?.[0];
  const d = m?.cvssData;
  return {
    exists: true,
    cvss: d?.baseScore != null ? { score: d.baseScore, severity: (d.baseSeverity ?? "").toLowerCase(), version: d.version ?? "" } : null,
    description: cve.descriptions?.find((x) => x.lang === "en")?.value?.slice(0, 600) ?? null,
    published: cve.published ?? null,
  };
}

export function parseEpss(json: string): Record<string, CveFacts["epss"]> {
  const doc = JSON.parse(json) as { data?: { cve: string; epss: string; percentile: string; date: string }[] };
  return Object.fromEntries((doc.data ?? []).map((r) => [r.cve.toUpperCase(), { score: Number(r.epss), percentile: Number(r.percentile), date: r.date }]));
}

interface KevEntry { cveID: string; dateAdded?: string; dueDate?: string; knownRansomwareCampaignUse?: string }
let kevCache: { at: number; byCve: Map<string, KevEntry> } | null = null;

/** Catálogo KEV inteiro, baixado no máximo 1×/h (§8.7). */
async function kevIndex(fetchImpl?: typeof fetch): Promise<Map<string, KevEntry>> {
  if (kevCache && Date.now() - kevCache.at < 3_600_000) return kevCache.byCve;
  const r = await httpGet(KEV, { fetchImpl, headers: { accept: "application/json" } });
  const doc = JSON.parse(r.body) as { vulnerabilities?: KevEntry[] };
  kevCache = { at: Date.now(), byCve: new Map((doc.vulnerabilities ?? []).map((v) => [v.cveID.toUpperCase(), v])) };
  return kevCache.byCve;
}

/**
 * Fatos oficiais das CVEs (até 10), com cache de 24 h em cve_cache.
 * Falha de uma fonte (ex.: EPSS fora do ar) deixa o campo nulo; não derruba a geração.
 */
export async function enrichCves(pool: Pool, cves: string[], opts: { nvdApiKey?: string; fetchImpl?: typeof fetch } = {}): Promise<Facts> {
  const ids = [...new Set(cves.map((c) => c.toUpperCase()))].slice(0, MAX_CVES);
  const out: Facts = { cves: {} };
  if (ids.length === 0) return out;

  const cached = await pool.query<{ cve_id: string; nvd: CveFacts | null; epss: CveFacts["epss"]; kev: CveFacts["kev"]; exists_in_nvd: boolean }>(
    `select cve_id, nvd, epss, kev, exists_in_nvd from cve_cache
      where cve_id = any($1::text[]) and fetched_at > now() - make_interval(hours => $2)`,
    [ids, CACHE_HOURS],
  );
  for (const r of cached.rows) out.cves[r.cve_id] = { ...(r.nvd ?? {}), exists: r.exists_in_nvd, epss: r.epss, kev: r.kev };
  const missing = ids.filter((id) => !out.cves[id]);
  if (missing.length === 0) return out;

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.nvdApiKey) headers.apiKey = opts.nvdApiKey;
  let epss: Record<string, CveFacts["epss"]> = {};
  try {
    epss = parseEpss((await httpGet(`${EPSS}?cve=${missing.join(",")}`, { fetchImpl: opts.fetchImpl })).body);
  } catch { /* EPSS indisponível: segue sem */ }
  let kev: Map<string, KevEntry> | null = null;
  try {
    kev = await kevIndex(opts.fetchImpl);
  } catch { /* KEV indisponível: segue sem */ }

  for (const id of missing) {
    let nvd: ReturnType<typeof parseNvdCve> | null = null;
    try {
      nvd = parseNvdCve((await httpGet(`${NVD}?cveId=${encodeURIComponent(id)}`, { headers, fetchImpl: opts.fetchImpl })).body);
    } catch {
      nvd = null; // NVD fora do ar: não dá para afirmar que a CVE não existe; não grava cache
    }
    const k = kev?.get(id);
    const facts: CveFacts = {
      exists: nvd?.exists ?? true,
      cvss: nvd?.cvss ?? null,
      description: nvd?.description ?? null,
      published: nvd?.published ?? null,
      epss: epss[id] ?? null,
      kev: kev ? (k ? { in_kev: true, date_added: k.dateAdded, due_date: k.dueDate, ransomware: k.knownRansomwareCampaignUse === "Known" } : { in_kev: false }) : null,
    };
    out.cves[id] = facts;
    if (nvd) {
      const { epss: e, kev: kv, exists, ...nvdPart } = facts;
      await pool.query(
        `insert into cve_cache (cve_id, nvd, epss, kev, exists_in_nvd, fetched_at)
         values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, now())
         on conflict (cve_id) do update set nvd = excluded.nvd, epss = excluded.epss, kev = excluded.kev,
                                            exists_in_nvd = excluded.exists_in_nvd, fetched_at = now()`,
        [id, JSON.stringify(nvdPart), JSON.stringify(e), JSON.stringify(kv), exists],
      );
    }
    // NVD sem chave: 5 req/30 s. Espaça as consultas.
    if (!opts.nvdApiKey && missing.length > 1) await new Promise((r) => setTimeout(r, 6500));
  }
  return out;
}
