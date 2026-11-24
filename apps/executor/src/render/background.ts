import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { IMAGE_PROMPT_SYSTEM, IMAGE_PROMPT_VERSION } from "@ironnews/shared";
import { z } from "zod";
import type { Pool } from "../db";
import { jsonSchemaFormat } from "../llm/format";
import { recordUsage, type ModelPrice } from "../llm/usage";
import type { Logger } from "../logger";
import { uploadObject, type StorageConfig } from "./storage";

/** Ilustração de fundo (Cloudflare Workers AI). Sem as credenciais, os criativos saem com fundo liso. */
export interface BackgroundDeps {
  pool: Pool;
  log: Logger;
  storage: StorageConfig;
  llm: { client: Anthropic; model: string; prices: Record<string, ModelPrice> } | null;
  workersAi: { accountId: string; token: string; fetchImpl?: typeof fetch } | null;
}

/** image@4: o tema e o objeto vêm antes do prompt, para a cena partir do fato da notícia. */
const PromptSchema = z.object({
  theme: z.string().min(10).max(300),
  subject: z.string().min(3).max(160),
  prompt: z.string().min(20).max(800),
});

export interface ImagePrompt {
  prompt: string;
  theme: string;
  subject: string;
}
const FLUX = "@cf/black-forest-labs/flux-1-schnell";

