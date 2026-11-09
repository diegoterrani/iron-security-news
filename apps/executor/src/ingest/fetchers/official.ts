import { EXCERPT_MAX, MAX_ITEM_AGE_DAYS, cleanText, extractCves, parseDate, truncate } from "../normalize";
import type { FetchContext, FetchedItem } from "../types";

// ---------------------------------------------------------------------------
// CISA KEV (catálogo JSON completo; só entra o que foi adicionado nos últimos 7 dias)
interface KevEntry {
  cveID: string;
  vendorProject?: string;
  product?: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  shortDescription?: string;
  requiredAction?: string;
  dueDate?: string;
  knownRansomwareCampaignUse?: string;
}

export function parseKev(json: string, ctx: Pick<FetchContext, "now">): FetchedItem[] {
  const doc = JSON.parse(json) as { vulnerabilities?: KevEntry[] };
  if (!Array.isArray(doc.vulnerabilities)) throw new Error("formato KEV inesperado");
  const minTime = ctx.now.getTime() - MAX_ITEM_AGE_DAYS * 86_400_000;
  const out: FetchedItem[] = [];
  for (const v of doc.vulnerabilities) {
    if (!/^CVE-\d{4}-\d{4,7}$/.test(v.cveID ?? "")) continue;
    const added = parseDate(v.dateAdded ? `${v.dateAdded}T00:00:00Z` : null, ctx.now);
    if (!added || added.getTime() < minTime) continue;
    const name = cleanText(v.vulnerabilityName) || `${v.vendorProject ?? ""} ${v.product ?? ""}`.trim();
    const ransomware = v.knownRansomwareCampaignUse === "Known";
    const excerpt = [
      cleanText(v.shortDescription),
      v.requiredAction ? `Required action: ${cleanText(v.requiredAction)}` : "",
      v.dueDate ? `Federal due date: ${v.dueDate}` : "",
      ransomware ? "Known to be used in ransomware campaigns." : "",
    ].filter(Boolean).join("\n");
    out.push({
      // Fragmento some na canonicalização; a query mantém uma URL única por CVE.
      url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${v.cveID}`,
      title: truncate(`CISA adds ${v.cveID} to KEV: ${name}`, 300),
      summary: truncate(cleanText(v.shortDescription), 500) || null,
      excerpt: truncate(excerpt, EXCERPT_MAX) || null,
      publishedAt: added,
      cves: [v.cveID],
      flags: { in_kev: true, exploited: true },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// NVD API 2.0 (CVEs publicadas na janela configurada, filtradas por severidade CVSS v3)
interface NvdCve {
  id: string;
  published?: string;
  descriptions?: { lang: string; value: string }[];
  metrics?: { cvssMetricV31?: { cvssData?: { baseScore?: number; baseSeverity?: string } }[] };
  cisaExploitAdd?: string;
}

export function nvdUrl(base: string, config: Record<string, unknown>, now: Date): string {
  const hours = Number(config.windowHours ?? 24);
  const start = new Date(now.getTime() - Math.min(Math.max(hours, 1), 168) * 3_600_000);
  const u = new URL(base);
  u.searchParams.set("pubStartDate", start.toISOString());
  u.searchParams.set("pubEndDate", now.toISOString());
  if (typeof config.cvssV3Severity === "string") u.searchParams.set("cvssV3Severity", config.cvssV3Severity);
  u.searchParams.set("resultsPerPage", "100");
  return u.toString();
}

export function parseNvd(json: string, ctx: Pick<FetchContext, "now">): FetchedItem[] {
  const doc = JSON.parse(json) as { vulnerabilities?: { cve: NvdCve }[] };
  if (!Array.isArray(doc.vulnerabilities)) throw new Error("formato NVD inesperado");
  return doc.vulnerabilities.flatMap(({ cve }) => {
    if (!cve?.id) return [];
    const desc = cleanText(cve.descriptions?.find((d) => d.lang === "en")?.value);
    const m = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
    const first = desc.split(/(?<=\.)\s/)[0] ?? desc;
    return [{
      url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
      title: truncate(`${cve.id}${m?.baseSeverity ? ` (${m.baseSeverity})` : ""}: ${first}`, 300),
      summary: truncate(desc, 500) || null,
      excerpt: truncate(desc, EXCERPT_MAX) || null,
      publishedAt: parseDate(cve.published ? `${cve.published.replace(/Z?$/, "Z")}` : null, ctx.now),
      cves: [cve.id, ...extractCves(desc).filter((c) => c !== cve.id)],
      flags: cve.cisaExploitAdd ? { in_kev: true, exploited: true } : undefined,
    }];
  });
}

// ---------------------------------------------------------------------------
// GitHub Security Advisories (REST /advisories, revisadas)
interface Ghsa {
  ghsa_id: string;
  cve_id: string | null;
  html_url: string;
  summary?: string;
  description?: string;
  published_at?: string;
  severity?: string;
  vulnerabilities?: { package?: { ecosystem?: string; name?: string } }[];
}

export function ghsaUrl(base: string, config: Record<string, unknown>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(config)) if (typeof v === "string") u.searchParams.set(k, v);
  u.searchParams.set("per_page", "50");
  u.searchParams.set("sort", "published");
  u.searchParams.set("direction", "desc");
  return u.toString();
}

export function parseGhsa(json: string, ctx: Pick<FetchContext, "now">): FetchedItem[] {
  const doc = JSON.parse(json) as Ghsa[];
  if (!Array.isArray(doc)) throw new Error("formato GitHub Advisories inesperado");
  return doc.flatMap((a) => {
    if (!a.html_url || !a.summary) return [];
    const pkgs = (a.vulnerabilities ?? [])
      .map((v) => (v.package?.name ? `${v.package.ecosystem ?? ""}:${v.package.name}` : ""))
      .filter(Boolean).slice(0, 5).join(", ");
    const desc = cleanText(a.description);
    return [{
      url: a.html_url,
      title: truncate(`${a.cve_id ?? a.ghsa_id}: ${cleanText(a.summary)}`, 300),
      summary: truncate(desc, 500) || null,
      excerpt: truncate([pkgs ? `Affected packages: ${pkgs}` : "", desc].filter(Boolean).join("\n"), EXCERPT_MAX) || null,
      publishedAt: parseDate(a.published_at, ctx.now),
      cves: [...new Set([...(a.cve_id ? [a.cve_id] : []), ...extractCves(desc)])],
    }];
  });
}
