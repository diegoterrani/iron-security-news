import { describe, expect, it, vi } from "vitest";
import { IgApiError, buildCaption, publishCarousel, refreshLongLivedToken, scrub } from "../src/publish/instagram-api";

type Call = { url: URL; method: string; body: URLSearchParams; auth: string | null };

/** Graph API falsa: responde por rota e grava as chamadas. */
function graph(routes: (c: Call) => unknown) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const c: Call = {
      url: new URL(String(input)), method: init?.method ?? "GET",
      body: new URLSearchParams(init?.body ? String(init.body) : ""), auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(c);
    const r = routes(c);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const deps = (f: typeof fetch) => ({ graphVersion: "v23.0", fetchImpl: f, sleep: async () => undefined });
const IMGS = ["https://s/a.jpg", "https://s/b.jpg", "https://s/c.jpg"];

describe("publishCarousel", () => {
  it("cria um item por imagem, o carrossel, espera FINISHED e publica; token só no header", async () => {
    let n = 0;
    let polls = 0;
    const { f, calls } = graph((c) => {
      const p = c.url.pathname;
      if (p === "/v23.0/178/media" && c.body.get("is_carousel_item") === "true") return { id: String(1000 + n++) };
      if (p === "/v23.0/178/media" && c.body.get("media_type") === "CAROUSEL") return { id: "2000" };
      if (p === "/v23.0/2000") return { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" };
      if (p === "/v23.0/178/media_publish") return { id: "3000" };
      if (p === "/v23.0/3000") return { permalink: "https://www.instagram.com/p/abc/" };
      throw new Error(p);
    });
    const r = await publishCarousel(deps(f), { igUserId: "178", token: "IGTOKEN", imageUrls: IMGS, caption: "legenda" });
    expect(r).toEqual({ mediaId: "3000", permalink: "https://www.instagram.com/p/abc/" });
    const carousel = calls.find((c) => c.body.get("media_type") === "CAROUSEL")!;
    expect(carousel.body.get("children")).toBe("1000,1001,1002");
    expect(carousel.body.get("caption")).toBe("legenda");
    expect(calls.find((c) => c.url.pathname.endsWith("media_publish"))!.body.get("creation_id")).toBe("2000");
    for (const c of calls) {
      expect(c.auth).toBe("Bearer IGTOKEN");
      expect(c.url.toString()).not.toContain("IGTOKEN");
    }
  });
  it("erro de processamento interrompe sem publicar", async () => {
    const { f, calls } = graph((c) => {
      if (c.url.pathname.endsWith("/media")) return { id: "1" };
      return { status_code: "ERROR", status: "Error: imagem não é JPEG" };
    });
    await expect(publishCarousel(deps(f), { igUserId: "1", token: "t", imageUrls: IMGS, caption: "" })).rejects.toThrow(/JPEG/);
    expect(calls.some((c) => c.url.pathname.endsWith("media_publish"))).toBe(false);
  });
  it("traduz o erro da Graph API: 190 pede reconexão, 4/17/32/613 é limite", async () => {
    const err = (code: number) => graph(() => new Response(JSON.stringify({ error: { message: "x", code } }), { status: 400 })).f;
    const e190 = await publishCarousel(deps(err(190)), { igUserId: "1", token: "t", imageUrls: IMGS, caption: "" }).then(() => { throw new Error("esperava erro"); }, (e: unknown) => e as IgApiError);
    expect(e190).toBeInstanceOf(IgApiError);
    expect(e190.needsReauth).toBe(true);
    const e4 = await publishCarousel(deps(err(4)), { igUserId: "1", token: "t", imageUrls: IMGS, caption: "" }).then(() => { throw new Error("esperava erro"); }, (e: unknown) => e as IgApiError);
    expect(e4.rateLimited).toBe(true);
  });
  it("recusa carrossel com menos de 2 ou mais de 10 imagens", async () => {
    const { f } = graph(() => ({}));
    await expect(publishCarousel(deps(f), { igUserId: "1", token: "t", imageUrls: ["a"], caption: "" })).rejects.toThrow(/2 a 10/);
  });
});

describe("refreshLongLivedToken", () => {
  it("devolve o token novo e a validade", async () => {
    const { f, calls } = graph(() => ({ access_token: "NEW", expires_in: 5_184_000 }));
    expect(await refreshLongLivedToken({ fetchImpl: f }, "OLD")).toEqual({ token: "NEW", expiresIn: 5_184_000 });
    expect(calls[0]!.url.searchParams.get("grant_type")).toBe("ig_refresh_token");
  });
  it("190 vira needsReauth e a mensagem não carrega o token", async () => {
    const { f } = graph(() => new Response(JSON.stringify({ error: { message: "bad access_token=IGQWRsecretsecretsecretsecret", code: 190 } }), { status: 400 }));
    const e = await refreshLongLivedToken({ fetchImpl: f }, "OLD").then(() => { throw new Error("esperava erro"); }, (x: unknown) => x as IgApiError);
    expect(e.needsReauth).toBe(true);
    expect(e.message).not.toContain("secret");
  });
});

describe("buildCaption / scrub", () => {
  it("anexa hashtags válidas sem repetir e respeita 30 hashtags", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `#t${i}`);
    const c = buildCaption("Texto #a #b", [...tags, "#t1", "inválida"]);
    expect((c.match(/#\w+/g) ?? []).length).toBe(30);
    expect(c.startsWith("Texto #a #b\n\n#t0 #t1")).toBe(true);
  });
  it("corta em 2.200 caracteres preservando as hashtags", () => {
    const c = buildCaption("x".repeat(3000), ["#ciber"]);
    expect(c.length).toBeLessThanOrEqual(2200);
    expect(c.endsWith("…\n\n#ciber")).toBe(true);
  });
  it("scrub esconde tokens", () => {
    expect(scrub("falhou access_token=abc123&x=1 e IGAAbcdefghijklmnopqrstuvwxyz")).toBe("falhou access_token=***&x=1 e IG***");
  });
});

describe("buildCaption com CTA", () => {
  it("encurta só o texto; CTA e hashtags ficam inteiros", () => {
    const cta = "Quer entender o caso completo? Link na Bio.";
    const c = buildCaption("x".repeat(3000), ["#ciber"], cta);
    expect(c.length).toBeLessThanOrEqual(2200);
    expect(c.endsWith(`${cta}\n\n#ciber`)).toBe(true);
  });
});

describe("publishCarousel com token do Facebook (usuário do sistema)", () => {
  it("usa graph.facebook.com com os mesmos endpoints", async () => {
    const { f, calls } = graph((c) => {
      if (c.url.pathname.endsWith("/media_publish")) return { id: "3" };
      if (c.url.pathname.endsWith("/media")) return { id: "2" };
      if (c.url.pathname.endsWith("/3")) return { permalink: "https://www.instagram.com/p/x/" };
      return { status_code: "FINISHED" };
    });
    await publishCarousel({ ...deps(f), host: "facebook" }, { igUserId: "178", token: "EAAx", imageUrls: IMGS, caption: "c" });
    expect(calls.every((c) => c.url.host === "graph.facebook.com")).toBe(true);
    expect(calls.some((c) => c.url.pathname === "/v23.0/178/media_publish")).toBe(true);
  });
});
