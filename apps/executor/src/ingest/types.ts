import type { Lang } from "@ironnews/shared";

export type SourceKind = "rss" | "json_api" | "cisa_kev" | "nvd" | "github_advisory" | "ransomware_live";

export interface SourceRow {
  id: string;
  brand_id: string;
  name: string;
  kind: SourceKind;
  url: string;
  lang: Lang;
  trust_weight: number;
  fetch_interval_min: number;
  config: Record<string, unknown>;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
}

/** Item já normalizado pelo fetcher, antes de deduplicar e agrupar. */
export interface FetchedItem {
  url: string;
  title: string;
  summary: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  cves: string[];
  /** Sinais objetivos vindos da fonte (ex.: KEV ⇒ in_kev). Entram em clusters.flags. */
  flags?: { in_kev?: boolean; exploited?: boolean; brazil?: boolean };
}

export interface FetchResult {
  /** HTTP 304: nada mudou (RN-SRC02). */
  notModified: boolean;
  items: FetchedItem[];
  etag: string | null;
  lastModified: string | null;
}

export interface FetchContext {
  now: Date;
  nvdApiKey?: string;
  githubToken?: string;
}
