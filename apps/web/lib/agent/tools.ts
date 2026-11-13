/**
 * Ferramentas do agente do WhatsApp para o Iron Cyber News. Cada uma vira uma tool MCP no OpenClaw
 * (iron_news__<nome>). Leituras usam a service_role (só colunas necessárias); escritas usam as RPCs agent_*,
 * que exigem um admin real e registram via='whatsapp' no audit_log.
 * Ferramentas com `confirm` exigem o código de 6 dígitos que o admin recebe fora do LLM (ver confirm.ts).
 */
import { z } from "zod";
import type { AgentContext } from "./auth";
import { AgentError, rpcError } from "./db";

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  confirm?: (args: z.output<S>, ctx: AgentContext) => Promise<string> | string;
  run: (args: z.output<S>, ctx: AgentContext) => Promise<unknown>;
}

const defineTool = <S extends z.ZodType>(t: AgentTool<S>): AgentTool<S> => t;

const uuid = z.string().uuid();
const lang = z.enum(["pt", "en"]);
const adminBase = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "https://news.iron-security.com").replace(/\/+$/, "");
const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

async function rpc(ctx: AgentContext, fn: string, args: Record<string, unknown>) {
  const { data, error } = await ctx.db.rpc(fn, args);
  if (error) throw rpcError(error.message);
  return data;
}

/** Título PT do artigo (o mesmo que o painel mostra na fila). */
async function titles(ctx: AgentContext, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!ids.length) return map;
  const { data, error } = await ctx.db
    .from("latest_contents").select("story_id, lang, title").in("story_id", ids)
    .eq("channel", "blog").eq("kind", "article");
  if (error) throw new Error(error.message);
  for (const c of data ?? []) if (c.lang === "pt" || !map.has(c.story_id)) map.set(c.story_id, c.title);
  return map;
}

async function storyLabel(ctx: AgentContext, id: string): Promise<{ title: string; status: string }> {
  const { data, error } = await ctx.db.from("stories").select("id, status").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new AgentError(404, "Matéria não encontrada");
  const t = (await titles(ctx, [id])).get(id);
  return { title: t ?? "(sem título)", status: data.status };
}

const STATUS_GROUPS = {
  fila: ["AWAITING_REVIEW"],
  producao: ["DRAFTING"],
  aprovadas: ["APPROVED", "SCHEDULED", "PUBLISHING"],
  publicadas: ["PUBLISHED", "PARTIAL"],
  rejeitadas: ["REJECTED"],
  falhas: ["FAILED"],
} as const;

async function listStories(ctx: AgentContext, statuses: readonly string[], limit: number) {
  const { data, error } = await ctx.db
    .from("stories")
    .select("id, status, score, category, severity, cve_ids, fact_guard, scheduled_for, published_at, created_at, rejected_reason, error")
    .in("status", [...statuses]).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const t = await titles(ctx, (data ?? []).map((s) => s.id));
  return (data ?? []).map((s) => ({
    story_id: s.id,
    titulo: t.get(s.id) ?? null,
    status: s.status,
    categoria: s.category,
    severidade: s.severity,
    pontuacao: Number(s.score),
    cves: s.cve_ids,
    checagem_ok: (s.fact_guard as { passed?: boolean | null })?.passed ?? null,
    criada_em: s.created_at,
    agendada_para: s.scheduled_for,
    publicada_em: s.published_at,
    motivo_rejeicao: s.rejected_reason,
    erro: s.error,
  }));
}

/** Campos editáveis por canal:tipo (o resto do corpo é preservado pela RPC). Igual ao painel. */
const EDITABLE: Record<string, { kind: string; fields: string[] }> = {
  blog: { kind: "article", fields: ["tldr", "markdown", "meta_description"] },
  facebook: { kind: "post", fields: ["text"] },
  linkedin: { kind: "post", fields: ["text"] },
  instagram: { kind: "carousel", fields: ["caption"] },
  youtube: { kind: "script", fields: ["script"] },
};

// ─── Leitura ──────────────────────────────────────────────────────────

const filaRevisao = defineTool({
  name: "fila_revisao",
  description: "Matérias aguardando revisão (mais novas primeiro): título, categoria, severidade, pontuação, CVEs e se passou na checagem de fatos.",
  input: z.object({ limite: z.number().int().min(1).max(30).default(10) }),
  run: ({ limite }, ctx) => listStories(ctx, STATUS_GROUPS.fila, limite),
});

