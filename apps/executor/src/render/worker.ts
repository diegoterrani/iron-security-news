import type { Queue } from "../queue";
import { renderStoryCreatives, type RenderDeps } from "./creatives";

/**
 * Fila `render`: uma mensagem por story (story pronta, texto editado ou fundo pedido no painel).
 * Várias mensagens da mesma story no mesmo lote viram uma renderização só; se alguma delas pediu o
 * fundo por IA (`background: "generate"`, RPC review_request_background), a renderização gera a imagem.
 */
export async function consumeRender(deps: RenderDeps, queue: Queue): Promise<void> {
  const msgs = await queue.read<{ story_id: string; background?: string }>("render", 600, 10);
  const wantsBackground = new Set(
    msgs.filter((m) => m.body.payload?.background === "generate").map((m) => m.body.payload!.story_id),
  );
  const done = new Set<string>();
  for (const m of msgs) {
    const storyId = m.body.payload?.story_id;
    if (!storyId || done.has(storyId)) {
      await queue.ack("render", m.msgId);
      continue;
    }
    try {
      await renderStoryCreatives(deps, storyId, { generateBackground: wantsBackground.has(storyId) });
      done.add(storyId);
      await queue.ack("render", m.msgId);
    } catch (err) {
      const error = (err as Error).message;
      const dest = await queue.retryOrDeadLetter("render", m, error);
      deps.log[dest === "dlq" ? "error" : "warn"]({ module: "render", storyId, err: error, dest }, "render failed");
    }
  }
}
