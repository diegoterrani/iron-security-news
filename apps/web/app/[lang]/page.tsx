import { notFound } from "next/navigation";
import { LANGS, type Lang } from "@ironnews/shared";

const copy: Record<Lang, { tagline: string; soon: string; disclaimer: string }> = {
  pt: {
    tagline: "Notícias de cibersegurança: incidentes, ameaças, zero-days e vulnerabilidades.",
    soon: "Em breve.",
    disclaimer:
      "Conteúdo produzido com apoio de inteligência artificial e revisado por um editor humano antes da publicação. Dados técnicos (CVSS, EPSS, KEV) vêm de fontes oficiais.",
  },
  en: {
    tagline: "Cybersecurity news: incidents, threats, zero-days and vulnerabilities.",
    soon: "Coming soon.",
    disclaimer:
      "Content produced with AI assistance and reviewed by a human editor before publication. Technical data (CVSS, EPSS, KEV) comes from official sources.",
  },
};

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!(LANGS as readonly string[]).includes(lang)) notFound();
  const t = copy[lang as Lang];
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 16px" }}>
      <h1 style={{ fontSize: 32, margin: 0 }}>IRON CYBER NEWS</h1>
      <p style={{ opacity: 0.85 }}>{t.tagline}</p>
      <p>{t.soon}</p>
      <nav style={{ display: "flex", gap: 12 }}>
        <a href="/pt" style={{ color: "#58A6FF" }}>PT</a>
        <a href="/en" style={{ color: "#58A6FF" }}>EN</a>
      </nav>
      <footer style={{ marginTop: 48, fontSize: 13, opacity: 0.7 }}>{t.disclaimer}</footer>
    </main>
  );
}
