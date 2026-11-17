"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import { createClient } from "@/lib/supabase/server";

export type ManualState = { ok?: boolean; message?: string };

const optional = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : null));

/** Mesmas regras da RPC (que revalida tudo no banco); aqui só para devolver a mensagem sem ida ao Supabase. */
const ManualInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.string().trim().max(2048).url("Informe um link válido.")
      .refine((u) => u.startsWith("https://"), "Só links https são aceitos."),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().trim().min(200, "O texto precisa ter pelo menos 200 caracteres.").max(60000, "Texto com até 60.000 caracteres."),
    source_name: optional(120),
    source_url: optional(2048).refine((u) => u === null || /^https?:\/\//.test(u), "Link da fonte inválido."),
  }),
]);

/** Cria o pedido. Papel editor+ e MFA são exigidos pela RPC (review_guard); o executor gera a story. */
export async function requestManualStory(_prev: ManualState, form: FormData): Promise<ManualState> {
  const viewer = await getViewer();
  if (viewer?.role !== "admin" && viewer?.role !== "editor") {
    return { ok: false, message: "Seu papel não permite esta ação (é preciso ser editor ou admin)." };
  }
  const kind = form.get("kind");
  const parsed = ManualInput.safeParse(
    kind === "url"
      ? { kind, url: form.get("url") ?? "" }
      : { kind, text: form.get("text") ?? "", source_name: form.get("source_name") ?? undefined, source_url: form.get("source_url") ?? undefined },
  );
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("manual_story_request", {
    p_kind: d.kind,
    p_url: d.kind === "url" ? d.url : null,
    p_text: d.kind === "text" ? d.text : null,
    p_source_name: d.kind === "text" ? d.source_name : null,
    p_source_url: d.kind === "text" ? d.source_url : null,
  });
  if (error) return { ok: false, message: rpcErrorMessage(error.message) };
  console.info(JSON.stringify({ module: "manual", event: "requested", kind: d.kind }));
  revalidatePath("/admin/nova");
  return { ok: true, message: "Pedido recebido. A notícia aparece em “Em produção” e, em 2 a 4 minutos, na fila de revisão." };
}
