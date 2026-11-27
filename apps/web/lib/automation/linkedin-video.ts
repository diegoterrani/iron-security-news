/**
 * Regras puras da automação "vídeo no perfil do LinkedIn" (o banco repete todas; aqui é para dar erro claro
 * antes de gastar uma chamada). Ver supabase/migrations/20261127000001_campaign_automation.sql.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { linkedinCaptionLength } from "../admin/campaigns";

export const MEDIA_BUCKET = "media";
export const AUTOMATION_MEDIA_RE = /^campanhas\/auto\/[0-9a-f-]{36}\/video\.mp4$/;
export const DEDUPE_KEY_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;
export const MAX_BODY_BYTES = 16 * 1024;
/** Limite da API do LinkedIn, contado sobre o texto já escapado (hashtags viram {hashtag|\\#|Tag}). */
export const LINKEDIN_MAX_CAPTION = 3000;

/** Caminho fixo, gerado só pelo servidor: o cliente nunca escolhe onde grava. */
export function newAutomationMediaPath(uuid: string = randomUUID()): string {
  const path = `campanhas/auto/${uuid.toLowerCase()}/video.mp4`;
  if (!AUTOMATION_MEDIA_RE.test(path)) throw new Error("uuid inválido");
  return path;
}

const trimmed = (min: number, max: number) =>
  z.string().transform((s) => s.trim()).pipe(z.string().min(min).max(max));

export const linkedinVideoSchema = z.object({
  campaign: trimmed(1, 80),
  caption: trimmed(1, 3000).refine((s) => linkedinCaptionLength(s) <= LINKEDIN_MAX_CAPTION, {
    message: "legenda passa de 3.000 caracteres no LinkedIn depois do escape das #hashtags e símbolos",
  }),
  media_path: z.string().regex(AUTOMATION_MEDIA_RE, "use o caminho devolvido por /uploads"),
  scheduled_for: z.string().datetime({ offset: true }),
  dedupe_key: z.string().regex(DEDUPE_KEY_RE, "a-z, 0-9, ponto, _ e -, 3 a 80"),
  first_comment: trimmed(1, 1250).optional(),
}).strict();

export type LinkedinVideoInput = z.output<typeof linkedinVideoSchema>;

/** Argumentos da RPC automation_linkedin_video_create. */
export function rpcArgs(actor: string, input: LinkedinVideoInput) {
  return {
    p_actor: actor,
    p_campaign: input.campaign,
    p_caption: input.caption,
    p_media: input.media_path,
    p_scheduled_for: input.scheduled_for,
    p_dedupe_key: input.dedupe_key,
    p_first_comment: input.first_comment ?? null,
  };
}
