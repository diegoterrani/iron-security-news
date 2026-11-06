import { z } from "zod";
import { CATEGORIES, SEVERITIES } from "../enums";

const CVE = z.string().regex(/^CVE-\d{4}-\d{4,7}$/);

export const TriageSchema = z.object({
  is_relevant: z.boolean(),
  discard_reason: z.string().max(120).nullable(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  relevance: z.number().min(0).max(1),
  flags: z.object({ zero_day: z.boolean(), exploited: z.boolean(), brazil: z.boolean() }),
  entities: z.object({
    cves: z.array(CVE).max(20),
    vendors: z.array(z.string().max(60)).max(10),
    threat_actors: z.array(z.string().max(60)).max(5),
    victims: z.array(z.string().max(80)).max(10),
    countries: z.array(z.string().length(2)).max(10),
  }),
  one_line: z.string().max(200),
});
export type Triage = z.infer<typeof TriageSchema>;

const Claim = z.object({ text: z.string().max(400), source_ids: z.array(z.string().uuid()).min(1) });

const ArticleLang = z.object({
  title: z.string().min(20).max(70),
  meta_description: z.string().min(80).max(155),
  tldr: z.string().max(300),
  markdown: z.string().min(1500).max(7000),
  tags: z.array(z.string().max(30)).min(3).max(8),
});

export const ArticleSchema = z.object({
  pt: ArticleLang,
  en: ArticleLang,
  claims: z.array(Claim).min(3).max(25),
  cves_mentioned: z.array(CVE),
});
export type Article = z.infer<typeof ArticleSchema>;

export const DerivativesSchema = z.object({
  instagram: z.object({
    slides: z.array(z.object({ heading: z.string().max(60), body: z.string().max(220) })).min(4).max(6),
    caption: z.string().max(2000),
    hashtags: z.array(z.string().regex(/^#\w+$/)).min(5).max(12),
    alt_text: z.string().max(300),
  }),
  facebook: z.object({ text: z.string().min(200).max(700) }),
  linkedin: z.object({
    text: z.string().min(400).max(1500),
    hashtags: z.array(z.string()).min(3).max(5),
    alt_text: z.string().max(300),
  }),
  youtube: z.object({
    script: z.string().min(600).max(1000),
    title: z.string().max(90),
    description: z.string().max(1500),
    tags: z.array(z.string().max(30)).max(12),
    on_screen_hook: z.string().max(50),
  }),
});
export type Derivatives = z.infer<typeof DerivativesSchema>;

/** Extrai CVE IDs de um texto (RN-ING04). */
export function extractCves(text: string): string[] {
  return [...new Set(text.toUpperCase().match(/CVE-\d{4}-\d{4,7}/g) ?? [])];
}
