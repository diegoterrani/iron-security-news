import type { Lang } from "@ironnews/shared";
import type { Article } from "./blog";
import { HTML_LANG } from "./i18n";
import { IRON_LINKS } from "./links";

/** Imagem de compartilhamento padrão (1200×630, public/og-default.png) para páginas sem capa própria. */
export const DEFAULT_OG_IMAGE = { url: "/og-default.png", alt: "IRON CYBER NEWS · Iron Security" } as const;

type JsonLd = Record<string, unknown>;

/** Organização dona do blog; o mesmo @id é referenciado como author/publisher dos artigos. */
export function organizationJsonLd(base: string): JsonLd {
  return {
    "@type": "Organization",
    "@id": `${IRON_LINKS.site}/#organization`,
    name: "Iron Security",
    url: IRON_LINKS.site,
    logo: { "@type": "ImageObject", url: `${base}/brand/iron-mark.png` },
    email: IRON_LINKS.email,
    sameAs: [IRON_LINKS.site],
  };
}

/** Grafo da home: Organization + WebSite (um por idioma, ligados pelo publisher). */
export function homeJsonLd(base: string, lang: Lang, description: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationJsonLd(base),
      {
        "@type": "WebSite",
        "@id": `${base}/${lang}#website`,
        name: "IRON CYBER NEWS",
        url: `${base}/${lang}`,
        description,
        inLanguage: HTML_LANG[lang],
        publisher: { "@id": `${IRON_LINKS.site}/#organization` },
      },
    ],
  };
}

/** NewsArticle com imagem (capa ou padrão) e dateModified, campos recomendados pelo Google News. */
export function articleJsonLd(a: Article, base: string): JsonLd {
  const url = `${base}/${a.lang}/${a.slug}`;
  const org = organizationJsonLd(base);
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.title,
    description: a.meta_description || a.tldr,
    image: [a.cover_url ?? `${base}${DEFAULT_OG_IMAGE.url}`],
    datePublished: a.published_at,
    // A view pública não expõe data de edição; a publicação é a última versão aprovada.
    dateModified: a.published_at,
    inLanguage: HTML_LANG[a.lang],
    mainEntityOfPage: url,
    keywords: [...a.tags, ...a.cve_ids].join(", "),
    author: org,
    publisher: org,
    isPartOf: { "@id": `${base}/${a.lang}#website` },
  };
}

/**
 * Serializa JSON-LD para <script> inline sem permitir fuga do elemento: escapa "<" (impede
 * "</script>") e os separadores U+2028/U+2029, que quebram parsers JS antigos.
 */
export function jsonLdScript(data: JsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
