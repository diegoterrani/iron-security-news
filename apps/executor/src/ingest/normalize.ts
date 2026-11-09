import { createHash } from "node:crypto";

/** Parâmetros de rastreamento removidos da URL canônica (RN-ING01). */
const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src)$/i;

/** URL sem utm_*, fbclid, gclid, fragmento e barra final (RN-ING01). Host em minúsculas, https preferido. */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.protocol === "http:") u.protocol = "https:";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  const s = u.toString();
  // Raiz sem query: "https://e.com/" → "https://e.com"
  return u.pathname === "/" && !u.search ? s.replace(/\/$/, "") : s;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const CVE_RE = /CVE-\d{4}-\d{4,7}/gi;

/** CVE IDs únicos, em maiúsculas, na ordem em que aparecem (RN-ING04). */
export function extractCves(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t?.matchAll(CVE_RE) ?? []) out.add(m[0].toUpperCase());
  return [...out];
}

/** Controle C0/DEL, zero-width, separadores de linha/parágrafo, bidi e BOM (montado por código, sem literais invisíveis). */
const INVISIBLE_CHARS = new RegExp(
  "[" +
    [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff]]
      .map(([a, b]) => `${esc(a!)}-${esc(b!)}`)
      .join("") +
    "]",
  "g",
);
function esc(cp: number): string {
  return "\\u" + cp.toString(16).padStart(4, "0");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/**
 * Texto plano seguro para guardar e mandar ao LLM (§9.2): sem HTML, sem URLs de imagem,
 * sem `</source>`, sem caracteres de controle/zero-width, espaços normalizados.
 */
export function cleanText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html
    .replace(/<(script|style|noscript|iframe|figure|figcaption)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  s = s
    .replace(/<\/?source[^>]*>/gi, " ")
    .replace(/https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?/gi, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Corta em `max` caracteres sem quebrar palavra, com reticências. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

export const EXCERPT_MAX = 2000; // RN-ING03
export const MAX_ITEM_AGE_DAYS = 7; // RN-ING02

export function isTooOld(publishedAt: Date | null, now = new Date()): boolean {
  return publishedAt !== null && now.getTime() - publishedAt.getTime() > MAX_ITEM_AGE_DAYS * 86_400_000;
}

/** Data de feed tolerante (RFC 822, ISO 8601). Datas no futuro distante viram `null`. */
export function parseDate(v: unknown, now = new Date()): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() - now.getTime() > 2 * 86_400_000) return null;
  return d;
}
