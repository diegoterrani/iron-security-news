import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { LANGS } from "@ironnews/shared";
import { HTML_LANG, dict, isLang } from "@/lib/i18n";
import { fontVars } from "@/lib/fonts";
import { indexable } from "@/lib/seo";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { IconSprite } from "@/components/Icon";
import { DEFAULT_OG_IMAGE } from "@/lib/structured-data";
// Só os tokens oficiais + o CSS público. O iron.css (legado) fica restrito ao /admin.
import "@/styles/brand/tokens.css";
import "@/styles/blog.css";

type Params = { params: Promise<{ lang: string }> };

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export const viewport: Viewport = { themeColor: "#090f0d" /* = --paper */, colorScheme: "dark" };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
    title: { default: "IRON CYBER NEWS", template: "%s · IRON CYBER NEWS" },
    description: dict[lang].meta.description,
    // Valores do layout valem para a home do idioma; a página de artigo sobrescreve canonical e OG.
    alternates: {
      canonical: `/${lang}`,
      languages: { "pt-BR": "/pt", en: "/en", "x-default": "/pt" },
      types: { "application/rss+xml": `/${lang}/rss.xml` },
    },
    openGraph: {
      type: "website",
      siteName: "IRON CYBER NEWS",
      locale: HTML_LANG[lang],
      url: `/${lang}`,
      title: "IRON CYBER NEWS",
      description: dict[lang].meta.description,
      images: [{ url: DEFAULT_OG_IMAGE.url, width: 1200, height: 630, alt: DEFAULT_OG_IMAGE.alt }],
    },
    twitter: { card: "summary_large_image", images: [DEFAULT_OG_IMAGE.url] },
    robots: indexable() ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function SiteLayout({ children, params }: Params & { children: ReactNode }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={HTML_LANG[lang]} className={fontVars}>
      <body>
        <IconSprite />
        <a className="skip-link" href="#content">
          {lang === "pt" ? "Pular para o conteúdo" : "Skip to content"}
        </a>
        <SiteHeader lang={lang} />
        {children}
        <SiteFooter lang={lang} />
      </body>
    </html>
  );
}
