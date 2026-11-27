import { encryptToken } from "@ironnews/shared";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_PATH_RE, pngSize, publishDueCampaignPosts, type CampaignPost } from "../src/publish/campaign";
import { publishReel } from "../src/publish/instagram-api";
import { campaignCommentary, createComment, uploadDocument, uploadVideo } from "../src/publish/linkedin-api";

type Call = { url: URL; method: string; headers: Headers; body: unknown };

/** API falsa: responde por rota e grava as chamadas. */
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

const li = (f: typeof fetch) => ({ apiVersion: "202606", fetchImpl: f, sleep: async () => undefined });
const OWNER = "urn:li:person:abc123";
const VIDEO = "urn:li:video:C5F10AQ";
const DOC = "urn:li:document:D4D10AQ";
const POST = "urn:li:share:7000000000000000001";

describe("uploadVideo (LinkedIn)", () => {
  it("sobe cada parte sem token, finaliza com os ETags na ordem e espera AVAILABLE", async () => {
    let polls = 0;
    const { f, calls } = api((c) => {
      if (c.url.pathname === "/rest/videos" && c.url.searchParams.get("action") === "initializeUpload") {
        return {
          value: {
            video: VIDEO, uploadToken: "tok",
            uploadInstructions: [
              { uploadUrl: "https://www.linkedin.com/dms-uploads/p1", firstByte: 0, lastByte: 3 },
              { uploadUrl: "https://www.linkedin.com/dms-uploads/p2", firstByte: 4, lastByte: 5 },
            ],
          },
        };
      }
      if (c.method === "PUT") return new Response(null, { status: 200, headers: { etag: c.url.pathname.endsWith("p1") ? "e1" : "e2" } });
      if (c.url.searchParams.get("action") === "finalizeUpload") return new Response(null, { status: 200 });
      if (c.url.pathname === `/rest/videos/${encodeURIComponent(VIDEO)}`) return { status: ++polls < 3 ? "PROCESSING" : "AVAILABLE" };
      throw new Error(c.url.toString());
    });
    expect(await uploadVideo(li(f), "AQTOKEN", OWNER, Buffer.from("abcdef"))).toBe(VIDEO);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      initializeUploadRequest: { owner: OWNER, fileSizeBytes: 6, uploadCaptions: false, uploadThumbnail: false },
    });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => Buffer.from(c.body as Uint8Array).toString())).toEqual(["abcd", "ef"]);
    for (const p of puts) expect(p.headers.get("authorization")).toBeNull();
    const fin = calls.find((c) => c.url.searchParams.get("action") === "finalizeUpload")!;
    expect(JSON.parse(String(fin.body))).toEqual({ finalizeUploadRequest: { video: VIDEO, uploadToken: "tok", uploadedPartIds: ["e1", "e2"] } });
    for (const c of calls) expect(c.url.toString()).not.toContain("AQTOKEN");
  });
  it("recusa uploadUrl fora do LinkedIn e intervalo de bytes inválido", async () => {
    const evil = api(() => ({ value: { video: VIDEO, uploadInstructions: [{ uploadUrl: "https://evil.example.com/x", firstByte: 0, lastByte: 1 }] } }));
    await expect(uploadVideo(li(evil.f), "t", OWNER, Buffer.from("ab"))).rejects.toThrow(/fora do LinkedIn/);
    expect(evil.calls).toHaveLength(1);
    const bad = api(() => ({ value: { video: VIDEO, uploadInstructions: [{ uploadUrl: "https://www.linkedin.com/x", firstByte: 0, lastByte: 99 }] } }));
    await expect(uploadVideo(li(bad.f), "t", OWNER, Buffer.from("ab"))).rejects.toThrow(/intervalo/);
  });
  it("processamento com falha interrompe", async () => {
    const { f } = api((c) => {
      if (c.url.searchParams.get("action") === "initializeUpload") {
        return { value: { video: VIDEO, uploadInstructions: [{ uploadUrl: "https://www.linkedin.com/x", firstByte: 0, lastByte: 1 }] } };
      }
      if (c.method === "PUT") return new Response(null, { status: 200, headers: { etag: "e" } });
      if (c.method === "POST") return new Response(null, { status: 200 });
      return { status: "PROCESSING_FAILED" };
    });
    await expect(uploadVideo(li(f), "t", OWNER, Buffer.from("ab"))).rejects.toThrow(/processar o vídeo/);
  });
});