const attr = (s: string) => s.replace(/["<>&]/g, " ").trim();

/** Sufixos fixos (atual e do image@2): iguais em todo prompt, só gastam tokens no histórico. */
const SUFFIX_IMAGE2 =
  "Empty dark negative space on the left, dark green-black palette, muted moss green highlights, blank unmarked surfaces, minimalist, photorealistic.";
const stripSuffix = (p: string) => [SUFFIX, SUFFIX_IMAGE2].reduce((acc, sfx) => acc.replace(sfx, ""), p).trim().replace(/\.$/, "");

/** Quantos prompts recentes vão ao modelo para ele não repetir assunto e cenário. */
export const RECENT_PROMPTS = 8;

/** Prompts das últimas ilustrações (de outras stories), sem o sufixo fixo, que não ajuda a diferenciar. */
export async function recentImagePrompts(pool: Pool, storyId: string, limit = RECENT_PROMPTS): Promise<string[]> {
  const { rows } = await pool.query<{ prompt: string | null }>(
    `select meta->>'prompt' as prompt from assets
      where kind = 'background' and status = 'ready' and story_id <> $1 and meta ? 'prompt'
      order by created_at desc limit $2`,
    [storyId, limit],
  );
  return rows.map((r) => stripSuffix(r.prompt ?? "")).filter(Boolean);
}

/**
 * Mensagem do usuário para o modelo do prompt. Título, resumo e prompts recentes são dados não confiáveis:
 * vão delimitados, com tamanho limitado e sem os caracteres que fechariam as tags.
 */
export function imagePromptInput(story: { title: string; tldr: string; category: string }, recent: string[] = []): string {
  const clean = (s: string, max: number) => s.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const recentBlock = recent.length
    ? `\n<recent>\n${recent.slice(0, RECENT_PROMPTS).map((p) => `- ${clean(p, 240)}`).join("\n")}\n</recent>`
    : "";
  return `<story category="${attr(story.category)}">\nTítulo: ${clean(story.title, 300)}\nResumo: ${clean(story.tldr, 1200)}\n</story>${recentBlock}`;
}

/** Prompt da imagem a partir do tema (o texto da story vai em <story>, como material não confiável). */
export async function imagePrompt(
  llm: NonNullable<BackgroundDeps["llm"]>, pool: Pool, storyId: string,
  story: { title: string; tldr: string; category: string },
): Promise<ImagePrompt> {
  // Sem histórico (falha de leitura), o prompt ainda sai; só perde a proteção contra repetição.
  const recent = await recentImagePrompts(pool, storyId).catch(() => [] as string[]);
  const msg = await llm.client.messages.create({
    model: llm.model,
    max_tokens: 2000,
    system: [{ type: "text", text: IMAGE_PROMPT_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: jsonSchemaFormat(PromptSchema) },
    messages: [{ role: "user", content: imagePromptInput(story, recent) }],
  });
  await recordUsage(pool, llm.prices, { storyId, task: "image_prompt", model: msg.model, usage: msg.usage, batch: false });
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const parsed = PromptSchema.safeParse(JSON.parse(text || "{}"));
  if (!parsed.success) throw new Error(`prompt de imagem inválido (${msg.stop_reason})`);
  const { theme, subject, prompt } = parsed.data;
  return { prompt: fluxPrompt(withSubject(prompt, subject), story.category), theme, subject };
}

const NEGATION = /\b(no|not|without|avoid|free of)\b/i;
const WRITING = /\b(text|texts|letters?|words?|labels?|labell?ed|signs?|signage|logos?|screens?|displays?|code|numbers?|numerals?|typography|captions?|writing|written|font)\b/i;
const PEOPLE = /\b(people|person|persons|faces?|humans?|hands?|hacker)\b/i;
/** Só o Brand Kit (paleta e espaço do texto). O assunto e o cenário vêm do prompt da notícia. */
export const SUFFIX = "Moss green and charcoal color grade, empty dark left third, unmarked surfaces, photorealistic.";

/** Assunto de reserva por categoria, para quando nada do prompt do modelo sobrevive à limpeza. */
const FALLBACK_SUBJECT: Record<string, string> = {
  ransomware: "Macro photograph of a heavy steel padlock and chain wrapped around a metal filing cabinet on the right",
  zero_day: "Macro photograph of a cracked glass lens with a thin beam of cold light on the right",
  vulnerability: "Close-up of a brushed metal door lock with a small crack in its cylinder on the right",
  data_breach: "Still life of an open steel vault with scattered blank paper folders on the right",
  malware: "Macro photograph of a circuit board with a dark organic growth spreading across it on the right",
  apt_campaign: "Aerial night view of a dark city power grid with a few glowing substations on the right",
  phishing_fraud: "Macro photograph of a metal fishing hook holding a blank bank card on the right",
  cloud_security: "Wide shot of low dark storm clouds over a steel transmission tower on the right",
  regulation_privacy: "Still life of a judge gavel resting on a closed leather folder on the right",
  ai_security: "Macro photograph of a mechanical eye made of brushed metal and glass on the right",
  supply_chain: "Wide night shot of stacked shipping containers at an empty port on the right",
};
const FALLBACK_DEFAULT = "Macro photograph of a brushed steel key resting on a dark stone surface on the right";

/** Garante que a cena começa pelo objeto escolhido: se o prompt não o cita, o objeto entra na frente. */
export function withSubject(prompt: string, subject: string): string {
  const words = subject.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const p = prompt.toLowerCase();
  const cited = words.length > 0 && words.filter((w) => p.includes(w)).length >= Math.ceil(words.length / 2);
  return cited ? prompt : `${subject.replace(/[.,;:]+$/, "")}, ${prompt}`;
}

/**
 * Prompt final do FLUX. O schnell não entende negação e desenha qualquer palavra ligada a escrita,
 * então tiramos cláusulas negativas, cláusulas que citam escrita/pessoas e siglas (GPU, SSH…),
 * e fechamos com um sufixo só de termos positivos do Brand Kit.
 */
export function fluxPrompt(raw: string, category?: string): string {
  const clauses = raw
    .split(/[,.;:]/)
    .map((c) => c.trim())
    .filter((c) => c && !NEGATION.test(c) && !WRITING.test(c) && !PEOPLE.test(c))
    .map((c) => c.replace(/\b[A-Z][A-Z0-9-]+\b/g, "").replace(/\s{2,}/g, " ").trim())
    .filter((c) => c.length > 2);
  const base = clauses.length ? clauses.join(", ") : (category && FALLBACK_SUBJECT[category]) || FALLBACK_DEFAULT;
  return `${base}. ${SUFFIX}`;
}

/** FLUX schnell no Workers AI: devolve JPEG 1024×1024. */
export async function generateImage(ai: NonNullable<BackgroundDeps["workersAi"]>, prompt: string): Promise<Buffer> {
  const res = await (ai.fetchImpl ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${ai.accountId}/ai/run/${FLUX}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ai.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 8 }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { success?: boolean; result?: { image?: string }; errors?: { message: string }[] };
  if (!res.ok || !body.success || !body.result?.image) {
    throw new Error(`Workers AI ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "sem imagem"}`);
  }
  return Buffer.from(body.result.image, "base64");
}

const toDataUri = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString("base64")}`;

/**
 * Fundo da story como data URI: reaproveita o já gerado (edições não custam nova imagem). Só GERA um novo
 * quando `generate` (pedido do editor no painel); aí guarda no Storage e registra em `assets`.
 * Sem fundo pronto e sem pedido, ou em qualquer falha, devolve null e o criativo sai com fundo liso.
 */
export async function storyBackground(
  deps: BackgroundDeps, storyId: string, story: { title: string; tldr: string; category: string },
  opts: { generate?: boolean } = {},
): Promise<string | null> {
  const { pool, log } = deps;
  try {
    const { rows: [existing] } = await pool.query<{ public_url: string; mime: string }>(
      `select public_url, mime from assets where story_id = $1 and kind = 'background' and status = 'ready'
        order by updated_at desc limit 1`,
      [storyId],
    );
    if (existing?.public_url) {
      const res = await fetch(existing.public_url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) return toDataUri(Buffer.from(await res.arrayBuffer()), existing.mime || "image/jpeg");
    }
    if (!opts.generate || !deps.llm || !deps.workersAi) return null;
    const { prompt, theme, subject } = await imagePrompt(deps.llm, pool, storyId, story);
    const jpg = await generateImage(deps.workersAi, prompt);
    const hash = createHash("sha256").update(jpg).digest("hex").slice(0, 10);
    const objectPath = `stories/${storyId}/background-${hash}.jpg`;
    const url = await uploadObject(deps.storage, objectPath, jpg, "image/jpeg");
    await pool.query(
      `insert into assets (story_id, channel, lang, kind, position, status, storage_path, public_url, mime, width, height, bytes,
                           provider, content_version, meta)
       values ($1, 'blog', 'pt', 'background', 1, 'ready', $2, $3, 'image/jpeg', 1024, 1024, $4, 'workers-ai', 1, $5::jsonb)
       on conflict (story_id, channel, lang, kind, position, content_version) do update
         set status = 'ready', storage_path = excluded.storage_path, public_url = excluded.public_url,
             bytes = excluded.bytes, meta = excluded.meta`,
      [storyId, objectPath, url, jpg.length, JSON.stringify({ model: FLUX, prompt, theme, subject, prompt_version: IMAGE_PROMPT_VERSION })],
    );
    log.info({ module: "render", storyId, bytes: jpg.length }, "background generated");
    return toDataUri(jpg, "image/jpeg");
  } catch (err) {
    log.warn({ module: "render", storyId, err: (err as Error).message }, "background unavailable; using plain background");
    return null;
  }
}
