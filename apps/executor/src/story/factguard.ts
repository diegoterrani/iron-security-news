import type { Article } from "@ironnews/shared";
import type { Facts } from "../facts/enrich";
import { extractCves } from "../ingest/normalize";
import { PLACEHOLDER_RE } from "./placeholders";

export interface GuardSource {
  id: string;
  title: string;
  summary: string | null;
  excerpt: string | null;
}

export interface GuardIssue {
  rule: "FG01" | "FG02" | "FG03" | "FG04";
  detail: string;
}

const articleText = (a: Article) =>
  [a.pt.title, a.pt.tldr, a.pt.markdown, a.en.title, a.en.tldr, a.en.markdown].join("\n");

const sourceText = (sources: GuardSource[]) => sources.map((s) => [s.title, s.summary, s.excerpt].filter(Boolean).join("\n")).join("\n");

// ---------------------------------------------------------------------------
// Números (RN-FG04): normaliza "1,5 milhão", "1.5 million", "1,500,000", "1.5M", "US$ 2,5 mi" para valor.

const SCALE: [RegExp, number][] = [
  [/^(bilh(ão|ões|oes)|billions?|bi|b|bn)$/i, 1e9],
  [/^(milh(ão|ões|oes)|millions?|mi|m|mm)$/i, 1e6],
  [/^(mil|thousands?|k)$/i, 1e3],
];

/** Valores possíveis de um literal numérico (formatos PT e EN podem ser ambíguos, ex.: "1.500"). */
export function numberCandidates(raw: string): number[] {
  const s = raw.replace(/\s/g, "");
  const out = new Set<number>();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) out.add(Number(s.replace(/,/g, ""))); // EN milhar
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) out.add(Number(s.replace(/\./g, "").replace(",", "."))); // PT milhar
  if (/^\d+([.,]\d+)?$/.test(s)) out.add(Number(s.replace(",", "."))); // decimal simples
  return [...out].filter(Number.isFinite);
}

export interface NumberMention {
  text: string;
  values: number[];
  percent: boolean;
}

const NUM_RE =
  /(?<![\w.,/-])(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s?(%|por cento|percent)|\s?(bilh(?:ão|ões|oes)|billions?|milh(?:ão|ões|oes)|millions?|mil|thousands?|bn|mi|bi|[kKmMbB])\b)?/g;

/** Números "significativos" do texto: ignora anos, datas, versões, CVEs, URLs, placeholders e contagens < 10. */
export function extractNumbers(text: string): NumberMention[] {
  const clean = text
    .replace(PLACEHOLDER_RE, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(CVE|GHSA)-[\w-]+/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\bv?\d+(\.\d+){2,}\b/gi, " ") // versões x.y.z
    .replace(/^\s*\d+[.)]\s/gm, " "); // marcadores de lista numerada
  const out: NumberMention[] = [];
  for (const m of clean.matchAll(NUM_RE)) {
    const [whole, n, pct, scaleWord] = m;
    let scale = 1;
    if (scaleWord) scale = SCALE.find(([re]) => re.test(scaleWord))?.[1] ?? 1;
    const values = numberCandidates(n!).map((v) => v * scale);
    if (values.length === 0) continue;
    const percent = Boolean(pct);
    const base = numberCandidates(n!)[0]!;
    if (!percent && scale === 1 && (base < 10 || (Number.isInteger(base) && base >= 1990 && base <= 2100))) continue;
    out.push({ text: whole!.trim(), values, percent });
  }
  return out;
}

function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
  return rel < 0.005; // arredondamento ("1,5 milhão" vs "1.497.000" não passa; "1.5M" vs "1,500,000" passa)
}

// ---------------------------------------------------------------------------

/**
 * Fact Guard (§4.6). Devolve a lista de problemas; vazia = aprovado.
 * `facts` já deve conter todas as CVEs citadas no artigo (o build enriquece antes de chamar).
 */
export function factGuard(a: Article, facts: Facts, sources: GuardSource[], storyCves: string[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const text = articleText(a);
  const srcText = sourceText(sources);
  const srcIds = new Set(sources.map((s) => s.id));

  // FG01: CVE citada precisa existir no NVD e estar nas fontes/na story.
  const known = new Set([...storyCves.map((c) => c.toUpperCase()), ...extractCves(srcText)]);
  const cited = new Set([...extractCves(text), ...a.cves_mentioned.map((c) => c.toUpperCase())]);
  for (const cve of cited) {
    const f = facts.cves[cve];
    if (f && f.exists === false) issues.push({ rule: "FG01", detail: `${cve} não existe no NVD` });
    else if (!known.has(cve)) issues.push({ rule: "FG01", detail: `${cve} não aparece nas fontes` });
  }

  // FG02: valores oficiais só por placeholder.
  const noPlaceholders = text.replace(PLACEHOLDER_RE, " ");
  const scoreNear = /\b(CVSS|EPSS)\b(?:\s*v?\d(?:\.\d)?(?=\s))?[^\n{}]{0,30}?(?<![v.\d])(\d{1,2}[.,]\d{1,3})\s*(%|\/\s*10|\))?/gi;
  for (const m of noPlaceholders.matchAll(scoreNear)) {
    issues.push({ rule: "FG02", detail: `valor escrito à mão perto de ${m[1]!.toUpperCase()}: "${m[0].trim().slice(0, 60)}"` });
  }
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!facts.cves[m[2]!.toUpperCase()]) issues.push({ rule: "FG02", detail: `placeholder para CVE sem dados oficiais: ${m[0]}` });
  }

  // FG03: toda claim com fonte válida do cluster.
  for (const [i, c] of a.claims.entries()) {
    const valid = c.source_ids.filter((id) => srcIds.has(id));
    if (valid.length === 0) issues.push({ rule: "FG03", detail: `claim ${i + 1} sem fonte válida: "${c.text.slice(0, 80)}"` });
  }

  // FG04: números do texto precisam estar nas fontes.
  const srcNums = extractNumbers(srcText);
  const seen = new Set<string>();
  for (const n of extractNumbers(text)) {
    const key = `${n.percent}|${n.values.join("/")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = srcNums.some((s) => s.percent === n.percent && s.values.some((sv) => n.values.some((nv) => sameNumber(sv, nv))));
    if (!found) issues.push({ rule: "FG04", detail: `número "${n.text}" não encontrado nas fontes` });
  }
  return issues;
}