const listarMaterias = defineTool({
  name: "listar_materias",
  description: "Lista matérias por grupo: fila, producao (IA escrevendo), aprovadas (agendadas/publicando), publicadas, rejeitadas, falhas.",
  input: z.object({
    grupo: z.enum(["fila", "producao", "aprovadas", "publicadas", "rejeitadas", "falhas"]),
    limite: z.number().int().min(1).max(30).default(10),
  }),
  run: ({ grupo, limite }, ctx) => listStories(ctx, STATUS_GROUPS[grupo], limite),
});

const verMateria = defineTool({
  name: "ver_materia",
  description:
    "Abre uma matéria para revisão: textos de cada canal no idioma pedido (blog, Instagram, LinkedIn, Facebook, Shorts), alertas da checagem de fatos, fontes, links das imagens e situação da publicação.",
  input: z.object({ story_id: uuid, idioma: lang.default("pt") }),
  async run({ story_id, idioma }, ctx) {
    const [{ data: s, error }, contents, links, assets, posts] = await Promise.all([
      ctx.db.from("stories").select("id, status, score, category, severity, cve_ids, fact_guard, scheduled_for, published_at, slug_pt, slug_en, rejected_reason, error").eq("id", story_id).maybeSingle(),
      ctx.db.from("latest_contents").select("channel, kind, version, title, body, edited_by").eq("story_id", story_id).eq("lang", idioma),
      ctx.db.from("story_sources").select("raw_items(title, url, sources(name))").eq("story_id", story_id),
      ctx.db.from("assets").select("channel, kind, position, content_version, public_url").eq("story_id", story_id).eq("lang", idioma).eq("status", "ready").order("content_version", { ascending: false }),
      ctx.db.from("channel_posts").select("channel, lang, target, status, external_url, last_error, scheduled_for, published_at").eq("story_id", story_id),
    ]);
    if (error) throw new Error(error.message);
    if (!s) throw new AgentError(404, "Matéria não encontrada");

    const textos: Record<string, unknown> = {};
    for (const c of contents.data ?? []) {
      const b = (c.body ?? {}) as Record<string, unknown>;
      const base = { versao: c.version, editado_por_humano: Boolean(c.edited_by), titulo: c.title };
      if (c.channel === "blog") {
        textos.blog = { ...base, resumo: b.tldr, meta_descricao: b.meta_description, artigo: cut(b.markdown, 2500), tags: b.tags };
      } else if (c.channel === "instagram") {
        const slides = (Array.isArray(b.slides) ? b.slides : []) as { heading?: string; body?: string }[];
        textos.instagram = { ...base, slides: slides.map((x, i) => `${i + 1}. ${x.heading ?? ""} — ${cut(x.body, 200)}`), legenda: b.caption, hashtags: b.hashtags };
      } else if (c.channel === "linkedin") {
        textos.linkedin = { ...base, texto: b.text, hashtags: b.hashtags };
      } else if (c.channel === "facebook") {
        textos.facebook = { ...base, texto: b.text };
      } else if (c.channel === "youtube") {
        textos.shorts = { ...base, gancho: b.on_screen_hook, roteiro: cut(b.script, 1200) };
      }
    }
    const seen = new Set<string>();
    const imagens = (assets.data ?? []).filter((a) => {
      const k = `${a.channel}|${a.kind}|${a.position}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return Boolean(a.public_url);
    }).sort((a, b) => a.position - b.position).map((a) => ({ canal: a.channel, tipo: a.kind, ordem: a.position, url: a.public_url }));
    const fg = (s.fact_guard ?? {}) as { passed?: boolean | null; issues?: { rule: string; detail: string }[] };
    const fontes = (links.data ?? []).flatMap((l) => {
      const r = l.raw_items as unknown as { title: string; url: string; sources: { name: string } | null } | null;
      return r ? [{ fonte: r.sources?.name ?? "", titulo: r.title, url: r.url }] : [];
    });
    return {
      story_id: s.id,
      status: s.status,
      categoria: s.category,
      severidade: s.severity,
      pontuacao: Number(s.score),
      cves: s.cve_ids,
      checagem_fatos: { ok: fg.passed ?? null, alertas: (fg.issues ?? []).slice(0, 10) },
      textos,
      imagens,
      fontes: fontes.slice(0, 10),
      publicacao: posts.data ?? [],
      painel: `${adminBase()}/admin/stories/${s.id}`,
      motivo_rejeicao: s.rejected_reason,
      erro: s.error,
    };
  },
});

const statusPublicacao = defineTool({
  name: "status_publicacao",
  description: "Situação da publicação de uma matéria em cada canal: pendente, publicando, publicado (com link), falhou (com erro) ou ignorado.",
  input: z.object({ story_id: uuid }),
  async run({ story_id }, ctx) {
    const { title, status } = await storyLabel(ctx, story_id);
    const { data, error } = await ctx.db
      .from("channel_posts").select("channel, lang, target, status, attempts, external_url, last_error, scheduled_for, published_at")
      .eq("story_id", story_id).order("channel");
    if (error) throw new Error(error.message);
    return { titulo: title, status_materia: status, canais: data ?? [] };
  },
});

const integracoes = defineTool({
  name: "integracoes",
  description: "Contas conectadas (Instagram, LinkedIn perfil/página): ativa, expirada ou precisando reconectar. Reconectar é feito no painel do News.",
  input: z.object({}),
  async run(_a, ctx) {
    const { data, error } = await ctx.db
      .from("integrations").select("channel, lang, target, account_name, status, expires_at, updated_at").order("channel");
    if (error) throw new Error(error.message);
    const now = Date.now();
    return {
      contas: (data ?? []).map((i) => ({
        canal: i.channel, idioma: i.lang, alvo: i.target, conta: i.account_name, status: i.status,
        expira_em: i.expires_at, vencida: Boolean(i.expires_at && new Date(i.expires_at).getTime() < now),
      })),
      reconectar_em: `${adminBase()}/admin/integracoes`,
    };
  },
});

const falhas = defineTool({
  name: "falhas",
  description: "O que deu errado nos últimos N dias: matérias com falha ou publicação parcial, posts que falharam por canal e fontes com erro ou desligadas.",
  input: z.object({ dias: z.number().int().min(1).max(30).default(7) }),
  async run({ dias }, ctx) {
    const since = new Date(Date.now() - dias * 86_400_000).toISOString();
    const [stories, posts, sources] = await Promise.all([
      ctx.db.from("stories").select("id, status, error, created_at").in("status", ["FAILED", "PARTIAL"]).gte("created_at", since).order("created_at", { ascending: false }).limit(20),
      ctx.db.from("channel_posts").select("story_id, channel, lang, target, attempts, last_error, updated_at").eq("status", "failed").gte("updated_at", since).limit(20),
      ctx.db.from("sources").select("id, name, enabled, consecutive_failures, last_error").or("enabled.eq.false,consecutive_failures.gt.0").limit(30),
    ]);
    for (const r of [stories, posts, sources]) if (r.error) throw new Error(r.error.message);
    const t = await titles(ctx, [...new Set([...(stories.data ?? []).map((s) => s.id), ...(posts.data ?? []).map((p) => p.story_id)])]);
    return {
      materias: (stories.data ?? []).map((s) => ({ story_id: s.id, titulo: t.get(s.id) ?? null, status: s.status, erro: cut(s.error, 300) })),
      posts: (posts.data ?? []).map((p) => ({ story_id: p.story_id, titulo: t.get(p.story_id) ?? null, canal: p.channel, idioma: p.lang, alvo: p.target, tentativas: p.attempts, erro: cut(p.last_error, 300) })),
      fontes: (sources.data ?? []).map((s) => ({ source_id: s.id, nome: s.name, ligada: s.enabled, falhas_seguidas: s.consecutive_failures, erro: cut(s.last_error, 200) })),
    };
  },
});

const custosIa = defineTool({
  name: "custos_ia",
  description: "Gasto com IA no mês (US$) contra o orçamento mensal, por tarefa, e quantas matérias foram geradas, aprovadas e publicadas no mês.",
  input: z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
  async run({ mes }, ctx) {
    const start = mes ? new Date(`${mes}-01T00:00:00Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const [usage, settings, stories] = await Promise.all([
      ctx.db.from("llm_usage").select("task, cost_usd").gte("created_at", start.toISOString()).lt("created_at", end.toISOString()).limit(50_000),
      ctx.db.from("settings").select("llm_monthly_budget_usd").limit(1).maybeSingle(),
      ctx.db.from("stories").select("status").gte("created_at", start.toISOString()).lt("created_at", end.toISOString()).limit(5_000),
    ]);
    for (const r of [usage, settings, stories]) if (r.error) throw new Error(r.error.message);
    const byTask: Record<string, number> = {};
    let total = 0;
    for (const u of usage.data ?? []) {
      const v = Number(u.cost_usd);
      total += v;
      byTask[u.task] = Math.round(((byTask[u.task] ?? 0) + v) * 100) / 100;
    }
    const byStatus: Record<string, number> = {};
    for (const s of stories.data ?? []) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const budget = Number(settings.data?.llm_monthly_budget_usd ?? 0);
    return {
      mes: start.toISOString().slice(0, 7),
      gasto_usd: Math.round(total * 100) / 100,
      orcamento_usd: budget,
      uso_pct: budget ? Math.round((total / budget) * 1000) / 10 : null,
      por_tarefa: byTask,
      materias_por_status: byStatus,
    };
  },
});

const fontes = defineTool({
  name: "fontes",
  description: "Fontes de notícias (id, nome, idioma, ligada, falhas seguidas, último erro). Use apenas_problemas para ver só as com erro ou desligadas.",
  input: z.object({ apenas_problemas: z.boolean().default(false) }),
  async run({ apenas_problemas }, ctx) {
    let q = ctx.db.from("sources").select("id, name, lang, enabled, consecutive_failures, last_error, last_fetched_at").order("name").limit(100);
    if (apenas_problemas) q = q.or("enabled.eq.false,consecutive_failures.gt.0");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map((s) => ({
      source_id: s.id, nome: s.name, idioma: s.lang, ligada: s.enabled, falhas_seguidas: s.consecutive_failures,
      ultima_coleta: s.last_fetched_at, erro: cut(s.last_error, 200),
    }));
  },
});

// ─── Revisão ──────────────────────────────────────────────────────────

const editarTexto = defineTool({
  name: "editar_texto",
  description:
    "Edita o texto de um canal enquanto a matéria está na fila (gera nova versão e refaz as imagens). Campos por canal: blog {tldr, markdown (mín. 200 caracteres), meta_description}; instagram {caption}; linkedin {text}; facebook {text}; youtube {script}. titulo opcional (máx. 120).",
  input: z.object({
    story_id: uuid,
    canal: z.enum(["blog", "instagram", "linkedin", "facebook", "youtube"]),
    idioma: lang.default("pt"),
    titulo: z.string().trim().min(1).max(120).optional(),
    campos: z.record(z.string(), z.string().max(30_000)).default({}),
  }),
  async run(a, ctx) {
    const spec = EDITABLE[a.canal];
    if (!spec) throw new AgentError(400, "Canal inválido");
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.campos)) {
      if (!spec.fields.includes(k)) throw new AgentError(400, `Campo "${k}" não é editável em ${a.canal}. Use: ${spec.fields.join(", ")}`);
      patch[k] = v.replace(/\r\n/g, "\n").trim();
    }
    if (!Object.keys(patch).length && !a.titulo) throw new AgentError(400, "Nada para alterar");
    if (patch.markdown !== undefined && patch.markdown.length < 200) throw new AgentError(400, "O artigo ficou curto demais (mínimo 200 caracteres).");
    const r = await rpc(ctx, "agent_edit", {
      p_actor: ctx.actor, p_story: a.story_id, p_channel: a.canal, p_lang: a.idioma, p_kind: spec.kind, p_title: a.titulo ?? null, p_patch: patch,
    });
    return { ok: true, nova_versao: (r as { version: number }).version, aviso: "As imagens são refeitas em até 1 minuto." };
  },
});

