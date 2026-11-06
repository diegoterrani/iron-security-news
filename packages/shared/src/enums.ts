export const LANGS = ["pt", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const CHANNELS = ["blog", "instagram", "facebook", "linkedin", "youtube"] as const;
export type Channel = (typeof CHANNELS)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STORY_STATUSES = [
  "DRAFTING", "AWAITING_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHING",
  "PUBLISHED", "PARTIAL", "REJECTED", "FAILED",
] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export const CATEGORIES = [
  "ransomware", "zero_day", "vulnerability", "data_breach", "malware", "apt_campaign",
  "phishing_fraud", "cloud_security", "regulation_privacy", "ai_security", "supply_chain", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const QUEUES = ["triage", "story_build", "render", "video", "video_events", "publish", "dlq"] as const;
export type QueueName = (typeof QUEUES)[number];

/** Cores fixas do badge de severidade (RN-RND01), alinhadas ao Iron Security Design System. */
export const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#FF3B45",
  high: "#FF7A1A",
  medium: "#FACC15",
  low: "#22C55E",
  info: "#00D9FF",
};
