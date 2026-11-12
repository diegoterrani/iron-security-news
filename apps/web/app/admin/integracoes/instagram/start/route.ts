import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/admin/data";
import { authorizeUrl } from "@/lib/integrations/instagram";
import { STATE_COOKIE, STATE_TTL_SECONDS, createState } from "@/lib/integrations/oauth-state";
import { instagramServerEnv } from "@/lib/integrations/server";

export const dynamic = "force-dynamic";

/**
 * Inicia a conexão da conta do Instagram (OAuth). O middleware já exige login + MFA em /admin;
 * aqui exige papel admin, gera o state assinado e guarda o nonce num cookie httpOnly restrito a este caminho.
 */
export async function GET(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(new URL(`/admin/integracoes?${q}`, req.url), { status: 303 });
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return back("erro=forbidden");
  const env = instagramServerEnv();
  if (!env) return back("erro=config");

  const { state, nonce } = await createState(env.stateSecret, viewer.id);
  const res = NextResponse.redirect(authorizeUrl(env.ig, state), { status: 303 });
  res.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // o retorno do Instagram é navegação GET de outro site: "lax" envia, "strict" não
    path: "/admin/integracoes/instagram",
    maxAge: STATE_TTL_SECONDS,
  });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
