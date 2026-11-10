import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { LANGS } from "@ironnews/shared";
import { HTML_LANG, dict, isLang } from "@/lib/i18n";
import { fontVars } from "@/lib/fonts";
import { indexable } from "@/lib/seo";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import "../iron.css";

type Params = { params: Promise<{ lang: string }> };

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export const viewport: Viewport = { themeColor: "#090f0d", colorScheme: "dark" };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
    title: { default: "IRON CYBER NEWS", template: "%s · IRON CYBER NEWS" },
    description: dict[lang].meta.description,
    alternates: {
      languages: { "pt-BR": "/pt", en: "/en" },
      types: { "application/rss+xml": `/${lang}/rss.xml` },
    },
    robots: indexable() ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function SiteLayout({ children, params }: Params & { children: ReactNode }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={HTML_LANG[lang]} className={fontVars}>
      <body>
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
