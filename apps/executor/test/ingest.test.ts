import { describe, expect, it } from "vitest";
import { updateCentroid, toPgVector, fromPgVector } from "../src/ingest/embeddings";
import { fetchSource } from "../src/ingest/fetchers";
import { ghsaUrl, nvdUrl, parseGhsa, parseKev, parseNvd } from "../src/ingest/fetchers/official";
import { parseFeed } from "../src/ingest/fetchers/rss";
import { canonicalUrl, cleanText, extractCves, isTooOld, parseDate, truncate } from "../src/ingest/normalize";
import type { SourceRow } from "../src/ingest/types";

const now = new Date("2026-11-09T12:00:00Z");

describe("canonicalUrl (RN-ING01)", () => {
  it("remove rastreamento, fragmento e barra final; força https e host minúsculo", () => {
    expect(canonicalUrl("http://WWW.Example.com/a/b/?utm_source=x&id=2&fbclid=1&gclid=2#top")).toBe("https://www.example.com/a/b?id=2");
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com");
    expect(canonicalUrl("https://example.com/x?b=2&a=1")).toBe("https://example.com/x?a=1&b=2");
  });
  it("mesma notícia com rastreamento diferente gera a mesma URL", () => {
    expect(canonicalUrl("https://e.com/n/?utm_medium=rss")).toBe(canonicalUrl("https://e.com/n#comments"));
  });
});

describe("extractCves (RN-ING04)", () => {
  it("extrai únicos, em maiúsculas, na ordem", () => {
    expect(extractCves("Fix for cve-2026-12345 and CVE-2026-1234567", "again CVE-2026-12345", null)).toEqual([
      "CVE-2026-12345", "CVE-2026-1234567",
    ]);
  });
  it("ignora padrões inválidos", () => {
    expect(extractCves("CVE-26-1 CVE-2026-12")).toEqual([]);
  });
});

describe("cleanText (§9.2)", () => {
  it("tira HTML, entidades, scripts, imagens, </source> e zero-width", () => {
    const html = '<p>Hello&nbsp;<b>world</b> &amp; &#8220;friends&#8221;</p><script>alert(1)</script>' +
      ' see https://cdn.x.com/a.png?w=1 </source><source id="x"> evil' + String.fromCharCode(0x200b, 0x07, 0x2028);
    expect(cleanText(html)).toBe("Hello world & “friends”\nsee evil");
  });
  it("vazio para null", () => expect(cleanText(null)).toBe(""));
});