describe("uploadDocument (LinkedIn)", () => {
  it("inicia, envia o PDF para a uploadUrl do LinkedIn e espera AVAILABLE", async () => {
    let polls = 0;
    const { f, calls } = api((c) => {
      if (c.url.pathname === "/rest/documents" && c.method === "POST") return { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/doc", document: DOC } };
      if (c.method === "PUT") return new Response(null, { status: 201 });
      if (c.url.pathname === `/rest/documents/${encodeURIComponent(DOC)}`) return { status: ++polls < 2 ? "PROCESSING" : "AVAILABLE" };
      throw new Error(c.url.toString());
    });
    expect(await uploadDocument(li(f), "AQTOKEN", OWNER, Buffer.from("%PDF"))).toBe(DOC);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ initializeUploadRequest: { owner: OWNER } });
  });
});

describe("createComment (LinkedIn)", () => {
  it("comenta como o autor no post certo", async () => {
    const { f, calls } = api(() => new Response(null, { status: 201 }));
    await createComment(li(f), "t", { actor: OWNER, postUrn: POST, text: "Fontes: x. Link: https://iron-security.com/contato?utm_source=linkedin" });
    expect(calls[0]!.url.pathname).toBe(`/rest/socialActions/${encodeURIComponent(POST)}/comments`);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      actor: OWNER, object: POST, message: { text: "Fontes: x. Link: https://iron-security.com/contato?utm_source=linkedin" },
    });
  });
  it("recusa URN de post inválido sem chamar a API", async () => {
    const { f, calls } = api(() => ({}));
    await expect(createComment(li(f), "t", { actor: OWNER, postUrn: "urn:li:x:1", text: "oi" })).rejects.toThrow(/URN/);
    expect(calls).toHaveLength(0);
  });
});

describe("campaignCommentary (little text)", () => {
  it("escapa os reservados e mantém as hashtags clicáveis", () => {
    expect(campaignCommentary("Agende (7 dias): iron.com/a_b\n\n#Cibersegurança #CISO"))
      .toBe("Agende \\(7 dias\\): iron.com/a\\_b\n\n{hashtag|\\#|Cibersegurança} {hashtag|\\#|CISO}");
  });
  it("# grudado numa palavra não vira hashtag", () => {
    expect(campaignCommentary("C#")).toBe("C\\#");
  });
  it("número sozinho não vira hashtag (o LinkedIn mostraria o template cru)", () => {
    expect(campaignCommentary("Plantão Cyber #3 · 27/11 #CVE2026"))
      .toBe("Plantão Cyber \\#3 · 27/11 {hashtag|\\#|CVE2026}");
  });
});

