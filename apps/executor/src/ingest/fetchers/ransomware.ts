import type { FetchContext, FetchedItem } from "../types";

/**
 * ransomware.live (§4.1): resumo AGREGADO das vítimas de um país (padrão BR).
 *
 * Decisão editorial (Terrani, 12/11/2026): a fonte entra só com números e tendências. Nomes de
 * vítimas, domínios, descrições e links de vazamento NUNCA saem daqui: citar uma empresa como
 * vítima a partir de um site de extorsão tem risco jurídico (LGPD, difamação) e ajuda o criminoso.
 * Nomes de GRUPOS criminosos e setores podem aparecer, porque são o dado de inteligência.
 *
 * Gera no máximo UM item por dia (URL única por data), para virar pauta de tendência e não spam.
 */
interface Victim {
  country?: string;
  group?: string;
  group_name?: string;
  activity?: string;
  sector?: string;
  discovered?: string;
  attackdate?: string;
  published?: string;
}

const DAY = 86_400_000;
const top = (counts: Map<string, number>, n: number) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
/** Rótulo de grupo/setor: só texto curto e "limpo" (o conteúdo vem de terceiros). */
const label = (s: unknown) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N} .&/_-]/gu, "").trim().slice(0, 40) : "");

export function parseRansomwareLive(
  json: string,
  config: Record<string, unknown>,
  ctx: Pick<FetchContext, "now">,
): FetchedItem[] {
  const doc = JSON.parse(json) as unknown;
  const list = (Array.isArray(doc) ? doc : (doc as { victims?: unknown }).victims) as Victim[] | undefined;
  if (!Array.isArray(list)) throw new Error("formato ransomware.live inesperado");
  const country = typeof config.country === "string" && /^[A-Z]{2}$/.test(config.country) ? config.country : "BR";
  const minVictims = typeof config.min_victims === "number" && config.min_victims > 0 ? config.min_victims : 1;

  const now = ctx.now.getTime();
  const groups = new Map<string, number>();
  const sectors = new Map<string, number>();
  let week = 0;
  let day = 0;
  for (const v of list) {
    if ((v.country ?? "").toUpperCase() !== country) continue;
    const when = Date.parse(v.discovered ?? v.published ?? v.attackdate ?? "");
    if (!Number.isFinite(when) || when > now + DAY || when < now - 7 * DAY) continue;
    week++;
    if (when >= now - DAY) day++;
    const g = label(v.group ?? v.group_name);
    if (g) bump(groups, g);
    const s = label(v.activity ?? v.sector);
    if (s && !/^(not found|unknown|n\/a)$/i.test(s)) bump(sectors, s);
  }
  if (week < minVictims) return [];

  const date = new Date(now).toISOString().slice(0, 10);
  const fmt = (pairs: [string, number][]) => pairs.map(([k, n]) => `${k} (${n})`).join(", ");
  const topGroups = top(groups, 5);
  const topSectors = top(sectors, 5);
  const where = country === "BR" ? "no Brasil" : `em ${country}`;
  const lines = [
    `Vítimas de ransomware ${where} divulgadas em sites de vazamento: ${week} nos últimos 7 dias, ${day} nas últimas 24 horas (dados agregados do ransomware.live até ${date}).`,
    topGroups.length ? `Grupos mais ativos: ${fmt(topGroups)}.` : "",
    topSectors.length ? `Setores mais atingidos: ${fmt(topSectors)}.` : "",
    "Os nomes das organizações não são divulgados por este resumo: a reivindicação de um grupo criminoso não confirma o ataque.",
  ].filter(Boolean);

  return [{
    url: `https://www.ransomware.live/?pais=${country}&dia=${date}`,
    title: `Ransomware ${where}: ${week} vítimas divulgadas em 7 dias${topGroups[0] ? `, ${topGroups[0][0]} lidera` : ""}`,
    summary: lines[0]!,
    excerpt: lines.join("\n"),
    publishedAt: new Date(now),
    cves: [],
    flags: { brazil: country === "BR" },
  }];
}
