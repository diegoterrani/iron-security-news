/**
 * Tokens do Brand Kit oficial (design-system.md do site www.iron-security.com, main@4375451):
 * só escuro, acento único verde-sálvia, raio 0, hairlines de 1 px, Manrope + IBM Plex Mono.
 * Proibido: superfície clara, neon, ciano/azul/roxo, gradiente colorido, glow, sombra, Inter.
 */
export const C = {
  ink: "#050807",
  paper: "#090f0d",
  soft: "#0d1713",
  surface: "#101e19",
  band: "#10251e",
  line: "#21352d",
  text: "#edf3ef",
  muted: "#a3b4ac",
  subtle: "#8a9d94",
  accent: "#6f9e89",
  accentText: "#93bda9",
  teal: "#578b76",
} as const;

/** Escala de risco do kit (preenchimento + tinta do texto). Sempre acompanhada da palavra do nível. */
export const RISK = {
  critical: { fill: "#c2413a", ink: "#f6b4ae" },
  high: { fill: "#b8662a", ink: "#f2c39b" },
  medium: { fill: "#a8862a", ink: "#ecd590" },
  low: { fill: "#4f7895", ink: "#b9d3e6" },
  info: { fill: "#4f6b74", ink: "#b7c9cf" },
} as const;

export type Severity = keyof typeof RISK;
export type Lang = "pt" | "en";

export const SEVERITY_WORD: Record<Lang, Record<Severity, string>> = {
  pt: { critical: "CRÍTICA", high: "ALTA", medium: "MÉDIA", low: "BAIXA", info: "INFORMATIVA" },
  en: { critical: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW", info: "INFO" },
};

export const CATEGORY_WORD: Record<Lang, Record<string, string>> = {
  pt: {
    ransomware: "RANSOMWARE", zero_day: "ZERO-DAY", vulnerability: "VULNERABILIDADE", data_breach: "VAZAMENTO DE DADOS",
    malware: "MALWARE", apt_campaign: "CAMPANHA APT", phishing_fraud: "PHISHING E FRAUDE", cloud_security: "NUVEM",
    regulation_privacy: "REGULAÇÃO E PRIVACIDADE", ai_security: "SEGURANÇA DE IA", supply_chain: "CADEIA DE SUPRIMENTOS", other: "CIBERSEGURANÇA",
  },
  en: {
    ransomware: "RANSOMWARE", zero_day: "ZERO-DAY", vulnerability: "VULNERABILITY", data_breach: "DATA BREACH",
    malware: "MALWARE", apt_campaign: "APT CAMPAIGN", phishing_fraud: "PHISHING & FRAUD", cloud_security: "CLOUD",
    regulation_privacy: "REGULATION & PRIVACY", ai_security: "AI SECURITY", supply_chain: "SUPPLY CHAIN", other: "CYBERSECURITY",
  },
};

export const SANS = "Manrope";
export const MONO = "IBM Plex Mono";
export const SITE = "news.iron-security.com";
