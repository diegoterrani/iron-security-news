import type { Metadata } from "next";
import { ExternalLink, Megaphone } from "lucide-react";
import { getViewer, rpcErrorMessage } from "@/lib/admin/data";
import {
  DESTINATIONS, DESTINATION_KEYS, POST_STATUS_LABEL, destinationLabel, type CampaignPostStatus, type DestinationKey,
} from "@/lib/admin/campaigns";
import { fmtDateTime } from "@/lib/admin/labels";
import { createClient } from "@/lib/supabase/server";
import { CampaignForm } from "./CampaignForm";
import { PostActions } from "./PostActions";

export const metadata: Metadata = { title: "Campanhas" };
export const dynamic = "force-dynamic";

interface PostRow {
  id: string;
  campaign: string;
  channel: string;
  target: string;
  format: string;
  caption: string;
  media: string[];
  status: CampaignPostStatus;
  scheduled_for: string;
  published_at: string | null;
  external_url: string | null;
  last_error: string | null;
}

interface IntegrationRow { channel: string; lang: string; target: string; account_name: string; status: string; expires_at: string | null }

const CHIP: Record<CampaignPostStatus, string> = {
  pending: "chip", publishing: "chip", published: "chip chip--ok", failed: "chip chip--warn", skipped: "chip",
};

export default async function CampaignsPage() {
  const supabase = await createClient();
  const [viewer, integrations, posts] = await Promise.all([
    getViewer(),
    supabase.rpc("integrations_list"),
    supabase.from("campaign_posts")
      .select("id, campaign, channel, target, format, caption, media, status, scheduled_for, published_at, external_url, last_error")
      .order("scheduled_for", { ascending: false }).limit(80),
  ]);
  const rows = (integrations.data ?? []) as IntegrationRow[];
  const connected = (channel: string, target: string) => rows.some((r) => r.channel === channel && r.lang === "pt" && r.target === target
    && r.status === "active" && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now()));
  const available = Object.fromEntries(
    DESTINATION_KEYS.map((k) => [k, connected(DESTINATIONS[k].channel, DESTINATIONS[k].target)]),
  ) as Record<DestinationKey, boolean>;
  const list = (posts.data ?? []) as PostRow[];
  const upcoming = list.filter((p) => p.status === "pending" || p.status === "publishing")
    .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  const history = list.filter((p) => p.status !== "pending" && p.status !== "publishing");
  const isAdmin = viewer?.role === "admin";

  return (
    <>
      <header className="admin-header">
        <div>
          <h1 className="admin-header__title">Campanhas</h1>
          <p className="admin-header__subtitle">Suba vídeos, carrosséis e PDFs prontos e publique no Instagram e no LinkedIn, agora ou no horário marcado.</p>
        </div>
      </header>
      <main id="content" className="admin-main admin-main--narrow" style={{ maxWidth: 760 }}>
        <section className="panel" aria-labelledby="c-nova">
          <h2 id="c-nova" className="section-title"><Megaphone className="icon" size={16} aria-hidden="true" /> Nova publicação</h2>
          <p className="section-hint">
            Usa as contas de Integrações. O executor publica no minuto marcado; vídeo leva de 1 a 10 minutos para processar.
            Um destino por vez: para a mesma peça em outra rede, envie de novo com o outro destino.
          </p>
          {isAdmin ? <CampaignForm available={available} /> : <p className="form__error" role="alert">Só administradores publicam campanhas.</p>}
        </section>

        <section className="panel" aria-labelledby="c-proximas">
          <h2 id="c-proximas" className="section-title">Próximas</h2>
          {posts.error && <p className="form__error" role="alert">{rpcErrorMessage(posts.error.message)}</p>}
          {upcoming.length === 0 ? <p className="section-hint">Nada agendado.</p> : <PostList posts={upcoming} isAdmin={isAdmin} />}
        </section>

        <section className="panel" aria-labelledby="c-historico">
          <h2 id="c-historico" className="section-title">Histórico</h2>
          {history.length === 0 ? <p className="section-hint">Nenhuma publicação ainda.</p> : <PostList posts={history} isAdmin={isAdmin} />}
        </section>
      </main>
    </>
  );
}

function PostList({ posts, isAdmin }: { posts: PostRow[]; isAdmin: boolean }) {
  return (
    <ul className="story-list">
      {posts.map((p) => (
        <li key={p.id} className="story-card">
          <div className="story-card__top">
            <span className={CHIP[p.status]}>{POST_STATUS_LABEL[p.status]}</span>
            <strong>{p.campaign}</strong>
            <span className="story-card__meta">· {destinationLabel(p.channel, p.target, p.format)}</span>
          </div>
          <p className="story-card__meta">
            {p.status === "published" && p.published_at ? `Publicada em ${fmtDateTime(p.published_at)}` : `Horário: ${fmtDateTime(p.scheduled_for)}`}
            {" · "}{p.media.length} arquivo{p.media.length > 1 ? "s" : ""}
          </p>
          <p className="story-card__meta">{p.caption.length > 160 ? `${p.caption.slice(0, 160)}…` : p.caption}</p>
          {p.last_error && <p className={p.status === "published" ? "alert alert--warn" : "form__error"}>{p.last_error}</p>}
          {p.external_url && (
            <a href={p.external_url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="icon" size={14} aria-hidden="true" /> Abrir o post
            </a>
          )}
          {isAdmin && <PostActions id={p.id} status={p.status} />}
        </li>
      ))}
    </ul>
  );
}
