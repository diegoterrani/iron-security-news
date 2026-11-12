"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { rpcErrorMessage } from "@/lib/admin/data";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { ok?: boolean; message?: string };

const Input = z.object({ channel: z.enum(["instagram", "facebook", "linkedin", "youtube"]), lang: z.enum(["pt", "en"]) });

/** Desconecta a conta (apaga o token). Papel admin + MFA são checados no banco pela RPC. */
export async function disconnectIntegration(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = Input.safeParse({ channel: form.get("channel"), lang: form.get("lang") });
  if (!parsed.success) return { ok: false, message: "Integração inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("integration_disconnect", { p_channel: parsed.data.channel, p_lang: parsed.data.lang });
  if (error) return { ok: false, message: rpcErrorMessage(error.message) };
  revalidatePath("/admin/integracoes");
  return { ok: true, message: "Conta desconectada. O token foi apagado." };
}
