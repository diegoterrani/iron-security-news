import type { Article } from "@ironnews/shared";
import { describe, expect, it } from "vitest";
import { parseEpss, parseNvdCve, type Facts } from "../src/facts/enrich";
import { coerceDerivatives, writerUserContent } from "../src/story/build";
import { extractNumbers, factGuard, numberCandidates } from "../src/story/factguard";
import { renderPlaceholders } from "../src/story/placeholders";
import { slugify } from "../src/story/slug";

const facts: Facts = {
  cves: {
    "CVE-2026-1000": {
      exists: true,
      cvss: { score: 9.8, severity: "critical", version: "3.1" },
      epss: { score: 0.1234, percentile: 0.9, date: "2026-11-09" },
      kev: { in_kev: true, date_added: "2026-11-06", due_date: "2026-11-27", ransomware: true },
    },
    "CVE-2026-2000": { exists: true, cvss: null, epss: null, kev: { in_kev: false } },
    "CVE-2026-9999": { exists: false },
  },
};

describe("placeholders (RN-FG02)", () => {
  it("PT e EN com formatação local", () => {
    const t = "CVSS {{cvss:CVE-2026-1000}}, EPSS {{epss:CVE-2026-1000}}, KEV: {{kev:CVE-2026-1000}}.";
    expect(renderPlaceholders(t, facts, "pt")).toBe(
      "CVSS 9,8 (Crítica), EPSS 12,3%, KEV: incluída no catálogo KEV da CISA em 06/11/2026 (prazo federal: 27/11/2026; uso conhecido em ransomware).",
    );
    expect(renderPlaceholders(t, facts, "en")).toBe(
      "CVSS 9.8 (Critical), EPSS 12.3%, KEV: added to CISA's KEV catalog on Nov 6, 2026 (federal due date: Nov 27, 2026; known ransomware use).",
    );
  });
  it("sem dado oficial vira 'não disponível'; fora do KEV é dito explicitamente", () => {
    expect(renderPlaceholders("{{cvss:CVE-2026-2000}} / {{kev:CVE-2026-2000}} / {{epss:CVE-2026-7777}}", facts, "pt"))
      .toBe("não disponível / não consta no catálogo KEV da CISA / não disponível");
  });
});

describe("números (RN-FG04)", () => {
  it("formatos PT e EN equivalentes", () => {
    expect(numberCandidates("1,500,000")).toEqual([1500000]);
    expect(numberCandidates("1.500.000")).toEqual([1500000]);
    expect(numberCandidates("1,5")).toEqual([1.5]);
    expect(numberCandidates("1.500").sort()).toEqual([1.5, 1500].sort());
  });
  it("extrai valores com escala e ignora anos, datas, versões, CVEs e contagens pequenas", () => {
    const n = extractNumbers("Em 2026, 1,5 milhão de pessoas e 37% dos clientes; versão 2.4.1; CVE-2026-1234; 3 ações; 06/11/2026; US$ 2,5 mi");
    expect(n.map((x) => x.text)).toEqual(["1,5 milhão", "37%", "2,5 mi"]);
    expect(n[0]!.values).toContain(1_500_000);
    expect(n[1]!.percent).toBe(true);
  });
});

const src = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Revolve puts breach victim count at 1.5 million",
    summary: "About 37% of customers affected. CVE-2026-1000 exploited.", excerpt: "Attackers stole $2.5 million." },
];
const md = (extra: string) => `## TL;DR\n${extra}\n` + "x ".repeat(800);
const lang = (extra: string) => ({ title: "Revolve confirma vazamento de dados de clientes", meta_description: "m".repeat(100), tldr: "t", markdown: md(extra), tags: ["a", "b", "c"] });
const article = (extraPt: string, extraEn = "", claims = [{ text: "c", source_ids: [src[0]!.id] }], cves: string[] = []): Article => ({
  pt: lang(extraPt), en: lang(extraEn), claims: [...claims, ...claims, ...claims], cves_mentioned: cves,
});

