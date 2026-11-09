import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink } from "lucide-react";
import { SeverityBadge } from "@/components/SeverityBadge";
import { canEdit, getStory, getViewer, type ContentRow } from "@/lib/admin/data";
import { CATEGORY_LABEL, CHANNEL_LABEL, SEVERITY_LABEL, STATUS_LABEL, fmtDateTime } from "@/lib/admin/labels";
import { EditForm, ReviewActions } from "./ReviewForms";

export const metadata: Metadata = { title: "Story" };
export const dynamic = "force-dynamic";

const TABS = [
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
  if (tab === "pt" || tab === "en") {
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
