import { describe, expect, it } from "vitest";
import { planCreatives, type ContentForRender, type StoryForRender } from "../src/render/creatives";
import { renderPng } from "../src/render/png";
import { publicUrl, uploadObject } from "../src/render/storage";

const story: StoryForRender = {
  id: "fe38bb06-f6a7-4d9d-9cbd-5ff031c22683", severity: "high", category: "vulnerability", cve_ids: ["CVE-2026-123158"],
  slug_pt: "falha-sshole", slug_en: "sshole-flaw",
};
const c = (channel: ContentForRender["channel"], lang: "pt" | "en", kind: string, version: number, body: Record<string, unknown>, title: string | null = null): ContentForRender =>
  ({ channel, lang, kind, version, title, body });
const slides = [{ heading: "Capa", body: "a" }, { heading: "Dois", body: "b" }, { heading: "Três", body: "c" }, { heading: " ", body: "vazio" }];
const contents = [
  c("blog", "pt", "article", 2, {}, "Falha sshole no OpenSSH é explorada"),
  c("blog", "en", "article", 1, {}, "SSHole OpenSSH flaw exploited"),
  c("instagram", "pt", "carousel", 3, { slides }),
  c("linkedin", "pt", "post", 1, { text: "x" }),
  c("youtube", "pt", "script", 1, { on_screen_hook: "Seu servidor pode estar exposto" }),
];

describe("planCreatives (§4.7)", () => {
  const plan = planCreatives(story, contents);
  it("PT: capa, card, carrossel (capa + slides + CTA, sem slide vazio) e capa do Short", () => {
    const pt = plan.filter((p) => p.lang === "pt").map((p) => `${p.channel}:${p.kind}:${p.position}:v${p.contentVersion}`);
    expect(pt).toEqual([
      "blog:cover:1:v2", "linkedin:card:1:v1",
      "instagram:carousel_slide:1:v3", "instagram:carousel_slide:2:v3", "instagram:carousel_slide:3:v3", "instagram:carousel_slide:4:v3",
      "youtube:thumbnail:1:v1",
    ]);
  });
  it("EN sem derivados: só capa e card (versão do artigo)", () => {
    expect(plan.filter((p) => p.lang === "en").map((p) => `${p.channel}:${p.kind}:v${p.contentVersion}`)).toEqual(["blog:cover:v1", "linkedin:card:v1"]);
  });
  it("sem slug ou sem artigo não gera nada", () => {
    expect(planCreatives({ ...story, slug_pt: null, slug_en: null }, contents)).toEqual([]);
    expect(planCreatives(story, [])).toEqual([]);
  });
});

describe("renderPng", () => {
  it("gera PNG no tamanho do template com as fontes do kit", async () => {
    const [cover] = planCreatives(story, contents);
    const png = await renderPng(cover!.el, cover!.size);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  }, 30_000);
});

describe("storage", () => {
  const cfg = { supabaseUrl: "https://x.supabase.co/", serviceKey: "sb_secret_" + "k".repeat(20) };
  it("URL pública do bucket media", () => {
    expect(publicUrl(cfg, "stories/a/pt/x.png")).toBe("https://x.supabase.co/storage/v1/object/public/media/stories/a/pt/x.png");
  });
  it("recusa caminho com ..; envia upsert com a chave", async () => {
    await expect(uploadObject(cfg, "../etc/passwd", Buffer.from("x"), "image/png")).rejects.toThrow(/inválido/);
    let headers: Headers | undefined;
    const fake = (async (_u: string, init: RequestInit) => { headers = new Headers(init.headers); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await uploadObject({ ...cfg, fetchImpl: fake }, "stories/a/pt/x.png", Buffer.from("x"), "image/png");
    expect(headers?.get("x-upsert")).toBe("true");
    expect(headers?.get("apikey")).toBe(cfg.serviceKey);
  });
});

describe("fundo por IA", () => {
  it("planCreatives passa o fundo a todos os criativos; sem fundo, nada muda", () => {
    const withBg = planCreatives(story, contents, "data:image/jpeg;base64,AAAA");
    const json = JSON.stringify(withBg.map((p) => p.el));
    expect(json.split("data:image/jpeg;base64,AAAA").length - 1).toBe(withBg.length);
    expect(JSON.stringify(planCreatives(story, contents).map((p) => p.el))).not.toContain("data:image/jpeg");
  });
  it("generateImage decodifica o JPEG do Workers AI e trata erro da API", async () => {
    const { generateImage } = await import("../src/render/background");
    let sent: { url: string; body: string } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body) };
      return new Response(JSON.stringify({ success: true, result: { image: Buffer.from("jpeg-bytes").toString("base64") } }), { status: 200 });
    }) as unknown as typeof fetch;
    const img = await generateImage({ accountId: "acc", token: "t", fetchImpl: ok }, "a dark server rack");
    expect(img.toString()).toBe("jpeg-bytes");
    expect(sent!.url).toContain("/accounts/acc/ai/run/@cf/black-forest-labs/flux-1-schnell");
    expect(JSON.parse(sent!.body)).toMatchObject({ prompt: "a dark server rack", steps: 8 });
    const fail = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 401 })) as unknown as typeof fetch;
    await expect(generateImage({ accountId: "acc", token: "t", fetchImpl: fail }, "x")).rejects.toThrow(/Authentication error/);
  });
});
