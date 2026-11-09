import type { Lang } from "@ironnews/shared";
import type { Facts } from "../facts/enrich";

export const PLACEHOLDER_RE = /\{\{(cvss|epss|kev):(CVE-\d{4}-\d{4,7})\}\}/gi;

const SEV: Record<Lang, Record<string, string>> = {
  pt: { critical: "Crítica", high: "Alta", medium: "Média", low: "Baixa", none: "Nenhuma" },
  en: { critical: "Critical", high: "High", medium: "Medium", low: "Low", none: "None" },
};
const NA: Record<Lang, string> = { pt: "não disponível", en: "not available" };

const num = (n: number, lang: Lang, digits = 1) =>
  n.toLocaleString(lang === "pt" ? "pt-BR" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "2026-11-06" → "06/11/2026" (PT) ou "Nov 6, 2026" (EN). */
function date(iso: string | undefined, lang: Lang): string {
  if (!iso) return NA[lang];
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return NA[lang];
  return lang === "pt"
    ? d.toLocaleDateString("pt-BR", { timeZone: "UTC" })
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** Valor oficial para um placeholder (RN-FG02). */
export function renderPlaceholder(kind: string, cve: string, facts: Facts, lang: Lang): string {
  const f = facts.cves[cve.toUpperCase()];
  switch (kind.toLowerCase()) {
    case "cvss":
      return f?.cvss ? `${num(f.cvss.score, lang)} (${SEV[lang][f.cvss.severity] ?? f.cvss.severity})` : NA[lang];
    case "epss":
      return f?.epss ? `${num(f.epss.score * 100, lang)}%` : NA[lang];
    case "kev": {
      const k = f?.kev;
      if (!k) return NA[lang];
      if (!k.in_kev) return lang === "pt" ? "não consta no catálogo KEV da CISA" : "not listed in CISA's KEV catalog";
      const ransom = k.ransomware ? (lang === "pt" ? "; uso conhecido em ransomware" : "; known ransomware use") : "";
      return lang === "pt"
        ? `incluída no catálogo KEV da CISA em ${date(k.date_added, lang)} (prazo federal: ${date(k.due_date, lang)}${ransom})`
        : `added to CISA's KEV catalog on ${date(k.date_added, lang)} (federal due date: ${date(k.due_date, lang)}${ransom})`;
    }
    default:
      return NA[lang];
  }
}

export function renderPlaceholders(text: string, facts: Facts, lang: Lang): string {
  return text.replace(PLACEHOLDER_RE, (_m, kind: string, cve: string) => renderPlaceholder(kind, cve, facts, lang));
}