const aprovarMateria = defineTool({
  name: "aprovar_materia",
  description:
    "Aprova a matéria e agenda o blog (PT e EN): sem publicar_em, publica no blog em até 1 minuto; com publicar_em (ISO 8601 com fuso, até 30 dias), publica nesse horário. Instagram e LinkedIn são pedidos depois, com publicar_instagram / publicar_linkedin. Exige confirmação.",
  input: z.object({ story_id: uuid, publicar_em: z.string().datetime({ offset: true }).optional() }),
  async confirm(a, ctx) {
    const { title } = await storyLabel(ctx, a.story_id);
    const quando = a.publicar_em ? `agendar o blog para ${a.publicar_em}` : "publicar no blog agora";
    return `Aprovar "${title}" e ${quando}?`;
  },
  async run(a, ctx) {
    const r = await rpc(ctx, "agent_approve", { p_actor: ctx.actor, p_story: a.story_id, p_when: a.publicar_em ?? null });
    return { ok: true, status: (r as { status: string }).status };
  },
});

const rejeitarMateria = defineTool({
  name: "rejeitar_materia",
  description: "Rejeita uma matéria da fila com um motivo (3 a 500 caracteres). Não volta para a fila. Exige confirmação.",
  input: z.object({ story_id: uuid, motivo: z.string().trim().min(3).max(500) }),
  async confirm(a, ctx) {
    const { title } = await storyLabel(ctx, a.story_id);
    return `Rejeitar "${title}"? Motivo: ${a.motivo}`;
  },
  async run(a, ctx) {
    await rpc(ctx, "agent_reject", { p_actor: ctx.actor, p_story: a.story_id, p_reason: a.motivo });
    return { ok: true, status: "REJECTED" };
  },
});

