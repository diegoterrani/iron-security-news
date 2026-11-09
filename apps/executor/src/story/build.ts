import Anthropic from "@anthropic-ai/sdk";
import {
  ArticleSchema, DERIVATIVES_PROMPT_VERSION, DERIVATIVES_SYSTEM, DerivativesSchema, WRITER_PROMPT_VERSION, WRITER_SYSTEM,
  type Article, type Derivatives, type Lang,
} from "@ironnews/shared";
import type { Pool } from "../db";
import { enrichCves, type Facts } from "../facts/enrich";
import { extractCves, truncate } from "../ingest/normalize";
import type { Logger } from "../logger";
import { jsonSchemaFormat } from "../llm/format";
import { budgetStatus, recordUsage, type ModelPrice } from "../llm/usage";
import { factGuard, type GuardIssue, type GuardSource } from "./factguard";
import { renderPlaceholders } from "./placeholders";
import { slugify } from "./slug";

export interface BuildDeps {
  pool: Pool;
  log: Logger;
  client: Anthropic;
  brandId: string;
  model: string;
  fallbackModel: string;
  prices: Record<string, ModelPrice>;
  nvdApiKey?: string;
}

interface StoryRow {
  id: string;
  status: string;
  category: string;
  severity: string;
  cve_ids: string[];
  created_at: Date;
}

export interface BuildSource extends GuardSource {
  name: string;
  url: string;
  published_at: Date | null;
}

/** Story mais velha que isso sem conteúdo perdeu a atualidade. */
const STALE_HOURS = 36;
const attr = (s: string) => s.replace(/["<>&]/g, " ").trim();

// ---------------------------------------------------------------------------
// Requisições

export function writerUserContent(sources: BuildSource[], facts: Facts, story: Pick<StoryRow, "category" | "severity">, issues: GuardIssue[] = []): string {
  // Para o redator, só existência/descrição/severidade: os números oficiais entram pelos placeholders (RN-FG02).
  const factsForLlm = Object.fromEntries(Object.entries(facts.cves).map(([id, f]) => [id, {
    exists_in_nvd: f.exists, severity: f.cvss?.severity ?? null, description: f.description ?? null,
  }]));
  const blocks = sources.map((s) => [
    `<source id="${s.id}" name="${attr(s.name)}" url="${attr(s.url)}"${s.published_at ? ` published="${s.published_at.toISOString().slice(0, 10)}"` : ""}>`,
    `Título: ${s.title}`,
    s.summary ? `Resumo: ${s.summary}` : "",
    s.excerpt && s.excerpt !== s.summary ? `Trecho: ${s.excerpt}` : "",
    "</source>",
  ].filter(Boolean).join("\n"));
  const parts = [
    blocks.join("\n\n"),
    `<facts>${JSON.stringify({ cves: factsForLlm })}</facts>`,
    `Categoria da pauta: ${story.category}. Severidade estimada: ${story.severity}.`,
  ];
  if (issues.length) {
    parts.push(`<issues>\n${issues.map((i) => `- [${i.rule}] ${i.detail}`).join("\n")}\n</issues>\nA versão anterior foi reprovada pela checagem de fatos pelos motivos acima. Reescreva corrigindo todos eles.`);
  }
  return parts.join("\n\n");
}

export function writerParams(model: string, content: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    // PT + EN + raciocínio passam de 11 mil tokens; com streaming o limite alto não esbarra em timeout HTTP.
    max_tokens: 32000,
    system: [{ type: "text", text: WRITER_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: jsonSchemaFormat(ArticleSchema) },
    messages: [{ role: "user", content }],
  };
}

export function derivativesParams(model: string, lang: Lang, article: Article["pt"]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 8000,
    system: [{ type: "text", text: DERIVATIVES_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: jsonSchemaFormat(DerivativesSchema) },
    messages: [{ role: "user", content: `<article lang="${lang}">\n# ${article.title}\n\n${article.markdown}\n</article>` }],
  };
}

// ---------------------------------------------------------------------------
// Parsing tolerante a detalhes (corta excessos inofensivos; o resto vira problema e nova tentativa)

function jsonFrom(msg: Anthropic.Message): unknown {
  if (msg.stop_reason === "refusal") throw new Error("modelo recusou");
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error(`sem saída (${msg.stop_reason})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON inválido (${msg.stop_reason})`);
  }
}

export function coerceArticle(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const a = { ...(raw as Record<string, unknown>) };
  for (const lang of ["pt", "en"]) {
    const l = a[lang];
    if (l && typeof l === "object") {
      const x = { ...(l as Record<string, unknown>) };
      if (typeof x.meta_description === "string") x.meta_description = truncate(x.meta_description, 155);
      if (Array.isArray(x.tags)) x.tags = x.tags.filter((t) => typeof t === "string").map((t: string) => t.slice(0, 30)).slice(0, 8);
      if (typeof x.tldr === "string") x.tldr = truncate(x.tldr, 300);
      a[lang] = x;
    }
  }
  if (Array.isArray(a.cves_mentioned)) {
    a.cves_mentioned = [...new Set(a.cves_mentioned.filter((c) => typeof c === "string").map((c: string) => c.toUpperCase()))]
      .filter((c) => /^CVE-\d{4}-\d{4,7}$/.test(c));
  }
  return a;
}

const hashtag = (h: string) => "#" + h.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9_]/g, "");

