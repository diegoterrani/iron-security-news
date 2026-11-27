import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../lib/agent/signature";
import { automationConfigProblem } from "../lib/automation/auth";
import { AUTOMATION_MEDIA_RE, linkedinVideoSchema, newAutomationMediaPath, rpcArgs } from "../lib/automation/linkedin-video";
// @ts-expect-error script .mjs sem tipos (Node puro, roda fora do app)
import { parseArgs, run, sign } from "../../../infra/automation/agendar-linkedin-video.mjs";
// @ts-expect-error script .mjs sem tipos (Node puro, roda fora do app)
import { parseArgs as waParseArgs, run as waRun } from "../../../infra/automation/agendar-whatsapp-grupo.mjs";
import { whatsappGroupSchema, whatsappRpcArgs } from "../lib/automation/whatsapp-group";

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(48);
const ACTOR = "0b0f4c1e-1111-4222-8333-944455556666";
const UUID = "a1b2c3d4-1111-4222-8333-944455556666";
const env = (over: Record<string, string | undefined> = {}) =>
  ({ AUTOMATION_API_ENABLED: "true", AUTOMATION_TOKEN: TOKEN, AUTOMATION_HMAC_SECRET: SECRET, AUTOMATION_ACTOR: ACTOR, ...over }) as unknown as NodeJS.ProcessEnv;

describe("configuração da automação", () => {
  it("aceita segredos próprios e um admin", () => {
    expect(automationConfigProblem(env())).toBeNull();
  });
  it("fica desligada sem o kill switch", () => {
    expect(automationConfigProblem(env({ AUTOMATION_API_ENABLED: undefined }))).toBe("disabled");
  });
  it("recusa segredos curtos, iguais entre si ou reaproveitados do agente", () => {
    expect(automationConfigProblem(env({ AUTOMATION_TOKEN: "curto" }))).toBe("missing secrets");
    expect(automationConfigProblem(env({ AUTOMATION_HMAC_SECRET: TOKEN }))).toBe("token equals secret");
    expect(automationConfigProblem(env({ AGENT_ADMIN_TOKEN: TOKEN }))).toBe("token reused from agent");
    expect(automationConfigProblem(env({ AGENT_HMAC_SECRET: SECRET }))).toBe("secret reused from agent");
  });
  it("exige o admin em AUTOMATION_ACTOR", () => {
    expect(automationConfigProblem(env({ AUTOMATION_ACTOR: "x" }))).toBe("missing actor");
  });
});

describe("caminho e validação do vídeo", () => {
  it("gera só caminhos do prefixo da automação", () => {
    expect(newAutomationMediaPath(UUID)).toBe(`campanhas/auto/${UUID}/video.mp4`);
    expect(AUTOMATION_MEDIA_RE.test(newAutomationMediaPath())).toBe(true);
    expect(() => newAutomationMediaPath("../../x")).toThrow();
  });

  const ok = {
    campaign: " Plantão Cyber ",
    caption: "Resumo do dia",
    media_path: `campanhas/auto/${UUID}/video.mp4`,
    scheduled_for: "2026-11-28T18:00:00-03:00",
    dedupe_key: "plantao-2026-11-28-linkedin",
  };

  it("aceita o pedido do Plantão e apara os textos", () => {
    const r = linkedinVideoSchema.parse(ok);
    expect(r.campaign).toBe("Plantão Cyber");
    expect(rpcArgs(ACTOR, r)).toMatchObject({ p_actor: ACTOR, p_media: ok.media_path, p_first_comment: null });
  });
  it("recusa caminho fora do prefixo, data sem fuso, chave inválida e campos extras", () => {
    expect(linkedinVideoSchema.safeParse({ ...ok, media_path: `campanhas/${UUID}/video.mp4` }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, media_path: `campanhas/auto/${UUID}/../x.mp4` }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, scheduled_for: "2026-11-28 18:00" }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, dedupe_key: "Plantão!" }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, target: "organization" }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, caption: "   " }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, caption: "x".repeat(3001) }).success).toBe(false);
    // Cabe cru (2.800), mas passa de 3.000 no LinkedIn: cada "#" e "_" ganha uma barra de escape.
    expect(linkedinVideoSchema.safeParse({ ...ok, caption: "a_".repeat(1400) }).success).toBe(false);
    expect(linkedinVideoSchema.safeParse({ ...ok, caption: "a_".repeat(700) }).success).toBe(true);
  });
});

