import type { Queue } from "../queue";
import { buildStory, type BuildDeps } from "./build";

/** Uma story por vez: a geração leva ~1 min e chama a API várias vezes. Visibilidade de 20 min. */
export async function consumeStoryBuild(deps: BuildDeps, queue: Queue): Promise<void> {
  const msgs = await queue.read<{ story_id: string }>("story_build", 1200, 1);
  for (const m of msgs) {
    const storyId = m.body.payload?.story_id;
    if (!storyId) {
      await queue.ack("story_build", m.msgId);
      continue;
    }
    try {
      const r = await buildStory(deps, storyId);
      await queue.ack("story_build", m.msgId);
      deps.log.info({ module: "story", storyId, result: r, traceId: m.body.traceId }, "story_build processed");
    } catch (err) {
      const error = (err as Error).message;
      const dest = await queue.retryOrDeadLetter("story_build", m, error);
      deps.log[dest === "dlq" ? "error" : "warn"]({ module: "story", storyId, err: error, attempt: m.body.attempt, dest }, "story_build failed");
      if (dest === "dlq") {
        await deps.pool.query("update stories set status = 'FAILED', error = $2 where id = $1 and status = 'DRAFTING'", [storyId, error.slice(0, 500)]);
      }
    }
  }
}
