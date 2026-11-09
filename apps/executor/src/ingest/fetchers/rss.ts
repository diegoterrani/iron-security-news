import { XMLParser } from "fast-xml-parser";
import { EXCERPT_MAX, cleanText, extractCves, parseDate, truncate } from "../normalize";
import type { FetchContext, FetchedItem } from "../types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link", "category"].includes(name),
});

type Node = unknown;

/** Texto de um nó que pode ser string, {#text}, array ou CDATA já fundido. */
function text(n: Node): string {
  if (n == null) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return text(n[0]);
  if (typeof n === "object") {
    const o = n as Record<string, unknown>;
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

/** Link do item: RSS <link>texto</link>, Atom <link rel="alternate" href>, ou guid permalink. */
function pickLink(entry: Record<string, unknown>): string {
  const links = (entry.link as Node[] | undefined) ?? [];
  for (const l of links) {
    if (typeof l === "string" && /^https?:/i.test(l.trim())) return l.trim();
    if (l && typeof l === "object") {
      const o = l as Record<string, string>;
      const rel = o["@_rel"] ?? "alternate";
      if (o["@_href"] && rel === "alternate") return o["@_href"];
      if (o["#text"] && /^https?:/i.test(o["#text"])) return o["#text"];
    }
  }
  for (const l of links) {
    const href = l && typeof l === "object" ? (l as Record<string, string>)["@_href"] : undefined;
    if (href) return href;
  }
  const guid = text(entry.guid);
  if (/^https?:/i.test(guid)) return guid;
  const about = (entry as Record<string, string>)["@_rdf:about"];
  return about && /^https?:/i.test(about) ? about : "";
}

/** RSS 2.0, RSS 1.0 (RDF) e Atom. Itens sem link ou título são ignorados. */
export function parseFeed(xml: string, ctx: Pick<FetchContext, "now">): FetchedItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const entries: Record<string, unknown>[] =
    doc.rss?.channel?.item ?? doc.feed?.entry ?? doc["rdf:RDF"]?.item ?? doc.channel?.item ?? [];
  if (!doc.rss && !doc.feed && !doc["rdf:RDF"]) throw new Error("conteúdo não é RSS/Atom");

  const out: FetchedItem[] = [];
  for (const e of entries.slice(0, 100)) {
    const url = pickLink(e);
    const title = cleanText(text(e.title));
    if (!url || !title) continue;
    const summaryRaw = text(e.description) || text(e.summary);
    const contentRaw = text(e["content:encoded"]) || text(e.content);
    const summary = truncate(cleanText(summaryRaw), 500) || null;
    const excerpt = truncate(cleanText(contentRaw || summaryRaw), EXCERPT_MAX) || null;
    const published = parseDate(
      text(e.pubDate) || text(e.published) || text(e["dc:date"]) || text(e.updated),
      ctx.now,
    );
    out.push({ url, title: truncate(title, 300), summary, excerpt, publishedAt: published, cves: extractCves(title, summary, excerpt) });
  }
  return out;
}
