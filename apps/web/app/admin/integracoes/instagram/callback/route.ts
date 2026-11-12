import { NextResponse, type NextRequest } from "next/server";
import { bytesToBase64, encryptToken } from "@ironnews/shared";
import { getViewer } from "@/lib/admin/data";
import { InstagramError, connectWithCode } from "@/lib/integrations/instagram";
import { STATE_COOKIE, verifyState } from "@/lib/integrations/oauth-state";
import { instagramServerEnv } from "@/lib/integrations/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Retorno do Instagram: confere o state (CSRF), troca o code pelo token de 60 dias, lê o perfil,
 * cifra o token (AES-256-GCM, chave só no servidor) e grava pela RPC integration_save (admin + MFA no banco).
 * O token nunca vai para o navegador, para a URL de retorno nem para o log.
 */
export async function GET(req: NextRequest) {
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/admin/integracoes?${q}`, req.url), { status: 303 });
    res.cookies.set(STATE_COOKIE, "", { path: "/admin/integracoes/instagram", maxAge: 0 });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  };
  const params = req.nextUrl.searchParams;

  const viewer = await getViewer();
  if (viewer?.role !== "admin") return done("erro=forbidden");
  const env = instagramServerEnv();
  if (!env) return done("erro=config");

  const check = await verifyState(env.stateSecret, params.get("state"), req.cookies.get(STATE_COOKIE)?.value, viewer.id);
  if (!check.ok) {
    console.warn(JSON.stringify({ module: "integrations", channel: "instagram", event: "state_rejected", reason: check.reason }));
    return done("erro=state");
  }
  if (params.get("error")) return done("erro=denied");
  const code = params.get("code");
  if (!code || code.length > 2048) return done("erro=exchange");

  let account;
  try {
    account = await connectWithCode(env.ig, code);
  } catch (err) {
    const c = err instanceof InstagramError ? err.code : "network";
    console.error(JSON.stringify({ module: "integrations", channel: "instagram", event: "connect_failed", code: c, status: err instanceof InstagramError ? err.status : undefined }));
    return done(`erro=${c}`);
  }

  try {
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
      p_meta: { account_type: account.accountType, token_kind: "instagram_long_lived" },
    });
    if (error) throw new Error(error.message.slice(0, 200));
  } catch (err) {
    console.error(JSON.stringify({ module: "integrations", channel: "instagram", event: "save_failed", error: err instanceof Error ? err.message : "?" }));
    return done("erro=save");
  }
  console.info(JSON.stringify({ module: "integrations", channel: "instagram", event: "connected", account: account.username }));
  return done("ok=instagram");
}
