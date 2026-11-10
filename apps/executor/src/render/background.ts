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

const PromptSchema = z.object({ prompt: z.string().min(20).max(800) });
const FLUX = "@cf/black-forest-labs/flux-1-schnell";

const attr = (s: string) => s.replace(/["<>&]/g, " ").trim();

/** Prompt da imagem a partir do tema (o texto da story vai em <story>, como material não confiável). */
export async function imagePrompt(
  llm: NonNullable<BackgroundDeps["llm"]>, pool: Pool, storyId: string,
  story: { title: string; tldr: string; category: string },
): Promise<string> {
  const msg = await llm.client.messages.create({
    model: llm.model,
    max_tokens: 2000,
    system: [{ type: "text", text: IMAGE_PROMPT_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: jsonSchemaFormat(PromptSchema) },
    messages: [{ role: "user", content: `<story category="${attr(story.category)}">\nTítulo: ${story.title}\nResumo: ${story.tldr}\n</story>` }],
  });
  await recordUsage(pool, llm.prices, { storyId, task: "image_prompt", model: msg.model, usage: msg.usage, batch: false });
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const parsed = PromptSchema.safeParse(JSON.parse(text || "{}"));
  if (!parsed.success) throw new Error(`prompt de imagem inválido (${msg.stop_reason})`);
  // Reforça as proibições do kit mesmo que o modelo as omita.
  return `${parsed.data.prompt.trim()}. Dark green-black palette, muted moss green highlights, no text, no letters, no logos, no people.`;
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
 * Fundo da story como data URI: reaproveita o já gerado (edições não custam nova imagem); senão gera,
 * guarda no Storage e registra em `assets`. Qualquer falha devolve null e o criativo sai com fundo liso.
 */
export async function storyBackground(
  deps: BackgroundDeps, storyId: string, story: { title: string; tldr: string; category: string },
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
    if (!deps.llm || !deps.workersAi) return null;
    const prompt = await imagePrompt(deps.llm, pool, storyId, story);
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
      [storyId, objectPath, url, jpg.length, JSON.stringify({ model: FLUX, prompt, prompt_version: IMAGE_PROMPT_VERSION })],
    );
    log.info({ module: "render", storyId, bytes: jpg.length }, "background generated");
    return toDataUri(jpg, "image/jpeg");
  } catch (err) {
    log.warn({ module: "render", storyId, err: (err as Error).message }, "background unavailable; using plain background");
    return null;
  }
}
