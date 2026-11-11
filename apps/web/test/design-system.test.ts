import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "../components/Icon";
import { dict } from "../lib/i18n";
import { articleJsonLd, homeJsonLd, jsonLdScript } from "../lib/structured-data";
import type { Article } from "../lib/blog";

/**
 * Conformidade com o design system da Iron Security nas páginas públicas.
 * Falha o build de CI se alguém reintroduzir sombra, raio, hex solto, outra fonte ou lucide.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** Remove comentários para que exemplos citados em texto não gerem falso positivo. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel, ext) : ext.test(name) ? [rel] : [];
  });
}

describe("CSS público (styles/blog.css)", () => {
  const css = stripComments(read("styles/blog.css"));

  it("não usa sombra", () => {
    expect(css).not.toMatch(/box-shadow|text-shadow|drop-shadow/);
  });

  it("não arredonda nada (raio 0)", () => {
    const radii = [...css.matchAll(/border-radius\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(radii.filter((r) => r !== "0")).toEqual([]);
  });

  it("não tem cor literal: só tokens de styles/brand/tokens.css", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
  });

  it("só usa Manrope e IBM Plex Mono (via --font-sans / --font-mono)", () => {
    const families = [...css.matchAll(/font-family\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    const shorthands = [...css.matchAll(/(?<![-\w])font\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    for (const f of families) expect(f).toMatch(/^var\(--font-(sans|mono)\)$/);
    for (const f of shorthands) expect(f).toMatch(/var\(--font-(sans|mono)\)$/);
  });

  it("usa a curva única do sistema em transições com easing", () => {
    expect(css).toContain("--ease: cubic-bezier(.215, .61, .355, 1)");
    expect(css).not.toMatch(/ease-in|ease-out|linear\b/);
  });
});

describe("tokens oficiais", () => {
  const tokens = read("styles/brand/tokens.css");

  it("é a cópia do site com origem declarada", () => {
    expect(tokens).toMatch(/CÓPIA LITERAL de diegoterrani\/IronSecurity-WebSite-New@[0-9a-f]{7}/);
  });

  it.each([
    ["--paper", "#090f0d"], ["--ink", "#050807"], ["--accent", "#6f9e89"], ["--accent-text", "#93bda9"],
    ["--teal", "#578b76"], ["--focus", "#a9e8ca"], ["--line", "#21352d"], ["--text", "#edf3ef"],
    ["--control-height", "48px"], ["--header-height", "84px"], ["--radius", "0"],
  ])("%s = %s", (name, value) => {
    expect(tokens).toContain(`${name}: ${value};`);
  });
});

describe("componentes públicos", () => {
  const publicFiles = [
    ...filesUnder("app/[lang]", /\.tsx?$/),
    ...filesUnder("components", /\.tsx$/),
  ];

  it("não usam lucide-react (só os ícones oficiais IRON)", () => {
    const offenders = publicFiles.filter((f) => /from "lucide-react"/.test(read(f)));
    expect(offenders.map((f) => relative(root, join(root, f)))).toEqual([]);
  });

  it("o sprite tem exatamente os 19 ícones IRON declarados", () => {
    const sprite = read("components/Icon.tsx");
    const ids = [...sprite.matchAll(/<symbol id="i-([a-z]+)"/g)].map((m) => m[1] ?? "");
    expect(ids.sort()).toEqual([...ICON_NAMES].sort());
    expect(ids).toHaveLength(19);
  });
});

describe("títulos com uma palavra de destaque", () => {
  it.each(["pt", "en"] as const)("%s: hero e h2 têm destaque não vazio", (lang) => {
    const t = dict[lang];
    for (const parts of [t.hero.title, t.feed.title, t.severity.title, t.coverage.title, t.method.title]) {
      expect(parts).toHaveLength(3);
      expect((parts[1] ?? "").trim().length).toBeGreaterThan(0);
      expect(parts[1]).not.toMatch(/\s/); // uma palavra só
    }
  });
});

describe("dados estruturados", () => {
  const base = "https://news.iron-security.com";
  const article: Article = {
    id: "1", cover_url: null, lang: "pt", slug: "teste", title: "Título </script><script>alert(1)</script>",
    tldr: "Resumo", category: "malware", severity: "high", cve_ids: ["CVE-2026-0001"], tags: ["x"],
    published_at: "2026-11-10T12:00:00Z", markdown: "", meta_description: "",
  };

  it("NewsArticle tem imagem padrão sem capa e dateModified", () => {
    const ld = articleJsonLd(article, base);
    expect(ld.image).toEqual([`${base}/og-default.png`]);
    expect(ld.dateModified).toBe(article.published_at);
  });

  it("NewsArticle usa a capa quando existe", () => {
    const ld = articleJsonLd({ ...article, cover_url: "https://cdn/x.png" }, base);
    expect(ld.image).toEqual(["https://cdn/x.png"]);
  });

  it("home publica Organization e WebSite ligados", () => {
    const ld = homeJsonLd(base, "en", "desc") as { "@graph": { "@type": string }[] };
    expect(ld["@graph"].map((n) => n["@type"])).toEqual(["Organization", "WebSite"]);
  });

  it("serialização não permite fechar o <script> (XSS)", () => {
    const out = jsonLdScript(articleJsonLd(article, base));
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(JSON.parse(out).headline).toBe(article.title);
  });
});
