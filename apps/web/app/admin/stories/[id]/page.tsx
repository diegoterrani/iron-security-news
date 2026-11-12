import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, ExternalLink } from "lucide-react";
import { SeverityBadge } from "@/components/SeverityBadge";
import { canEdit, getAssets, getInstagramPublish, getStory, getViewer, type AssetRow, type ContentRow, type InstagramPublishState } from "@/lib/admin/data";
import { CATEGORY_LABEL, CHANNEL_LABEL, SEVERITY_LABEL, STATUS_LABEL, fmtDateTime } from "@/lib/admin/labels";
import { CopyButton } from "./CopyButton";
import { PublishInstagramButton } from "./PublishInstagram";
import { EditForm, ReviewActions } from "./ReviewForms";

export const metadata: Metadata = { title: "Story" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "criativos", label: "Criativos" },
  { key: "pt", label: "Artigo PT" },
  { key: "en", label: "Artigo EN" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "youtube", label: "Shorts" },
  { key: "fontes", label: "Fontes" },
  { key: "fatos", label: "Fatos oficiais" },
] as const;

/** Markdown gerado por IA: sem HTML bruto (padrão do react-markdown) e links externos isolados. */
function Md({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> }}
        urlTransform={(url) => (/^(https?:|mailto:|#|\/)/i.test(url) ? url : "")}
      >
        {text}
      </Markdown>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function Meta({ c }: { c: ContentRow }) {
  return (
    <p className="story-card__meta">
      versão {c.version} · {c.edited_by ? "editada por humano" : `gerada por ${c.model ?? "IA"} (${c.prompt_version ?? "?"})`} · {fmtDateTime(c.created_at)}
    </p>
  );
}

export default async function StoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ aba?: string }> }) {
  const [{ id }, { aba }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [data, viewer] = await Promise.all([getStory(id), getViewer()]);
  if (!data) notFound();
  const { story, contents, sources } = data;
  const tab = TABS.find((t) => t.key === aba)?.key ?? "pt";
  const editable = canEdit(viewer) && story.status === "AWAITING_REVIEW";
  const find = (channel: string, lang: string) => contents.find((c) => c.channel === channel && c.lang === lang);
  const fg = story.fact_guard;

  let body: React.ReactNode = null;
  if (tab === "criativos") {
    const [assets, igPublish] = await Promise.all([getAssets(story.id), getInstagramPublish(story.id)]);
    const publish = { storyId: story.id, isAdmin: viewer?.role === "admin", approved: APPROVED_STATUSES.includes(story.status), ...igPublish };
    body = <Creatives assets={assets} find={find} publish={publish} />;
  } else if (tab === "pt" || tab === "en") {
    const a = find("blog", tab);
    body = !a ? <p className="section-hint">Sem artigo neste idioma.</p> : (
      <>
        <Meta c={a} />
        <h2 className="article-title">{a.title}</h2>
        <p className="article-tldr"><strong>TL;DR:</strong> {str(a.body.tldr)}</p>
        <p className="section-hint">Meta description: {str(a.body.meta_description)}</p>
        <div className="chips">{list(a.body.tags).map((t) => <span key={t} className="chip">{t}</span>)}</div>
        <Md text={str(a.body.markdown)} />
        {editable && (
          <EditForm storyId={story.id} channel="blog" lang={tab} kind="article" title={a.title}
            fields={[
              { name: "tldr", label: "TL;DR", value: str(a.body.tldr), rows: 3 },
              { name: "meta_description", label: "Meta description (até 155)", value: str(a.body.meta_description), rows: 2 },
              { name: "markdown", label: "Artigo (markdown)", value: str(a.body.markdown), rows: 24 },
            ]} />
        )}
      </>
    );
  } else if (tab === "fontes") {
    body = (
      <ul className="source-list">
        {sources.map((s) => (
          <li key={s.id}>
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title} <ExternalLink className="icon" size={12} aria-hidden="true" /></a>
            <span className="story-card__meta"> · {s.source} · {fmtDateTime(s.published_at)}</span>
          </li>
        ))}
      </ul>
    );
  } else if (tab === "fatos") {
    body = <pre className="code-block">{JSON.stringify(story.facts, null, 2)}</pre>;
  } else {
    const blocks = (["pt", "en"] as const).map((lang) => {
      const c = find(tab, lang);
      if (!c) return <div key={lang}><h3 className="section-title">{lang.toUpperCase()}</h3><p className="section-hint">Sem conteúdo neste idioma.</p></div>;
      const b = c.body;
      let preview: React.ReactNode;
      let field: { name: string; label: string; value: string; rows?: number };
      if (tab === "instagram") {
        const slides = (Array.isArray(b.slides) ? b.slides : []) as { heading?: string; body?: string }[];
        preview = (
          <>
            <ol className="slides">{slides.map((s, i) => <li key={i}><strong>{s.heading}</strong><br />{s.body}</li>)}</ol>
            <p className="pre-wrap">{str(b.caption)}</p>
            <p className="mono">{list(b.hashtags).join(" ")}</p>
            <p className="section-hint">Alt text: {str(b.alt_text)}</p>
          </>
        );
        field = { name: "caption", label: "Legenda", value: str(b.caption), rows: 8 };
      } else if (tab === "youtube") {
        preview = (
          <>
            <p><strong>{c.title}</strong> · gancho: “{str(b.on_screen_hook)}”</p>
            <p className="pre-wrap">{str(b.script)}</p>
            <p className="section-hint">{str(b.description)}</p>
          </>
        );
        field = { name: "script", label: "Roteiro", value: str(b.script), rows: 10 };
      } else {
        preview = (
          <>
            <p className="pre-wrap">{str(b.text)}</p>
            {list(b.hashtags).length > 0 && <p className="mono">{list(b.hashtags).join(" ")}</p>}
          </>
        );
        field = { name: "text", label: "Texto", value: str(b.text), rows: 10 };
      }
      return (
        <div key={lang} className="channel-block">
          <h3 className="section-title">{CHANNEL_LABEL[tab]} · {lang.toUpperCase()}</h3>
          <Meta c={c} />
          {preview}
          {editable && <EditForm storyId={story.id} channel={c.channel} lang={lang} kind={c.kind} fields={[field]} />}
        </div>
      );
    });
    body = <div className="stack">{blocks}</div>;
  }

  return (
    <>
      <header className="admin-header">
        <div>
          <Link href="/admin" className="back-link"><ArrowLeft className="icon" size={14} aria-hidden="true" /> Fila</Link>
          <h1 className="admin-header__title">{find("blog", "pt")?.title ?? "Story"}</h1>
          <p className="admin-header__subtitle">
            {STATUS_LABEL[story.status]} · score {Number(story.score).toFixed(1)} · criada {fmtDateTime(story.created_at)}
          </p>
        </div>
        {editable && <ReviewActions storyId={story.id} />}
      </header>
      <main id="content" className="admin-main">
        <div className="chips">
          <SeverityBadge severity={story.severity} label={SEVERITY_LABEL[story.severity]} />
          <span className="chip">{CATEGORY_LABEL[story.category] ?? story.category}</span>
          {story.cve_ids.map((c) => <span key={c} className="chip mono">{c}</span>)}
        </div>
        {fg?.passed === false && (
          <section className="alert alert--warn" aria-label="Fact Guard">
            <p><AlertTriangle className="icon" size={14} aria-hidden="true" /> <strong>Fact Guard reprovou.</strong> Confira os pontos abaixo antes de aprovar:</p>
            <ul>{fg.issues.map((i, n) => <li key={n}><span className="mono">{i.rule}</span> {i.detail}</li>)}</ul>
          </section>
        )}
        {fg?.passed === true && (
          <p className="alert alert--ok"><CheckCircle2 className="icon" size={14} aria-hidden="true" /> Fact Guard aprovado ({fg.attempts?.length ?? 1} tentativa(s)). Dados de CVSS/EPSS/KEV vêm de fontes oficiais.</p>
        )}
        {story.error && <p className="alert alert--warn">{story.error}</p>}
        <nav className="segmented" aria-label="Conteúdos">
          {TABS.map((t) => (
            <Link key={t.key} href={`/admin/stories/${story.id}?aba=${t.key}`} className="segmented__item" aria-current={t.key === tab ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
        <section className="panel">{body}</section>
      </main>
    </>
  );
}

const APPROVED_STATUSES = ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "PARTIAL"];

type PublishProps = InstagramPublishState & { storyId: string; isAdmin: boolean; approved: boolean };

/** Estado e botão da publicação direta no Instagram (carrossel PT). */
function InstagramPublish({ p }: { p: PublishProps }) {
  const post = p.post;
  if (post?.status === "published") {
    return (
      <p className="alert alert--ok" role="status">
        <CheckCircle2 className="icon" size={14} aria-hidden="true" /> Publicado no Instagram{post.published_at ? ` em ${fmtDateTime(post.published_at)}` : ""}.
        {post.external_url && <> <a href={post.external_url} target="_blank" rel="noopener noreferrer">Ver o post</a></>}
      </p>
    );
  }
  if (post && (post.status === "pending" || post.status === "publishing")) {
    return <p className="section-hint" role="status">Publicando no Instagram… o executor processa em até 1 minuto. Recarregue para ver o resultado.</p>;
  }
  let action: React.ReactNode;
  if (!p.isAdmin) action = <p className="section-hint">Só administradores publicam no Instagram.</p>;
  else if (!p.approved) action = <p className="section-hint">Aprove a story para liberar a publicação no Instagram.</p>;
  else if (!p.account) action = <p className="section-hint">Nenhuma conta do Instagram conectada. <Link href="/admin/integracoes">Conectar em Integrações</Link>.</p>;
  else action = <PublishInstagramButton storyId={p.storyId} account={p.account} retry={Boolean(post)} />;
  return (
    <div className="stack">
      {post?.status === "failed" && <p className="alert alert--warn" role="alert"><AlertTriangle className="icon" size={14} aria-hidden="true" /> Falhou: {post.last_error}</p>}
      {post?.status === "skipped" && <p className="section-hint">{post.last_error}</p>}
      {action}
    </div>
  );
}

const fileName = (a: AssetRow) => `iron-${a.channel}-${a.lang}-${a.kind}-${a.position}.png`;

function Thumb({ a, width }: { a: AssetRow; width: number }) {
  if (!a.public_url) return null;
  return (
    <figure className="creative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={a.public_url} alt={`${a.channel} ${a.kind} ${a.position}`} width={width} height={Math.round(width * ((a.height ?? 1) / (a.width ?? 1)))} loading="lazy" />
      <a className="creative__dl" href={a.public_url} download={fileName(a)} target="_blank" rel="noopener noreferrer">
        <Download className="icon" size={14} aria-hidden="true" /> {a.width}×{a.height}
      </a>
    </figure>
  );
}

/** Pacote para download (§4.10 modo manual): imagens + legendas prontas, por rede e idioma. */
function Creatives({ assets, find, publish }: { assets: AssetRow[]; find: (channel: string, lang: string) => ContentRow | undefined; publish: PublishProps }) {
  if (assets.length === 0) {
    return <p className="section-hint">Os criativos ainda não foram gerados. Eles saem em até 1 minuto depois que a story fica pronta ou um texto é editado.</p>;
  }
  const text = (c: ContentRow | undefined, field: string) => (c && typeof c.body[field] === "string" ? (c.body[field] as string) : "");
  const tags = (c: ContentRow | undefined) => (c && Array.isArray(c.body.hashtags) ? (c.body.hashtags as string[]).join(" ") : "");
  return (
    <div className="stack">
      {(["pt", "en"] as const).map((lang) => {
        const of = (channel: string, kind: string) => assets.filter((a) => a.lang === lang && a.channel === channel && a.kind === kind);
        const ig = of("instagram", "carousel_slide");
        if (!assets.some((a) => a.lang === lang)) return null;
        const igCaption = [text(find("instagram", lang), "caption"), tags(find("instagram", lang))].filter(Boolean).join("\n\n");
        const liText = [text(find("linkedin", lang), "text"), tags(find("linkedin", lang))].filter(Boolean).join("\n\n");
        const fbText = text(find("facebook", lang), "text");
        return (
          <section key={lang} className="channel-block" aria-label={`Criativos ${lang.toUpperCase()}`}>
            <h2 className="section-title">{lang === "pt" ? "Português" : "English"}</h2>
            {ig.length > 0 && (
              <div className="creative-group">
                <h3 className="section-title">Instagram · carrossel ({ig.length} slides)</h3>
                <div className="creative-row">{ig.map((a) => <Thumb key={a.position} a={a} width={180} />)}</div>
                {igCaption && <><p className="pre-wrap creative-text">{igCaption}</p><CopyButton text={igCaption} label="Copiar legenda" /></>}
                {lang === "pt" && <InstagramPublish p={publish} />}
              </div>
            )}
            {of("linkedin", "card").map((a) => (
              <div key="li" className="creative-group">
                <h3 className="section-title">LinkedIn · card</h3>
                <Thumb a={a} width={420} />
                {liText && <><p className="pre-wrap creative-text">{liText}</p><CopyButton text={liText} label="Copiar texto" /></>}
              </div>
            ))}
            {fbText && ig[0] && (
              <div className="creative-group">
                <h3 className="section-title">Facebook · imagem do 1º slide + texto</h3>
                <p className="pre-wrap creative-text">{fbText}</p><CopyButton text={fbText} label="Copiar texto" />
              </div>
            )}
            <div className="creative-row">
              {of("blog", "cover").map((a) => <div key="cover" className="creative-group"><h3 className="section-title">Capa do blog / compartilhamento</h3><Thumb a={a} width={360} /></div>)}
              {of("youtube", "thumbnail").map((a) => <div key="yt" className="creative-group"><h3 className="section-title">Capa do Short</h3><Thumb a={a} width={150} /></div>)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
