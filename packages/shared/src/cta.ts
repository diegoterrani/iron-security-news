/**
 * CTA padrão no fim de cada post das redes. Não é gerado pela IA nem gravado no conteúdo: é anexado
 * na montagem do texto final (cópia no admin e publicação), então vale para stories antigas e
 * sobrevive a edições humanas. Instagram/Facebook não aceitam link clicável na legenda → "link na bio".
 */
import type { Lang } from "./enums";

export const BLOG_URL = "https://news.iron-security.com/";
export const ACADEMY_SOC_N1_URL = "https://www.iron-security.com/academy/soc-n1";

export type SocialChannel = "instagram" | "facebook" | "linkedin" | "youtube";

const CTA: Record<"bio" | "links", Record<Lang, string>> = {
  bio: {
    pt:
      "Quer entender o caso completo e as ações recomendadas? Leia o artigo completo no blog Iron Cyber News - Link na Bio.\n\n" +
      "Conheça nossa trilha de treinamento da Iron Security Academy, estamos lançando o treinamento FORMAÇÃO SOC N1 - Link na Bio.",
    en:
      "Want the full story and the recommended actions? Read the full article on the Iron Cyber News blog - Link in Bio.\n\n" +
      "Explore the Iron Security Academy training path: we are launching the SOC N1 TRAINING PROGRAM - Link in Bio.",
  },
  links: {
    pt:
      `Quer entender o caso completo e as ações recomendadas? Leia o artigo completo no blog Iron Cyber News - ${BLOG_URL}\n\n` +
      `Conheça nossa trilha de treinamento da Iron Security Academy, estamos lançando o treinamento FORMAÇÃO SOC N1 - ${ACADEMY_SOC_N1_URL}`,
    en:
      `Want the full story and the recommended actions? Read the full article on the Iron Cyber News blog - ${BLOG_URL}\n\n` +
      `Explore the Iron Security Academy training path: we are launching the SOC N1 TRAINING PROGRAM - ${ACADEMY_SOC_N1_URL}`,
  },
};

export function socialCta(channel: SocialChannel, lang: Lang): string {
  return CTA[channel === "instagram" || channel === "facebook" ? "bio" : "links"][lang];
}

/** Convites que a IA escrevia no fim (prompts antigos): saem para o CTA padrão não ficar duplicado. */
const OLD_INVITE = new RegExp(
  [
    String.raw`link (na|in) (a )?bio`,
    String.raw`\b(leia|confira|acesse|veja|saiba|read|check out|see|learn)\b[^.!?\n]{0,80}\b(artigo|blog|article|analysis|análise|post completo|full story)`,
    String.raw`(mais|full|more) detalhes no blog|(more|full) details on the`,
    String.raw`^(quer|want)\b[^?\n]{0,160}\?$`, // pergunta-gancho que antecedia o convite
  ].join("|"),
  "i",
);

/** Tira do fim do texto o convite antigo (até 3 frases) e linhas só de hashtags (já vão no campo próprio). */
export function stripOldInvite(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const tags = t.match(/\n+\s*(#[\p{L}\p{N}_]+\s*)+$/u);
    if (tags) { t = t.slice(0, t.length - tags[0].length).trim(); continue; }
    const m = t.match(/(?:^|[.!?…]\s+|\n+)([^.!?…\n]*[.!?…]?)$/);
    if (!m || !OLD_INVITE.test(m[1]!.trim())) break;
    t = t.slice(0, t.length - m[1]!.length).trim();
  }
  return t;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const tagLine = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).join(" ") : "");

/** Campo do conteúdo que recebe o CTA em cada rede (no Short, a descrição do vídeo). */
export const CTA_FIELD: Record<SocialChannel, string> = { instagram: "caption", facebook: "text", linkedin: "text", youtube: "description" };

/** Partes do post final: texto (sem convite antigo) + CTA + hashtags. */
export function socialPostParts(channel: SocialChannel, lang: Lang, body: Record<string, unknown>) {
  return {
    text: stripOldInvite(str(body[CTA_FIELD[channel]])),
    cta: socialCta(channel, lang),
    hashtags: channel === "instagram" || channel === "linkedin" ? tagLine(body.hashtags) : "",
  };
}

/** Texto pronto para postar: texto, CTA padrão e, por último, as hashtags. */
export function socialPostText(channel: SocialChannel, lang: Lang, body: Record<string, unknown>): string {
  const p = socialPostParts(channel, lang, body);
  return [p.text, p.cta, p.hashtags].filter(Boolean).join("\n\n");
}
