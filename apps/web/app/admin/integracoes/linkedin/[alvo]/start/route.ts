import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/admin/data";
import { LI_STATE_COOKIE, authorizeUrl, cookiePath, targetFromSlug } from "@/lib/integrations/linkedin";
import { STATE_TTL_SECONDS, createState } from "@/lib/integrations/oauth-state";
import { linkedinServerEnv } from "@/lib/integrations/server";

export const dynamic = "force-dynamic";

/**
 * Inicia a conexão do LinkedIn (perfil ou página). O middleware já exige login + MFA em /admin;
 * aqui exige papel admin, gera o state assinado e guarda o nonce num cookie httpOnly restrito ao alvo.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ alvo: string }> }) {
  const back = (q: string) => NextResponse.redirect(new URL(`/admin/integracoes?${q}`, req.url), { status: 303 });
  const target = targetFromSlug((await params).alvo);
  if (!target) return back("erro_li=config");
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return back("erro_li=forbidden");
  const env = linkedinServerEnv(target);
  if (!env) return back("erro_li=config");

  const { state, nonce } = await createState(env.stateSecret, viewer.id);
  const res = NextResponse.redirect(authorizeUrl(env.li, state), { status: 303 });
  res.cookies.set(LI_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // o retorno do LinkedIn é navegação GET de outro site: "lax" envia, "strict" não
    path: cookiePath(target),
    maxAge: STATE_TTL_SECONDS,
  });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
