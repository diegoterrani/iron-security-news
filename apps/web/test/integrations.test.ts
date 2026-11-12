import { describe, expect, it, vi } from "vitest";
import { INSTAGRAM_SCOPES, InstagramError, accountFromToken, authorizeUrl, connectWithCode, instagramConfig } from "../lib/integrations/instagram";
import { createState, verifyState } from "../lib/integrations/oauth-state";

const SECRET = "s".repeat(40);
const cfg = instagramConfig({ INSTAGRAM_APP_ID: "123456", INSTAGRAM_APP_SECRET: "app-secret" }, "https://news.iron-security.com/")!;

describe("oauth state (CSRF do callback)", () => {
  it("aceita o state do mesmo usuário, com o cookie certo e dentro do prazo", async () => {
    const { state, nonce } = await createState(SECRET, "user-1", 1000);
    expect(await verifyState(SECRET, state, nonce, "user-1", 1500)).toEqual({ ok: true });
  });
  it("recusa state ausente, adulterado, expirado, de outro cookie ou de outro usuário", async () => {
    const { state, nonce } = await createState(SECRET, "user-1", 1000);
    expect(await verifyState(SECRET, null, nonce, "user-1", 1000)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyState(SECRET, state, undefined, "user-1", 1000)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyState(SECRET, `${state}0`, nonce, "user-1", 1000)).toMatchObject({ ok: false, reason: "signature" });
    expect(await verifyState("x".repeat(40), state, nonce, "user-1", 1000)).toMatchObject({ ok: false, reason: "signature" });
    expect(await verifyState(SECRET, state, nonce, "user-1", 1000 + 601)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyState(SECRET, state, "outro", "user-1", 1000)).toEqual({ ok: false, reason: "nonce" });
    expect(await verifyState(SECRET, state, nonce, "user-2", 1000)).toEqual({ ok: false, reason: "user" });
  });
  it("exige segredo de pelo menos 32 caracteres", async () => {
    await expect(createState("curto", "u")).rejects.toThrow(/OAUTH_STATE_SECRET/);
  });
});

describe("instagramConfig / authorizeUrl", () => {
  it("sem app id numérico ou sem secret: não configurado", () => {
    expect(instagramConfig({}, "https://x")).toBeNull();
    expect(instagramConfig({ INSTAGRAM_APP_ID: "abc", INSTAGRAM_APP_SECRET: "s" }, "https://x")).toBeNull();
  });
  it("monta a URL de autorização com redirect exato, escopos mínimos e state", () => {
    const u = new URL(authorizeUrl(cfg, "st"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("https://news.iron-security.com/admin/integracoes/instagram/callback");
    expect(u.searchParams.get("scope")).toBe(INSTAGRAM_SCOPES.join(","));
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("client_id")).toBe("123456");
    expect(u.toString()).not.toContain("app-secret");
    expect(cfg.graphVersion).toBe("v23.0");
  });
});

function fakeFetch(responses: Record<string, unknown | Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`url inesperada: ${url}`);
    const r = responses[key];
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
}

const OK = {
  "api.instagram.com/oauth/access_token": { access_token: "short", user_id: 1, permissions: "instagram_business_basic,instagram_business_content_publish" },
  "graph.instagram.com/access_token": { access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 },
  "graph.instagram.com/v23.0/me": { user_id: "17841400000000000", username: "ironsecurity", account_type: "BUSINESS" },
};

