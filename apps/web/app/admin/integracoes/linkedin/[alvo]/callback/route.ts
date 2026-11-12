import { NextResponse, type NextRequest } from "next/server";
import { bytesToBase64, encryptToken } from "@ironnews/shared";
import { getViewer } from "@/lib/admin/data";
import { LI_STATE_COOKIE, LinkedinError, connectWithCode, cookiePath, targetFromSlug, tokenContext } from "@/lib/integrations/linkedin";
import { verifyState } from "@/lib/integrations/oauth-state";
import { linkedinServerEnv } from "@/lib/integrations/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Retorno do LinkedIn: confere o state (CSRF), troca o code pelo token, descobre o autor (perfil ou
 * página administrada), cifra os tokens (AES-256-GCM, chave só no servidor) e grava pela RPC
 * integration_save (admin + MFA no banco). Os tokens nunca vão para o navegador, para a URL nem para o log.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ alvo: string }> }) {
  const target = targetFromSlug((await params).alvo);
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/admin/integracoes?${q}`, req.url), { status: 303 });
    if (target) res.cookies.set(LI_STATE_COOKIE, "", { path: cookiePath(target), maxAge: 0 });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  };
  if (!target) return done("erro_li=config");
  const q = req.nextUrl.searchParams;

  const viewer = await getViewer();
  if (viewer?.role !== "admin") return done("erro_li=forbidden");
  const env = linkedinServerEnv(target);
  if (!env) return done("erro_li=config");

  const check = await verifyState(env.stateSecret, q.get("state"), req.cookies.get(LI_STATE_COOKIE)?.value, viewer.id);
  if (!check.ok) {
    console.warn(JSON.stringify({ module: "integrations", channel: "linkedin", target, event: "state_rejected", reason: check.reason }));
    return done("erro_li=state");
  }
  if (q.get("error")) return done("erro_li=denied");
  const code = q.get("code");
  if (!code || code.length > 2048) return done("erro_li=exchange");

  let account;
  try {
    account = await connectWithCode(env.li, code);
  } catch (err) {
    const c = err instanceof LinkedinError ? err.code : "network";
    console.error(JSON.stringify({ module: "integrations", channel: "linkedin", target, event: "connect_failed", code: c, status: err instanceof LinkedinError ? err.status : undefined }));
    return done(`erro_li=${c}`);
  }

  try {
    const sealed = await encryptToken(env.tokenKey, account.accessToken, tokenContext(target, account.accountId));
    const sealedRefresh = account.refreshToken
      ? await encryptToken(env.tokenKey, account.refreshToken, tokenContext(target, account.accountId, "refresh"))
      : null;
    const supabase = await createClient();
    const { error } = await supabase.rpc("integration_save", {
      p_channel: "linkedin",
      p_lang: "pt",
      p_target: target,
      p_account_id: account.accountId,
      p_account_name: account.accountName,
      p_token_enc: bytesToBase64(sealed),
      p_refresh_token_enc: sealedRefresh ? bytesToBase64(sealedRefresh) : null,
      p_expires_at: account.expiresAt.toISOString(),
      p_scopes: account.scopes,
      p_meta: {
        token_kind: "linkedin_oauth",
        api_version: env.li.apiVersion,
        refresh_expires_at: account.refreshExpiresAt?.toISOString() ?? null,
      },
    });
    if (error) throw new Error(error.message.slice(0, 200));
  } catch (err) {
    console.error(JSON.stringify({ module: "integrations", channel: "linkedin", target, event: "save_failed", error: err instanceof Error ? err.message : "?" }));
    return done("erro_li=save");
  }
  console.info(JSON.stringify({ module: "integrations", channel: "linkedin", target, event: "connected", account: account.accountName }));
  return done(`ok=linkedin-${target === "member" ? "perfil" : "pagina"}`);
}