describe("script do cliente", () => {
  it("assina igual ao servidor", () => {
    const now = 1_800_000_000_000;
    const ts = String(now);
    const body = JSON.stringify({ a: 1 });
    const signature = sign(SECRET, ts, "post", "/api/automation/v1/uploads", body);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature, method: "POST", path: "/api/automation/v1/uploads", body, now })).toBe(true);
  });

  it("exige vídeo, legenda, horário com fuso e chave", () => {
    expect(() => parseArgs(["--video", "a.mp4"])).toThrow(/legenda/);
    expect(() => parseArgs(["--video", "a", "--legenda", "b", "--quando", "2026-11-28T18:00", "--chave", "k"])).toThrow(/fuso/);
    expect(parseArgs(["--video", "a", "--legenda", "b", "--quando", "2026-11-28T18:00:00-03:00", "--chave", "plantao-x"]).campanha).toBe("Plantão Cyber");
  });

  it("faz upload, PUT do MP4 e agenda, sem mandar segredo ao Storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-"));
    await writeFile(join(dir, "v.mp4"), Buffer.alloc(1024, 1));
    await writeFile(join(dir, "l.txt"), "  Legenda do dia \n");
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/uploads")) return Response.json({ ok: true, data: { path: `campanhas/auto/${UUID}/video.mp4`, signed_url: "https://st.example/upload?token=x" } });
      if (url.startsWith("https://st.example")) return new Response("{}", { status: 200 });
      return Response.json({ ok: true, data: { id: UUID, status: "pending", duplicate: false } });
    };
    const data = await run(
      ["--video", join(dir, "v.mp4"), "--legenda", join(dir, "l.txt"), "--quando", "2026-11-28T18:00:00-03:00", "--chave", "plantao-2026-11-28-linkedin"],
      { NEWS_AUTOMATION_URL: "https://news.example/", AUTOMATION_TOKEN: TOKEN, AUTOMATION_HMAC_SECRET: SECRET },
      fake,
    );
    expect(data.status).toBe("pending");
    expect(calls.map((c) => c.url)).toEqual([
      "https://news.example/api/automation/v1/uploads",
      "https://st.example/upload?token=x",
      "https://news.example/api/automation/v1/linkedin-video",
    ]);
    const storageHeaders = JSON.stringify(calls[1]!.init.headers);
    expect(storageHeaders).not.toContain(TOKEN);
    const sent = JSON.parse(String(calls[2]!.init.body));
    expect(sent).toMatchObject({ caption: "Legenda do dia", media_path: `campanhas/auto/${UUID}/video.mp4`, dedupe_key: "plantao-2026-11-28-linkedin" });
  });

  it("propaga o erro do servidor sem vazar o token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-"));
    await writeFile(join(dir, "v.mp4"), Buffer.alloc(10, 1));
    await writeFile(join(dir, "l.txt"), "x");
    const fake = async () => Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    await expect(run(
      ["--video", join(dir, "v.mp4"), "--legenda", join(dir, "l.txt"), "--quando", "2026-11-28T18:00:00Z", "--chave", "plantao-x"],
      { AUTOMATION_TOKEN: TOKEN, AUTOMATION_HMAC_SECRET: SECRET }, fake,
    )).rejects.toThrow(/HTTP 401: Unauthorized/);
  });
});

