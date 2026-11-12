import { describe, expect, it, vi } from "vitest";
import { LiApiError, buildCommentary, createPost, escapeLittleText, refreshAccessToken, scrub, uploadImage } from "../src/publish/linkedin-api";

type Call = { url: URL; method: string; headers: Headers; body: unknown };

/** API REST falsa do LinkedIn: responde por rota e grava as chamadas. */
function api(routes: (c: Call) => Response | unknown) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const c: Call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
    calls.push(c);
    const r = routes(c);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const deps = (f: typeof fetch) => ({ apiVersion: "202606", fetchImpl: f, sleep: async () => undefined });
const OWNER = "urn:li:person:abc123";
const IMG = "urn:li:image:C4E10AQ";

describe("uploadImage", () => {
  it("inicia o upload, envia os bytes para a uploadUrl do LinkedIn e espera AVAILABLE; token só no header", async () => {
    let polls = 0;
    const { f, calls } = api((c) => {
      if (c.url.pathname === "/rest/images" && c.url.searchParams.get("action") === "initializeUpload") {
        return { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/xyz", image: IMG } };
      }
      if (c.url.hostname === "www.linkedin.com" && c.method === "PUT") return new Response(null, { status: 201 });
      if (c.url.pathname === `/rest/images/${encodeURIComponent(IMG)}`) return { status: ++polls < 2 ? "PROCESSING" : "AVAILABLE" };
      throw new Error(c.url.toString());
    });
    expect(await uploadImage(deps(f), "AQTOKEN", OWNER, Buffer.from("png"), "image/png")).toBe(IMG);
    const init = calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ initializeUploadRequest: { owner: OWNER } });
    expect(init.headers.get("linkedin-version")).toBe("202606");
    expect(init.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    for (const c of calls) {
      expect(c.headers.get("authorization")).toBe("Bearer AQTOKEN");
      expect(c.url.toString()).not.toContain("AQTOKEN");
    }
  });
  it("não envia o token para uploadUrl fora do LinkedIn", async () => {
    const { f, calls } = api(() => ({ value: { uploadUrl: "https://evil.example.com/up", image: IMG } }));
    await expect(uploadImage(deps(f), "AQTOKEN", OWNER, Buffer.from("x"), "image/png")).rejects.toThrow(/fora do LinkedIn/);
    expect(calls).toHaveLength(1);
  });
  it("falha de processamento interrompe", async () => {
    const { f } = api((c) => {
      if (c.method === "POST") return { value: { uploadUrl: "https://www.linkedin.com/up", image: IMG } };
      if (c.method === "PUT") return new Response(null, { status: 201 });
      return { status: "PROCESSING_FAILED" };
    });
    await expect(uploadImage(deps(f), "t", OWNER, Buffer.from("x"), "image/png")).rejects.toThrow(/processar/);
  });
});

describe("createPost", () => {
  it("cria o post público com a imagem e devolve o URN e o link", async () => {
    const { f, calls } = api(() => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7000000000000000001" } }));
    const r = await createPost(deps(f), { author: OWNER, token: "t", commentary: "texto", imageUrn: IMG, altText: "alt", title: "Título" });
    expect(r).toEqual({ postUrn: "urn:li:share:7000000000000000001", url: "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/" });
    const body = JSON.parse(String(calls[0]!.body));
    expect(body).toMatchObject({ author: OWNER, commentary: "texto", visibility: "PUBLIC", lifecycleState: "PUBLISHED", content: { media: { id: IMG, altText: "alt" } } });
  });
  it("traduz erros: 401 pede reconexão, 429 é limite (com Retry-After), 403 é permissão", async () => {
    const err = (status: number, h: Record<string, string> = {}) =>
      api(() => new Response(JSON.stringify({ message: "x AQ" + "a".repeat(30) }), { status, headers: h })).f;
    const run = (f: typeof fetch) => createPost(deps(f), { author: OWNER, token: "t", commentary: "c", imageUrn: IMG, altText: "", title: "" })
      .then(() => { throw new Error("esperava erro"); }, (e: unknown) => e as LiApiError);
    const e401 = await run(err(401));
    expect(e401.needsReauth).toBe(true);
    expect(e401.message).not.toMatch(/AQa{20}/);
    const e429 = await run(err(429, { "retry-after": "120" }));
    expect(e429.rateLimited).toBe(true);
    expect(e429.retryAfterSec).toBe(120);
    const e403 = await run(err(403));
    expect(e403.needsReauth || e403.rateLimited).toBe(false);
    expect(e403.httpStatus).toBe(403);
  });
});

describe("buildCommentary (little text)", () => {
  it("escapa os caracteres reservados (senão o LinkedIn corta o texto)", () => {
    expect(escapeLittleText("CVE (crítica) #1 @x [a] <b> *c* _d_ ~e~ {f} | \\")).toBe(
      "CVE \\(crítica\\) \\#1 \\@x \\[a\\] \\<b\\> \\*c\\* \\_d\\_ \\~e\\~ \\{f\\} \\| \\\\",
    );
  });
  it("hashtags viram o template oficial, sem repetição, até 5", () => {
    const c = buildCommentary("Texto.", ["#Ransomware", "#CyberSecurity", "#Ransomware", "#Zero_Day", "#A", "#B", "#C", "#lixo com espaço"]);
    expect(c).toBe("Texto.\n\n{hashtag|\\#|Ransomware} {hashtag|\\#|CyberSecurity} {hashtag|\\#|ZeroDay} {hashtag|\\#|A} {hashtag|\\#|B}");
  });
  it("respeita o limite de 3.000 caracteres sem quebrar um escape", () => {
    const c = buildCommentary("(".repeat(2000), ["#Tag"]);
    expect(c.length).toBeLessThanOrEqual(3000);
    expect(c).toMatch(/…\n\n\{hashtag/);
    expect(c.split("…")[0]!).toMatch(/^(\\\()+$/);
  });
});

describe("refreshAccessToken", () => {
  it("troca o refresh token e devolve o novo par", async () => {
    const { f, calls } = api(() => ({ access_token: "AQnew", expires_in: 5184000, refresh_token: "AQref", refresh_token_expires_in: 31536000 }));
    const r = await refreshAccessToken({ fetchImpl: f }, { id: "cid", secret: "sec" }, "AQold");
    expect(r).toEqual({ token: "AQnew", expiresIn: 5184000, refreshToken: "AQref", refreshExpiresIn: 31536000 });
    const body = new URLSearchParams(String(calls[0]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.url.toString()).not.toContain("AQold");
  });
  it("invalid_grant (400) vira reconexão", async () => {
    const { f } = api(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const e = (await refreshAccessToken({ fetchImpl: f }, { id: "c", secret: "s" }, "x").catch((x: unknown) => x)) as LiApiError;
    expect(e.needsReauth).toBe(true);
  });
});

describe("scrub", () => {
  it("remove tokens do LinkedIn das mensagens", () => {
    expect(scrub(`falhou com AQ${"x".repeat(40)} e access_token=abc`)).toBe("falhou com AQ*** e access_token=***");
  });
});
