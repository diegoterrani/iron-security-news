import { httpGet } from "../http";
import type { FetchContext, FetchResult, SourceKind, SourceRow } from "../types";
import { ghsaUrl, nvdUrl, parseGhsa, parseKev, parseNvd } from "./official";
import { parseRansomwareLive } from "./ransomware";
import { parseFeed } from "./rss";

/** Tipos de fonte com coletor implementado. `json_api` fica para depois. */
export const SUPPORTED_KINDS: SourceKind[] = ["rss", "cisa_kev", "nvd", "github_advisory", "ransomware_live"];

export async function fetchSource(src: SourceRow, ctx: FetchContext, fetchImpl?: typeof fetch): Promise<FetchResult> {
  switch (src.kind) {
    case "rss": {
      const r = await httpGet(src.url, { etag: src.etag, lastModified: src.last_modified, fetchImpl,
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } });
      return { notModified: r.status === 304, items: r.status === 304 ? [] : parseFeed(r.body, ctx), etag: r.etag, lastModified: r.lastModified };
    }
    case "cisa_kev": {
      const r = await httpGet(src.url, { etag: src.etag, lastModified: src.last_modified, fetchImpl, headers: { accept: "application/json" } });
      return { notModified: r.status === 304, items: r.status === 304 ? [] : parseKev(r.body, ctx), etag: r.etag, lastModified: r.lastModified };
    }
    case "nvd": {
      // Consulta por janela de tempo: não há fetch condicional.
      const headers: Record<string, string> = { accept: "application/json" };
      if (ctx.nvdApiKey) headers.apiKey = ctx.nvdApiKey;
      const r = await httpGet(nvdUrl(src.url, src.config, ctx.now), { headers, fetchImpl });
      return { notModified: false, items: parseNvd(r.body, ctx), etag: null, lastModified: null };
    }
    case "github_advisory": {
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
      if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
      const r = await httpGet(ghsaUrl(src.url, src.config), { headers, etag: src.etag, fetchImpl });
      return { notModified: r.status === 304, items: r.status === 304 ? [] : parseGhsa(r.body, ctx), etag: r.etag, lastModified: null };
    }
    case "ransomware_live": {
      // Resumo agregado do país, sem nomes de vítimas (ver fetchers/ransomware.ts).
      const r = await httpGet(src.url, { fetchImpl, headers: { accept: "application/json" } });
      return { notModified: false, items: parseRansomwareLive(r.body, src.config, ctx), etag: null, lastModified: null };
    }
    default:
      throw new Error(`tipo de fonte sem coletor: ${src.kind}`);
  }
}