const publicarInstagram = defineTool({
  name: "publicar_instagram",
  description:
    "Publica o carrossel no Instagram (matéria já aprovada, conta conectada, slides prontos). Se a publicação anterior falhou, tenta de novo. O executor publica em até 1 minuto; confira com status_publicacao. Exige confirmação.",
  input: z.object({ story_id: uuid, idioma: lang.default("pt") }),
  async confirm(a, ctx) {
    const { title } = await storyLabel(ctx, a.story_id);
    const { data: post } = await ctx.db.from("channel_posts").select("status, external_url").eq("story_id", a.story_id).eq("channel", "instagram").eq("lang", a.idioma).maybeSingle();
    const aviso = post?.status === "failed" ? " (nova tentativa: confira antes no Instagram se o post não saiu mesmo)" : "";
    return `Publicar o carrossel de "${title}" no Instagram (${a.idioma.toUpperCase()})${aviso}?`;
  },
  async run(a, ctx) {
    const r = await rpc(ctx, "agent_publish_instagram", { p_actor: ctx.actor, p_story: a.story_id, p_lang: a.idioma });
    return { ok: true, status: (r as { status: string }).status };
  },
});

const publicarLinkedin = defineTool({
  name: "publicar_linkedin",
  description:
    "Publica o post no LinkedIn: alvo member (perfil do Diego) ou organization (página da Iron). Matéria já aprovada, conta do alvo conectada e card pronto. Se falhou antes, tenta de novo. Exige confirmação.",
  input: z.object({ story_id: uuid, alvo: z.enum(["member", "organization"]), idioma: lang.default("pt") }),
  async confirm(a, ctx) {
    const { title } = await storyLabel(ctx, a.story_id);
    const onde = a.alvo === "member" ? "no seu perfil" : "na página da Iron";
    const { data: post } = await ctx.db.from("channel_posts").select("status").eq("story_id", a.story_id).eq("channel", "linkedin").eq("lang", a.idioma).eq("target", a.alvo).maybeSingle();
    const aviso = post?.status === "failed" ? " (nova tentativa: confira antes no LinkedIn se o post não saiu mesmo)" : "";
    return `Publicar "${title}" no LinkedIn ${onde} (${a.idioma.toUpperCase()})${aviso}?`;
  },
  async run(a, ctx) {
    const r = await rpc(ctx, "agent_publish_linkedin", { p_actor: ctx.actor, p_story: a.story_id, p_target: a.alvo, p_lang: a.idioma });
    return { ok: true, status: (r as { status: string }).status };
  },
});