describe("truncate / datas", () => {
  it("corta sem quebrar palavra", () => {
    expect(truncate("alpha beta gamma delta", 15)).toBe("alpha beta…");
    expect(truncate("curto", 10)).toBe("curto");
  });
  it("descarta itens com mais de 7 dias (RN-ING02)", () => {
    expect(isTooOld(new Date("2026-11-01T11:00:00Z"), now)).toBe(true);
    expect(isTooOld(new Date("2026-11-03T13:00:00Z"), now)).toBe(false);
    expect(isTooOld(null, now)).toBe(false);
  });
  it("parseDate aceita RFC 822/ISO e rejeita futuro distante", () => {
    expect(parseDate("Sun, 08 Nov 2026 10:00:00 +0000", now)?.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(parseDate("2030-01-01T00:00:00Z", now)).toBeNull();
    expect(parseDate("lixo", now)).toBeNull();
  });
});

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Feed</title>
<item><title><![CDATA[Ransomware hits &amp; leaks data (CVE-2026-1111)]]></title>
<link>https://news.example.com/story-1/?utm_source=rss</link>
<description><![CDATA[<p>Short <b>summary</b></p>]]></description>
<content:encoded><![CDATA[<p>Full body mentions CVE-2026-2222.</p><img src="https://x.com/a.png">]]></content:encoded>
<pubDate>Sun, 08 Nov 2026 10:00:00 +0000</pubDate><guid isPermaLink="false">abc</guid></item>
<item><title>No link item</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title type="html">Zero-day in Widget</title>
<link rel="replies" href="https://blog.example.com/c"/><link rel="alternate" href="https://blog.example.com/zero-day"/>
<summary type="html">&lt;p&gt;Exploited in the wild&lt;/p&gt;</summary><published>2026-11-07T08:00:00Z</published></entry></feed>`;

const RDF = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://cert.br/"><title>CERT.br</title></channel>
<item rdf:about="https://www.cert.br/docs/x"><title>Alerta</title><link>https://www.cert.br/docs/x</link>
<description>Texto</description><dc:date>2026-11-06T10:00:00-03:00</dc:date></item></rdf:RDF>`;

describe("parseFeed", () => {
  it("RSS 2.0 com CDATA, content:encoded e CVEs do corpo", () => {
    const [a, ...rest] = parseFeed(RSS, { now });
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({
      url: "https://news.example.com/story-1/?utm_source=rss",
      title: "Ransomware hits & leaks data (CVE-2026-1111)",
      summary: "Short summary",
      excerpt: "Full body mentions CVE-2026-2222.",
      cves: ["CVE-2026-1111", "CVE-2026-2222"],
    });
    expect(a!.publishedAt?.toISOString()).toBe("2026-11-08T10:00:00.000Z");
  });
  it("Atom escolhe o link alternate", () => {
    const [e] = parseFeed(ATOM, { now });
    expect(e).toMatchObject({ url: "https://blog.example.com/zero-day", title: "Zero-day in Widget", summary: "Exploited in the wild" });
  });
  it("RSS 1.0 (RDF)", () => {
    const [e] = parseFeed(RDF, { now });
    expect(e).toMatchObject({ url: "https://www.cert.br/docs/x", title: "Alerta" });
    expect(e!.publishedAt?.toISOString()).toBe("2026-11-06T13:00:00.000Z");
  });
  it("rejeita conteúdo que não é feed", () => {
    expect(() => parseFeed("<html><body>oops</body></html>", { now })).toThrow(/RSS/);
  });
});

describe("fontes oficiais", () => {
  it("KEV: só adições dos últimos 7 dias, com flags in_kev/exploited", () => {
    const kev = JSON.stringify({ vulnerabilities: [
      { cveID: "CVE-2026-1000", vendorProject: "Acme", product: "VPN", vulnerabilityName: "Acme VPN Auth Bypass",
        dateAdded: "2026-11-08", shortDescription: "Bypass.", requiredAction: "Patch.", dueDate: "2026-11-29",
        knownRansomwareCampaignUse: "Known" },
      { cveID: "CVE-2025-9", dateAdded: "2026-10-01" },
    ] });
    const items = parseKev(kev, { now });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ cves: ["CVE-2026-1000"], flags: { in_kev: true, exploited: true } });
    expect(items[0]!.title).toBe("CISA adds CVE-2026-1000 to KEV: Acme VPN Auth Bypass");
    expect(items[0]!.excerpt).toContain("ransomware");
    expect(canonicalUrl(items[0]!.url)).toContain("CVE-2026-1000");
  });
  it("NVD: URL com janela e severidade; item com severidade no título", () => {
    const u = new URL(nvdUrl("https://services.nvd.nist.gov/rest/json/cves/2.0", { cvssV3Severity: "CRITICAL", windowHours: 24 }, now));
    expect(u.searchParams.get("cvssV3Severity")).toBe("CRITICAL");
    expect(u.searchParams.get("pubStartDate")).toBe("2026-11-08T12:00:00.000Z");
    const items = parseNvd(JSON.stringify({ vulnerabilities: [{ cve: {
      id: "CVE-2026-5555", published: "2026-11-09T01:15:00.000",
      descriptions: [{ lang: "en", value: "A flaw in X allows RCE. More text." }],
      metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL" } }] } } }] }), { now });
    expect(items[0]).toMatchObject({ title: "CVE-2026-5555 (CRITICAL): A flaw in X allows RCE.", cves: ["CVE-2026-5555"] });
    expect(items[0]!.publishedAt?.toISOString()).toBe("2026-11-09T01:15:00.000Z");
  });
  it("GitHub Advisories: query a partir do config e CVE do advisory", () => {
    const u = new URL(ghsaUrl("https://api.github.com/advisories", { type: "reviewed", severity: "critical" }));
    expect(u.searchParams.get("severity")).toBe("critical");
    const items = parseGhsa(JSON.stringify([{ ghsa_id: "GHSA-x", cve_id: "CVE-2026-7", html_url: "https://github.com/advisories/GHSA-x",
      summary: "RCE in lib", description: "Details", published_at: "2026-11-08T00:00:00Z",
      vulnerabilities: [{ package: { ecosystem: "npm", name: "lib" } }] }]), { now });
    expect(items[0]).toMatchObject({ title: "CVE-2026-7: RCE in lib", cves: ["CVE-2026-7"] });
    expect(items[0]!.excerpt).toContain("npm:lib");
  });
});

describe("fetchSource", () => {
  const src: SourceRow = { id: "s", brand_id: "b", name: "Feed", kind: "rss", url: "https://feed.example.com/rss", lang: "en",
    trust_weight: 0.8, fetch_interval_min: 30, config: {}, etag: '"v1"', last_modified: null, consecutive_failures: 0 };

  it("manda If-None-Match e trata 304 sem itens (RN-SRC02)", async () => {
    let sent: Headers | undefined;
    const fake = (async (_u: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    }) as unknown as typeof fetch;
    const r = await fetchSource(src, { now }, fake);
    expect(sent?.get("if-none-match")).toBe('"v1"');
    expect(r).toMatchObject({ notModified: true, items: [] });
  });
  it("erro HTTP vira exceção (conta como falha da fonte)", async () => {
    const fake = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchSource(src, { now }, fake)).rejects.toThrow(/503/);
  });
  it("tipo sem coletor falha explicitamente", async () => {
    await expect(fetchSource({ ...src, kind: "json_api" }, { now })).rejects.toThrow(/sem coletor/);
  });
});

describe("embeddings", () => {
  it("centroide por média incremental e serialização pgvector", () => {
    expect(updateCentroid([1, 1], 1, [3, 5])).toEqual([2, 3]);
    expect(fromPgVector(toPgVector([0.5, -1]))).toEqual([0.5, -1]);
  });
});
