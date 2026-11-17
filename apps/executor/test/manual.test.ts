import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { MANUAL_TEXT_MAX, articleBody, extractArticle, metaContent, splitPastedText } from "../src/manual/extract";
import { FetchRejected, assertPublicHttpsUrl, guardedLookup, isBlockedIp, safeFetch } from "../src/manual/safe-fetch";
import { buildManualItem, type ManualRequestRow } from "../src/manual/worker";
import { writerUserContent } from "../src/story/build";

/** Resposta HTTP falsa para o safeFetch (sem rede). */
function fakeResponse(status: number, headers: Record<string, string>, body = ""): IncomingMessage {
  const s = new PassThrough() as unknown as IncomingMessage;
  (s as { statusCode?: number }).statusCode = status;
  (s as { headers: Record<string, string> }).headers = headers;
  (s as unknown as PassThrough).end(body);
  return s;
}

const PARAGRAPH = "A empresa confirmou que 1.234 servidores foram afetados pela falha CVE-2026-1000 na semana passada, segundo o comunicado oficial.";
const HTML = `<!doctype html><html><head>
  <title>Título da aba | Portal</title>
  <meta property="og:title" content="Falha crítica atinge servidores &amp; roteadores">
  <meta content="Resumo da matéria publicado pelo portal." name="description">
  <meta property="og:site_name" content="Portal Exemplo">
  <meta property="article:published_time" content="2026-11-16T10:00:00Z">
  </head><body>
  <nav><p>Menu que não deve entrar no texto de jeito nenhum, nem por acaso.</p></nav>
  <article><h1>Falha crítica</h1>${`<p>${PARAGRAPH}</p>`.repeat(5)}
  <script>alert("x")</script><aside><p>Leia também: outra notícia que não interessa ao redator.</p></aside></article>
  <footer><p>Rodapé com copyright e endereço que não deve entrar.</p></footer>
  </body></html>`;

describe("SSRF: validação da URL e do IP", () => {
  it("bloqueia IPs internos, metadata da nuvem e IPv6 local", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("aceita só https público, porta 443 e sem credenciais", () => {
    expect(assertPublicHttpsUrl("https://www.bleepingcomputer.com/news/x").hostname).toBe("www.bleepingcomputer.com");
    for (const bad of [
      "http://exemplo.com/a", "file:///etc/passwd", "https://user:pw@exemplo.com/", "https://exemplo.com:8443/",
      "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data",
      "https://intranet/", "https://servidor.internal/", "não é url",
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(FetchRejected);
    }
  });

  it("lookup do socket recusa quando algum IP resolvido é interno (DNS rebinding)", async () => {
    const fakeDns = ((_h: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])) as never;
    const err = await new Promise<Error | null>((r) => guardedLookup(fakeDns)("evil.example", {}, (e) => r(e)));
    expect(err).toBeInstanceOf(FetchRejected);

    const okDns = ((_h: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }])) as never;
    const addr = await new Promise<string>((r) => guardedLookup(okDns)("ok.example", {}, (_e, a) => r(a as string)));
    expect(addr).toBe("93.184.216.34");
  });

  it("revalida o destino de cada redirecionamento", async () => {
    const requestImpl = async (u: URL) =>
      u.hostname === "curto.example"
        ? fakeResponse(302, { location: "https://127.0.0.1/admin" })
        : fakeResponse(200, { "content-type": "text/html" }, HTML);
    await expect(safeFetch("https://curto.example/x", { requestImpl })).rejects.toThrow(/interno/);
  });

  it("segue redirecionamento válido e recusa tipo não textual e 403 com dica", async () => {
    const ok = await safeFetch("https://a.example/1", {
      requestImpl: async (u) => (u.pathname === "/1"
        ? fakeResponse(301, { location: "/2" })
        : fakeResponse(200, { "content-type": "text/html; charset=utf-8" }, HTML)),
    });
    expect(ok.url).toBe("https://a.example/2");
    await expect(safeFetch("https://a.example/pdf", { requestImpl: async () => fakeResponse(200, { "content-type": "application/pdf" }) }))
      .rejects.toThrow(/cole o texto/);
    await expect(safeFetch("https://a.example/f", { requestImpl: async () => fakeResponse(403, {}) })).rejects.toThrow(/403/);
  });

  it("erro 5xx e de rede são temporários; 404 é permanente", async () => {
    const e5 = await safeFetch("https://a.example/", { requestImpl: async () => fakeResponse(503, {}) }).catch((e) => e);
    expect(e5).toBeInstanceOf(FetchRejected);
    expect((e5 as FetchRejected).permanent).toBe(false);
    const e4 = await safeFetch("https://a.example/", { requestImpl: async () => fakeResponse(404, {}) }).catch((e) => e);
    expect((e4 as FetchRejected).permanent).toBe(true);
    const net = await safeFetch("https://a.example/", { requestImpl: async () => { throw new Error("ECONNRESET"); } }).catch((e) => e);
    expect((net as FetchRejected).permanent).toBe(false);
  });

  it("recusa página acima do teto de tamanho", async () => {
    const big = "x".repeat(2048);
    await expect(safeFetch("https://a.example/", { maxBytes: 1024, requestImpl: async () => fakeResponse(200, { "content-type": "text/html" }, big) }))
      .rejects.toThrow(/grande demais/);
  });
});