describe("publishReel (Instagram)", () => {
  it("cria o contêiner REELS, espera FINISHED e publica; token só no header", async () => {
    let polls = 0;
    const { f, calls } = api((c) => {
      if (c.method === "POST" && c.url.pathname.endsWith("/123/media")) return { id: "900" };
      if (c.method === "GET" && c.url.pathname.endsWith("/900")) return { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" };
      if (c.url.pathname.endsWith("/media_publish")) return { id: "901" };
      if (c.url.pathname.endsWith("/901")) return { permalink: "https://www.instagram.com/reel/abc/" };
      throw new Error(c.url.toString());
    });
    const r = await publishReel({ graphVersion: "v23.0", host: "facebook", fetchImpl: f, sleep: async () => undefined },
      { igUserId: "123", token: "EAATOKEN", videoUrl: "https://x.supabase.co/v.mp4", caption: "Legenda #tag" });
    expect(r).toEqual({ mediaId: "901", permalink: "https://www.instagram.com/reel/abc/" });
    const create = new URLSearchParams(String(calls[0]!.body));
    expect(Object.fromEntries(create)).toEqual({ media_type: "REELS", video_url: "https://x.supabase.co/v.mp4", caption: "Legenda #tag", share_to_feed: "true" });
    expect(calls[0]!.url.hostname).toBe("graph.facebook.com");
    for (const c of calls) {
      expect(c.headers.get("authorization")).toBe("Bearer EAATOKEN");
      expect(c.url.toString()).not.toContain("EAATOKEN");
    }
  });
  it("erro no processamento do vídeo interrompe sem publicar", async () => {
    const { f, calls } = api((c) => (c.method === "POST" ? { id: "900" } : { status_code: "ERROR", status: "formato" }));
    await expect(publishReel({ graphVersion: "v23.0", fetchImpl: f, sleep: async () => undefined },
      { igUserId: "123", token: "t", videoUrl: "https://x/v.mp4", caption: "c" })).rejects.toThrow(/processamento do vídeo/);
    expect(calls.some((c) => c.url.pathname.endsWith("/media_publish"))).toBe(false);
  });
});

describe("caminhos e PNG", () => {
  it("só aceita arquivos dentro de campanhas/<uuid>/", () => {
    expect(MEDIA_PATH_RE.test("campanhas/0b6f4c1e-1111-4a2b-9c3d-123456789abc/01-video.mp4")).toBe(true);
    expect(MEDIA_PATH_RE.test("campanhas/../segredo.mp4")).toBe(false);
    // Prefixo da automação (agendamento diário do Plantão Cyber, /api/automation/v1/uploads).
    expect(MEDIA_PATH_RE.test("campanhas/auto/0b6f4c1e-1111-4a2b-9c3d-123456789abc/video.mp4")).toBe(true);
    expect(MEDIA_PATH_RE.test("campanhas/auto/../0b6f4c1e-1111-4a2b-9c3d-123456789abc/video.mp4")).toBe(false);
    expect(MEDIA_PATH_RE.test("campanhas/outro/0b6f4c1e-1111-4a2b-9c3d-123456789abc/video.mp4")).toBe(false);
    expect(MEDIA_PATH_RE.test("stories/0b6f4c1e-1111-4a2b-9c3d-123456789abc/a.mp4")).toBe(false);
    expect(MEDIA_PATH_RE.test("campanhas/0b6f4c1e-1111-4a2b-9c3d-123456789abc/a.exe")).toBe(false);
  });
  it("lê largura e altura do cabeçalho PNG", () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(1350, 20);
    expect(pngSize(png)).toEqual({ width: 1080, height: 1350 });
    expect(() => pngSize(Buffer.from("nao e png"))).toThrow(/PNG/);
  });
});

// ---------- worker (banco falso) ----------

const KEY = Buffer.alloc(32, 7).toString("base64");
const UUID = "0b6f4c1e-1111-4a2b-9c3d-123456789abc";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const storage = { supabaseUrl: "https://proj.supabase.co", serviceKey: "svc" };

function fakePool(post: CampaignPost, integ: Record<string, unknown>) {
  const updates: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/set status = 'publishing'/.test(sql)) return { rows: [post] };
      if (/from integrations/.test(sql)) return { rows: [integ] };
      updates.push({ sql, params });
      return { rows: [] };
    }),
  };
  return { pool: pool as never, updates };
}

const liPost = (over: Partial<CampaignPost> = {}): CampaignPost => ({
  id: "11111111-2222-3333-4444-555555555555", channel: "linkedin", target: "member", format: "document",
  caption: "Carrossel #CISO", first_comment: "Link: https://iron-security.com/contato", doc_title: "Antes da próxima onda",
  media: [`campanhas/${UUID}/01-carrossel.pdf`], attempts: 1, integration_id: "int-1", ...over,
});

async function liInteg() {
  const enc = await encryptToken(KEY, "AQTOKEN", `linkedin:member:${OWNER}`);
  return { channel: "linkedin", target: "member", account_id: OWNER, access_token_enc: Buffer.from(enc), status: "active", expires_at: null, meta: {} };
}

