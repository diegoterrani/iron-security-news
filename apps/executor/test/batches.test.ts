import { describe, expect, it } from "vitest";
import { BatchHttpError, createBatchClient } from "../src/llm/batches";

describe("OpenRouter Batch API", () => {
  it("envia endpoint/model/completion_window antes de requests, sem model no corpo", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fake = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ id: "batch_1", status: "validating" }), { status: 202 });
    }) as unknown as typeof fetch;
    const b = createBatchClient("sk-or-test", fake);
    const r = await b.create("anthropic/claude-haiku-5.5", [
      { custom_id: "a", params: { model: "anthropic/claude-haiku-5.5", max_tokens: 10, messages: [{ role: "user", content: "oi" }] } },
    ]);
    expect(r.id).toBe("batch_1");
    expect(url).toBe("https://openrouter.ai/api/v1/batches");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(["endpoint", "model", "completion_window", "requests"]);
    expect(body.endpoint).toBe("/v1/messages");
    expect(body.requests[0]).toEqual({ custom_id: "a", body: { max_tokens: 10, messages: [{ role: "user", content: "oi" }] } });
  });
  it("erro HTTP vira BatchHttpError com o status", async () => {
    const fake = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(createBatchClient("k", fake).retrieve("msgbatch_x")).rejects.toBeInstanceOf(BatchHttpError);
  });
});
