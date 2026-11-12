"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { bytesToBase64, encryptToken } from "@ironnews/shared";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import { CONNECT_ERROR_MESSAGE, InstagramError, accountFromToken } from "@/lib/integrations/instagram";
import { tokenOnlyEnv } from "@/lib/integrations/server";
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

/**
 * Conecta a conta colando o token gerado no painel da Meta ("Generate access tokens").
 * Caminho para apps criados com o "Unified login", em que o OAuth antigo do Instagram não aparece.
 * O token é conferido no Instagram, cifrado aqui (AES-256-GCM) e só então vai ao banco; nunca é logado.
 */
export async function saveInstagramToken(_prev: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return { ok: false, message: CONNECT_ERROR_MESSAGE.forbidden };
  const env = tokenOnlyEnv();
  if (!env) return { ok: false, message: "TOKEN_ENC_KEY não está configurada no servidor." };
  const token = String(form.get("token") ?? "").trim();

  let account;
  try {
    account = await accountFromToken(env.graphVersion, token);
  } catch (err) {
    const code = err instanceof InstagramError ? err.code : "network";
    console.error(JSON.stringify({ module: "integrations", channel: "instagram", event: "manual_token_failed", code }));
    return { ok: false, message: CONNECT_ERROR_MESSAGE[code] ?? CONNECT_ERROR_MESSAGE.network };
  }

  const sealed = await encryptToken(env.tokenKey, account.accessToken, `instagram:${account.accountId}`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("integration_save", {
    p_channel: "instagram",
    p_lang: "pt",
    p_account_id: account.accountId,
    p_account_name: account.username,
    p_token_enc: bytesToBase64(sealed),
    p_expires_at: account.expiresAt.toISOString(),
    p_scopes: account.scopes,
    p_meta: { account_type: account.accountType, token_kind: "instagram_dashboard_token" },
  });
  if (error) return { ok: false, message: rpcErrorMessage(error.message) };
  console.info(JSON.stringify({ module: "integrations", channel: "instagram", event: "connected_manual", account: account.username }));
  revalidatePath("/admin/integracoes");
  return { ok: true, message: `Conta @${account.username} conectada.` };
}
