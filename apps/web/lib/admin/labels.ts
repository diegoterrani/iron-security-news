import type { Severity, StoryStatus } from "@ironnews/shared";

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Crítica", high: "Alta", medium: "Média", low: "Baixa", info: "Info",
};

export const STATUS_LABEL: Record<StoryStatus, string> = {
  DRAFTING: "Em produção", AWAITING_REVIEW: "Aguardando revisão", APPROVED: "Aprovada", SCHEDULED: "Agendada",
  PUBLISHING: "Publicando", PUBLISHED: "Publicada", PARTIAL: "Publicada parcialmente", REJECTED: "Rejeitada", FAILED: "Falhou",
};

export const CATEGORY_LABEL: Record<string, string> = {
  ransomware: "Ransomware", zero_day: "Zero-day", vulnerability: "Vulnerabilidade", data_breach: "Vazamento",
  malware: "Malware", apt_campaign: "Campanha APT", phishing_fraud: "Phishing/Fraude", cloud_security: "Nuvem",
  regulation_privacy: "Regulação/Privacidade", ai_security: "Segurança de IA", supply_chain: "Cadeia de suprimentos", other: "Outros",
};

export const CHANNEL_LABEL: Record<string, string> = {
  blog: "Blog", instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", youtube: "YouTube Shorts",
};

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
