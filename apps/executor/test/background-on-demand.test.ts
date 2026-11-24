import { describe, expect, it, vi } from "vitest";

describe("fundo por IA sob demanda", () => {
  it("sem pedido do editor e sem fundo pronto: não chama LLM nem FLUX e devolve fundo liso", async () => {
    const { storyBackground } = await import("../src/render/background");
    const llmCall = vi.fn();
    const aiCall = vi.fn();
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as never;
    const log = { info: vi.fn(), warn: vi.fn() } as never;
    const deps = {
      pool, log, storage: { url: "https://x", serviceKey: "k", bucket: "media" } as never,
      llm: { client: { messages: { create: llmCall } }, model: "m", prices: {} } as never,
      workersAi: { accountId: "a", token: "t", fetchImpl: aiCall as never },
    };
    expect(await storyBackground(deps, "s1", { title: "T", tldr: "R", category: "malware" })).toBeNull();
    expect(llmCall).not.toHaveBeenCalled();
    expect(aiCall).not.toHaveBeenCalled();
  });

  it("worker: uma renderização por story e gera o fundo se QUALQUER mensagem do lote pediu", async () => {
    vi.resetModules();
    const calls: { id: string; opts: unknown }[] = [];
    vi.doMock("../src/render/creatives", () => ({
      renderStoryCreatives: async (_d: unknown, id: string, opts: unknown) => { calls.push({ id, opts }); return 1; },
    }));
    const { consumeRender } = await import("../src/render/worker");
    const msg = (msgId: number, story_id: string, background?: string) => ({ msgId, body: { payload: { story_id, background } } });
    const acked: number[] = [];
    const queue = {
      read: async () => [msg(1, "a"), msg(2, "a", "generate"), msg(3, "b")],
      ack: async (_q: string, id: number) => { acked.push(id); },
      retryOrDeadLetter: async () => "retry",
    } as never;
    await consumeRender({ log: { warn: vi.fn(), error: vi.fn() } } as never, queue);
    expect(calls).toEqual([
      { id: "a", opts: { generateBackground: true } },
      { id: "b", opts: { generateBackground: false } },
    ]);
    expect(acked.sort()).toEqual([1, 2, 3]);
    vi.doUnmock("../src/render/creatives");
  });
});
