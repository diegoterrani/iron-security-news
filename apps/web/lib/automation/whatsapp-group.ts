/**
 * Regras puras da automação "texto no grupo do WhatsApp" (o banco repete todas; aqui é para dar erro claro
 * antes de gastar uma chamada). Ver supabase/migrations/20261127000002_whatsapp_automation.sql.
 */
import { z } from "zod";
import { DEDUPE_KEY_RE } from "./linkedin-video";

/** Teto do banco (whatsapp_posts_body_check). Bem abaixo do limite do WhatsApp, de propósito: é um aviso. */
export const WHATSAPP_MAX_BODY = 1500;

export const whatsappGroupSchema = z.object({
  body: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(WHATSAPP_MAX_BODY)),
  send_after: z.string().datetime({ offset: true }),
  dedupe_key: z.string().regex(DEDUPE_KEY_RE, "a-z, 0-9, ponto, _ e -, 3 a 80"),
}).strict();

export type WhatsappGroupInput = z.output<typeof whatsappGroupSchema>;

/** Argumentos da RPC automation_whatsapp_group_create. */
export function whatsappRpcArgs(actor: string, input: WhatsappGroupInput) {
  return { p_actor: actor, p_body: input.body, p_send_after: input.send_after, p_dedupe_key: input.dedupe_key };
}