describe("extração da matéria", () => {
  it("lê metadados em qualquer ordem de atributos e decodifica entidades", () => {
    expect(metaContent(HTML, ["description"])).toBe("Resumo da matéria publicado pelo portal.");
    const a = extractArticle(HTML, new Date("2026-11-17T00:00:00Z"));
    expect(a.title).toBe("Falha crítica atinge servidores & roteadores");
    expect(a.siteName).toBe("Portal Exemplo");
    expect(a.publishedAt?.toISOString()).toBe("2026-11-16T10:00:00.000Z");
  });

  it("pega o corpo do <article> sem menu, rodapé, aside nem script", () => {
    const body = articleBody(HTML);
    expect(body).toContain("1.234 servidores");
    expect(body).not.toMatch(/Menu|Rodapé|Leia também|alert/);
  });

  it("matéria em <div> com poucos <p> de legenda usa o texto inteiro do escopo", () => {
    const html = `<html><body><main><p>Foto: divulgação da empresa afetada pelo ataque.</p>${`<div>${PARAGRAPH}</div>`.repeat(6)}</main></body></html>`;
    const body = articleBody(html);
    expect(body).toContain("1.234 servidores");
    expect(body.length).toBeGreaterThan(PARAGRAPH.length * 5);
  });

  it("texto colado: 1ª linha vira título, sem # do markdown, com teto de tamanho", () => {
    const r = splitPastedText(`# Ransomware atinge hospital\n\n${"Parágrafo com detalhes. ".repeat(1000)}`);
    expect(r.title).toBe("Ransomware atinge hospital");
    expect(r.text.length).toBeLessThanOrEqual(MANUAL_TEXT_MAX);
  });
});

describe("pedido → item", () => {
  const base: ManualRequestRow = {
    id: "11111111-1111-1111-1111-111111111111", brand_id: "b", kind: "text", input_url: null,
    input_text: `Vazamento expõe dados de clientes\n${PARAGRAPH.repeat(3)}`, source_name: null, source_url: null, attempts: 1,
  };

  it("texto sem link usa URN interno e rótulo da redação", async () => {
    const it = await buildManualItem(base);
    expect(it.url).toBe(`urn:ironnews:manual:${base.id}`);
    expect(it.sourceLabel).toBe("Envio da redação");
    expect(it.title).toBe("Vazamento expõe dados de clientes");
  });

  it("texto com fonte informada usa nome e link da fonte", async () => {
    const it = await buildManualItem({ ...base, source_name: "Reuters", source_url: "https://www.reuters.com/x?utm_source=a" });
    expect(it.sourceLabel).toBe("Reuters");
    expect(it.canonical).toBe("https://www.reuters.com/x");
  });

  it("link: extrai a página e usa o nome do veículo", async () => {
    const it = await buildManualItem(
      { ...base, kind: "url", input_url: "https://portal.example/n", input_text: null },
      { requestImpl: async () => fakeResponse(200, { "content-type": "text/html" }, HTML) },
    );
    expect(it.sourceLabel).toBe("Portal Exemplo");
    expect(it.text).toContain("1.234 servidores");
    expect(it.text.startsWith("Resumo da matéria")).toBe(true);
  });

  it("link sem texto legível pede para colar o texto", async () => {
    await expect(buildManualItem(
      { ...base, kind: "url", input_url: "https://spa.example/", input_text: null },
      { requestImpl: async () => fakeResponse(200, { "content-type": "text/html" }, "<html><body><div id=root></div></body></html>") },
    )).rejects.toThrow(/cole o texto/);
  });
});

describe("redator com fonte manual", () => {
  it("não envia URL interna (urn:) ao modelo", () => {
    const c = writerUserContent(
      [{ id: "s1", name: "Envio da redação", url: "urn:ironnews:manual:x", title: "T", summary: "S", excerpt: null, published_at: null }],
      { cves: {} }, { category: "other", severity: "info" },
    );
    expect(c).toContain('<source id="s1" name="Envio da redação">');
    expect(c).not.toContain("urn:");
  });
});
