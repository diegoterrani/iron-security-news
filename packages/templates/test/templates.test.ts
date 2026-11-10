import { describe, expect, it } from "vitest";
import { IRON_MARK_DATA_URI, carouselCta, cover, pickAccent, type El, type StoryCreative } from "../src/index";

const s: StoryCreative = {
  lang: "pt", severity: "critical", category: "ransomware", cves: ["CVE-2026-1"], title: "Ransomware paralisa hospitais no Brasil",
  slug: "ransomware-paralisa-hospitais", logo: IRON_MARK_DATA_URI,
};

/** Todo o texto visível da árvore de elementos, na ordem. */
function texts(el: El | string): string[] {
  if (typeof el === "string") return [el];
  const ch = el.props.children;
  return (Array.isArray(ch) ? ch : ch === undefined ? [] : [ch]).flatMap((c) => texts(c as El | string));
}

describe("pickAccent (uma palavra em destaque, regra do kit)", () => {
  it("última palavra com 4+ letras; ignora pontuação e palavras curtas", () => {
    expect(pickAccent("Falha sshole no OpenSSH já é explorada")).toBe(6);
    expect(pickAccent("Quem é afetado")).toBe(2);
    expect(pickAccent("Ataque ao SUS em SP")).toBe(0);
  });
  it("aceita palavra escolhida", () => {
    expect(pickAccent("Leia a matéria completa no blog", "blog")).toBe(5);
  });
});

describe("templates", () => {
  it("severidade sempre escrita, nunca só cor; categoria e CVE presentes", () => {
    const t = texts(cover(s)).join(" ");
    expect(t).toContain("SEVERIDADE CRÍTICA");
    expect(t).toContain("RANSOMWARE");
    expect(t).toContain("CVE-2026-1");
  });
  it("EN usa os rótulos em inglês", () => {
    expect(texts(cover({ ...s, lang: "en" })).join(" ")).toContain("CRITICAL SEVERITY");
  });
  it("slide final traz o link do artigo (RN-RND02)", () => {
    expect(texts(carouselCta(s, 6)).join(" ")).toContain("news.iron-security.com/pt/ransomware-paralisa-hospitais");
  });
  it("logo embutido é um PNG", () => {
    expect(IRON_MARK_DATA_URI.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
  });
});