describe("texto no grupo do WhatsApp", () => {
  const ok = { body: "  *Plantão Cyber nº 4*\n\nhttps://youtu.be/x  ", send_after: "2026-11-28T18:00:00-03:00", dedupe_key: "plantao-2026-11-28-whatsapp" };

  it("aceita o pedido do Plantão e apara o texto", () => {
    const r = whatsappGroupSchema.parse(ok);
    expect(r.body).toBe("*Plantão Cyber nº 4*\n\nhttps://youtu.be/x");
    expect(whatsappRpcArgs(ACTOR, r)).toEqual({ p_actor: ACTOR, p_body: r.body, p_send_after: ok.send_after, p_dedupe_key: ok.dedupe_key });
  });

  it("recusa texto vazio ou longo, horário sem fuso, chave inválida e campos extras (como outro grupo)", () => {
    expect(whatsappGroupSchema.safeParse({ ...ok, body: "   " }).success).toBe(false);
    expect(whatsappGroupSchema.safeParse({ ...ok, body: "x".repeat(1501) }).success).toBe(false);
    expect(whatsappGroupSchema.safeParse({ ...ok, send_after: "2026-11-28 18:00" }).success).toBe(false);
    expect(whatsappGroupSchema.safeParse({ ...ok, dedupe_key: "Plantão!" }).success).toBe(false);
    expect(whatsappGroupSchema.safeParse({ ...ok, group: "123@g.us" }).success).toBe(false);
    expect(whatsappGroupSchema.safeParse({ ...ok, media: "https://x/y.png" }).success).toBe(false);
  });

  it("o script exige mensagem, horário com fuso e chave", () => {
    expect(() => waParseArgs(["--mensagem", "a.txt"])).toThrow(/quando/);
    expect(() => waParseArgs(["--mensagem", "a", "--quando", "2026-11-28T18:00", "--chave", "k"])).toThrow(/fuso/);
  });

  it("o script envia o texto assinado à rota e recusa mensagem longa antes de chamar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    await writeFile(join(dir, "m.txt"), "  Manchetes do dia \n");
    await writeFile(join(dir, "longa.txt"), "x".repeat(1501));
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, data: { id: UUID, status: "pending", duplicate: false } });
    };
    const envOk = { NEWS_AUTOMATION_URL: "https://news.example", AUTOMATION_TOKEN: TOKEN, AUTOMATION_HMAC_SECRET: SECRET };
    const args = (f: string) => ["--mensagem", join(dir, f), "--quando", "2026-11-28T18:00:00-03:00", "--chave", "plantao-2026-11-28-whatsapp"];

    expect((await waRun(args("m.txt"), envOk, fake)).status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://news.example/api/automation/v1/whatsapp-group");
    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = String(calls[0]!.init.body);
    expect(verifySignature({ secret: SECRET, timestamp: headers["x-automation-timestamp"]!, signature: headers["x-automation-signature"]!, method: "POST", path: "/api/automation/v1/whatsapp-group", body, now: Number(headers["x-automation-timestamp"]) })).toBe(true);
    expect(JSON.parse(body)).toEqual({ body: "Manchetes do dia", send_after: "2026-11-28T18:00:00-03:00", dedupe_key: "plantao-2026-11-28-whatsapp" });

    await expect(waRun(args("longa.txt"), envOk, fake)).rejects.toThrow(/1501 caracteres/);
    expect(calls).toHaveLength(1);
  });
});

describe("erro do upload do vídeo", () => {
  it("mostra o motivo do Storage sem a URL assinada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-"));
    await writeFile(join(dir, "v.mp4"), Buffer.alloc(10, 1));
    await writeFile(join(dir, "l.txt"), "x");
    const fake = async (url: string) => {
      if (url.endsWith("/uploads")) return Response.json({ ok: true, data: { path: `campanhas/auto/${UUID}/video.mp4`, signed_url: "https://st.example/upload?token=segredo" } });
      return new Response(JSON.stringify({ statusCode: "413", error: "Payload too large" }), { status: 400 });
    };
    const err = await run(
      ["--video", join(dir, "v.mp4"), "--legenda", join(dir, "l.txt"), "--quando", "2026-11-28T18:00:00Z", "--chave", "plantao-x"],
      { AUTOMATION_TOKEN: TOKEN, AUTOMATION_HMAC_SECRET: SECRET }, fake,
    ).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 400: .*Payload too large/);
    expect(String(err)).not.toContain("segredo");
  });
});
