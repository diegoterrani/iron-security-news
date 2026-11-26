"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import { DESTINATIONS, MEDIA_PATH_RE, brasiliaToIso, extOf, isDestinationKey } from "@/lib/admin/campaigns";
import { createClient } from "@/lib/supabase/server";

export type CampaignActionState = { ok?: boolean; message?: string };

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

const Input = z.object({
  destination: z.string().refine(isDestinationKey, "Destino inválido."),
  campaign: z.string().trim().min(1, "Dê um nome à campanha.").max(80, "Nome da campanha com até 80 caracteres."),
  caption: z.string().trim().min(1, "Escreva a legenda.").max(3000),
  first_comment: optionalText(1250),
  doc_title: optionalText(200),
  media: z.array(z.string().regex(MEDIA_PATH_RE, "Arquivo inválido.")).min(1).max(10),
  when: z.string().trim().optional(),
});

/**
 * Agenda a publicação depois que o navegador subiu os arquivos. Papel admin, MFA, arquivos e conta
 * conectada são conferidos de novo na RPC campaign_post_create (banco).
 */
export async function createCampaignPost(raw: unknown): Promise<CampaignActionState> {
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return { ok: false, message: "Só administradores publicam campanhas." };
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const d = parsed.data;
  const dest = DESTINATIONS[d.destination as keyof typeof DESTINATIONS];
  if (d.caption.length > dest.captionMax) return { ok: false, message: `Legenda com até ${dest.captionMax} caracteres.` };
  if (d.media.some((m) => !dest.exts.includes(extOf(m)))) return { ok: false, message: "Arquivo não serve para este destino." };
  if (dest.needsTitle && !d.doc_title) return { ok: false, message: "Dê um título ao documento." };
  let when: string | null = null;
  if (d.when) {
    when = brasiliaToIso(d.when);
    if (!when) return { ok: false, message: "Data e hora inválidas." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("campaign_post_create", {
    p_campaign: d.campaign,
    p_channel: dest.channel,
    p_target: dest.target,
    p_format: dest.format,
    p_caption: d.caption,
    p_media: d.media,
    p_scheduled_for: when,
    p_first_comment: dest.firstComment ? d.first_comment : null,
    p_doc_title: d.doc_title,
  });
  if (error) return { ok: false, message: rpcErrorMessage(error.message) };
  console.info(JSON.stringify({ module: "campaign", event: "scheduled", destination: d.destination, files: d.media.length }));
  revalidatePath("/admin/campanhas");
  const at = (data as { scheduled_for?: string } | null)?.scheduled_for;
  const label = at && when
    ? `Agendada para ${new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })} (Brasília).`
    : "Na fila: sai em até 1 minuto (vídeo pode levar alguns minutos para processar).";
  return { ok: true, message: label };
}

const Id = z.string().uuid();

async function call(fn: "campaign_post_cancel" | "campaign_post_retry", form: FormData): Promise<CampaignActionState> {
  const id = Id.safeParse(form.get("id"));
  if (!id.success) return { ok: false, message: "Publicação inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, { p_id: id.data });
  if (error) {
    return {
      ok: false,
      message: error.message.includes("INVALID_STATE") ? "A publicação mudou de estado. Recarregue a página." : rpcErrorMessage(error.message),
    };
  }
  revalidatePath("/admin/campanhas");
  return { ok: true };
}

export async function cancelCampaignPost(_prev: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const r = await call("campaign_post_cancel", form);
  return r.ok ? { ok: true, message: "Cancelada." } : r;
}

export async function retryCampaignPost(_prev: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const r = await call("campaign_post_retry", form);
  return r.ok ? { ok: true, message: "Na fila de novo: sai em até 1 minuto." } : r;
}
