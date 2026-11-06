import { LANGS, type Category, type Lang, type Severity } from "@ironnews/shared";

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

export const HTML_LANG: Record<Lang, string> = { pt: "pt-BR", en: "en" };

type Dictionary = {
  meta: { description: string };
  nav: { latest: string; coverage: string; method: string; language: string };
  byline: string;
  hero: { eyebrow: string; title: string; subtitle: string };
  metrics: {
    sources: { label: string; hint: string };
    languages: { label: string; value: string; hint: string };
    review: { label: string; value: string; hint: string };
    data: { label: string; hint: string };
  };
  feed: { title: string; hint: string; emptyTitle: string; emptyText: string };
  severity: { title: string; labels: Record<Severity, string>; descriptions: Record<Severity, string> };
  coverage: { title: string; categories: Record<Category, string> };
  method: { title: string; steps: { title: string; text: string }[] };
  footer: { disclaimer: string; rights: string };
};

export const dict: Record<Lang, Dictionary> = {
  pt: {
    meta: { description: "Notícias de cibersegurança curadas pela Iron Security: incidentes, ameaças, zero-days e vulnerabilidades." },
    nav: { latest: "Últimas", coverage: "Cobertura", method: "Metodologia", language: "Idioma" },
    byline: "por Iron Security",
    hero: {
      eyebrow: "Threat intelligence diária",
      title: "Notícias de cibersegurança, verificadas e sem ruído",
      subtitle:
        "Incidentes, ransomware, zero-days e vulnerabilidades críticas, priorizados por severidade e checados contra fontes oficiais.",
    },
    metrics: {
      sources: { label: "Fontes curadas", hint: "Vendors, CERTs e órgãos oficiais" },
      languages: { label: "Idiomas", value: "PT · EN", hint: "Cada notícia em duas versões" },
      review: { label: "Revisão editorial", value: "Humana", hint: "Nada é publicado sem aprovação" },
      data: { label: "Dados técnicos", hint: "CVSS, EPSS e KEV de fonte oficial" },
    },
    feed: {
      title: "Últimas publicações",
      hint: "Atualizado diariamente",
      emptyTitle: "O primeiro boletim está a caminho",
      emptyText:
        "Estamos calibrando as fontes e a triagem. As publicações aparecerão aqui assim que forem aprovadas pela equipe editorial.",
    },
    severity: {
      title: "Escala de severidade",
      labels: { critical: "Crítica", high: "Alta", medium: "Média", low: "Baixa", info: "Informativa" },
      descriptions: {
        critical: "Exploração ativa ou impacto amplo imediato",
        high: "Risco elevado, correção prioritária",
        medium: "Exige atenção e planejamento",
        low: "Impacto limitado ou mitigado",
        info: "Contexto, tendências e regulação",
      },
    },
    coverage: {
      title: "Cobertura",
      categories: {
        ransomware: "Ransomware",
        zero_day: "Zero-day",
        vulnerability: "Vulnerabilidades",
        data_breach: "Vazamento de dados",
        malware: "Malware",
        apt_campaign: "Campanhas APT",
        phishing_fraud: "Phishing e fraude",
        cloud_security: "Segurança em nuvem",
        regulation_privacy: "Regulação e LGPD",
        ai_security: "Segurança de IA",
        supply_chain: "Cadeia de suprimentos",
        other: "Outros",
      },
    },
    method: {
      title: "Como produzimos",
      steps: [
        { title: "Coleta", text: "Feeds de vendors, CERTs, CISA KEV e NVD, com deduplicação." },
        { title: "Triagem", text: "Classificação por categoria, severidade e relevância." },
        { title: "Verificação", text: "CVE, CVSS, EPSS e KEV conferidos em fonte oficial." },
        { title: "Revisão", text: "Um editor aprova cada texto antes da publicação." },
      ],
    },
    footer: {
      disclaimer:
        "Conteúdo produzido com apoio de inteligência artificial e revisado por um editor humano antes da publicação. Dados técnicos (CVSS, EPSS, KEV) vêm de fontes oficiais.",
      rights: "Todos os direitos reservados.",
    },
  },
  en: {
    meta: { description: "Cybersecurity news curated by Iron Security: incidents, threats, zero-days and vulnerabilities." },
    nav: { latest: "Latest", coverage: "Coverage", method: "Methodology", language: "Language" },
    byline: "by Iron Security",
    hero: {
      eyebrow: "Daily threat intelligence",
      title: "Cybersecurity news, verified and noise-free",
      subtitle:
        "Incidents, ransomware, zero-days and critical vulnerabilities, ranked by severity and checked against official sources.",
    },
    metrics: {
      sources: { label: "Curated sources", hint: "Vendors, CERTs and official agencies" },
      languages: { label: "Languages", value: "PT · EN", hint: "Every story in two versions" },
      review: { label: "Editorial review", value: "Human", hint: "Nothing ships without approval" },
      data: { label: "Technical data", hint: "CVSS, EPSS and KEV from official sources" },
    },
    feed: {
      title: "Latest stories",
      hint: "Updated daily",
      emptyTitle: "The first briefing is on its way",
      emptyText:
        "We are calibrating sources and triage. Stories will show up here as soon as the editorial team approves them.",
    },
    severity: {
      title: "Severity scale",
      labels: { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" },
      descriptions: {
        critical: "Active exploitation or broad immediate impact",
        high: "Elevated risk, patch with priority",
        medium: "Needs attention and planning",
        low: "Limited or mitigated impact",
        info: "Context, trends and regulation",
      },
    },
    coverage: {
      title: "Coverage",
      categories: {
        ransomware: "Ransomware",
        zero_day: "Zero-day",
        vulnerability: "Vulnerabilities",
        data_breach: "Data breaches",
        malware: "Malware",
        apt_campaign: "APT campaigns",
        phishing_fraud: "Phishing & fraud",
        cloud_security: "Cloud security",
        regulation_privacy: "Regulation & privacy",
        ai_security: "AI security",
        supply_chain: "Supply chain",
        other: "Other",
      },
    },
    method: {
      title: "How we work",
      steps: [
        { title: "Collection", text: "Vendor, CERT, CISA KEV and NVD feeds, deduplicated." },
        { title: "Triage", text: "Ranked by category, severity and relevance." },
        { title: "Verification", text: "CVE, CVSS, EPSS and KEV checked at the official source." },
        { title: "Review", text: "An editor approves every story before it goes live." },
      ],
    },
    footer: {
      disclaimer:
        "Content produced with AI assistance and reviewed by a human editor before publication. Technical data (CVSS, EPSS, KEV) comes from official sources.",
      rights: "All rights reserved.",
    },
  },
};