export function coerceDerivatives(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const d = structuredClone(raw) as Record<string, any>;
  if (d.instagram) {
    if (Array.isArray(d.instagram.hashtags)) d.instagram.hashtags = [...new Set(d.instagram.hashtags.map(String).map(hashtag).filter((h: string) => h.length > 1))].slice(0, 12);
    if (Array.isArray(d.instagram.slides)) {
      d.instagram.slides = d.instagram.slides.slice(0, 6).map((s: any) => ({ heading: String(s?.heading ?? "").slice(0, 60), body: truncate(String(s?.body ?? ""), 220) }));
    }
    if (typeof d.instagram.alt_text === "string") d.instagram.alt_text = truncate(d.instagram.alt_text, 300);
    if (typeof d.instagram.caption === "string") d.instagram.caption = truncate(d.instagram.caption, 2000);
  }
  if (d.linkedin) {
    if (Array.isArray(d.linkedin.hashtags)) d.linkedin.hashtags = [...new Set(d.linkedin.hashtags.map(String).map(hashtag))].slice(0, 5);
    if (typeof d.linkedin.alt_text === "string") d.linkedin.alt_text = truncate(d.linkedin.alt_text, 300);
  }
  if (d.youtube) {
    if (typeof d.youtube.title === "string") d.youtube.title = truncate(d.youtube.title, 90);
    if (typeof d.youtube.on_screen_hook === "string") d.youtube.on_screen_hook = truncate(d.youtube.on_screen_hook, 50);
    if (typeof d.youtube.description === "string") d.youtube.description = truncate(d.youtube.description, 1500);
    if (Array.isArray(d.youtube.tags)) d.youtube.tags = d.youtube.tags.map((t: unknown) => String(t).slice(0, 30)).slice(0, 12);
  }
  return d;
}

const firstIssue = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

// ---------------------------------------------------------------------------

async function loadSources(pool: Pool, storyId: string): Promise<BuildSource[]> {
  const { rows } = await pool.query<BuildSource>(
    `select r.id, s.name, r.url, r.title, r.summary, r.content_excerpt as excerpt, r.published_at
       from story_sources ss join raw_items r on r.id = ss.raw_item_id join sources s on s.id = r.source_id
      where ss.story_id = $1
      order by r.relevance desc nulls last, s.trust_weight desc`,
    [storyId],
  );
  return rows;
}

async function failStory(pool: Pool, storyId: string, error: string) {
  await pool.query("update stories set status = 'FAILED', error = $2 where id = $1 and status = 'DRAFTING'", [storyId, error.slice(0, 500)]);
}

