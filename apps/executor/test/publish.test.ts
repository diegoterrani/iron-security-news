import { verifyRequest } from "@ironnews/shared";
import { describe, expect, it, vi } from "vitest";
import { revalidate } from "../src/publish/blog";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof revalidate>[0]["log"];
const secret = "s".repeat(32);

describe("revalidate (atualização do site após publicar)", () => {
  it("envia POST assinado que o site aceita, com as tags sem repetição", async () => {
    let seen: { body: string; ts: string | null; sig: string | null } | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen = { body: String(init.body), ts: h.get("x-timestamp"), sig: h.get("x-signature") };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await revalidate({ pool: null as never, log, siteUrl: "https://x", revalidateUrl: "https://x/api/internal/revalidate", revalidateSecret: secret, fetchImpl: fake },
      ["articles", "article:a", "articles"]);
    expect(ok).toBe(true);
    expect(JSON.parse(seen!.body)).toEqual({ tags: ["articles", "article:a"] });
    expect(await verifyRequest(secret, seen!.body, seen!.ts, seen!.sig)).toBe(true);
    expect(await verifyRequest("outro-segredo-qualquer-123456789", seen!.body, seen!.ts, seen!.sig)).toBe(false);
  });
  it("falha (401, rede) só gera aviso; sem configuração não tenta", async () => {
    const f401 = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await revalidate({ pool: null as never, log, siteUrl: "https://x", revalidateUrl: "https://x/r", revalidateSecret: secret, fetchImpl: f401 }, ["articles"])).toBe(false);
    const never = vi.fn();
    expect(await revalidate({ pool: null as never, log, siteUrl: "https://x", fetchImpl: never as unknown as typeof fetch }, ["articles"])).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});