// ─── Fontes ───────────────────────────────────────────────────────────

const pausarFonte = defineTool({
  name: "pausar_fonte",
  description: "Desliga a coleta de uma fonte de notícias. Exige confirmação.",
  input: z.object({ source_id: uuid }),
  async confirm(a, ctx) {
    const { data } = await ctx.db.from("sources").select("name").eq("id", a.source_id).maybeSingle();
    if (!data) throw new AgentError(404, "Fonte não encontrada");
    return `Pausar a coleta da fonte "${data.name}"?`;
  },
  async run(a, ctx) {
    return { ok: true, fonte: await rpc(ctx, "agent_set_source_enabled", { p_actor: ctx.actor, p_source: a.source_id, p_enabled: false }) };
  },
});

const retomarFonte = defineTool({
  name: "retomar_fonte",
  description: "Religa a coleta de uma fonte (zera o contador de falhas).",
  input: z.object({ source_id: uuid }),
  async run(a, ctx) {
    return { ok: true, fonte: await rpc(ctx, "agent_set_source_enabled", { p_actor: ctx.actor, p_source: a.source_id, p_enabled: true }) };
  },
});

export const TOOLS: AgentTool[] = [
  filaRevisao, listarMaterias, verMateria, statusPublicacao, integracoes, falhas, custosIa, fontes,
  editarTexto, aprovarMateria, rejeitarMateria, publicarInstagram, publicarLinkedin, pausarFonte, retomarFonte,
] as AgentTool[];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const findTool = (name: string): AgentTool | null => byName.get(name) ?? null;

/** Manifesto lido pelo servidor MCP (nome, descrição, se pede confirmação e JSON Schema da entrada). */
export function toolManifest() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    requires_confirmation: Boolean(t.confirm),
    input_schema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }),
  }));
}