/** Gera artigo + derivados de uma story em DRAFTING (§9.5). Idempotente: outra situação é ignorada. */
export async function buildStory(deps: BuildDeps, storyId: string): Promise<"built" | "skipped" | "failed"> {
  const { pool, log, client } = deps;
  const { rows } = await pool.query<StoryRow>(
    "select id, status, category, severity::text, cve_ids, created_at from stories where id = $1",
    [storyId],
  );
  const story = rows[0];
  if (!story || story.status !== "DRAFTING") return "skipped";
  if (Date.now() - story.created_at.getTime() > STALE_HOURS * 3_600_000) {
    await failStory(pool, storyId, `pauta com mais de ${STALE_HOURS} h sem conteúdo`);
    return "failed";
  }
  const budget = await budgetStatus(pool, deps.brandId);
  if (budget.ratio >= 1) {
    await failStory(pool, storyId, `orçamento de IA atingido (US$ ${budget.spent.toFixed(2)} de ${budget.budget.toFixed(2)})`);
    return "failed";
  }
  const sources = await loadSources(pool, storyId);
  if (sources.length === 0) {
    await failStory(pool, storyId, "story sem fontes");
    return "failed";
  }
  let facts = await enrichCves(pool, story.cve_ids, { nvdApiKey: deps.nvdApiKey });

  // ---- artigo + Fact Guard: Haiku, Haiku com correções, Sonnet (RN-FG05)
  const attempts = [deps.model, deps.model, deps.fallbackModel];
  let article: Article | null = null;
  let articleModel = deps.model;
  let issues: GuardIssue[] = [];
  const history: { model: string; issues: GuardIssue[] }[] = [];
  for (const model of attempts) {
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.stream(writerParams(model, writerUserContent(sources, facts, story, issues))).finalMessage();
    } catch (err) {
      // Requisição recusada pela API (400) vale como tentativa perdida; 429/5xx/rede sobem e a fila tenta de novo.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      issues = [{ rule: "FG03", detail: `API recusou a chamada (${model}): ${err.message}`.slice(0, 300) }];
      history.push({ model, issues });
      log.warn({ module: "story", storyId, model, err: err.message }, "writer request rejected");
      continue;
    }
    await recordUsage(pool, deps.prices, { storyId, task: "write", model: msg.model, usage: msg.usage, batch: false });
    let candidate: Article;
    try {
      const parsed = ArticleSchema.safeParse(coerceArticle(jsonFrom(msg)));
      if (!parsed.success) throw new Error(`schema: ${firstIssue(parsed.error)}`);
      candidate = parsed.data;
    } catch (err) {
      issues = [{ rule: "FG03", detail: `saída fora do formato: ${(err as Error).message}`.slice(0, 300) }];
      history.push({ model: msg.model, issues });
      continue;
    }
    const cited = [...new Set([...candidate.cves_mentioned, ...extractCves(candidate.pt.markdown, candidate.en.markdown)])];
    const missing = cited.filter((c) => !facts.cves[c]);
    if (missing.length) {
      const more = await enrichCves(pool, missing, { nvdApiKey: deps.nvdApiKey });
      facts = { cves: { ...facts.cves, ...more.cves } };
    }
    issues = factGuard(candidate, facts, sources, story.cve_ids);
    history.push({ model: msg.model, issues });
    article = candidate;
    articleModel = msg.model;
    if (issues.length === 0) break;
  }
  if (!article) {
    await failStory(pool, storyId, `redação falhou em ${attempts.length} tentativas: ${issues[0]?.detail ?? "?"}`);
    return "failed";
  }
  const passed = issues.length === 0;
  const { rows: st } = await pool.query<{ langs: Lang[] }>("select langs from settings where brand_id = $1", [deps.brandId]);
  const langs = (st[0]?.langs ?? ["pt", "en"]).filter((l): l is Lang => l === "pt" || l === "en");

  // ---- derivados por idioma (falha num canal não impede a revisão do artigo)
  const derivatives: Partial<Record<Lang, Derivatives>> = {};
  const derivErrors: string[] = [];
  for (const lang of langs) {
    for (let i = 0; i < 2 && !derivatives[lang]; i++) {
      const msg = await client.messages.create(derivativesParams(deps.model, lang, article[lang]));
      await recordUsage(pool, deps.prices, { storyId, task: "derive", model: msg.model, usage: msg.usage, batch: false });
      try {
        const parsed = DerivativesSchema.safeParse(coerceDerivatives(jsonFrom(msg)));
        if (!parsed.success) throw new Error(firstIssue(parsed.error));
        derivatives[lang] = parsed.data;
      } catch (err) {
        if (i === 1) derivErrors.push(`${lang}: ${(err as Error).message}`.slice(0, 200));
      }
    }
  }

  await saveContents(pool, { storyId, article, articleModel, passed, issues, history, facts, langs, derivatives, derivErrors });
  log.info({ module: "story", storyId, factGuard: passed, attempts: history.length, langs, derivErrors }, "story built");
  return "built";
}