describe("publishDueCampaignPosts", () => {
  it("modo de teste: baixa o arquivo, não chama o LinkedIn e marca skipped", async () => {
    const { pool, updates } = fakePool(liPost(), await liInteg());
    const { f, calls } = api((c) => (c.url.hostname === "proj.supabase.co" ? new Response("%PDF-1.7") : (() => { throw new Error("chamou a API"); })()));
    expect(await publishDueCampaignPosts({ pool, log, storage, tokenKey: KEY, dryRun: true, ig: { graphVersion: "v23.0" }, li: li(f), fetchImpl: f })).toBe(0);
    expect(calls.map((c) => c.url.hostname)).toEqual(["proj.supabase.co"]);
    expect(calls[0]!.url.pathname).toBe(`/storage/v1/object/public/media/campanhas/${UUID}/01-carrossel.pdf`);
    expect(updates.some((u) => /status = 'skipped'/.test(u.sql))).toBe(true);
  });

  it("publica o PDF com título e comenta; falha no comentário vira aviso, não falha do post", async () => {
    const { pool, updates } = fakePool(liPost(), await liInteg());
    let polls = 0;
    const { f, calls } = api((c) => {
      if (c.url.hostname === "proj.supabase.co") return new Response("%PDF-1.7");
      if (c.url.pathname === "/rest/documents" && c.method === "POST") return { value: { uploadUrl: "https://www.linkedin.com/up", document: DOC } };
      if (c.method === "PUT") return new Response(null, { status: 201 });
      if (c.url.pathname.startsWith("/rest/documents/")) return { status: ++polls < 2 ? "PROCESSING" : "AVAILABLE" };
      if (c.url.pathname === "/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": POST } });
      if (c.url.pathname.includes("/comments")) return new Response(JSON.stringify({ message: "sem permissão" }), { status: 403 });
      throw new Error(c.url.toString());
    });
    expect(await publishDueCampaignPosts({ pool, log, storage, tokenKey: KEY, dryRun: false, ig: { graphVersion: "v23.0" }, li: li(f), fetchImpl: f })).toBe(1);
    const post = calls.find((c) => c.url.pathname === "/rest/posts")!;
    const body = JSON.parse(String(post.body));
    expect(body.author).toBe(OWNER);
    expect(body.commentary).toBe("Carrossel {hashtag|\\#|CISO}");
    expect(body.content.media).toEqual({ id: DOC, title: "Antes da próxima onda" });
    const done = updates.find((u) => /status = 'published'/.test(u.sql))!;
    expect(done.params[1]).toBe(POST);
    expect(String(done.params[3])).toMatch(/1º comentário falhou/);
  });

  it("conta de outro destino ou token vencido: falha com mensagem e não chama a API", async () => {
    const integ = { ...(await liInteg()), target: "organization" };
    const { pool, updates } = fakePool(liPost(), integ);
    const { f, calls } = api(() => ({}));
    await publishDueCampaignPosts({ pool, log, storage, tokenKey: KEY, dryRun: false, ig: { graphVersion: "v23.0" }, li: li(f), fetchImpl: f });
    expect(calls).toHaveLength(0);
    const failed = updates.find((u) => /status = 'failed', last_error = \$2/.test(u.sql))!;
    expect(String(failed.params[1])).toMatch(/Reconecte em Integrações/);
  });

  it("Reels: manda ao Instagram a URL pública do Storage", async () => {
    const enc = await encryptToken(KEY, "EAATOKEN", "instagram:123");
    const integ = { channel: "instagram", target: "default", account_id: "123", access_token_enc: Buffer.from(enc), status: "active", expires_at: null, meta: { api_host: "facebook" } };
    const post = liPost({ channel: "instagram", target: "default", format: "reel", first_comment: null, doc_title: null, media: [`campanhas/${UUID}/01-reel.mp4`] });
    const { pool } = fakePool(post, integ);
    const { f, calls } = api((c) => {
      if (c.method === "POST" && c.url.pathname.endsWith("/123/media")) return { id: "900" };
      if (c.url.pathname.endsWith("/900")) return { status_code: "FINISHED" };
      if (c.url.pathname.endsWith("/media_publish")) return { id: "901" };
      return { permalink: "https://www.instagram.com/reel/x/" };
    });
    expect(await publishDueCampaignPosts({
      pool, log, storage, tokenKey: KEY, dryRun: false, ig: { graphVersion: "v23.0", fetchImpl: f, sleep: async () => undefined }, li: li(f), fetchImpl: f,
    })).toBe(1);
    expect(new URLSearchParams(String(calls[0]!.body)).get("video_url"))
      .toBe(`https://proj.supabase.co/storage/v1/object/public/media/campanhas/${UUID}/01-reel.mp4`);
  });
});
