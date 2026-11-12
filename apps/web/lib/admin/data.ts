import type { Lang, Severity, StoryStatus } from "@ironnews/shared";
import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "editor" | "viewer";
export interface Viewer {
  id: string;
  email: string;
  role: Role | null;
}

export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  return { id: user.id, email: user.email ?? "", role: (data?.role as Role | undefined) ?? null };
}

export const canEdit = (v: Viewer | null) => v?.role === "admin" || v?.role === "editor";

export interface FactGuard {
  passed: boolean | null;
  issues: { rule: string; detail: string }[];
  attempts?: { model: string; issues: { rule: string; detail: string }[] }[];
}

export interface StoryRow {
  id: string;
  status: StoryStatus;
  score: number;
  category: string;
  severity: Severity;
  cve_ids: string[];
  tags: string[];
  slug_pt: string | null;
  slug_en: string | null;
  fact_guard: FactGuard;
  facts: { cves?: Record<string, unknown> };
  error: string | null;
  rejected_reason: string | null;
  created_at: string;
  approved_at: string | null;
}

export interface ContentRow {
  id: string;
  channel: "blog" | "instagram" | "facebook" | "linkedin" | "youtube";
  lang: Lang;
  kind: "article" | "post" | "carousel" | "script";
  version: number;
  title: string | null;
  body: Record<string, unknown>;
  edited_by: string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: string;
}

const STORY_COLUMNS =
  "id, status, score, category, severity, cve_ids, tags, slug_pt, slug_en, fact_guard, facts, error, rejected_reason, created_at, approved_at";

export async function listStories(statuses: StoryStatus[]): Promise<(StoryRow & { title: string | null })[]> {
  const supabase = await createClient();
  const { data: stories, error } = await supabase
    .from("stories").select(STORY_COLUMNS).in("status", statuses).order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  const ids = (stories ?? []).map((s) => s.id);
  const titles = new Map<string, string | null>();
  if (ids.length) {
    const { data } = await supabase
      .from("latest_contents").select("story_id, title").in("story_id", ids)
      .eq("channel", "blog").eq("kind", "article").eq("lang", "pt");
    for (const c of data ?? []) titles.set(c.story_id as string, c.title as string | null);
  }
  return (stories ?? []).map((s) => ({ ...(s as unknown as StoryRow), title: titles.get(s.id) ?? null }));
}

export interface SourceRow {
  id: string;
  title: string;
  url: string;
  published_at: string | null;
  source: string;
}

export async function getStory(id: string): Promise<{ story: StoryRow; contents: ContentRow[]; sources: SourceRow[] } | null> {
  const supabase = await createClient();
  const { data: story } = await supabase.from("stories").select(STORY_COLUMNS).eq("id", id).maybeSingle();
  if (!story) return null;
  const [{ data: contents }, { data: links }] = await Promise.all([
    supabase.from("latest_contents").select("id, channel, lang, kind, version, title, body, edited_by, model, prompt_version, created_at").eq("story_id", id),
    supabase.from("story_sources").select("raw_items(id, title, url, published_at, sources(name))").eq("story_id", id),
  ]);
  const sources = (links ?? []).flatMap((l) => {
    const r = l.raw_items as unknown as { id: string; title: string; url: string; published_at: string | null; sources: { name: string } | null } | null;
    return r ? [{ id: r.id, title: r.title, url: r.url, published_at: r.published_at, source: r.sources?.name ?? "" }] : [];
  });
  return { story: story as unknown as StoryRow, contents: (contents ?? []) as ContentRow[], sources };
}

/** Mensagens das RPCs de revisão (o banco devolve o código no texto do erro). */
export function rpcErrorMessage(message: string): string {
  if (message.includes("MFA_REQUIRED")) return "Sessão sem verificação em duas etapas. Entre de novo.";
  if (message.includes("UNAUTHENTICATED")) return "Sessão expirada. Entre de novo.";
  if (message.includes("FORBIDDEN")) return "Seu papel não permite esta ação (é preciso ser editor ou admin).";
  if (message.includes("INVALID_STATE")) return "A story mudou de estado (talvez outra pessoa já tenha revisado). Recarregue a página.";
  if (message.includes("VALIDATION_ERROR")) return message.replace(/^.*VALIDATION_ERROR:?\s*/, "") || "Dados inválidos.";
  if (message.includes("NOT_FOUND")) return "Conteúdo não encontrado.";
  return "Não foi possível concluir a ação. Tente de novo.";
}

export interface AssetRow {
  channel: "blog" | "instagram" | "linkedin" | "youtube" | "facebook";
  lang: Lang;
  kind: "cover" | "carousel_slide" | "card" | "thumbnail" | "video";
  position: number;
  content_version: number;
  public_url: string | null;
  width: number | null;
  height: number | null;
}

/** Criativos mais recentes de cada posição (a versão de conteúdo mais alta vence). */
export async function getAssets(storyId: string): Promise<AssetRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("assets")
    .select("channel, lang, kind, position, content_version, public_url, width, height")
    .eq("story_id", storyId).eq("status", "ready")
    .order("content_version", { ascending: false });
  const latest = new Map<string, AssetRow>();
  for (const a of (data ?? []) as AssetRow[]) {
    const key = `${a.channel}|${a.lang}|${a.kind}|${a.position}`;
    if (!latest.has(key)) latest.set(key, a);
  }
  return [...latest.values()].sort((x, y) => x.position - y.position);
}

export interface InstagramPublishState {
  /** Conta conectada e válida (via RPC: o painel nunca lê a tabela integrations). */
  account: string | null;
  post: { status: "pending" | "publishing" | "published" | "failed" | "skipped"; last_error: string | null; external_url: string | null; published_at: string | null } | null;
}

/** Estado da publicação do carrossel PT no Instagram para a aba Criativos. */
export async function getInstagramPublish(storyId: string): Promise<InstagramPublishState> {
  const supabase = await createClient();
  const [integrations, posts] = await Promise.all([
    supabase.rpc("integrations_list"),
    supabase.from("channel_posts").select("status, last_error, external_url, published_at")
      .eq("story_id", storyId).eq("channel", "instagram").eq("lang", "pt").maybeSingle(),
  ]);
  const ig = ((integrations.data ?? []) as { channel: string; lang: string; account_name: string; status: string; expires_at: string | null }[])
    .find((r) => r.channel === "instagram" && r.lang === "pt");
  const valid = ig && ig.status === "active" && (!ig.expires_at || new Date(ig.expires_at).getTime() > Date.now());
  return { account: valid ? ig.account_name : null, post: (posts.data as InstagramPublishState["post"]) ?? null };
}