describe("connectWithCode", () => {
  it("troca o code por token longo e lê a conta profissional", async () => {
    const f = fakeFetch(OK);
    const acc = await connectWithCode(cfg, "abc#_", f, new Date("2026-11-12T00:00:00Z"));
    expect(acc).toMatchObject({ accountId: "17841400000000000", username: "ironsecurity", accessToken: "LONG" });
    expect(acc.expiresAt.toISOString()).toBe("2027-01-11T00:00:00.000Z");
    const first = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(new URLSearchParams(String(first[1].body)).get("code")).toBe("abc");
  });
  it("aceita a resposta no formato { data: [...] }", async () => {
    const acc = await connectWithCode(cfg, "c", fakeFetch({ ...OK, "api.instagram.com/oauth/access_token": { data: [OK["api.instagram.com/oauth/access_token"]] } }));
    expect(acc.accessToken).toBe("LONG");
  });
  it("recusa conta pessoal", async () => {
    const f = fakeFetch({ ...OK, "graph.instagram.com/v23.0/me": { user_id: "1", username: "x", account_type: "PERSONAL" } });
    await expect(connectWithCode(cfg, "c", f)).rejects.toMatchObject({ code: "not_professional" });
  });
  it("recusa quando faltou a permissão de publicar", async () => {
    const f = fakeFetch({ ...OK, "api.instagram.com/oauth/access_token": { access_token: "s", permissions: "instagram_business_basic" } });
    await expect(connectWithCode(cfg, "c", f)).rejects.toMatchObject({ code: "scopes" });
  });
  it("erro HTTP vira código estável, sem repassar o corpo da resposta", async () => {
    const f = fakeFetch({ ...OK, "api.instagram.com/oauth/access_token": new Response('{"error_message":"segredo"}', { status: 400 }) });
    const err = await connectWithCode(cfg, "c", f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstagramError);
    expect((err as InstagramError).code).toBe("exchange");
    expect((err as Error).message).not.toContain("segredo");
  });
  it("falha de rede vira 'network'", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(connectWithCode(cfg, "c", f)).rejects.toMatchObject({ code: "network" });
  });
});

describe("accountFromToken (token colado do painel da Meta)", () => {
  const IG = `IGAA${"x".repeat(60)}`;
  const FB = `EAA${"y".repeat(60)}`;
  const ID = "17841467008904236";
  const callOf = (f: typeof fetch) => (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;

  it("IGAA: confere a conta em graph.instagram.com e marca validade de 59 dias", async () => {
    const f = fakeFetch({ "graph.instagram.com/v23.0/me": OK["graph.instagram.com/v23.0/me"] });
    const acc = await accountFromToken("v23.0", IG, null, f, new Date("2026-11-12T00:00:00Z"));
    expect(acc).toMatchObject({ accountId: "17841400000000000", username: "ironsecurity", accessToken: IG, host: "instagram" });
    expect(acc.expiresAt?.toISOString()).toBe("2027-01-10T00:00:00.000Z");
    expect(callOf(f)[0]).not.toContain(IG); // token só no header
    expect(new Headers(callOf(f)[1].headers).get("authorization")).toBe(`Bearer ${IG}`);
  });
  it("EAA (usuário do sistema): exige o id da conta, confere em graph.facebook.com e fica sem validade", async () => {
    const f = fakeFetch({ [`graph.facebook.com/v23.0/${ID}`]: { id: ID, username: "diegoterrani1" } });
    const acc = await accountFromToken("v23.0", FB, ID, f);
    expect(acc).toMatchObject({ accountId: ID, username: "diegoterrani1", host: "facebook", expiresAt: null });
    expect(callOf(f)[0]).not.toContain(FB);
    await expect(accountFromToken("v23.0", FB, null, f)).rejects.toMatchObject({ code: "ig_id" });
    await expect(accountFromToken("v23.0", FB, "abc", f)).rejects.toMatchObject({ code: "ig_id" });
  });
  it("EAA que não enxerga a conta informada é recusado", async () => {
    const other = fakeFetch({ "graph.facebook.com": { id: "999", username: "outra" } });
    await expect(accountFromToken("v23.0", FB, ID, other)).rejects.toMatchObject({ code: "profile" });
    const denied = fakeFetch({ "graph.facebook.com": new Response("{}", { status: 400 }) });
    await expect(accountFromToken("v23.0", FB, ID, denied)).rejects.toMatchObject({ code: "token_invalid" });
  });
  it("recusa formato desconhecido sem chamar a API", async () => {
    const f = fakeFetch({});
    await expect(accountFromToken("v23.0", "IGAA curto", null, f)).rejects.toMatchObject({ code: "token_format" });
    await expect(accountFromToken("v23.0", `XYZ${"x".repeat(60)}`, ID, f)).rejects.toMatchObject({ code: "token_format" });
    expect(f).not.toHaveBeenCalled();
  });
  it("IGAA recusado vira token_invalid; conta pessoal é recusada", async () => {
    const bad = fakeFetch({ "graph.instagram.com": new Response("{}", { status: 400 }) });
    await expect(accountFromToken("v23.0", IG, null, bad)).rejects.toMatchObject({ code: "token_invalid" });
    const personal = fakeFetch({ "graph.instagram.com": { user_id: "1", username: "x", account_type: "PERSONAL" } });
    await expect(accountFromToken("v23.0", IG, null, personal)).rejects.toBeInstanceOf(InstagramError);
  });
});