const render = <T>(v: T, facts: Facts, lang: Lang): T => JSON.parse(renderPlaceholders(JSON.stringify(v), facts, lang)) as T;

async function saveContents(pool: Pool, p: {
  storyId: string; article: Article; articleModel: string; passed: boolean; issues: GuardIssue[];
  history: { model: string; issues: GuardIssue[] }[]; facts: Facts; langs: Lang[];
  derivatives: Partial<Record<Lang, Derivatives>>; derivErrors: string[];
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const insert = (channel: string, lang: Lang, kind: string, title: string | null, body: unknown, model: string, pv: string) =>
      client.query(
        `insert into story_contents (story_id, channel, lang, kind, version, title, body, model, prompt_version)
         values ($1, $2, $3, $4,
                 coalesce((select max(version) + 1 from story_contents where story_id = $1 and channel = $2 and lang = $3 and kind = $4), 1),
                 $5, $6::jsonb, $7, $8)`,
        [p.storyId, channel, lang, kind, title, JSON.stringify(body), model, pv],
      );
    const slugs: Partial<Record<Lang, string>> = {};
    for (const lang of p.langs) {
      const a = p.article[lang];
      await insert("blog", lang, "article", renderPlaceholders(a.title, p.facts, lang), {
        tldr: renderPlaceholders(a.tldr, p.facts, lang),
        markdown: renderPlaceholders(a.markdown, p.facts, lang),
        markdown_template: a.markdown, // com placeholders, para re-render quando os fatos mudarem
        meta_description: renderPlaceholders(a.meta_description, p.facts, lang),
        tags: a.tags,
        claims: p.article.claims,
      }, p.articleModel, WRITER_PROMPT_VERSION);
      slugs[lang] = await uniqueSlug(client, lang, slugify(a.title), p.storyId);
      const d = p.derivatives[lang];
      if (d) {
        const r = render(d, p.facts, lang);
        await insert("instagram", lang, "carousel", null, r.instagram, p.articleModel, DERIVATIVES_PROMPT_VERSION);
        await insert("facebook", lang, "post", null, r.facebook, p.articleModel, DERIVATIVES_PROMPT_VERSION);
        await insert("linkedin", lang, "post", null, r.linkedin, p.articleModel, DERIVATIVES_PROMPT_VERSION);
        await insert("youtube", lang, "script", r.youtube.title, r.youtube, p.articleModel, DERIVATIVES_PROMPT_VERSION);
      }
    }
    await client.query(
      `update stories set status = 'AWAITING_REVIEW', facts = $2::jsonb, fact_guard = $3::jsonb, tags = $4::text[],
              slug_pt = $5, slug_en = $6, error = $7
        where id = $1 and status = 'DRAFTING'`,
      [p.storyId, JSON.stringify(p.facts),
        JSON.stringify({ passed: p.passed, issues: p.issues, attempts: p.history }),
        p.article.pt.tags, slugs.pt ?? null, slugs.en ?? null,
        p.derivErrors.length ? `derivados com erro: ${p.derivErrors.join(" | ")}` : null],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** RN-STO04: slug do título; colidiu, recebe o sufixo com 6 caracteres do id. */
async function uniqueSlug(client: { query: Pool["query"] }, lang: Lang, base: string, storyId: string): Promise<string> {
  const col = lang === "pt" ? "slug_pt" : "slug_en";
  const { rowCount } = await client.query(`select 1 from stories where ${col} = $1 and id <> $2`, [base, storyId]);
  return rowCount ? `${base}-${storyId.replace(/-/g, "").slice(0, 6)}` : base;
}