describe("factGuard (§4.6)", () => {
  it("aprova números presentes nas fontes em outro formato e CVE válida com placeholder", () => {
    const a = article("1,5 milhão de vítimas; 37% dos clientes; US$ 2,5 milhões; CVSS {{cvss:CVE-2026-1000}}",
      "1.5 million victims", undefined, ["CVE-2026-1000"]);
    expect(factGuard(a, facts, src, ["CVE-2026-1000"])).toEqual([]);
  });
  it("FG04: número inventado", () => {
    expect(factGuard(article("2 milhões de vítimas"), facts, src, []).map((i) => i.rule)).toEqual(["FG04"]);
  });
  it("FG01: CVE inexistente no NVD ou fora das fontes", () => {
    const r = factGuard(article("CVE-2026-9999 e CVE-2026-2000"), facts, src, []);
    expect(r).toEqual([
      { rule: "FG01", detail: "CVE-2026-9999 não existe no NVD" },
      { rule: "FG01", detail: "CVE-2026-2000 não aparece nas fontes" },
    ]);
  });
  it("FG02: CVSS escrito à mão; versão do CVSS não conta", () => {
    expect(factGuard(article("nota CVSS de 9.8"), facts, src, []).some((i) => i.rule === "FG02")).toBe(true);
    expect(factGuard(article("segundo o CVSS v3.1 {{cvss:CVE-2026-1000}}"), facts, src, ["CVE-2026-1000"]).filter((i) => i.rule === "FG02")).toEqual([]);
  });
  it("FG03: claim apontando para fonte fora do cluster", () => {
    const r = factGuard(article("ok", "", [{ text: "x", source_ids: ["22222222-2222-4222-8222-222222222222"] }]), facts, src, []);
    expect(r.filter((i) => i.rule === "FG03")).toHaveLength(3);
  });
});

describe("dados oficiais", () => {
  it("NVD: CVSS 3.1 e descrição; ausência = não existe", () => {
    const f = parseNvdCve(JSON.stringify({ vulnerabilities: [{ cve: { id: "CVE-2026-1", published: "2026-11-01T00:00:00",
      descriptions: [{ lang: "en", value: "RCE" }], metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.1, baseSeverity: "CRITICAL", version: "3.1" } }] } } }] }));
    expect(f).toMatchObject({ exists: true, cvss: { score: 9.1, severity: "critical" }, description: "RCE" });
    expect(parseNvdCve(JSON.stringify({ vulnerabilities: [] }))).toEqual({ exists: false });
  });
  it("EPSS", () => {
    expect(parseEpss(JSON.stringify({ data: [{ cve: "cve-2026-1", epss: "0.5", percentile: "0.99", date: "2026-11-09" }] })))
      .toEqual({ "CVE-2026-1": { score: 0.5, percentile: 0.99, date: "2026-11-09" } });
  });
});

describe("redação e derivados", () => {
  it("prompt do redator: fontes em <source>, fatos sem números oficiais, problemas anteriores", () => {
    const c = writerUserContent(
      [{ ...src[0]!, name: 'X "Y"', url: "https://e.com/a", published_at: null }],
      facts, { category: "data_breach", severity: "high" }, [{ rule: "FG04", detail: "número 7 não encontrado" }],
    );
    expect(c).toContain('<source id="11111111-1111-4111-8111-111111111111" name="X  Y" url="https://e.com/a">');
    expect(c).not.toContain("9.8");
    expect(c).not.toContain("0.1234");
    expect(c).toContain("<issues>");
  });
  it("hashtags sem acento/espaço e listas cortadas", () => {
    const d = coerceDerivatives({ instagram: { hashtags: ["#Segurança", "Ransomware", "#ciber segurança", "#Segurança"], slides: [] }, linkedin: { hashtags: ["#A", "#B"] } }) as any;
    expect(d.instagram.hashtags).toEqual(["#Seguranca", "#Ransomware", "#ciberseguranca"]);
  });
  it("slug", () => {
    expect(slugify("Falha crítica no Windows: 1,5 mi afetados!")).toBe("falha-critica-no-windows-1-5-mi-afetados");
    expect(slugify("x".repeat(30) + " " + "y".repeat(60)).length).toBeLessThanOrEqual(80);
    expect(slugify("!!!")).toBe("noticia");
  });
});
