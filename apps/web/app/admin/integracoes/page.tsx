import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, Instagram, Linkedin, Plug } from "lucide-react";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import { fmtDateTime } from "@/lib/admin/labels";
import { CONNECT_ERROR_MESSAGE, INSTAGRAM_SCOPES } from "@/lib/integrations/instagram";
import { LINKEDIN_ERROR_MESSAGE, LINKEDIN_SCOPES, TARGET_SLUG, type LinkedinTarget } from "@/lib/integrations/linkedin";
import { instagramServerEnv, linkedinMissingEnv, linkedinServerEnv, tokenOnlyEnv } from "@/lib/integrations/server";
import { createClient } from "@/lib/supabase/server";
import { DisconnectForm } from "./DisconnectForm";
import { TokenForm } from "./TokenForm";

export const metadata: Metadata = { title: "Integrações" };
export const dynamic = "force-dynamic";

interface IntegrationRow {
  channel: string;
  lang: string;
  target: string;
  account_name: string;
  account_id: string;
  status: "active" | "needs_reauth" | "disabled";
  expires_at: string | null;
  scopes: string[];
  updated_at: string;
}

const DAY_MS = 86_400_000;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ ok?: string; erro?: string; erro_li?: string }> }) {
  const { ok, erro, erro_li: erroLi } = await searchParams;
  const supabase = await createClient();
  const [viewer, list] = await Promise.all([getViewer(), supabase.rpc("integrations_list")]);
  const rows = (list.data ?? []) as IntegrationRow[];
  const ig = rows.find((r) => r.channel === "instagram" && r.lang === "pt");
  const isAdmin = viewer?.role === "admin";
  const configured = instagramServerEnv() !== null; // OAuth (login do Instagram)
  const canPasteToken = tokenOnlyEnv() !== null; // token colado (Unified login)
  const now = Date.now();
  const expiresInDays = ig?.expires_at ? Math.floor((new Date(ig.expires_at).getTime() - now) / DAY_MS) : null;
  // Token sem validade (usuário do sistema, EAA…) fica conectado até ser revogado ou desconectado.
  const connected = ig?.status === "active" && (expiresInDays === null || expiresInDays >= 0);

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
        {(ok === "linkedin-perfil" || ok === "linkedin-pagina") && (
          <p className="alert alert--ok" role="status"><CheckCircle2 className="icon" size={14} aria-hidden="true" /> {ok === "linkedin-perfil" ? "Perfil do LinkedIn conectado." : "Página do LinkedIn conectada."}</p>
        )}
        {erroLi && (
          <p className="alert alert--warn" role="alert"><AlertTriangle className="icon" size={14} aria-hidden="true" /> {LINKEDIN_ERROR_MESSAGE[erroLi] ?? "Não foi possível conectar o LinkedIn. Tente de novo."}</p>
        )}
        {list.error && <p className="form__error" role="alert">{rpcErrorMessage(list.error.message)}</p>}

        <section className="panel channel-block" aria-labelledby="ig-title">
          <h2 id="ig-title" className="section-title"><Instagram className="icon" size={16} aria-hidden="true" /> Instagram</h2>
          {connected ? (
            <>
              <p><strong>@{ig!.account_name}</strong> <span className="chip chip--ok">Conectada</span></p>
              <p className="section-hint">
                {expiresInDays === null ? "Token sem data de validade (usuário do sistema)." : `Token válido até ${fmtDateTime(ig!.expires_at!)} (${expiresInDays} dias).`}{" "}
                Conectada em {fmtDateTime(ig!.updated_at)}.
              </p>
              {expiresInDays !== null && expiresInDays < 7 && (
                <p className="alert alert--warn"><AlertTriangle className="icon" size={14} aria-hidden="true" /> O token vence em menos de 7 dias. Reconecte para renovar.</p>
              )}
            </>
          ) : ig?.status === "needs_reauth" || (ig?.status === "active" && !connected) ? (
            <p><strong>@{ig!.account_name}</strong> <span className="chip chip--warn">Precisa reconectar</span></p>
          ) : (
            <p className="section-hint">Nenhuma conta conectada. Os carrosséis continuam disponíveis para download na aba Criativos.</p>
          )}
          <p className="section-hint">Permissões pedidas: <span className="mono">{INSTAGRAM_SCOPES.join(", ")}</span> (ler o perfil e publicar).</p>

          {!configured && !canPasteToken && (
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
          ) : null}
          {isAdmin && canPasteToken && <TokenForm reconnect={Boolean(ig && ig.status !== "disabled")} />}
          {!isAdmin && <p className="section-hint">Só administradores podem conectar ou desconectar contas.</p>}
        </section>

        <section className="panel channel-block" aria-labelledby="li-title">
          <h2 id="li-title" className="section-title"><Linkedin className="icon" size={16} aria-hidden="true" /> LinkedIn</h2>
          <p className="section-hint">O post de cada story pode sair no seu perfil, na página da IRON ou nos dois. Cada um tem a sua conexão.</p>
          <LinkedinAccount target="member" row={rows.find((r) => r.channel === "linkedin" && r.lang === "pt" && r.target === "member")} isAdmin={isAdmin} now={now} />
          <LinkedinAccount target="organization" row={rows.find((r) => r.channel === "linkedin" && r.lang === "pt" && r.target === "organization")} isAdmin={isAdmin} now={now} />
        </section>
      </main>
    </>
  );
}

