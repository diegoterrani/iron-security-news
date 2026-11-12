import { describe, expect, it, vi } from "vitest";
import { LINKEDIN_SCOPES, LinkedinError, authorizeUrl, connectWithCode, linkedinConfig, targetFromSlug, tokenContext } from "../lib/integrations/linkedin";

const SITE = "https://news.iron-security.com/";
const member = linkedinConfig("member", { LINKEDIN_CLIENT_ID: "86abc123", LINKEDIN_CLIENT_SECRET: "li-secret" }, SITE)!;
const org = (orgId?: string) =>
  linkedinConfig("organization", { LINKEDIN_ORG_CLIENT_ID: "77org456", LINKEDIN_ORG_CLIENT_SECRET: "org-secret", LINKEDIN_ORG_ID: orgId, LINKEDIN_API_VERSION: "202607" }, SITE)!;

type Call = { url: URL; method: string; headers: Headers; body: URLSearchParams };
function fake(routes: (c: Call) => Response | unknown) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const c: Call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: new URLSearchParams(init?.body ? String(init.body) : "") };
    calls.push(c);
    const r = routes(c);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const TOKEN = { access_token: "AQVtoken", expires_in: 5_184_000, scope: "openid,profile,w_member_social" };

describe("linkedinConfig / authorizeUrl", () => {
  it("cada alvo lê o seu app; sem client id/secret não está configurado", () => {
    expect(linkedinConfig("member", {}, SITE)).toBeNull();
    expect(linkedinConfig("organization", { LINKEDIN_CLIENT_ID: "86abc123", LINKEDIN_CLIENT_SECRET: "s" }, SITE)).toBeNull();
    expect(member.redirectUri).toBe("https://news.iron-security.com/admin/integracoes/linkedin/perfil/callback");
    expect(org().redirectUri).toBe("https://news.iron-security.com/admin/integracoes/linkedin/pagina/callback");
    expect(member.apiVersion).toBe("202606");
    expect(org().apiVersion).toBe("202607");
    expect(org("123").orgId).toBe("123");
    expect(org("abc").orgId).toBeNull();
  });
  it("monta a URL de autorização com redirect exato, escopos mínimos e state, sem o secret", () => {
    const u = new URL(authorizeUrl(member, "st"));
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(u.searchParams.get("scope")).toBe(LINKEDIN_SCOPES.member.join(" "));
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("client_id")).toBe("86abc123");
    expect(u.toString()).not.toContain("li-secret");
  });
  it("slug da URL ↔ alvo; contexto da cifra separa alvo, conta e tipo de token", () => {
    expect(targetFromSlug("perfil")).toBe("member");
    expect(targetFromSlug("pagina")).toBe("organization");
    expect(targetFromSlug("../x")).toBeNull();
    expect(tokenContext("member", "urn:li:person:a")).toBe("linkedin:member:urn:li:person:a");
    expect(tokenContext("organization", "urn:li:organization:1", "refresh")).toBe("linkedin-refresh:organization:urn:li:organization:1");
  });
});

describe("connectWithCode: perfil", () => {
  it("troca o code, lê o /userinfo e devolve o autor urn:li:person", async () => {
    const { f, calls } = fake((c) => (c.url.pathname === "/oauth/v2/accessToken" ? TOKEN : { sub: "abc_123-X", name: "Diego Terrani" }));
    const a = await connectWithCode(member, "CODE", f, new Date(0));
    expect(a).toMatchObject({ target: "member", accountId: "urn:li:person:abc_123-X", accountName: "Diego Terrani", accessToken: "AQVtoken", refreshToken: null });
    expect(a.expiresAt.getTime()).toBe(5_184_000_000);
    expect(calls[0]!.body.get("redirect_uri")).toBe(member.redirectUri);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer AQVtoken");
  });
  it("recusa token sem a permissão de publicar e code recusado", async () => {
    await expect(connectWithCode(member, "C", fake(() => ({ ...TOKEN, scope: "openid,profile" })).f)).rejects.toMatchObject({ code: "scopes" });
    await expect(connectWithCode(member, "C", fake(() => new Response("{}", { status: 400 })).f)).rejects.toBeInstanceOf(LinkedinError);
  });
});

describe("connectWithCode: página", () => {
  const routes = (orgs: string[]) => (c: Call) => {
    if (c.url.pathname === "/oauth/v2/accessToken") return { ...TOKEN, scope: "rw_organization_admin,w_organization_social", refresh_token: "AQref", refresh_token_expires_in: 31_536_000 };
    if (c.url.pathname === "/rest/organizationAcls") return { elements: orgs.map((o) => ({ organization: `urn:li:organization:${o}`, role: "ADMINISTRATOR" })) };
    if (c.url.pathname.startsWith("/rest/organizations/")) return { localizedName: "IRON Security" };
    throw new Error(c.url.toString());
  };
  it("com uma página administrada, usa ela e guarda o refresh token", async () => {
    const { f, calls } = fake(routes(["111"]));
    const a = await connectWithCode(org(), "C", f, new Date(0));
    expect(a).toMatchObject({ accountId: "urn:li:organization:111", accountName: "IRON Security", refreshToken: "AQref" });
    expect(a.refreshExpiresAt?.getTime()).toBe(31_536_000_000);
    const acl = calls.find((c) => c.url.pathname === "/rest/organizationAcls")!;
    expect(acl.url.searchParams.get("role")).toBe("ADMINISTRATOR");
    expect(acl.headers.get("linkedin-version")).toBe("202607");
  });
  it("várias páginas exigem LINKEDIN_ORG_ID; id que a pessoa não administra é recusado; nenhuma página também", async () => {
    await expect(connectWithCode(org(), "C", fake(routes(["111", "222"])).f)).rejects.toMatchObject({ code: "many_orgs" });
    expect((await connectWithCode(org("222"), "C", fake(routes(["111", "222"])).f)).accountId).toBe("urn:li:organization:222");
    await expect(connectWithCode(org("333"), "C", fake(routes(["111"])).f)).rejects.toMatchObject({ code: "org_not_admin" });
    await expect(connectWithCode(org(), "C", fake(routes([])).f)).rejects.toMatchObject({ code: "no_org" });
  });
});
