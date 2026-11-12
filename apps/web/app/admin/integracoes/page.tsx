import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, Instagram, Plug } from "lucide-react";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import { fmtDateTime } from "@/lib/admin/labels";
import { CONNECT_ERROR_MESSAGE, INSTAGRAM_SCOPES } from "@/lib/integrations/instagram";
import { instagramServerEnv } from "@/lib/integrations/server";
import { createClient } from "@/lib/supabase/server";
import { DisconnectForm } from "./DisconnectForm";

export const metadata: Metadata = { title: "Integrações" };
export const dynamic = "force-dynamic";

interface IntegrationRow {
  channel: string;
  lang: string;
  account_name: string;
  account_id: string;
  status: "active" | "needs_reauth" | "disabled";
  expires_at: string | null;
  scopes: string[];
  updated_at: string;
}

const DAY_MS = 86_400_000;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ ok?: string; erro?: string }> }) {
  const { ok, erro } = await searchParams;
  const supabase = await createClient();
  const [viewer, list] = await Promise.all([getViewer(), supabase.rpc("integrations_list")]);
  const rows = (list.data ?? []) as IntegrationRow[];
  const ig = rows.find((r) => r.channel === "instagram" && r.lang === "pt");
  const isAdmin = viewer?.role === "admin";
  const configured = instagramServerEnv() !== null;
  const now = Date.now();
  const expiresInDays = ig?.expires_at ? Math.floor((new Date(ig.expires_at).getTime() - now) / DAY_MS) : null;
  const connected = ig?.status === "active" && expiresInDays !== null && expiresInDays >= 0;

  return (
    <>
      <header className="admin-header">
        <div>
          <h1 className="admin-header__title">Integrações</h1>
          <p className="admin-header__subtitle">Contas onde o painel publica. Os tokens ficam cifrados no servidor e nunca aparecem aqui.</p>
        </div>
      </header>
      <main id="content" className="admin-main admin-main--narrow">
        {ok === "instagram" && (
          <p className="alert alert--ok" role="status"><CheckCircle2 className="icon" size={14} aria-hidden="true" /> Conta do Instagram conectada.</p>
        )}
        {erro && (
          <p className="alert alert--warn" role="alert"><AlertTriangle className="icon" size={14} aria-hidden="true" /> {CONNECT_ERROR_MESSAGE[erro] ?? "Não foi possível conectar. Tente de novo."}</p>
        )}
        {list.error && <p className="form__error" role="alert">{rpcErrorMessage(list.error.message)}</p>}

        <section className="panel channel-block" aria-labelledby="ig-title">
          <h2 id="ig-title" className="section-title"><Instagram className="icon" size={16} aria-hidden="true" /> Instagram</h2>
          {connected ? (
            <>
              <p><strong>@{ig!.account_name}</strong> <span className="chip chip--ok">Conectada</span></p>
              <p className="section-hint">
                Token válido até {fmtDateTime(ig!.expires_at!)} ({expiresInDays} dias). Conectada em {fmtDateTime(ig!.updated_at)}.
              </p>
              {expiresInDays! < 7 && (
                <p className="alert alert--warn"><AlertTriangle className="icon" size={14} aria-hidden="true" /> O token vence em menos de 7 dias. Reconecte para renovar.</p>
              )}
            </>
          ) : ig?.status === "needs_reauth" || (ig?.status === "active" && !connected) ? (
            <p><strong>@{ig!.account_name}</strong> <span className="chip chip--warn">Precisa reconectar</span></p>
          ) : (
            <p className="section-hint">Nenhuma conta conectada. Os carrosséis continuam disponíveis para download na aba Criativos.</p>
          )}
          <p className="section-hint">Permissões pedidas: <span className="mono">{INSTAGRAM_SCOPES.join(", ")}</span> (ler o perfil e publicar).</p>

          {!configured && (
            <p className="alert alert--warn">
              <AlertTriangle className="icon" size={14} aria-hidden="true" /> {CONNECT_ERROR_MESSAGE.config}
            </p>
          )}
          {isAdmin ? (
            <div className="review-actions">
              {configured && (
                // <a> e não <Link>: a rota inicia o OAuth e não deve ser pré-carregada.
                <a className="button button--primary" href="/admin/integracoes/instagram/start">
                  <Plug className="icon" size={16} aria-hidden="true" /> {ig && ig.status !== "disabled" ? "Reconectar" : "Conectar Instagram"}
                </a>
              )}
              {ig && ig.status !== "disabled" && <DisconnectForm channel="instagram" lang="pt" account={ig.account_name} />}
            </div>
          ) : (
            <p className="section-hint">Só administradores podem conectar ou desconectar contas.</p>
          )}
        </section>
      </main>
    </>
  );
}
