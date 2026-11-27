import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../lib/agent/signature";
import { automationConfigProblem } from "../lib/automation/auth";
import { AUTOMATION_MEDIA_RE, linkedinVideoSchema, newAutomationMediaPath, rpcArgs } from "../lib/automation/linkedin-video";
// @ts-expect-error script .mjs sem tipos (Node puro, roda fora do app)
import { parseArgs, run, sign } from "../../../infra/automation/agendar-linkedin-video.mjs";

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