const LI_LABEL: Record<LinkedinTarget, { title: string; hint: string; connect: string }> = {
  member: {
    title: "Perfil pessoal",
    hint: "Publica como você. O LinkedIn libera o token por 60 dias e não renova sozinho: reconecte quando o aviso aparecer.",
    connect: "Conectar perfil",
  },
  organization: {
    title: "Página da IRON",
    hint: "Publica como a página. Depende do produto Community Management API aprovado pelo LinkedIn no app da página.",
    connect: "Conectar página",
  },
};

/** Estado e ações de uma conta do LinkedIn (perfil ou página). */
function LinkedinAccount({ target, row, isAdmin, now }: { target: LinkedinTarget; row: IntegrationRow | undefined; isAdmin: boolean; now: number }) {
  const label = LI_LABEL[target];
  const configured = linkedinServerEnv(target) !== null;
  const days = row?.expires_at ? Math.floor((new Date(row.expires_at).getTime() - now) / DAY_MS) : null;
  const connected = row?.status === "active" && (days === null || days >= 0);
  const active = row && row.status !== "disabled";
  return (
    <div className="creative-group">
      <h3 className="section-title">{label.title}</h3>
      {connected ? (
        <>
          <p><strong>{row!.account_name}</strong> <span className="chip chip--ok">Conectada</span></p>
          <p className="section-hint">
            {days === null ? "Token sem data de validade." : `Token válido até ${fmtDateTime(row!.expires_at!)} (${days} dias).`} Conectada em {fmtDateTime(row!.updated_at)}.
          </p>
          {days !== null && days < 7 && (
            <p className="alert alert--warn"><AlertTriangle className="icon" size={14} aria-hidden="true" /> O token vence em menos de 7 dias. Reconecte para renovar.</p>
          )}
        </>
      ) : active ? (
        <p><strong>{row!.account_name}</strong> <span className="chip chip--warn">Precisa reconectar</span></p>
      ) : (
        <p className="section-hint">Nada conectado. O texto e o card continuam disponíveis para copiar e baixar na aba LinkedIn.</p>
      )}
      <p className="section-hint">{label.hint} Permissões pedidas: <span className="mono">{LINKEDIN_SCOPES[target].join(", ")}</span>.</p>
      {!configured && (
        <p className="alert alert--warn"><AlertTriangle className="icon" size={14} aria-hidden="true" /> Falta configurar na Vercel (Production) e fazer Redeploy:{" "}
          {(() => { const m = linkedinMissingEnv(target); return m.length ? m.join(", ") : "variáveis presentes, mas a configuração foi recusada"; })()}.
          {target === "organization" && " App com a Community Management API."}</p>
      )}
      {isAdmin && (configured || active) && (
        <div className="review-actions">
          {configured && (
            // <a> e não <Link>: a rota inicia o OAuth e não deve ser pré-carregada.
            <a className="button button--primary" href={`/admin/integracoes/linkedin/${TARGET_SLUG[target]}/start`}>
              <Plug className="icon" size={16} aria-hidden="true" /> {active ? "Reconectar" : label.connect}
            </a>
          )}
          {active && <DisconnectForm channel="linkedin" lang="pt" target={target} account={row!.account_name} />}
        </div>
      )}
    </div>
  );
}
